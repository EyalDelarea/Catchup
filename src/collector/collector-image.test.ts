/**
 * T016 (collector side) — Tests for image enqueue behavior in handleIncomingMessage.
 *
 * Verifies:
 * - Non-sticker image: downloaded, media_status='present', analyze.image enqueued
 * - Sticker: NOT enqueued
 * - Image download failure: media 'missing', NOT enqueued
 * - No downloadImage provided: NOT enqueued
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import pg from "pg";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrationsUp } from "../db/migrate.js";
import { handleIncomingMessage } from "./collector.js";
import type { WAMessage } from "@whiskeysockets/baileys";
import { InMemoryJobBus } from "../jobs/in-memory-bus.js";
import { InMemoryJobRunRecorder } from "../jobs/job-run-recorder.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "..", "db", "migrations");

// ---------------------------------------------------------------------------
// Fake WAMessage factories
// ---------------------------------------------------------------------------

function makeFakeWAImageMessage(overrides: Partial<{
  id: string;
  remoteJid: string;
  pushName: string;
  timestampSeconds: number;
  caption: string | null;
}> = {}): WAMessage {
  const {
    id = "LIVE_IMG_001",
    remoteJid = "img-group@g.us",
    pushName = "ImgSender",
    timestampSeconds = 1700100000,
    caption = null,
  } = overrides;
  return {
    key: { id, remoteJid, fromMe: false },
    messageTimestamp: timestampSeconds,
    pushName,
    message: {
      imageMessage: {
        caption: caption ?? undefined,
        mimetype: "image/jpeg",
      },
    },
  } as unknown as WAMessage;
}

function makeFakeWAStickerMessage(overrides: Partial<{
  id: string;
  remoteJid: string;
  timestampSeconds: number;
}> = {}): WAMessage {
  const {
    id = "LIVE_STICKER_001",
    remoteJid = "sticker-group@g.us",
    timestampSeconds = 1700200000,
  } = overrides;
  return {
    key: { id, remoteJid, fromMe: false },
    messageTimestamp: timestampSeconds,
    pushName: "StickerSender",
    message: {
      stickerMessage: {
        mimetype: "image/webp",
        isAnimated: false,
      },
    },
  } as unknown as WAMessage;
}

const FAKE_IMAGE = Buffer.from("fake-jpeg-bytes");
const fakeImageDownloader = async () => FAKE_IMAGE;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("collector image enqueue (T016)", () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let dataDir: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
    await runMigrationsUp(container.getConnectionUri(), MIGRATIONS_DIR);
    dataDir = os.tmpdir();
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  }, 30_000);

  it("enqueues analyze.image for a new non-sticker image when downloaded successfully", async () => {
    const recorder = new InMemoryJobRunRecorder();
    const bus = new InMemoryJobBus(recorder);

    const waMsg = makeFakeWAImageMessage({
      id: "IMG_ENQUEUE_001",
      remoteJid: "img-enqueue@g.us",
      timestampSeconds: 1700100001,
    });

    const stored = await handleIncomingMessage(pool, waMsg, {
      dataDir,
      bus,
      downloadImage: fakeImageDownloader,
    });
    expect(stored).toBe(true);

    const imageJobs = recorder.enqueuedJobs.filter((j) => j.job.type === "analyze.image");
    expect(imageJobs).toHaveLength(1);
    const { messageId } = imageJobs[0]!.job.payload as { messageId: string };
    expect(typeof messageId).toBe("string");
    expect(messageId.length).toBeGreaterThan(0);

    // Verify the DB row has media_status='present'
    const { rows } = await pool.query(
      `SELECT media_status FROM messages WHERE external_id = $1`,
      ["IMG_ENQUEUE_001"]
    );
    expect(rows[0]!.media_status).toBe("present");
  });

  it("does NOT enqueue analyze.image for a sticker", async () => {
    const recorder = new InMemoryJobRunRecorder();
    const bus = new InMemoryJobBus(recorder);

    const waMsg = makeFakeWAStickerMessage({
      id: "STICKER_SKIP_001",
      remoteJid: "sticker-skip@g.us",
      timestampSeconds: 1700200001,
    });

    const stored = await handleIncomingMessage(pool, waMsg, {
      dataDir,
      bus,
      downloadImage: fakeImageDownloader,
    });
    expect(stored).toBe(true);

    const imageJobs = recorder.enqueuedJobs.filter((j) => j.job.type === "analyze.image");
    expect(imageJobs).toHaveLength(0);
  });

  it("marks media 'missing' and does NOT enqueue when image download fails", async () => {
    const recorder = new InMemoryJobRunRecorder();
    const bus = new InMemoryJobBus(recorder);
    const failingDownloader = async () => { throw new Error("download boom"); };

    const waMsg = makeFakeWAImageMessage({
      id: "IMG_DLFAIL_001",
      remoteJid: "img-dlfail@g.us",
      timestampSeconds: 1700100002,
    });

    const stored = await handleIncomingMessage(pool, waMsg, {
      dataDir,
      bus,
      downloadImage: failingDownloader,
    });
    expect(stored).toBe(true);

    const imageJobs = recorder.enqueuedJobs.filter((j) => j.job.type === "analyze.image");
    expect(imageJobs).toHaveLength(0);

    const { rows } = await pool.query(
      `SELECT media_status FROM messages WHERE external_id = $1`,
      ["IMG_DLFAIL_001"]
    );
    expect(rows[0]!.media_status).toBe("missing");
  });

  it("does NOT enqueue analyze.image when no downloadImage is provided", async () => {
    const recorder = new InMemoryJobRunRecorder();
    const bus = new InMemoryJobBus(recorder);

    const waMsg = makeFakeWAImageMessage({
      id: "IMG_NODL_001",
      remoteJid: "img-nodl@g.us",
      timestampSeconds: 1700100003,
    });

    const stored = await handleIncomingMessage(pool, waMsg, { dataDir, bus });
    expect(stored).toBe(true);

    const imageJobs = recorder.enqueuedJobs.filter((j) => j.job.type === "analyze.image");
    expect(imageJobs).toHaveLength(0);
  });

  it("does NOT enqueue a second analyze.image for a duplicate image message", async () => {
    const recorder = new InMemoryJobRunRecorder();
    const bus = new InMemoryJobBus(recorder);

    const waMsg = makeFakeWAImageMessage({
      id: "IMG_DUPE_001",
      remoteJid: "img-dupe@g.us",
      timestampSeconds: 1700100004,
    });

    const first = await handleIncomingMessage(pool, waMsg, {
      dataDir, bus, downloadImage: fakeImageDownloader,
    });
    expect(first).toBe(true);

    const second = await handleIncomingMessage(pool, waMsg, {
      dataDir, bus, downloadImage: fakeImageDownloader,
    });
    expect(second).toBe(false);

    const imageJobs = recorder.enqueuedJobs.filter((j) => j.job.type === "analyze.image");
    expect(imageJobs).toHaveLength(1); // only from first insertion
  });
});
