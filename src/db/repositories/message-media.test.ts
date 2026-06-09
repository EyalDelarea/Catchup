import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NormalizedMessage } from "../../importer/types.js";
import { createTestDatabase } from "../../test/db.js";
import { upsertGroup } from "./groups.js";
import {
  markMediaPresent,
  markMediaUnrecoverable,
  pruneMediaSecrets,
  recordMediaAttempt,
  selectPendingMedia,
  upsertMessageMedia,
} from "./message-media.js";
import { insertMessages } from "./messages.js";

describe("message-media", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  async function seedMessage(
    groupId: number,
    overrides: Partial<NormalizedMessage> = {},
  ): Promise<number> {
    const row: NormalizedMessage & { participantId: number | null } = {
      groupId,
      importId: null,
      source: "import",
      senderName: null,
      messageType: "media",
      textContent: null,
      mediaFilename: "IMG-001.jpg",
      mediaPath: "/tmp/IMG-001.jpg",
      mediaStatus: "present",
      sentAt: new Date("2026-01-01T08:00:00.000Z"),
      dedupeKey: `dk-${Math.random()}`,
      externalId: null,
      participantId: null,
      ...overrides,
    };
    await insertMessages(pool, [row]);
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM messages WHERE dedupe_key = $1`,
      [row.dedupeKey],
    );
    return Number(rows[0].id);
  }

  describe("upsertMessageMedia — write-once + volatile refresh", () => {
    it("inserts a pending row and keeps media_key write-once while refreshing direct_path on re-upsert", async () => {
      const groupId = await upsertGroup(pool, { name: "MM-writeonce-1", source: "import" });
      const messageId = await seedMessage(groupId, { dedupeKey: "mm-wo-1" });

      const key1 = Buffer.from("key1");
      const key2 = Buffer.from("key2_different");

      await upsertMessageMedia(pool, {
        messageId,
        mediaKind: "image",
        mimeType: "image/jpeg",
        mediaKey: key1,
        directPath: "/path/v1",
        url: "https://example.com/v1",
        fileEncSha256: null,
        fileSha256: null,
        mediaKeyTs: null,
        fileLength: null,
        waMessage: null,
        downloadState: "pending",
      });

      // Second upsert with different media_key and new direct_path
      await upsertMessageMedia(pool, {
        messageId,
        mediaKind: "image",
        mimeType: "image/jpeg",
        mediaKey: key2,
        directPath: "/path/v2",
        url: "https://example.com/v2",
        fileEncSha256: null,
        fileSha256: null,
        mediaKeyTs: null,
        fileLength: null,
        waMessage: null,
        downloadState: "pending",
      });

      const { rows } = await pool.query<{
        media_key: Buffer;
        direct_path: string;
      }>(`SELECT media_key, direct_path FROM message_media WHERE message_id = $1`, [messageId]);

      expect(rows).toHaveLength(1);
      // direct_path must be refreshed to the newer value
      expect(rows[0].direct_path).toBe("/path/v2");
      // media_key must stay as the original (write-once)
      expect(Buffer.from(rows[0].media_key).toString()).toBe("key1");
    });
  });

  describe("selectPendingMedia", () => {
    it("returns only pending rows, oldest-first by sent_at, capped by limit", async () => {
      const groupId = await upsertGroup(pool, { name: "MM-select-pend-1", source: "import" });

      const older = await seedMessage(groupId, {
        dedupeKey: "mm-pend-old-1",
        sentAt: new Date("2026-02-01T08:00:00.000Z"),
      });
      const newer = await seedMessage(groupId, {
        dedupeKey: "mm-pend-new-1",
        sentAt: new Date("2026-02-02T08:00:00.000Z"),
      });
      const presentMsg = await seedMessage(groupId, {
        dedupeKey: "mm-pend-present-1",
        sentAt: new Date("2026-02-03T08:00:00.000Z"),
      });

      await upsertMessageMedia(pool, {
        messageId: older,
        mediaKind: "image",
        mimeType: null,
        mediaKey: null,
        directPath: null,
        url: null,
        fileEncSha256: null,
        fileSha256: null,
        mediaKeyTs: null,
        fileLength: null,
        waMessage: null,
        downloadState: "pending",
      });
      await upsertMessageMedia(pool, {
        messageId: newer,
        mediaKind: "video",
        mimeType: null,
        mediaKey: null,
        directPath: null,
        url: null,
        fileEncSha256: null,
        fileSha256: null,
        mediaKeyTs: null,
        fileLength: null,
        waMessage: null,
        downloadState: "pending",
      });
      // Insert as pending then mark present
      await upsertMessageMedia(pool, {
        messageId: presentMsg,
        mediaKind: "audio",
        mimeType: null,
        mediaKey: null,
        directPath: null,
        url: null,
        fileEncSha256: null,
        fileSha256: null,
        mediaKeyTs: null,
        fileLength: null,
        waMessage: null,
        downloadState: "pending",
      });
      await markMediaPresent(pool, presentMsg, "/some/path");

      const results = await selectPendingMedia(pool, 100);
      const ids = results.map((r) => r.messageId);

      // Must include both pending messages
      expect(ids).toContain(older);
      expect(ids).toContain(newer);
      // Must NOT include the present message
      expect(ids).not.toContain(presentMsg);

      // Oldest-first ordering
      const olderIdx = ids.indexOf(older);
      const newerIdx = ids.indexOf(newer);
      expect(olderIdx).toBeLessThan(newerIdx);
    });

    it("respects the limit parameter", async () => {
      const groupId = await upsertGroup(pool, { name: "MM-select-limit-1", source: "import" });

      for (let i = 0; i < 4; i++) {
        const msgId = await seedMessage(groupId, {
          dedupeKey: `mm-lim-${i}-${Math.random()}`,
          sentAt: new Date(`2026-03-0${i + 1}T08:00:00.000Z`),
        });
        await upsertMessageMedia(pool, {
          messageId: msgId,
          mediaKind: "image",
          mimeType: null,
          mediaKey: null,
          directPath: null,
          url: null,
          fileEncSha256: null,
          fileSha256: null,
          mediaKeyTs: null,
          fileLength: null,
          waMessage: null,
          downloadState: "pending",
        });
      }

      const results = await selectPendingMedia(pool, 2);
      expect(results.length).toBeLessThanOrEqual(2);
    });
  });

  describe("markMediaUnrecoverable", () => {
    it("sets download_state=unrecoverable and last_error", async () => {
      const groupId = await upsertGroup(pool, { name: "MM-unrecov-1", source: "import" });
      const messageId = await seedMessage(groupId, { dedupeKey: "mm-unrecov-1" });

      await upsertMessageMedia(pool, {
        messageId,
        mediaKind: "document",
        mimeType: null,
        mediaKey: null,
        directPath: null,
        url: null,
        fileEncSha256: null,
        fileSha256: null,
        mediaKeyTs: null,
        fileLength: null,
        waMessage: null,
        downloadState: "pending",
      });

      await markMediaUnrecoverable(pool, messageId, "gone");

      const { rows } = await pool.query<{
        download_state: string;
        last_error: string;
      }>(`SELECT download_state, last_error FROM message_media WHERE message_id = $1`, [messageId]);
      expect(rows).toHaveLength(1);
      expect(rows[0].download_state).toBe("unrecoverable");
      expect(rows[0].last_error).toBe("gone");
    });
  });

  describe("markMediaPresent", () => {
    it("sets download_state=present and direct_path", async () => {
      const groupId = await upsertGroup(pool, { name: "MM-present-1", source: "import" });
      const messageId = await seedMessage(groupId, { dedupeKey: "mm-present-1" });

      await upsertMessageMedia(pool, {
        messageId,
        mediaKind: "image",
        mimeType: null,
        mediaKey: null,
        directPath: null,
        url: null,
        fileEncSha256: null,
        fileSha256: null,
        mediaKeyTs: null,
        fileLength: null,
        waMessage: null,
        downloadState: "pending",
      });

      await markMediaPresent(pool, messageId, "/new/path");

      const { rows } = await pool.query<{
        download_state: string;
        direct_path: string;
        last_error: string | null;
      }>(
        `SELECT download_state, direct_path, last_error FROM message_media WHERE message_id = $1`,
        [messageId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].download_state).toBe("present");
      expect(rows[0].direct_path).toBe("/new/path");
      expect(rows[0].last_error).toBeNull();
    });
  });

  describe("recordMediaAttempt", () => {
    it("increments attempts and sets last_error", async () => {
      const groupId = await upsertGroup(pool, { name: "MM-attempt-1", source: "import" });
      const messageId = await seedMessage(groupId, { dedupeKey: "mm-attempt-1" });

      await upsertMessageMedia(pool, {
        messageId,
        mediaKind: "audio",
        mimeType: null,
        mediaKey: null,
        directPath: null,
        url: null,
        fileEncSha256: null,
        fileSha256: null,
        mediaKeyTs: null,
        fileLength: null,
        waMessage: null,
        downloadState: "pending",
      });

      await recordMediaAttempt(pool, messageId, "timeout");
      await recordMediaAttempt(pool, messageId, "connection reset");

      const { rows } = await pool.query<{
        attempts: number;
        last_error: string;
      }>(`SELECT attempts, last_error FROM message_media WHERE message_id = $1`, [messageId]);
      expect(rows).toHaveLength(1);
      expect(rows[0].attempts).toBe(2);
      expect(rows[0].last_error).toBe("connection reset");
    });
  });

  describe("pruneMediaSecrets", () => {
    it("sets media_key, wa_message, direct_path, url to NULL and download_state=pruned", async () => {
      const groupId = await upsertGroup(pool, { name: "MM-prune-1", source: "import" });
      const messageId = await seedMessage(groupId, { dedupeKey: "mm-prune-1" });

      await upsertMessageMedia(pool, {
        messageId,
        mediaKind: "image",
        mimeType: "image/jpeg",
        mediaKey: Buffer.from("secretkey"),
        directPath: "/path/to/file",
        url: "https://example.com/media",
        fileEncSha256: null,
        fileSha256: null,
        mediaKeyTs: null,
        fileLength: null,
        waMessage: Buffer.from("wamessage"),
        downloadState: "present",
      });

      await pruneMediaSecrets(pool, messageId);

      const { rows } = await pool.query<{
        media_key: Buffer | null;
        wa_message: Buffer | null;
        direct_path: string | null;
        url: string | null;
        download_state: string;
      }>(
        `SELECT media_key, wa_message, direct_path, url, download_state
         FROM message_media WHERE message_id = $1`,
        [messageId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].media_key).toBeNull();
      expect(rows[0].wa_message).toBeNull();
      expect(rows[0].direct_path).toBeNull();
      expect(rows[0].url).toBeNull();
      expect(rows[0].download_state).toBe("pruned");
    });
  });

  describe("downgrade guard", () => {
    it("re-upsert with downloadState=pending must not downgrade a present row", async () => {
      const groupId = await upsertGroup(pool, { name: "MM-downgrade-1", source: "import" });
      const messageId = await seedMessage(groupId, { dedupeKey: "mm-downgrade-1" });

      // Insert pending
      await upsertMessageMedia(pool, {
        messageId,
        mediaKind: "image",
        mimeType: null,
        mediaKey: null,
        directPath: null,
        url: null,
        fileEncSha256: null,
        fileSha256: null,
        mediaKeyTs: null,
        fileLength: null,
        waMessage: null,
        downloadState: "pending",
      });

      // Mark as present
      await markMediaPresent(pool, messageId, "/downloaded/path");

      // Re-upsert with pending — simulates a re-pull
      await upsertMessageMedia(pool, {
        messageId,
        mediaKind: "image",
        mimeType: null,
        mediaKey: null,
        directPath: "/new/re-pull/path",
        url: null,
        fileEncSha256: null,
        fileSha256: null,
        mediaKeyTs: null,
        fileLength: null,
        waMessage: null,
        downloadState: "pending",
      });

      const { rows } = await pool.query<{ download_state: string }>(
        `SELECT download_state FROM message_media WHERE message_id = $1`,
        [messageId],
      );
      expect(rows).toHaveLength(1);
      // Must NOT be downgraded to pending
      expect(rows[0].download_state).toBe("present");
    });
  });
});
