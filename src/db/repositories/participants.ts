import type pg from "pg";

/**
 * Upsert a participant by display_name.
 * Returns the participant id as a number.
 */
export async function upsertParticipant(
  client: pg.Pool | pg.PoolClient,
  displayName: string,
): Promise<number> {
  const result = await client.query<{ id: string }>(
    `
    INSERT INTO participants (display_name)
    VALUES ($1)
    ON CONFLICT (tenant_id, display_name) DO UPDATE SET display_name = EXCLUDED.display_name
    RETURNING id
    `,
    [displayName],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error(`upsertParticipant: no row returned for displayName="${displayName}"`);
  }
  return Number(row.id);
}

/**
 * Upsert many participants by display_name in parallel.
 * Returns a Map<display_name, id>.
 */
export async function upsertParticipants(
  client: pg.Pool | pg.PoolClient,
  displayNames: string[],
): Promise<Map<string, number>> {
  const entries = await Promise.all(
    displayNames.map(async (name) => {
      const id = await upsertParticipant(client, name);
      return [name, id] as [string, number];
    }),
  );
  return new Map(entries);
}
