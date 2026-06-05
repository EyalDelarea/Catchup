import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NormalizedMessage } from "../../importer/types.js";
import { createTestDatabase } from "../../test/db.js";
import {
  isDisplayNameUnresolved,
  listGroups,
  listUnresolvedGroups,
  updateDisplayName,
  upsertGroup,
  upsertGroupByWhatsappId,
} from "./groups.js";
import { insertMessages } from "./messages.js";

function makeMsg(
  groupId: number,
  dedupeKey: string,
  sentAt: Date,
  overrides: Partial<NormalizedMessage> = {},
): NormalizedMessage & { participantId: number | null } {
  return {
    groupId,
    importId: null,
    source: "import",
    senderName: "Alice",
    messageType: "text",
    textContent: "Hello",
    mediaFilename: null,
    mediaPath: null,
    mediaStatus: null,
    externalId: null,
    sentAt,
    dedupeKey,
    participantId: null,
    ...overrides,
  };
}

describe("listGroups — lastMessageAt (T015)", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("returns lastMessageAt as the newest message's sent_at", async () => {
    const groupId = await upsertGroup(pool, { name: "LMA-group-a", source: "import" });

    const older = new Date("2026-01-01T09:00:00Z");
    const newer = new Date("2026-01-02T15:30:00Z");

    await insertMessages(pool, [
      makeMsg(groupId, "lma-a-001", older),
      makeMsg(groupId, "lma-a-002", newer),
    ]);

    const groups = await listGroups(pool);
    const g = groups.find((x) => x.name === "LMA-group-a");
    expect(g).toBeDefined();
    expect(g!.lastMessageAt).not.toBeNull();
    // Compare via ISO string to avoid timezone noise
    expect(g!.lastMessageAt!.toISOString()).toBe(newer.toISOString());
  });

  it("returns lastMessageAt as null for a group with no messages", async () => {
    await upsertGroup(pool, { name: "LMA-empty-group", source: "import" });
    const groups = await listGroups(pool);
    const g = groups.find((x) => x.name === "LMA-empty-group");
    expect(g).toBeDefined();
    expect(g!.lastMessageAt).toBeNull();
  });

  it("existing fields (name, source, messageCount) remain intact (backward-compat)", async () => {
    const groupId = await upsertGroup(pool, { name: "LMA-compat-group", source: "import" });
    await insertMessages(pool, [
      makeMsg(groupId, "lma-compat-001", new Date("2026-03-01T10:00:00Z")),
      makeMsg(groupId, "lma-compat-002", new Date("2026-03-02T10:00:00Z")),
    ]);
    const groups = await listGroups(pool);
    const g = groups.find((x) => x.name === "LMA-compat-group");
    expect(g).toBeDefined();
    expect(g!.source).toBe("import");
    expect(g!.messageCount).toBe(2);
    // lastMessageAt should also be present
    expect(g!.lastMessageAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T019 — updateDisplayName + isDisplayNameUnresolved
// ---------------------------------------------------------------------------

describe("updateDisplayName + isDisplayNameUnresolved (T019)", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("updateDisplayName returns true and renames when name == whatsapp_id (still the raw JID)", async () => {
    const jid = "dn-test-001@g.us";
    await upsertGroupByWhatsappId(pool, { whatsappId: jid, name: jid, source: "live" });

    const result = await updateDisplayName(pool, jid, "My Group");

    expect(result).toBe(true);

    const { rows } = await pool.query(`SELECT name FROM groups WHERE whatsapp_id = $1`, [jid]);
    expect(rows[0].name).toBe("My Group");
  });

  it("updateDisplayName returns false (no-op) when name was already changed from the JID", async () => {
    const jid = "dn-test-002@g.us";
    await upsertGroupByWhatsappId(pool, { whatsappId: jid, name: jid, source: "live" });
    // Rename it first
    await updateDisplayName(pool, jid, "Already Named");

    // Second call with a different name should be a no-op
    const result = await updateDisplayName(pool, jid, "Should Not Apply");

    expect(result).toBe(false);

    // Name should remain "Already Named"
    const { rows } = await pool.query(`SELECT name FROM groups WHERE whatsapp_id = $1`, [jid]);
    expect(rows[0].name).toBe("Already Named");
  });

  it("updateDisplayName round-trips: stored name equals the new display name after update", async () => {
    const jid = "dn-test-003@g.us";
    await upsertGroupByWhatsappId(pool, { whatsappId: jid, name: jid, source: "live" });

    await updateDisplayName(pool, jid, "Round-Trip Name");

    const { rows } = await pool.query(`SELECT name FROM groups WHERE whatsapp_id = $1`, [jid]);
    expect(rows[0].name).toBe("Round-Trip Name");
  });

  it("isDisplayNameUnresolved returns true when name == whatsapp_id (still the raw JID)", async () => {
    const jid = "dn-unresolved-001@g.us";
    await upsertGroupByWhatsappId(pool, { whatsappId: jid, name: jid, source: "live" });

    const unresolved = await isDisplayNameUnresolved(pool, jid);
    expect(unresolved).toBe(true);
  });

  it("isDisplayNameUnresolved returns false after the name has been changed from the JID", async () => {
    const jid = "dn-unresolved-002@g.us";
    await upsertGroupByWhatsappId(pool, { whatsappId: jid, name: jid, source: "live" });
    await updateDisplayName(pool, jid, "Resolved Name");

    const unresolved = await isDisplayNameUnresolved(pool, jid);
    expect(unresolved).toBe(false);
  });

  it("isDisplayNameUnresolved returns false when the group does not exist", async () => {
    const unresolved = await isDisplayNameUnresolved(pool, "nonexistent@g.us");
    expect(unresolved).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listUnresolvedGroups
// ---------------------------------------------------------------------------

describe("listUnresolvedGroups", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("returns only groups where name == whatsapp_id (unresolved)", async () => {
    const jidA = "lu-unresolved-a@g.us";
    const jidB = "lu-unresolved-b@lid";
    const jidC = "lu-resolved-c@g.us";

    await upsertGroupByWhatsappId(pool, { whatsappId: jidA, name: jidA, source: "live" });
    await upsertGroupByWhatsappId(pool, { whatsappId: jidB, name: jidB, source: "live" });
    await upsertGroupByWhatsappId(pool, { whatsappId: jidC, name: jidC, source: "live" });
    // Resolve jidC so it is excluded
    await updateDisplayName(pool, jidC, "Already Named");

    const unresolved = await listUnresolvedGroups(pool);
    const jids = unresolved.map((r) => r.whatsappId);

    expect(jids).toContain(jidA);
    expect(jids).toContain(jidB);
    expect(jids).not.toContain(jidC);
  });

  it("returns empty array when all groups are resolved", async () => {
    const jid = "lu-all-resolved@g.us";
    await upsertGroupByWhatsappId(pool, { whatsappId: jid, name: jid, source: "live" });
    await updateDisplayName(pool, jid, "Named Group");

    // Only check that this jid is not included (other tests may have unresolved groups)
    const unresolved = await listUnresolvedGroups(pool);
    const jids = unresolved.map((r) => r.whatsappId);
    expect(jids).not.toContain(jid);
  });

  it("returns the id and whatsappId for each unresolved group", async () => {
    const jid = "lu-fields-check@lid";
    await upsertGroupByWhatsappId(pool, { whatsappId: jid, name: jid, source: "live" });

    const unresolved = await listUnresolvedGroups(pool);
    const entry = unresolved.find((r) => r.whatsappId === jid);
    expect(entry).toBeDefined();
    expect(typeof entry!.id).toBe("number");
    expect(entry!.whatsappId).toBe(jid);
  });
});
