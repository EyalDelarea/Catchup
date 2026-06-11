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
 * Refresh the derived People projection. A "person" is a participant NAMED as the
 * owner of at least one todo/meeting (keeps the list meaningful — not every
 * participant ever seen). Status is by message recency; open_threads + next_step
 * come from their open todos. Idempotent upsert on (tenant_id, participant_id);
 * fully rebuildable from messages + the agenda tables.
 */
export async function refreshPeople(client: pg.Pool | pg.PoolClient): Promise<void> {
  await client.query(`
    INSERT INTO people
      (participant_id, status, last_contact_at, open_threads, next_step, next_step_source_message_id)
    SELECT p.id,
      CASE WHEN max(m.sent_at) < now() - interval '14 days' THEN 'cold-lead' ELSE 'active' END,
      max(m.sent_at),
      COALESCE((SELECT count(DISTINCT t.group_id) FROM todos t
                WHERE t.owner = p.display_name AND NOT t.done), 0),
      (SELECT t.title FROM todos t
       WHERE t.owner = p.display_name AND NOT t.done ORDER BY t.created_at DESC LIMIT 1),
      (SELECT t.source_message_id FROM todos t
       WHERE t.owner = p.display_name AND NOT t.done ORDER BY t.created_at DESC LIMIT 1)
    FROM participants p
    JOIN messages m ON m.participant_id = p.id
    WHERE EXISTS (SELECT 1 FROM todos t WHERE t.owner = p.display_name)
       OR EXISTS (SELECT 1 FROM meetings mt WHERE mt.owner = p.display_name)
    GROUP BY p.id, p.display_name
    ON CONFLICT (tenant_id, participant_id) DO UPDATE SET
      status = EXCLUDED.status,
      last_contact_at = EXCLUDED.last_contact_at,
      open_threads = EXCLUDED.open_threads,
      next_step = EXCLUDED.next_step,
      next_step_source_message_id = EXCLUDED.next_step_source_message_id,
      updated_at = now()
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
