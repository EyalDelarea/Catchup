import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MediaDescriptor } from "../../collector/media-descriptor.js";
import type { NormalizedMessage } from "../../importer/types.js";
import { createTestDatabase } from "../../test/db.js";
import { upsertGroup } from "./groups.js";
import {
  descriptorToUpsertInput,
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
    it("pruned row is not modified by a subsequent upsert (Fix 1 — no secret resurrection)", async () => {
      const groupId = await upsertGroup(pool, { name: "MM-prune-resurrect-1", source: "import" });
      const messageId = await seedMessage(groupId, {
        dedupeKey: `mm-prune-resurrect-${Math.random()}`,
      });

      const key1 = Buffer.from("original-key");
      const blob1 = Buffer.from("original-blob");
      const key2 = Buffer.from("new-key-after-reprull");
      const blob2 = Buffer.from("new-blob-after-reprull");

      // Step 1: insert as 'present' with real secrets
      await upsertMessageMedia(pool, {
        messageId,
        mediaKind: "image",
        mimeType: "image/jpeg",
        mediaKey: key1,
        directPath: "/path/original",
        url: "https://example.com/original",
        fileEncSha256: null,
        fileSha256: null,
        mediaKeyTs: null,
        fileLength: null,
        waMessage: blob1,
        downloadState: "present",
      });

      // Step 2: prune the secrets
      await pruneMediaSecrets(pool, messageId);

      // Step 3: re-pull upsert with fresh non-null secrets — must be ignored
      await upsertMessageMedia(pool, {
        messageId,
        mediaKind: "image",
        mimeType: "image/jpeg",
        mediaKey: key2,
        directPath: "/path/reprull",
        url: "https://example.com/reprull",
        fileEncSha256: null,
        fileSha256: null,
        mediaKeyTs: null,
        fileLength: null,
        waMessage: blob2,
        downloadState: "pending",
      });

      const { rows } = await pool.query<{
        media_key: Buffer | null;
        wa_message: Buffer | null;
        download_state: string;
      }>(`SELECT media_key, wa_message, download_state FROM message_media WHERE message_id = $1`, [
        messageId,
      ]);
      expect(rows).toHaveLength(1);
      // Secrets must remain nulled — not resurrected
      expect(rows[0].media_key).toBeNull();
      expect(rows[0].wa_message).toBeNull();
      // State must remain pruned — not reset to pending
      expect(rows[0].download_state).toBe("pruned");
    });

    it("volatile fields use COALESCE: null incoming does not overwrite existing, but non-null refreshes (Fix 7)", async () => {
      const groupId = await upsertGroup(pool, { name: "MM-volatile-coalesce-1", source: "import" });
      const messageId = await seedMessage(groupId, {
        dedupeKey: `mm-volatile-coalesce-${Math.random()}`,
      });

      // First upsert: set directPath and mimeType
      await upsertMessageMedia(pool, {
        messageId,
        mediaKind: "image",
        mimeType: "image/jpeg",
        mediaKey: null,
        directPath: "/p1",
        url: "https://example.com/p1",
        fileEncSha256: null,
        fileSha256: null,
        mediaKeyTs: null,
        fileLength: 1000,
        waMessage: null,
        downloadState: "pending",
      });

      // Second upsert: null volatile fields — must NOT overwrite existing values
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

      const { rows: rows2 } = await pool.query<{
        direct_path: string | null;
        mime_type: string | null;
        url: string | null;
        file_length: number | null;
      }>(
        `SELECT direct_path, mime_type, url, file_length FROM message_media WHERE message_id = $1`,
        [messageId],
      );
      expect(rows2).toHaveLength(1);
      // Null incoming must not clobber existing values
      expect(rows2[0].direct_path).toBe("/p1");
      expect(rows2[0].mime_type).toBe("image/jpeg");
      expect(rows2[0].url).toBe("https://example.com/p1");
      // file_length may be returned as string by the pg driver (BIGINT → string)
      expect(Number(rows2[0].file_length)).toBe(1000);

      // Third upsert: non-null directPath — must refresh
      await upsertMessageMedia(pool, {
        messageId,
        mediaKind: "image",
        mimeType: null,
        mediaKey: null,
        directPath: "/p2",
        url: null,
        fileEncSha256: null,
        fileSha256: null,
        mediaKeyTs: null,
        fileLength: null,
        waMessage: null,
        downloadState: "pending",
      });

      const { rows: rows3 } = await pool.query<{ direct_path: string | null }>(
        `SELECT direct_path FROM message_media WHERE message_id = $1`,
        [messageId],
      );
      expect(rows3).toHaveLength(1);
      // Non-null incoming must refresh
      expect(rows3[0].direct_path).toBe("/p2");
    });

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

    it("excludes pending rows that have reached the maxAttempts cap (default=5)", async () => {
      const groupId = await upsertGroup(pool, { name: "MM-select-cap-1", source: "import" });

      const capMsg = await seedMessage(groupId, {
        dedupeKey: `mm-cap-exhausted-${Math.random()}`,
        sentAt: new Date("2026-04-01T08:00:00.000Z"),
      });
      const okMsg = await seedMessage(groupId, {
        dedupeKey: `mm-cap-ok-${Math.random()}`,
        sentAt: new Date("2026-04-02T08:00:00.000Z"),
      });

      // Both rows start pending
      for (const msgId of [capMsg, okMsg]) {
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

      // Exhaust the cap for capMsg (5 attempts = at the default cap)
      await pool.query(`UPDATE message_media SET attempts = 5 WHERE message_id = $1`, [capMsg]);

      const results = await selectPendingMedia(pool, 100);
      const ids = results.map((r) => r.messageId);

      expect(ids).not.toContain(capMsg); // exhausted — must be excluded
      expect(ids).toContain(okMsg); // under cap — must be included
    });

    it("excludes pending rows that have reached a custom maxAttempts cap", async () => {
      const groupId = await upsertGroup(pool, { name: "MM-select-cap-custom-1", source: "import" });

      const capMsg = await seedMessage(groupId, {
        dedupeKey: `mm-cap-custom-exhausted-${Math.random()}`,
        sentAt: new Date("2026-04-03T08:00:00.000Z"),
      });
      const okMsg = await seedMessage(groupId, {
        dedupeKey: `mm-cap-custom-ok-${Math.random()}`,
        sentAt: new Date("2026-04-04T08:00:00.000Z"),
      });

      for (const msgId of [capMsg, okMsg]) {
        await upsertMessageMedia(pool, {
          messageId: msgId,
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
      }

      // Set capMsg to exactly 3 attempts and use cap=3 → should be excluded
      await pool.query(`UPDATE message_media SET attempts = 3 WHERE message_id = $1`, [capMsg]);

      const results = await selectPendingMedia(pool, 100, 3);
      const ids = results.map((r) => r.messageId);

      expect(ids).not.toContain(capMsg);
      expect(ids).toContain(okMsg);
    });

    it("excludes pending rows with non-analyzable media kinds (sticker, document)", async () => {
      const groupId = await upsertGroup(pool, { name: "MM-select-kind-1", source: "import" });

      const stickerMsg = await seedMessage(groupId, {
        dedupeKey: `mm-kind-sticker-${Math.random()}`,
        sentAt: new Date("2026-05-01T08:00:00.000Z"),
      });
      const documentMsg = await seedMessage(groupId, {
        dedupeKey: `mm-kind-document-${Math.random()}`,
        sentAt: new Date("2026-05-02T08:00:00.000Z"),
      });
      const audioMsg = await seedMessage(groupId, {
        dedupeKey: `mm-kind-audio-${Math.random()}`,
        sentAt: new Date("2026-05-03T08:00:00.000Z"),
      });

      await upsertMessageMedia(pool, {
        messageId: stickerMsg,
        mediaKind: "sticker",
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
        messageId: documentMsg,
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
      await upsertMessageMedia(pool, {
        messageId: audioMsg,
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

      const results = await selectPendingMedia(pool, 100);
      const ids = results.map((r) => r.messageId);

      expect(ids).not.toContain(stickerMsg); // non-analyzable — excluded
      expect(ids).not.toContain(documentMsg); // non-analyzable — excluded
      expect(ids).toContain(audioMsg); // analyzable — included
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

    it("is a safe no-op when download_state is still pending (guard against stranding)", async () => {
      const groupId = await upsertGroup(pool, { name: "MM-prune-guard-1", source: "import" });
      const messageId = await seedMessage(groupId, { dedupeKey: "mm-prune-guard-1" });

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
        downloadState: "pending",
      });

      // pruneMediaSecrets on a pending row must be a no-op
      await pruneMediaSecrets(pool, messageId);

      const { rows } = await pool.query<{
        media_key: Buffer | null;
        download_state: string;
      }>(`SELECT media_key, download_state FROM message_media WHERE message_id = $1`, [messageId]);
      expect(rows).toHaveLength(1);
      // Row must be completely unchanged
      expect(rows[0].download_state).toBe("pending");
      expect(rows[0].media_key).not.toBeNull();
    });
  });

  describe("descriptorToUpsertInput", () => {
    it("coerces Uint8Array fields to Buffer and passes through scalar fields", () => {
      const descriptor: MediaDescriptor = {
        mediaKind: "image",
        mimeType: "image/jpeg",
        mediaKey: new Uint8Array([1, 2, 3]),
        directPath: "/path/to/media",
        url: "https://example.com/media.jpg",
        fileEncSha256: new Uint8Array([4, 5, 6]),
        fileSha256: new Uint8Array([7, 8, 9]),
        mediaKeyTs: 1700000000,
        fileLength: 12345,
        waMessage: new Uint8Array([10, 11, 12]),
      };

      const result = descriptorToUpsertInput(42, descriptor, "pending");

      expect(result.messageId).toBe(42);
      expect(result.mediaKind).toBe("image");
      expect(result.mimeType).toBe("image/jpeg");
      expect(result.mediaKey).toBeInstanceOf(Buffer);
      expect(result.mediaKey!.equals(Buffer.from([1, 2, 3]))).toBe(true);
      expect(result.directPath).toBe("/path/to/media");
      expect(result.url).toBe("https://example.com/media.jpg");
      expect(result.fileEncSha256).toBeInstanceOf(Buffer);
      expect(result.fileEncSha256!.equals(Buffer.from([4, 5, 6]))).toBe(true);
      expect(result.fileSha256).toBeInstanceOf(Buffer);
      expect(result.fileSha256!.equals(Buffer.from([7, 8, 9]))).toBe(true);
      expect(result.mediaKeyTs).toBe(1700000000);
      expect(result.fileLength).toBe(12345);
      expect(result.waMessage).toBeInstanceOf(Buffer);
      expect(result.waMessage!.equals(Buffer.from([10, 11, 12]))).toBe(true);
      expect(result.downloadState).toBe("pending");
    });

    it("coerces null Uint8Array fields to null and passes state through", () => {
      const descriptor: MediaDescriptor = {
        mediaKind: "audio",
        mimeType: null,
        mediaKey: null,
        directPath: null,
        url: null,
        fileEncSha256: null,
        fileSha256: null,
        mediaKeyTs: null,
        fileLength: null,
        waMessage: new Uint8Array([1]),
      };

      const result = descriptorToUpsertInput(99, descriptor, "present");

      expect(result.messageId).toBe(99);
      expect(result.mediaKey).toBeNull();
      expect(result.fileEncSha256).toBeNull();
      expect(result.fileSha256).toBeNull();
      expect(result.downloadState).toBe("present");
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
