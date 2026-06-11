import type pg from "pg";
import type { ExtractedItem } from "../../summarization/extract-entities.js";

export type MeetingRow = {
  id: number;
  title: string;
  startsAt: Date | null;
  owner: string | null;
  chat: string;
  sourceMessageId: number;
};

export type TodoRow = {
  id: number;
  title: string;
  dueAt: Date | null;
  owner: string | null;
  done: boolean;
  chat: string;
  sourceMessageId: number;
};

/** Upsert meetings, keyed by source message (re-extraction updates, never dupes). */
export async function upsertMeetings(
  client: pg.Pool | pg.PoolClient,
  items: ExtractedItem[],
): Promise<void> {
  for (const m of items) {
    await client.query(
      `INSERT INTO meetings (title, owner, group_id, source_message_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, source_message_id)
       DO UPDATE SET title = EXCLUDED.title, owner = EXCLUDED.owner, updated_at = now()`,
      [m.title, m.owner, m.groupId, m.sourceMessageId],
    );
  }
}

/** Upsert todos, keyed by source message. `done` is user state — PRESERVED on conflict. */
export async function upsertTodos(
  client: pg.Pool | pg.PoolClient,
  items: ExtractedItem[],
): Promise<void> {
  for (const t of items) {
    await client.query(
      `INSERT INTO todos (title, owner, group_id, source_message_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, source_message_id)
       DO UPDATE SET title = EXCLUDED.title, owner = EXCLUDED.owner, updated_at = now()`,
      [t.title, t.owner, t.groupId, t.sourceMessageId],
    );
  }
}

/** Meetings joined to their chat name; optional [from,to] window on starts_at. */
export async function listMeetings(
  client: pg.Pool | pg.PoolClient,
  range?: { from?: Date; to?: Date },
): Promise<MeetingRow[]> {
  const params: unknown[] = [];
  const clauses: string[] = [];
  if (range?.from) {
    params.push(range.from);
    clauses.push(`m.starts_at >= $${params.length}`);
  }
  if (range?.to) {
    params.push(range.to);
    clauses.push(`m.starts_at <= $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { rows } = await client.query<{
    id: string;
    title: string;
    starts_at: Date | null;
    owner: string | null;
    chat: string | null;
    source_message_id: string;
  }>(
    `SELECT m.id, m.title, m.starts_at, m.owner, g.name AS chat, m.source_message_id
     FROM meetings m LEFT JOIN groups g ON g.id = m.group_id
     ${where}
     ORDER BY m.starts_at ASC NULLS LAST, m.id ASC`,
    params,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    title: r.title,
    startsAt: r.starts_at,
    owner: r.owner,
    chat: r.chat ?? "",
    sourceMessageId: Number(r.source_message_id),
  }));
}

/** Todos joined to their chat name, undone first then by recency. */
export async function listTodos(client: pg.Pool | pg.PoolClient): Promise<TodoRow[]> {
  const { rows } = await client.query<{
    id: string;
    title: string;
    due_at: Date | null;
    owner: string | null;
    done: boolean;
    chat: string | null;
    source_message_id: string;
  }>(
    `SELECT t.id, t.title, t.due_at, t.owner, t.done, g.name AS chat, t.source_message_id
     FROM todos t LEFT JOIN groups g ON g.id = t.group_id
     ORDER BY t.done ASC, t.created_at DESC, t.id DESC`,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    title: r.title,
    dueAt: r.due_at,
    owner: r.owner,
    done: r.done,
    chat: r.chat ?? "",
    sourceMessageId: Number(r.source_message_id),
  }));
}

/** Toggle a todo's done flag. Returns false when the id is unknown. */
export async function setTodoDone(
  client: pg.Pool | pg.PoolClient,
  id: number,
  done: boolean,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE todos SET done = $2, updated_at = now() WHERE id = $1`,
    [id, done],
  );
  return (rowCount ?? 0) > 0;
}
