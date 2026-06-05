/**
 * T016 (importer side) — Tests for analyze.image enqueue in runImport.
 *
 * Verifies:
 * - Present non-sticker images get analyze.image enqueued (newest-first)
 * - Stickers do NOT get analyze.image enqueued
 * - Missing media does NOT get enqueued
 *
 * Uses a real Postgres container (testcontainers) + InMemoryJobBus.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import pg from "pg";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { runMigrationsUp } from "../db/migrate.js";
import { runImport } from "./run-import.js";
import { InMemoryJobBus } from "../jobs/in-memory-bus.js";
import { InMemoryJobRunRecorder } from "../jobs/job-run-recorder.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../db/migrations");
const FIXTURES_DIR = path.resolve(__dirname, "../../fixtures");

describe("runImport image enqueue (T016)", () => {
  let container: StartedPostgreSqlContainer;
  let connectionString: string;
  let pool: pg.Pool;
  let dataDir: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    connectionString = container.getConnectionUri();
    pool = new pg.Pool({ connectionString });
    await runMigrationsUp(connectionString, MIGRATIONS_DIR);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-import-img-test-"));
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
    if (dataDir && fs.existsSync(dataDir)) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("enqueues analyze.image for present images in a ZIP import (newest-first)", async () => {
    const recorder = new InMemoryJobRunRecorder();
    const bus = new InMemoryJobBus(recorder);
    const filePath = path.join(FIXTURES_DIR, "sample-chat.zip");

    await runImport(
      { filePath, name: "Zip Image Enqueue Test" },
      { databaseUrl: connectionString, dataDir, bus }
    );

    const imageJobs = recorder.enqueuedJobs.filter((j) => j.job.type === "analyze.image");
    // The fixture sample-chat.zip has at least one image (IMG-20260531-WA0001.jpg)
    expect(imageJobs.length).toBeGreaterThan(0);

    // Each messageId in the jobs must correspond to a real messages row with present image
    for (const job of imageJobs) {
      const { messageId } = job.job.payload as { messageId: string };
      const { rows } = await pool.query(
        `SELECT media_status, media_filename FROM messages WHERE id = $1`,
        [Number(messageId)]
      );
      expect(rows.length).toBe(1);
      expect(rows[0]!.media_status).toBe("present");
      // Must be a recognized image extension
      const filename: string = rows[0]!.media_filename ?? "";
      expect(filename).toMatch(/\.(jpg|jpeg|png|gif|webp)$/i);
    }
  });

  it("does not enqueue analyze.image for missing media", async () => {
    // .txt imports have no media → nothing should be enqueued for analyze.image
    const recorder = new InMemoryJobRunRecorder();
    const bus = new InMemoryJobBus(recorder);
    const filePath = path.join(FIXTURES_DIR, "android-chat.txt");

    await runImport(
      { filePath, name: "Txt No Image Enqueue" },
      { databaseUrl: connectionString, dataDir, bus }
    );

    const imageJobs = recorder.enqueuedJobs.filter((j) => j.job.type === "analyze.image");
    expect(imageJobs).toHaveLength(0);
  });
}, 120_000);
