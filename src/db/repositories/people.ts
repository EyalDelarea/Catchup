import type pg from "pg";

export type PersonRow = {
  id: number;
  name: string;
  status: "active" | "cold-lead" | "warm" | "dormant";
  lastContactAt: Date | null;
  openThreads: number;
  nextStep: string | null;
  sourceMessageId: number | null;
  chat: string | null;
};

/**
 * Refresh the derived People projection — the contacts you actually talk to in
 * the chats you've **included** (scope-consistent with the digest). A person
 * qualifies when, in an included (non-removed) chat, they have a real message and
 * are either the **counterpart of a 1:1 chat** (the only non-self participant) or
 * **named as the owner** of a todo/meeting. Group members who are neither are
 * left out so the list doesn't flood. Status is by message recency; open_threads
 * counts the included chats they're active in; next_step comes from their open todos.
 *
 * Pure projection: fully rebuilt each call (DELETE + INSERT), so excluding a chat
 * drops its people and re-including brings them straight back — nothing from an
 * un-selected chat ever drives the list.
 */
export async function refreshPeople(client: pg.Pool | pg.PoolClient): Promise<void> {
  // Rebuild from scratch (RLS scopes this to the current tenant). Nothing
  // FK-references people.id, so re-issuing ids is safe.
  await client.query(`DELETE FROM people`);
  await client.query(`
    INSERT INTO people
      (participant_id, status, last_contact_at, open_threads, next_step, next_step_source_message_id)
    SELECT p.id,
      CASE WHEN max(m.sent_at) < now() - interval '14 days' THEN 'cold-lead' ELSE 'active' END,
      max(m.sent_at),
      count(DISTINCT m.group_id),
      (SELECT t.title FROM todos t
       WHERE t.owner = p.display_name AND NOT t.done ORDER BY t.created_at DESC LIMIT 1),
      (SELECT t.source_message_id FROM todos t
       WHERE t.owner = p.display_name AND NOT t.done ORDER BY t.created_at DESC LIMIT 1)
    FROM participants p
    JOIN messages m
      ON m.participant_id = p.id AND m.from_me IS NOT TRUE AND m.message_type <> 'system'
    JOIN chat_scopes cs
      ON cs.group_id = m.group_id AND cs.included AND cs.removed_at IS NULL
    WHERE p.display_name IS NOT NULL AND btrim(p.display_name) <> ''
      AND (
        m.group_id IN (
          SELECT dm.group_id FROM messages dm
          WHERE dm.from_me IS NOT TRUE AND dm.message_type <> 'system'
          GROUP BY dm.group_id
          HAVING count(DISTINCT dm.participant_id) = 1
        )
        OR EXISTS (SELECT 1 FROM todos t WHERE t.owner = p.display_name)
        OR EXISTS (SELECT 1 FROM meetings mt WHERE mt.owner = p.display_name)
      )
    GROUP BY p.id, p.display_name
  `);
}

/** The People list: name + status + next-step (with its source chat for the jump). */
export async function listPeople(client: pg.Pool | pg.PoolClient): Promise<PersonRow[]> {
  const { rows } = await client.query<{
    id: string;
    name: string;
    status: PersonRow["status"];
    last_contact_at: Date | null;
    open_threads: number;
    next_step: string | null;
    next_step_source_message_id: string | null;
    chat: string | null;
  }>(`
    SELECT pe.id, par.display_name AS name, pe.status, pe.last_contact_at,
           pe.open_threads, pe.next_step, pe.next_step_source_message_id,
           g.name AS chat
    FROM people pe
    JOIN participants par ON par.id = pe.participant_id
    LEFT JOIN messages msg ON msg.id = pe.next_step_source_message_id
    LEFT JOIN groups g ON g.id = msg.group_id
    ORDER BY pe.last_contact_at DESC NULLS LAST, pe.id ASC
  `);
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    status: r.status,
    lastContactAt: r.last_contact_at,
    openThreads: r.open_threads,
    nextStep: r.next_step,
    sourceMessageId:
      r.next_step_source_message_id === null ? null : Number(r.next_step_source_message_id),
    chat: r.chat,
  }));
}
