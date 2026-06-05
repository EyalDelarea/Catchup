import pg from "pg";
import { loadConfig } from "../config.js";

export function createDbClient() {
  const config = loadConfig();

  return new pg.Pool({
    connectionString: config.databaseUrl,
  });
}
