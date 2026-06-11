import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NormalizedMessage } from "../../importer/types.js";
import { createTestDatabase } from "../../test/db.js";
import { listMeetings, listTodos, setTodoDone, upsertMeetings, upsertTodos } from "./agenda.js";
import { upsertGroup } from "./groups.js";
import { getMessageIdByExternalId, insertMessages } from "./messages.js";
import { upsertParticipant } from "./participants.js";
import { listPeople, refreshPeople } from "./people.js";

describe("agenda + people repositories", () => {
  let pool: pg.Pool;
  let groupId: number;
  let msgId: number;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
    groupId = await upsertGroup(pool, { name: "agenda-grp", source: "import" });
    const participantId = await upsertParticipant(pool, "דנה");
    const msg: NormalizedMessage & { participantId: number } = {
      groupId,
      importId: null,
      source: "import",
      senderName: "דנה",
      participantId,
      messageType: "text",
      textContent: "hi",
      mediaFilename: null,
      mediaPath: null,
      mediaStatus: null,
      sentAt: new Date(),
      dedupeKey: `ag-${Math.random()}`,
      externalId: "AG-MSG-1",
      fromMe: null,
    };
    await insertMessages(pool, [msg]);
    const found = await getMessageIdByExternalId(pool, groupId, "AG-MSG-1");
    msgId = found!.id;
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("upserts + lists meetings and todos, joined to the chat", async () => {
    await upsertMeetings(pool, [
      { title: "פגישה 14:00", owner: "דנה", groupId, sourceMessageId: msgId },
    ]);
    await upsertTodos(pool, [
      { title: "לשלוח דוח", owner: "דנה", groupId, sourceMessageId: msgId },
    ]);

    const meetings = await listMeetings(pool);
    expect(meetings.find((m) => m.title === "פגישה 14:00")?.chat).toBe("agenda-grp");
    const todos = await listTodos(pool);
    expect(todos.find((t) => t.title === "לשלוח דוח")).toMatchObject({ done: false, owner: "דנה" });
  });

  it("preserves done across re-extraction (a checked box is never reset)", async () => {
    const todo = (await listTodos(pool)).find((t) => t.sourceMessageId === msgId)!;
    expect(await setTodoDone(pool, todo.id, true)).toBe(true);
    // re-extract the same source → upsert must NOT reset done
    await upsertTodos(pool, [
      { title: "לשלוח דוח (עודכן)", owner: "דנה", groupId, sourceMessageId: msgId },
    ]);
    const after = (await listTodos(pool)).find((t) => t.sourceMessageId === msgId)!;
    expect(after.done).toBe(true);
    expect(after.title).toBe("לשלוח דוח (עודכן)");
  });

  it("derives a person from a todo owner with their next step + source", async () => {
    // un-done the todo so it counts as an open next-step
    const todo = (await listTodos(pool)).find((t) => t.sourceMessageId === msgId)!;
    await setTodoDone(pool, todo.id, false);
    await refreshPeople(pool);
    const dana = (await listPeople(pool)).find((p) => p.name === "דנה");
    expect(dana).toBeDefined();
    expect(dana?.nextStep).toContain("לשלוח דוח");
    expect(dana?.sourceMessageId).toBe(msgId);
    expect(dana?.chat).toBe("agenda-grp");
  });
});
