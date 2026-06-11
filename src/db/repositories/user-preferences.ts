import type pg from "pg";

/** A tenant's preferences. A missing row resolves to env defaults at the caller. */
export type UserPreferences = {
  /** CSV HH:MM (same grammar as DIGEST_TIMES). */
  digestTimes: string;
  morningNotification: boolean;
  /** RESERVED for the S6 engine; S5 round-trips it opaquely. */
  engineConfig: Record<string, unknown>;
  /** nullable — the S1 client localStorage stays the source of truth. */
  theme: string | null;
};

type Row = {
  digest_times: string;
  morning_notification: boolean;
  engine_config: Record<string, unknown>;
  theme: string | null;
};

function mapRow(r: Row): UserPreferences {
  return {
    digestTimes: r.digest_times,
    morningNotification: r.morning_notification,
    engineConfig: r.engine_config ?? {},
    theme: r.theme ?? null,
  };
}

/** The current tenant's preferences row, or null when none has been saved yet. */
export async function getPreferences(client: pg.Pool | pg.PoolClient): Promise<UserPreferences | null> {
  const { rows } = await client.query<Row>(
    `SELECT digest_times, morning_notification, engine_config, theme FROM user_preferences LIMIT 1`,
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * Upsert the current tenant's preferences (one row, keyed by the tenant_id PK
 * default). Only the provided fields are written; the rest keep their stored
 * values or column defaults on first insert. Returns the resulting row.
 */
export async function upsertPreferences(
  client: pg.Pool | pg.PoolClient,
  patch: Partial<UserPreferences>,
): Promise<UserPreferences> {
  const cols: string[] = [];
  const vals: string[] = [];
  const sets: string[] = [];
  const params: unknown[] = [];

  const add = (col: string, value: unknown) => {
    params.push(value);
    cols.push(col);
    vals.push(`$${params.length}`);
    sets.push(`${col} = EXCLUDED.${col}`);
  };
  if (patch.digestTimes !== undefined) add("digest_times", patch.digestTimes);
  if (patch.morningNotification !== undefined) add("morning_notification", patch.morningNotification);
  if (patch.engineConfig !== undefined) add("engine_config", JSON.stringify(patch.engineConfig));
  if (patch.theme !== undefined) add("theme", patch.theme);
  sets.push("updated_at = now()");

  // With no fields provided, still ensure a row exists (defaults).
  const insert = cols.length
    ? `INSERT INTO user_preferences (${cols.join(", ")}) VALUES (${vals.join(", ")})`
    : `INSERT INTO user_preferences DEFAULT VALUES`;

  const { rows } = await client.query<Row>(
    `${insert}
     ON CONFLICT (tenant_id) DO UPDATE SET ${sets.join(", ")}
     RETURNING digest_times, morning_notification, engine_config, theme`,
    params,
  );
  return mapRow(rows[0]!);
}
