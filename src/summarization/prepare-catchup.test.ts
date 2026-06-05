import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrationsUp } from "../db/migrate.js";
import { upsertGroup } from "../db/repositories/groups.js";
import { insertMediaAnalysis } from "../db/repositories/media-analyses.js";
import { insertMessages } from "../db/repositories/messages.js";
import { upsertParticipant } from "../db/repositories/participants.js";
import { upsertWatermark } from "../db/repositories/read-watermarks.js";
import { insertSummary } from "../db/repositories/summaries.js";
import type { NormalizedMessage } from "../importer/types.js";
import { prepareCatchup } from "./prepare-catchup.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "..", "db", "migrations");

describe("prepareCatchup", () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
    await runMigrationsUp(container.getConnectionUri(), MIGRATIONS_DIR);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  }, 30_000);

  /** Seed a single message and return its database id. */
  async function seed(
    groupId: number,
    m: Partial<NormalizedMessage> & { dedupeKey: string; sentAt: Date },
  ): Promise<number> {
    const senderName = m.senderName !== undefined ? m.senderName : "Dana";
    let participantId: number | null = null;
    if (senderName != null) {
      participantId = await upsertParticipant(pool, senderName);
    }
    const row: NormalizedMessage & { participantId: number | null } = {
      groupId,
      importId: null,
      source: "import",
      senderName,
      messageType: "text",
      textContent: "hi",
      mediaFilename: null,
      mediaPath: null,
      mediaStatus: null,
      externalId: null,
      participantId,
      ...m,
    };
    if (m.senderName === null) {
      row.participantId = null;
    } else {
      row.participantId = participantId;
    }
    await insertMessages(pool, [row]);
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM messages WHERE dedupe_key=$1`,
      [row.dedupeKey],
    );
    return Number(rows[0]!.id);
  }

  it("throws Unknown chat error for a non-existent group name", async () => {
    await expect(prepareCatchup(pool, "no-such-group", 100, 999_999)).rejects.toThrow(
      'Unknown chat "no-such-group"',
    );
  });

  it("first-run fallback: no watermark → usedFallback=true, fromExclusive=null, newWatermark = newest message cursor", async () => {
    const g = await upsertGroup(pool, { name: "PC-firstrun", source: "import" });
    const t1 = new Date("2026-01-01T10:00:00Z");
    const t2 = new Date("2026-01-01T11:00:00Z");
    const t3 = new Date("2026-01-01T12:00:00Z");

    await seed(g, { dedupeKey: "pc-fr-1", sentAt: t1, textContent: "msg1" });
    await seed(g, { dedupeKey: "pc-fr-2", sentAt: t2, textContent: "msg2" });
    const lastId = await seed(g, { dedupeKey: "pc-fr-3", sentAt: t3, textContent: "msg3" });

    const result = await prepareCatchup(pool, "PC-firstrun", 100, 999_999);

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("unreachable");

    expect(result.usedFallback).toBe(true);
    expect(result.parameters.fromExclusive).toBeNull();
    expect(result.newWatermark.messageId).toBe(lastId);
    expect(result.newWatermark.sentAt.getTime()).toBe(t3.getTime());
    expect(result.messageCount).toBeLessThanOrEqual(100);
    expect(result.summaryType).toBe("watermark");
    expect(result.groupId).toBe(g);
  });

  it("first-run fallback with fallbackN=2: only the newest 2 messages are included", async () => {
    const g = await upsertGroup(pool, { name: "PC-firstrun-n", source: "import" });
    const times = [
      new Date("2026-02-01T10:00:00Z"),
      new Date("2026-02-01T11:00:00Z"),
      new Date("2026-02-01T12:00:00Z"),
      new Date("2026-02-01T13:00:00Z"),
    ];
    for (let i = 0; i < 4; i++) {
      await seed(g, { dedupeKey: `pc-fn-${i}`, sentAt: times[i]!, textContent: `m${i}` });
    }
    const lastId = await pool
      .query<{ id: string }>(`SELECT id FROM messages WHERE dedupe_key='pc-fn-3'`)
      .then((r) => Number(r.rows[0]!.id));

    const result = await prepareCatchup(pool, "PC-firstrun-n", 2, 999_999);

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("unreachable");
    expect(result.messageCount).toBe(2);
    expect(result.newWatermark.messageId).toBe(lastId);
    expect(result.usedFallback).toBe(true);
  });

  it("incremental: with watermark set, only strictly-after messages are included, newWatermark > wm", async () => {
    const g = await upsertGroup(pool, { name: "PC-incremental", source: "import" });
    const t1 = new Date("2026-03-01T10:00:00Z");
    const t2 = new Date("2026-03-01T11:00:00Z");
    const t3 = new Date("2026-03-01T12:00:00Z");

    const id1 = await seed(g, { dedupeKey: "pc-inc-1", sentAt: t1, textContent: "before wm" });
    const id2 = await seed(g, { dedupeKey: "pc-inc-2", sentAt: t2, textContent: "at wm" });
    const id3 = await seed(g, { dedupeKey: "pc-inc-3", sentAt: t3, textContent: "after wm" });

    // Watermark at message id2
    await upsertWatermark(pool, g, { sentAt: t2, messageId: id2 });

    const result = await prepareCatchup(pool, "PC-incremental", 100, 999_999);

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("unreachable");

    expect(result.messageCount).toBe(1);
    expect(result.newWatermark.messageId).toBe(id3);
    expect(result.newWatermark.messageId).toBeGreaterThan(id2);
    expect(result.usedFallback).toBe(false);
    expect(result.parameters.fromExclusive).toMatchObject({
      sentAt: t2.toISOString(),
      messageId: id2,
    });
    expect(result.parameters.toInclusive).toMatchObject({
      sentAt: t3.toISOString(),
      messageId: id3,
    });
  });

  it("BARRIER: pending voice note after watermark truncates range; message after barrier is excluded", async () => {
    const g = await upsertGroup(pool, { name: "PC-barrier", source: "import" });
    const t0 = new Date("2026-04-01T09:00:00Z"); // wm anchor
    const tA = new Date("2026-04-01T10:00:00Z"); // readable A
    const tB = new Date("2026-04-01T11:00:00Z"); // readable B
    const tV = new Date("2026-04-01T12:00:00Z"); // pending voice note (barrier)
    const tC = new Date("2026-04-01T13:00:00Z"); // readable C — after barrier, excluded

    const wmId = await seed(g, { dedupeKey: "pc-bar-wm", sentAt: t0, textContent: "anchor" });
    const idA = await seed(g, { dedupeKey: "pc-bar-A", sentAt: tA, textContent: "msg A" });
    const idB = await seed(g, { dedupeKey: "pc-bar-B", sentAt: tB, textContent: "msg B" });
    // Pending voice note (no transcript)
    await seed(g, {
      dedupeKey: "pc-bar-voice",
      sentAt: tV,
      messageType: "media",
      textContent: null,
      mediaFilename: "PTT-pending.opus",
      mediaPath: "/tmp/PTT-pending.opus",
      mediaStatus: "present",
    });
    await seed(g, { dedupeKey: "pc-bar-C", sentAt: tC, textContent: "msg C" });

    await upsertWatermark(pool, g, { sentAt: t0, messageId: wmId });

    const result = await prepareCatchup(pool, "PC-barrier", 100, 999_999);

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("unreachable");

    // Only A and B; C is after the barrier and excluded
    expect(result.messageCount).toBe(2);
    expect(result.newWatermark.messageId).toBe(idB);
    expect(result.parameters.toInclusive.messageId).toBe(idB);
  });

  it("cache-hit: watermark present, no readable messages after it, prior 'watermark' summary exists → cache-hit", async () => {
    const g = await upsertGroup(pool, { name: "PC-cachehit", source: "import" });
    const t1 = new Date("2026-05-01T10:00:00Z");
    const id1 = await seed(g, { dedupeKey: "pc-ch-1", sentAt: t1, textContent: "old msg" });

    // Watermark at the only message
    await upsertWatermark(pool, g, { sentAt: t1, messageId: id1 });

    // Insert a prior watermark summary
    await insertSummary(pool, {
      groupId: g,
      summaryType: "watermark",
      parameters: {
        fromExclusive: null,
        toInclusive: { sentAt: t1.toISOString(), messageId: id1 },
        messageCount: 1,
        usedFallback: true,
      },
      output: { overview: "cached overview" },
      model: "gemma4:26b",
    });

    const result = await prepareCatchup(pool, "PC-cachehit", 100, 999_999);

    expect(result.kind).toBe("cache-hit");
    if (result.kind !== "cache-hit") throw new Error("unreachable");
    expect(result.summary).toBe("cached overview");
    expect(result.generatedAt instanceof Date).toBe(true);
  });

  it("empty: watermark present, nothing after it, no prior catch-up summary → empty", async () => {
    const g = await upsertGroup(pool, { name: "PC-empty-wm", source: "import" });
    const t1 = new Date("2026-05-02T10:00:00Z");
    const id1 = await seed(g, { dedupeKey: "pc-ew-1", sentAt: t1, textContent: "only msg" });

    // Watermark at the only message, no summary row
    await upsertWatermark(pool, g, { sentAt: t1, messageId: id1 });

    const result = await prepareCatchup(pool, "PC-empty-wm", 100, 999_999);
    expect(result.kind).toBe("empty");
  });

  it("empty: first-run with a group that has zero readable messages → empty", async () => {
    const g = await upsertGroup(pool, { name: "PC-empty-nomsgs", source: "import" });
    // No messages seeded, no watermark

    const result = await prepareCatchup(pool, "PC-empty-nomsgs", 100, 999_999);
    expect(result.kind).toBe("empty");
  });

  it("over-budget: a non-empty range with tiny tokenBudget throws", async () => {
    const g = await upsertGroup(pool, { name: "PC-overbudget", source: "import" });
    const t1 = new Date("2026-06-01T10:00:00Z");
    await seed(g, { dedupeKey: "pc-ob-1", sentAt: t1, textContent: "some message content" });

    await expect(prepareCatchup(pool, "PC-overbudget", 100, 5)).rejects.toThrow(/narrow it/);
  });

  it("no-writes: prepareCatchup does not insert into summaries or read_watermarks", async () => {
    const g = await upsertGroup(pool, { name: "PC-nowrites", source: "import" });
    const t1 = new Date("2026-06-02T10:00:00Z");
    const t2 = new Date("2026-06-02T11:00:00Z");
    const id1 = await seed(g, { dedupeKey: "pc-nw-1", sentAt: t1, textContent: "msg1" });
    await seed(g, { dedupeKey: "pc-nw-2", sentAt: t2, textContent: "msg2" });

    // Set watermark at id1 so there's one new message
    await upsertWatermark(pool, g, { sentAt: t1, messageId: id1 });

    // Count rows before
    const { rows: sumBefore } = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM summaries WHERE group_id = $1`,
      [g],
    );
    const { rows: wmBefore } = await pool.query<{ watermark_message_id: string }>(
      `SELECT watermark_message_id FROM read_watermarks WHERE group_id = $1`,
      [g],
    );

    const result = await prepareCatchup(pool, "PC-nowrites", 100, 999_999);
    expect(result.kind).toBe("ready");

    // Count rows after — should be unchanged
    const { rows: sumAfter } = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM summaries WHERE group_id = $1`,
      [g],
    );
    const { rows: wmAfter } = await pool.query<{ watermark_message_id: string }>(
      `SELECT watermark_message_id FROM read_watermarks WHERE group_id = $1`,
      [g],
    );

    expect(Number(sumAfter[0]!.count)).toBe(Number(sumBefore[0]!.count));
    expect(wmAfter[0]!.watermark_message_id).toBe(wmBefore[0]!.watermark_message_id);
  });

  // -------------------------------------------------------------------------
  // T022 — dual barrier: visual-media barrier + voice-note barrier
  // -------------------------------------------------------------------------

  it("T022-1: present-unanalyzed image before any pending voice note bounds the catch-up window", async () => {
    const g = await upsertGroup(pool, { name: "PC-imgbar", source: "import" });
    const t0 = new Date("2026-07-01T09:00:00Z"); // watermark anchor
    const tA = new Date("2026-07-01T10:00:00Z"); // readable text
    const tImg = new Date("2026-07-01T11:00:00Z"); // pending image (barrier)
    const tB = new Date("2026-07-01T12:00:00Z"); // text after barrier — must be excluded

    const wmId = await seed(g, { dedupeKey: "pc-ib-wm", sentAt: t0, textContent: "anchor" });
    const idA = await seed(g, { dedupeKey: "pc-ib-A", sentAt: tA, textContent: "before image" });
    // Pending image — no analysis row
    await seed(g, {
      dedupeKey: "pc-ib-img",
      sentAt: tImg,
      messageType: "media",
      textContent: null,
      mediaFilename: "photo.jpg",
      mediaPath: "/tmp/photo.jpg",
      mediaStatus: "present",
    });
    await seed(g, { dedupeKey: "pc-ib-B", sentAt: tB, textContent: "after image" });

    await upsertWatermark(pool, g, { sentAt: t0, messageId: wmId });

    const result = await prepareCatchup(pool, "PC-imgbar", 100, 999_999);

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("unreachable");

    // Only message A before the image barrier; B is excluded
    expect(result.messageCount).toBe(1);
    expect(result.newWatermark.messageId).toBe(idA);
    expect(result.parameters.toInclusive.messageId).toBe(idA);
  });

  it("T022-2: failed image analysis does NOT bound the catch-up — watermark advances past it", async () => {
    const g = await upsertGroup(pool, { name: "PC-imgbar-failed", source: "import" });
    const t0 = new Date("2026-07-02T09:00:00Z");
    const tA = new Date("2026-07-02T10:00:00Z");
    const tImg = new Date("2026-07-02T11:00:00Z");
    const tB = new Date("2026-07-02T12:00:00Z");

    const wmId = await seed(g, { dedupeKey: "pc-ibf-wm", sentAt: t0, textContent: "anchor" });
    await seed(g, { dedupeKey: "pc-ibf-A", sentAt: tA, textContent: "msg A" });
    const imgId = await seed(g, {
      dedupeKey: "pc-ibf-img",
      sentAt: tImg,
      messageType: "media",
      textContent: null,
      mediaFilename: "fail.jpg",
      mediaPath: "/tmp/fail.jpg",
      mediaStatus: "present",
    });
    // Mark as failed analysis — should NOT block
    await insertMediaAnalysis(pool, {
      messageId: imgId,
      kind: "image",
      description: null,
      engine: "llama3.2-vision",
      status: "failed",
      errorMessage: "timeout",
    });
    const idB = await seed(g, { dedupeKey: "pc-ibf-B", sentAt: tB, textContent: "msg B" });

    await upsertWatermark(pool, g, { sentAt: t0, messageId: wmId });

    const result = await prepareCatchup(pool, "PC-imgbar-failed", 100, 999_999);

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("unreachable");

    // The failed image does NOT block; both A and B are included (image itself has no content)
    // B must be the new watermark since the range advances past the failed image
    expect(result.newWatermark.messageId).toBe(idB);
  });

  it("T022-3: when both a pending voice note and a pending image exist, the earlier one wins", async () => {
    const g = await upsertGroup(pool, { name: "PC-dual-barrier", source: "import" });
    const t0 = new Date("2026-07-03T09:00:00Z");
    const tA = new Date("2026-07-03T10:00:00Z");
    const tImg = new Date("2026-07-03T11:00:00Z"); // image barrier — earlier
    const tVoice = new Date("2026-07-03T12:00:00Z"); // voice note barrier — later
    const tB = new Date("2026-07-03T13:00:00Z");

    const wmId = await seed(g, { dedupeKey: "pc-db-wm", sentAt: t0, textContent: "anchor" });
    const idA = await seed(g, { dedupeKey: "pc-db-A", sentAt: tA, textContent: "before both" });
    // Pending image (earlier barrier)
    await seed(g, {
      dedupeKey: "pc-db-img",
      sentAt: tImg,
      messageType: "media",
      textContent: null,
      mediaFilename: "snap.jpg",
      mediaPath: "/tmp/snap.jpg",
      mediaStatus: "present",
    });
    // Pending voice note (later barrier)
    await seed(g, {
      dedupeKey: "pc-db-voice",
      sentAt: tVoice,
      messageType: "media",
      textContent: null,
      mediaFilename: "PTT-001.opus",
      mediaPath: "/tmp/PTT-001.opus",
      mediaStatus: "present",
    });
    await seed(g, { dedupeKey: "pc-db-B", sentAt: tB, textContent: "after both" });

    await upsertWatermark(pool, g, { sentAt: t0, messageId: wmId });

    const result = await prepareCatchup(pool, "PC-dual-barrier", 100, 999_999);

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("unreachable");

    // Image is earlier → it wins; only A is included; B and everything after image are excluded
    expect(result.messageCount).toBe(1);
    expect(result.newWatermark.messageId).toBe(idA);
  });

  it("T022-4: when the voice note is earlier than the pending image, the voice note wins", async () => {
    const g = await upsertGroup(pool, { name: "PC-dual-barrier-vn", source: "import" });
    const t0 = new Date("2026-07-04T09:00:00Z");
    const tA = new Date("2026-07-04T10:00:00Z");
    const tVoice = new Date("2026-07-04T11:00:00Z"); // voice note barrier — earlier
    const tImg = new Date("2026-07-04T12:00:00Z"); // image barrier — later
    const tB = new Date("2026-07-04T13:00:00Z");

    const wmId = await seed(g, { dedupeKey: "pc-dbvn-wm", sentAt: t0, textContent: "anchor" });
    const idA = await seed(g, { dedupeKey: "pc-dbvn-A", sentAt: tA, textContent: "before both" });
    // Pending voice note (earlier barrier)
    await seed(g, {
      dedupeKey: "pc-dbvn-voice",
      sentAt: tVoice,
      messageType: "media",
      textContent: null,
      mediaFilename: "PTT-001.opus",
      mediaPath: "/tmp/PTT-001.opus",
      mediaStatus: "present",
    });
    // Pending image (later barrier)
    await seed(g, {
      dedupeKey: "pc-dbvn-img",
      sentAt: tImg,
      messageType: "media",
      textContent: null,
      mediaFilename: "snap.jpg",
      mediaPath: "/tmp/snap.jpg",
      mediaStatus: "present",
    });
    await seed(g, { dedupeKey: "pc-dbvn-B", sentAt: tB, textContent: "after both" });

    await upsertWatermark(pool, g, { sentAt: t0, messageId: wmId });

    const result = await prepareCatchup(pool, "PC-dual-barrier-vn", 100, 999_999);

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("unreachable");

    // Voice note is earlier → it wins; only A is included
    expect(result.messageCount).toBe(1);
    expect(result.newWatermark.messageId).toBe(idA);
  });
});
