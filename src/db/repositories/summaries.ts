import type pg from "pg";
import type { SummaryOutput } from "../../summarization/summarizer.js";

export type InsertSummaryInput = {
  groupId: number;
  summaryType: "last_n" | "since" | "watermark";
  parameters: Record<string, unknown>;
  output: SummaryOutput;
  model: string;
};

/**
 * Returns the most recent catch-up (summary_type='watermark') summary for a
 * group, or null when none exists. Used by prepareCatchup to serve the cache.
 */
export async function getLatestCatchupSummary(
  client: pg.Pool | pg.PoolClient,
  groupId: number
): Promise<{ overview: string; createdAt: Date } | null> {
  const { rows } = await client.query<{ output: { overview: string }; created_at: Date }>(
    `
    SELECT output, created_at
    FROM summaries
    WHERE group_id = $1
      AND summary_type = 'watermark'
    ORDER BY created_at DESC, id DESC
    LIMIT 1
    `,
    [groupId]
  );
  if (rows.length === 0) return null;
  const row = rows[0]!;
  return { overview: row.output.overview, createdAt: row.created_at };
}

export type SummaryRow = {
  id: number;
  summaryType: string;
  parameters: Record<string, unknown>;
  output: { overview: string };
  model: string;
  createdAt: Date;
};

/**
 * Returns summaries for a group, newest-first, limited to `limit` rows.
 */
export async function listSummariesByGroup(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
  limit: number
): Promise<SummaryRow[]> {
  const { rows } = await client.query<{
    id: string;
    summary_type: string;
    parameters: Record<string, unknown>;
    output: { overview: string };
    model: string;
    created_at: Date;
  }>(
    `
    SELECT id, summary_type, parameters, output, model, created_at
    FROM summaries
    WHERE group_id = $1
    ORDER BY created_at DESC, id DESC
    LIMIT $2
    `,
    [groupId, limit]
  );
  return rows.map((row) => ({
    id: Number(row.id),
    summaryType: row.summary_type,
    parameters: row.parameters,
    output: row.output,
    model: row.model,
    createdAt: row.created_at,
  }));
}

/** Persist a generated summary; returns the new row id (FR-018). */
export async function insertSummary(
  client: pg.Pool | pg.PoolClient,
  input: InsertSummaryInput
): Promise<number> {
  const { rows } = await client.query<{ id: string }>(
    `
    INSERT INTO summaries (group_id, summary_type, parameters, output, model)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id
    `,
    [
      input.groupId,
      input.summaryType,
      JSON.stringify(input.parameters),
      JSON.stringify(input.output),
      input.model,
    ]
  );
  return Number(rows[0].id);
}
