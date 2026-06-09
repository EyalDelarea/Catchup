import type pg from "pg";

/**
 * Identity of the tenant that owns all data predating multi-tenancy (T1). Mirrors the
 * row seeded by migration 021. Configurable via DEFAULT_TENANT_ID so the existing local
 * deployment runs as this tenant with no other configuration (FR-010).
 */
export const DEFAULT_TENANT_ID =
  process.env.DEFAULT_TENANT_ID ?? "00000000-0000-0000-0000-000000000001";

/**
 * Run a unit of work in the context of exactly one tenant. Opens a transaction on a
 * single pooled connection, sets the transaction-local `app.tenant_id` GUC (which the
 * RLS policies key off), runs `fn` with that client, and commits — or rolls back on
 * error. The GUC is transaction-local, so a pooled connection never leaks one tenant's
 * context into the next checkout.
 */
export async function withTenant<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // set_config(name, value, is_local=true) === SET LOCAL, but parameterizable.
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
