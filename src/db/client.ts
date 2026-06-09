import pg from "pg";
import { loadConfig } from "../config.js";

/**
 * Owner/admin pool — full privileges, RLS-bypassing (superuser/owner). Used by
 * migrations and operator tooling.
 */
export function createDbClient() {
  const config = loadConfig();

  return new pg.Pool({
    connectionString: config.databaseUrl,
  });
}

/** Like createDbClient, but accepts an explicit connection string (used by tests). */
export function createAdminPool(connectionString?: string): pg.Pool {
  return new pg.Pool({ connectionString: connectionString ?? loadConfig().databaseUrl });
}

/**
 * Application pool — connects as the non-superuser `catchup_app` role so RLS is
 * enforced. All normal tenant-scoped data access goes through this pool inside
 * withTenant(). Reads APP_DATABASE_URL, falling back to DATABASE_URL for local dev.
 */
export function createAppPool(connectionString?: string): pg.Pool {
  const url = connectionString ?? process.env.APP_DATABASE_URL ?? loadConfig().databaseUrl;
  return new pg.Pool({ connectionString: url });
}
