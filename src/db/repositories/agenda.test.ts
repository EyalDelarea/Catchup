import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NormalizedMessage } from "../../importer/types.js";
import { createTestDatabase } from "../../test/db.js";
import { listMeetings, listTodos, setTodoDone, upsertMeetings, upsertTodos } from "./agenda.js";
import { upsertScope } from "./chat-scopes.js";
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
    // Default-off scoping: People only derives from included chats.
    await upsertScope(pool, { groupId, included: true });
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

  // ── Broadened, scope-aware People derivation ─────────────────────────
  async function seedMsg(gid: number, name: string, key: string): Promise<void> {
    const pid = await upsertParticipant(pool, name);
    await insertMessages(pool, [
      {
        groupId: gid,
        importId: null,
        source: "import",
        senderName: name,
        participantId: pid,
        messageType: "text",
        textContent: "hi",
        mediaFilename: null,
        mediaPath: null,
        mediaStatus: null,
        sentAt: new Date(),
        dedupeKey: key,
        externalId: null,
        fromMe: null,
      } as NormalizedMessage & { participantId: number },
    ]);
  }

  it("derives a 1:1 counterpart from an included chat even without a todo", async () => {
    const dm = await upsertGroup(pool, { name: "dm-roni", source: "import" });
    await seedMsg(dm, "רוני", `dm-${Math.random()}`);
    await upsertScope(pool, { groupId: dm, included: true });
    await refreshPeople(pool);
    const roni = (await listPeople(pool)).find((p) => p.name === "רוני");
    expect(roni).toBeDefined();
    expect(roni?.nextStep ?? null).toBeNull(); // no todo → no next step, still listed
  });

  it("does not derive people from un-selected (un-scoped) chats", async () => {
    const dm = await upsertGroup(pool, { name: "dm-noam", source: "import" });
    await seedMsg(dm, "נועם", `dm-${Math.random()}`); // no scope row → excluded (default-off)
    await refreshPeople(pool);
    expect((await listPeople(pool)).find((p) => p.name === "נועם")).toBeUndefined();
  });

  it("does not flood with plain group members (not 1:1, not an owner)", async () => {
    const grp = await upsertGroup(pool, { name: "grp-team", source: "import" });
    await seedMsg(grp, "אורי", `g-${Math.random()}`);
    await seedMsg(grp, "גל", `g-${Math.random()}`); // two non-self participants → a group, not a DM
    await upsertScope(pool, { groupId: grp, included: true });
    await refreshPeople(pool);
    const names = (await listPeople(pool)).map((p) => p.name);
    expect(names).not.toContain("אורי");
    expect(names).not.toContain("גל");
  });
});
