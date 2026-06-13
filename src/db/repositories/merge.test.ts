import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test/db.js";
import { listMeetings, listTodos, setTodoDone, upsertMeetings, upsertTodos } from "./agenda.js";
import { upsertGroupByWhatsappId } from "./groups.js";
import { mergeGroups } from "./merge.js";
import { upsertParticipant } from "./participants.js";

describe("mergeGroups", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  async function insertMsg(
    groupId: number,
    participantId: number,
    dedupeKey: string,
    externalId: string | null,
  ) {
    await pool.query(
      `INSERT INTO messages
         (group_id, participant_id, import_id, source, external_id, message_type,
          text_content, media_filename, media_path, media_status, sent_at, dedupe_key, from_me)
       VALUES ($1,$2,NULL,'live',$3,'text','hi',NULL,NULL,NULL,NOW(),$4,false)`,
      [groupId, participantId, externalId, dedupeKey],
    );
  }

  async function msgId(groupId: number, dedupeKey: string): Promise<number> {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM messages WHERE group_id = $1 AND dedupe_key = $2`,
      [groupId, dedupeKey],
    );
    return Number(rows[0].id);
  }

  it("moves non-colliding messages, drops collisions, deletes dup, names survivor", async () => {
    const survivorJid = "972502028299-merge@s.whatsapp.net";
    const dupJid = "70390252580989-merge@lid";
    const survivorId = await upsertGroupByWhatsappId(pool, {
      whatsappId: survivorJid,
      name: survivorJid, // unnamed phone chat
      source: "live",
    });
    const dupId = await upsertGroupByWhatsappId(pool, {
      whatsappId: dupJid,
      name: dupJid,
      source: "live",
    });
    await pool.query(`UPDATE groups SET name = 'Bar Hevr Merge' WHERE id = $1`, [dupId]);

    const p = await upsertParticipant(pool, "Merge Sender");

    // survivor has a1, a2
    await insertMsg(survivorId, p, "merge-a1", "EXT-A1");
    await insertMsg(survivorId, p, "merge-a2", "EXT-A2");
    // dup has a1 (collision by dedupe_key) and b1 (unique)
    await insertMsg(dupId, p, "merge-a1", "EXT-DUP-A1");
    await insertMsg(dupId, p, "merge-b1", "EXT-B1");

    const result = await mergeGroups(pool, { survivorId, dupId, name: "Bar Hevr Merge" });

    expect(result.movedMessages).toBe(1); // only b1 moved
    expect(result.deletedDuplicateMessages).toBe(1); // a1 collision dropped

    // survivor now has a1, a2, b1
    const { rows: survRows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM messages WHERE group_id = $1`,
      [survivorId],
    );
    expect(survRows[0].n).toBe(3);

    // dup group is gone
    const { rows: dupRows } = await pool.query(`SELECT 1 FROM groups WHERE id = $1`, [dupId]);
    expect(dupRows.length).toBe(0);

    // survivor is named
    const { rows: nameRows } = await pool.query(`SELECT name FROM groups WHERE id = $1`, [
      survivorId,
    ]);
    expect(nameRows[0].name).toBe("Bar Hevr Merge");
  });

  // ── DATA-6: agenda rows hang off messages by FK ON DELETE CASCADE ────────
  // A colliding dup message is DELETEd in mergeGroups; without rescue, its todo
  // (even one the user already checked off) + meeting cascade-delete silently.
  it("rescues a checked-off todo + meeting off a colliding message onto the survivor", async () => {
    const survivorJid = "972502028299-data6@s.whatsapp.net";
    const dupJid = "70390252580989-data6@lid";
    const survivorId = await upsertGroupByWhatsappId(pool, {
      whatsappId: survivorJid,
      name: survivorJid,
      source: "live",
    });
    const dupId = await upsertGroupByWhatsappId(pool, {
      whatsappId: dupJid,
      name: dupJid,
      source: "live",
    });
    await pool.query(`UPDATE groups SET name = 'Dana DATA-6' WHERE id = $1`, [dupId]);

    const p = await upsertParticipant(pool, "DATA-6 Sender");

    // The same logical message ingested under both identities → collides on
    // dedupe_key, so the dup copy is the one mergeGroups deletes (not moves).
    await insertMsg(survivorId, p, "data6-shared", "EXT-SURV");
    await insertMsg(dupId, p, "data6-shared", "EXT-DUP");
    const survMsgId = await msgId(survivorId, "data6-shared");
    const dupMsgId = await msgId(dupId, "data6-shared");

    // The dup's (doomed) message carries the user's checked-off todo + a meeting.
    await upsertTodos(pool, [
      { title: "לסיים דוח", owner: "דנה", groupId: dupId, sourceMessageId: dupMsgId },
    ]);
    await upsertMeetings(pool, [
      { title: "סטנדאפ 09:00", owner: "דנה", groupId: dupId, sourceMessageId: dupMsgId },
    ]);
    const todo = (await listTodos(pool)).find((t) => t.sourceMessageId === dupMsgId);
    expect(await setTodoDone(pool, todo!.id, true)).toBe(true);

    const result = await mergeGroups(pool, { survivorId, dupId, name: "Dana DATA-6" });
    expect(result.repointedTodos).toBe(1);
    expect(result.repointedMeetings).toBe(1);

    // The colliding dup message is gone...
    const { rows: gone } = await pool.query(`SELECT 1 FROM messages WHERE id = $1`, [dupMsgId]);
    expect(gone.length).toBe(0);

    // ...but the checked-off todo survived, re-pointed onto the survivor message.
    const survivedTodo = (await listTodos(pool)).find((t) => t.title === "לסיים דוח");
    expect(survivedTodo).toBeDefined();
    expect(survivedTodo?.done).toBe(true);
    expect(survivedTodo?.sourceMessageId).toBe(survMsgId);

    // ...and so did the meeting.
    const survivedMeeting = (await listMeetings(pool)).find((m) => m.title === "סטנדאפ 09:00");
    expect(survivedMeeting).toBeDefined();
    expect(survivedMeeting?.sourceMessageId).toBe(survMsgId);
  });

  // When the survivor message ALSO carries the same todo, the (tenant_id,
  // source_message_id) unique index means we can't repoint onto it — the merge
  // must still succeed, keep one row, and never reset the user's checked box.
  it("on a todo collision keeps one row and never resets the checked box", async () => {
    const survivorJid = "972502028300-data6c@s.whatsapp.net";
    const dupJid = "70390252580990-data6c@lid";
    const survivorId = await upsertGroupByWhatsappId(pool, {
      whatsappId: survivorJid,
      name: survivorJid,
      source: "live",
    });
    const dupId = await upsertGroupByWhatsappId(pool, {
      whatsappId: dupJid,
      name: dupJid,
      source: "live",
    });
    await pool.query(`UPDATE groups SET name = 'Roni DATA-6c' WHERE id = $1`, [dupId]);

    const p = await upsertParticipant(pool, "DATA-6c Sender");

    // Same logical message under both identities (collides on dedupe_key); BOTH
    // copies were summarised into the same todo (distinct source_message_id rows).
    await insertMsg(survivorId, p, "data6c-shared", "EXT-SURV-C");
    await insertMsg(dupId, p, "data6c-shared", "EXT-DUP-C");
    const survMsgId = await msgId(survivorId, "data6c-shared");
    const dupMsgId = await msgId(dupId, "data6c-shared");

    await upsertTodos(pool, [
      { title: "להזמין אולם", owner: "רוני", groupId: survivorId, sourceMessageId: survMsgId },
    ]);
    await upsertTodos(pool, [
      { title: "להזמין אולם", owner: "רוני", groupId: dupId, sourceMessageId: dupMsgId },
    ]);
    // The user checked off the dup's copy; the survivor's copy stays open.
    const dupTodo = (await listTodos(pool)).find((t) => t.sourceMessageId === dupMsgId);
    expect(await setTodoDone(pool, dupTodo!.id, true)).toBe(true);

    // Must NOT abort on the unique index...
    await expect(
      mergeGroups(pool, { survivorId, dupId, name: "Roni DATA-6c" }),
    ).resolves.toBeTruthy();

    // ...exactly one todo for that content remains, on the survivor message...
    const remaining = (await listTodos(pool)).filter((t) => t.title === "להזמין אולם");
    expect(remaining).toHaveLength(1);
    expect(remaining[0].sourceMessageId).toBe(survMsgId);
    // ...and the checked box was carried across, not reset.
    expect(remaining[0].done).toBe(true);
  });

  it("rejects merging a group into itself", async () => {
    await expect(mergeGroups(pool, { survivorId: 1, dupId: 1, name: "x" })).rejects.toThrow();
  });
});
