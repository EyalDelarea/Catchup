import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import pg from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrationsUp } from "../migrate.js";
import { getLastRun, recordRun } from "./scheduler-state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

describe("scheduler-state repository", () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
    await runMigrationsUp(container.getConnectionUri(), MIGRATIONS_DIR);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  }, 30_000);

  it("getLastRun returns null for an unknown slot", async () => {
    const result = await getLastRun(pool, "digest@08:00");
    expect(result).toBeNull();
  });

  it("recordRun then getLastRun round-trips the timestamp", async () => {
    const runAt = new Date("2026-06-04T08:00:00.000Z");
    await recordRun(pool, "digest@08:00-rt", runAt);

    const result = await getLastRun(pool, "digest@08:00-rt");
    expect(result).not.toBeNull();
    expect(result!.getTime()).toBe(runAt.getTime());
  });

  it("second recordRun with a later time advances last_run_at (upsert)", async () => {
    const runAt1 = new Date("2026-06-04T08:00:00.000Z");
    const runAt2 = new Date("2026-06-04T18:00:00.000Z");

    await recordRun(pool, "digest@18:00-adv", runAt1);
    await recordRun(pool, "digest@18:00-adv", runAt2);

    const result = await getLastRun(pool, "digest@18:00-adv");
    expect(result!.getTime()).toBe(runAt2.getTime());
  });

  it("recordRun with an earlier time does NOT move last_run_at backwards", async () => {
    const runAtLater = new Date("2026-06-04T18:00:00.000Z");
    const runAtEarlier = new Date("2026-06-04T08:00:00.000Z");

    await recordRun(pool, "digest@08:00-mono", runAtLater);
    // Attempt to move backward — must be a no-op
    await recordRun(pool, "digest@08:00-mono", runAtEarlier);

    const result = await getLastRun(pool, "digest@08:00-mono");
    expect(result!.getTime()).toBe(runAtLater.getTime());
  });

  it("recordRun with the same time is idempotent", async () => {
    const runAt = new Date("2026-06-04T08:00:00.000Z");

    await recordRun(pool, "digest@08:00-idem", runAt);
    await recordRun(pool, "digest@08:00-idem", runAt);

    const result = await getLastRun(pool, "digest@08:00-idem");
    expect(result!.getTime()).toBe(runAt.getTime());
  });
});
