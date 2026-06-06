/**
 * Tests for pruneMediaFile (src/media/prune.ts).
 *
 * Uses @testcontainers/postgresql so we exercise real SQL.
 * File I/O is exercised via real temp files created within the test.
 * The `unlink` dep is injectable so we can also test the no-ENOENT path
 * without touching disk.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertGroup } from "../db/repositories/groups.js";
import { insertMessages } from "../db/repositories/messages.js";
import type { NormalizedMessage } from "../importer/types.js";
import { createTestDatabase } from "../test/db.js";
import { pruneMediaFile } from "./prune.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMediaMsg(
  overrides: Partial<NormalizedMessage> = {},
): NormalizedMessage & { participantId: null } {
  return {
    groupId: 0,
    importId: null,
    source: "import" as const,
    senderName: null,
    messageType: "media" as const,
    textContent: null,
    mediaFilename: "voice.opus",
    mediaPath: "/tmp/placeholder.opus",
    mediaStatus: "present" as const,
    sentAt: new Date("2026-01-01T10:00:00Z"),
    dedupeKey: `prune-test-${Math.random()}`,
    externalId: null,
    fromMe: null,
    participantId: null,
    ...overrides,
  };
}

async function insertMediaMessage(
  pool: pg.Pool,
  groupId: number,
  mediaPath: string,
  dedupeKey?: string,
): Promise<number> {
  const result = await insertMessages(pool, [
    makeMediaMsg({ groupId, mediaPath, dedupeKey: dedupeKey ?? `prune-msg-${Math.random()}` }),
  ]);
  return result.ids[0]!;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("pruneMediaFile", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  // -------------------------------------------------------------------------
  // Core prune behaviour
  // -------------------------------------------------------------------------

  it("deletes the file, sets media_status='pruned', and clears media_path", async () => {
    const groupId = await upsertGroup(pool, { name: "prune-core-group", source: "import" });

    // Create a real temp file on disk
    const tmpFile = path.join(os.tmpdir(), `prune-test-${Date.now()}.opus`);
    fs.writeFileSync(tmpFile, "fake audio data");
    expect(fs.existsSync(tmpFile)).toBe(true);

    const messageId = await insertMediaMessage(pool, groupId, tmpFile, "prune-core-001");

    await pruneMediaFile(pool, messageId, { retainMedia: false });

    // File should be gone
    expect(fs.existsSync(tmpFile)).toBe(false);

    // DB should reflect pruned state
    const { rows } = await pool.query(
      `SELECT media_status, media_path FROM messages WHERE id = $1`,
      [messageId],
    );
    expect(rows[0]?.media_status).toBe("pruned");
    expect(rows[0]?.media_path).toBeNull();
  });

  it("is idempotent: calling prune on an already-pruned row does not throw", async () => {
    const groupId = await upsertGroup(pool, { name: "prune-idempotent-group", source: "import" });
    const messageId = await insertMediaMessage(
      pool,
      groupId,
      "/tmp/already-gone.opus",
      "prune-idempotent-001",
    );

    // Manually set to pruned state (simulating a prior prune)
    await pool.query(
      `UPDATE messages SET media_status = 'pruned', media_path = NULL WHERE id = $1`,
      [messageId],
    );

    // Calling again should not throw
    await expect(pruneMediaFile(pool, messageId, { retainMedia: false })).resolves.not.toThrow();

    // State stays pruned
    const { rows } = await pool.query(
      `SELECT media_status, media_path FROM messages WHERE id = $1`,
      [messageId],
    );
    expect(rows[0]?.media_status).toBe("pruned");
  });

  // -------------------------------------------------------------------------
  // ENOENT: missing file on disk still marks pruned (no throw)
  // -------------------------------------------------------------------------

  it("marks status 'pruned' even when the file is already missing (ENOENT), without throwing", async () => {
    const groupId = await upsertGroup(pool, { name: "prune-enoent-group", source: "import" });
    const messageId = await insertMediaMessage(
      pool,
      groupId,
      "/tmp/definitely-not-there-xyzzy.opus",
      "prune-enoent-001",
    );

    // Should not throw (ENOENT is swallowed)
    await expect(pruneMediaFile(pool, messageId, { retainMedia: false })).resolves.not.toThrow();

    // DB should be updated
    const { rows } = await pool.query(
      `SELECT media_status, media_path FROM messages WHERE id = $1`,
      [messageId],
    );
    expect(rows[0]?.media_status).toBe("pruned");
    expect(rows[0]?.media_path).toBeNull();
  });

  // -------------------------------------------------------------------------
  // retainMedia=true: no-op
  // -------------------------------------------------------------------------

  it("does NOT delete file and leaves status 'present' when retainMedia=true", async () => {
    const groupId = await upsertGroup(pool, { name: "prune-retain-group", source: "import" });

    const tmpFile = path.join(os.tmpdir(), `prune-retain-${Date.now()}.opus`);
    fs.writeFileSync(tmpFile, "keep me");

    const messageId = await insertMediaMessage(pool, groupId, tmpFile, "prune-retain-001");

    await pruneMediaFile(pool, messageId, { retainMedia: true });

    // File should still exist
    expect(fs.existsSync(tmpFile)).toBe(true);
    fs.unlinkSync(tmpFile); // cleanup

    // DB status unchanged
    const { rows } = await pool.query(
      `SELECT media_status, media_path FROM messages WHERE id = $1`,
      [messageId],
    );
    expect(rows[0]?.media_status).toBe("present");
    expect(rows[0]?.media_path).toBe(tmpFile);
  });

  // -------------------------------------------------------------------------
  // Injectable unlink (hermetic test — no real FS)
  // -------------------------------------------------------------------------

  it("calls the injected unlink with the media_path and updates DB", async () => {
    const groupId = await upsertGroup(pool, { name: "prune-inject-group", source: "import" });
    const fakeFile = "/injected/fake/path/audio.opus";
    const messageId = await insertMediaMessage(pool, groupId, fakeFile, "prune-inject-001");

    const unlinkedPaths: string[] = [];
    const fakeUnlink = (p: string) => {
      unlinkedPaths.push(p);
    };

    await pruneMediaFile(pool, messageId, { retainMedia: false, unlink: fakeUnlink });

    expect(unlinkedPaths).toEqual([fakeFile]);

    const { rows } = await pool.query(
      `SELECT media_status, media_path FROM messages WHERE id = $1`,
      [messageId],
    );
    expect(rows[0]?.media_status).toBe("pruned");
    expect(rows[0]?.media_path).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Prune failure (unlink throws non-ENOENT): marks pruned, does NOT re-throw
  // -------------------------------------------------------------------------

  it("marks status 'pruned' even when unlink throws a non-ENOENT error (best-effort FS)", async () => {
    const groupId = await upsertGroup(pool, { name: "prune-unlink-err-group", source: "import" });
    const messageId = await insertMediaMessage(
      pool,
      groupId,
      "/tmp/perm-denied.opus",
      "prune-unlink-err-001",
    );

    const failingUnlink = (_p: string) => {
      const err = new Error("EACCES: permission denied");
      (err as NodeJS.ErrnoException).code = "EACCES";
      throw err;
    };

    // Must NOT throw even though unlink failed
    await expect(
      pruneMediaFile(pool, messageId, { retainMedia: false, unlink: failingUnlink }),
    ).resolves.not.toThrow();

    // DB must still be updated to pruned
    const { rows } = await pool.query(
      `SELECT media_status, media_path FROM messages WHERE id = $1`,
      [messageId],
    );
    expect(rows[0]?.media_status).toBe("pruned");
    expect(rows[0]?.media_path).toBeNull();
  });
});
