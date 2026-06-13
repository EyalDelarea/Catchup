import type pg from "pg";
import { upsertMeetings, upsertTodos } from "../db/repositories/agenda.js";
import { refreshPeople } from "../db/repositories/people.js";
import { extractEntities } from "./extract-entities.js";
import type { SummaryOutput } from "./summarizer.js";

/** Minimal structural logger (pino-compatible) — only `warn` is used here. */
type Warner = { warn: (obj: Record<string, unknown>, msg?: string) => void };

/** Distinct participant display names that have posted in a group (for owner matching). */
async function participantNamesForGroup(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
): Promise<string[]> {
  const { rows } = await client.query<{ display_name: string }>(
    `SELECT DISTINCT p.display_name
     FROM participants p JOIN messages m ON m.participant_id = p.id
     WHERE m.group_id = $1 AND p.display_name IS NOT NULL`,
    [groupId],
  );
  return rows.map((r) => r.display_name);
}

/**
 * S7 materialization: turn a freshly-persisted STRUCTURED summary's decision
 * bullets into meeting/todo rows for the chat, then refresh the People projection.
 * Legacy (non-v2) summaries are skipped (no structured decisions to extract).
 * Best-effort by contract — callers wrap this so it never fails a summary.
 */
export async function refreshEntitiesForGroup(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
  output: SummaryOutput,
): Promise<void> {
  if (!("version" in output) || output.version !== 2) return;
  const names = await participantNamesForGroup(client, groupId);
  const { meetings, todos } = extractEntities(output.decisions, groupId, names);
  await upsertMeetings(client, meetings);
  await upsertTodos(client, todos);
  await refreshPeople(client);
}

/**
 * Best-effort, LOGGED wrapper around {@link refreshEntitiesForGroup} — the single
 * extraction policy shared by the worker digest path and the streaming serve path.
 * Never throws: an extraction hiccup must not fail (or roll back) a committed
 * summary, but — unlike a bare `.catch(() => {})` — it leaves a `warn` breadcrumb
 * so an empty To-dos tab is diagnosable instead of silent.
 */
export async function materializeEntities(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
  output: SummaryOutput,
  logger?: Warner,
): Promise<void> {
  try {
    await refreshEntitiesForGroup(client, groupId, output);
  } catch (err) {
    logger?.warn({ evt: "extract", op: "materialize", groupId, err }, "entity extraction failed");
  }
}
