import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertGroup } from "../db/repositories/groups.js";
import { insertMessages } from "../db/repositories/messages.js";
import { upsertParticipant } from "../db/repositories/participants.js";
import type { NormalizedMessage } from "../importer/types.js";
import { createTestDatabase } from "../test/db.js";
import { selectActiveGroups } from "./select-active-groups.js";

describe("selectActiveGroups", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  async function seed(groupId: number, sentAt: Date, dedupeKey: string, text = "hi") {
    const participantId = await upsertParticipant(pool, "Dana");
    const row: NormalizedMessage & { participantId: number | null } = {
      groupId,
      importId: null,
      source: "import",
      senderName: "Dana",
      messageType: "text",
      textContent: text,
      mediaFilename: null,
      mediaPath: null,
      mediaStatus: null,
      externalId: null,
      participantId,
      dedupeKey,
      sentAt,
    };
    await insertMessages(pool, [row]);
  }

  it("returns only chats with content in the range, ordered by name", async () => {
    const work = await upsertGroup(pool, { name: "Work", source: "import" });
    const family = await upsertGroup(pool, { name: "Family", source: "import" });
    const old = await upsertGroup(pool, { name: "Old", source: "import" });

    const since = new Date("2026-06-06T00:00:00.000Z");
    await seed(work, new Date("2026-06-06T09:00:00.000Z"), "w1");
    await seed(family, new Date("2026-06-06T10:00:00.000Z"), "f1");
    await seed(old, new Date("2026-06-01T10:00:00.000Z"), "o1"); // before `since` → excluded

    const groups = await selectActiveGroups(pool, { since });
    expect(groups.map((g) => g.name)).toEqual(["Family", "Work"]);
  });

  it("excludes chats whose only in-range messages are system/empty", async () => {
    const since = new Date("2026-06-06T00:00:00.000Z");
    const sys = await upsertGroup(pool, { name: "SystemOnly", source: "import" });
    const participantId = await upsertParticipant(pool, "Dana");
    await insertMessages(pool, [
      {
        groupId: sys,
        importId: null,
        source: "import",
        senderName: "Dana",
        messageType: "system",
        textContent: "joined",
        mediaFilename: null,
        mediaPath: null,
        mediaStatus: null,
        externalId: null,
        participantId,
        dedupeKey: "s1",
        sentAt: new Date("2026-06-06T11:00:00.000Z"),
      },
    ]);
    const groups = await selectActiveGroups(pool, { since });
    expect(groups.find((g) => g.name === "SystemOnly")).toBeUndefined();
  });
});
