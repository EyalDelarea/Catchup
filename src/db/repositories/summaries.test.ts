import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrationsUp } from "../migrate.js";
import { upsertGroup } from "./groups.js";
import { insertSummary, listSummariesByGroup } from "./summaries.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

describe("summaries schema", () => {
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

  it("stores a summary row with jsonb parameters/output and rejects a bad summary_type", async () => {
    const groupId = await upsertGroup(pool, { name: "S-schema", source: "import" });

    await expect(
      pool.query(
        `INSERT INTO summaries (group_id, summary_type, parameters, output, model)
         VALUES ($1, 'last_n', $2, $3, 'gemma4:26b')`,
        [
          groupId,
          JSON.stringify({ n: 100 }),
          JSON.stringify({ overview: "x", decisions: [], open_questions: [], action_items: [] }),
        ],
      ),
    ).resolves.toBeDefined();

    await expect(
      pool.query(
        `INSERT INTO summaries (group_id, summary_type, parameters, output, model)
         VALUES ($1, 'bogus', '{}', '{}', 'gemma4:26b')`,
        [groupId],
      ),
    ).rejects.toMatchObject({ code: "23514" }); // check_violation
  });

  it("findGroupByName returns the group or null", async () => {
    const { findGroupByName } = await import("./groups.js");
    await upsertGroup(pool, { name: "S-find", source: "import" });
    const found = await findGroupByName(pool, "S-find");
    expect(found).toMatchObject({ name: "S-find" });
    expect(typeof found!.id).toBe("number");
    expect(await findGroupByName(pool, "nope")).toBeNull();
  });

  it("insertSummary persists and returns an id", async () => {
    const { insertSummary } = await import("./summaries.js");
    const groupId = await upsertGroup(pool, { name: "S-insert", source: "import" });
    const id = await insertSummary(pool, {
      groupId,
      summaryType: "last_n",
      parameters: { n: 50 },
      output: { overview: "o" },
      model: "gemma4:26b",
    });
    expect(typeof id).toBe("number");
    const { rows } = await pool.query(`SELECT output FROM summaries WHERE id = $1`, [id]);
    expect(rows[0].output).toMatchObject({ overview: "o" });
  });

  it("insertSummary accepts 'watermark' as a summary_type", async () => {
    const groupId = await upsertGroup(pool, { name: "S-watermark", source: "import" });
    const id = await insertSummary(pool, {
      groupId,
      summaryType: "watermark",
      parameters: {
        fromExclusive: null,
        toInclusive: { sentAt: "2026-01-01T10:00:00.000Z", messageId: 42 },
        messageCount: 5,
        usedFallback: true,
      },
      output: { overview: "catchup overview" },
      model: "gemma4:26b",
    });
    expect(typeof id).toBe("number");
    const { rows } = await pool.query(`SELECT output, summary_type FROM summaries WHERE id = $1`, [
      id,
    ]);
    expect(rows[0].summary_type).toBe("watermark");
    expect(rows[0].output).toMatchObject({ overview: "catchup overview" });
  });

  it("getLatestCatchupSummary returns null when no watermark summary exists", async () => {
    const { getLatestCatchupSummary } = await import("./summaries.js");
    const groupId = await upsertGroup(pool, { name: "S-glcs-empty", source: "import" });
    const result = await getLatestCatchupSummary(pool, groupId);
    expect(result).toBeNull();
  });

  it("getLatestCatchupSummary returns only 'watermark' rows, not 'last_n'", async () => {
    const { getLatestCatchupSummary } = await import("./summaries.js");
    const groupId = await upsertGroup(pool, { name: "S-glcs-types", source: "import" });
    // Insert a last_n row — must NOT be returned
    await insertSummary(pool, {
      groupId,
      summaryType: "last_n",
      parameters: { n: 10 },
      output: { overview: "last_n overview" },
      model: "gemma4:26b",
    });
    const result = await getLatestCatchupSummary(pool, groupId);
    expect(result).toBeNull();
  });

  it("getLatestCatchupSummary returns the most recent watermark row's overview and createdAt", async () => {
    const { getLatestCatchupSummary } = await import("./summaries.js");
    const groupId = await upsertGroup(pool, { name: "S-glcs-order", source: "import" });

    // Insert an older watermark summary
    await insertSummary(pool, {
      groupId,
      summaryType: "watermark",
      parameters: {
        fromExclusive: null,
        toInclusive: { sentAt: "2026-01-01T10:00:00.000Z", messageId: 1 },
        messageCount: 3,
        usedFallback: true,
      },
      output: { overview: "older overview" },
      model: "gemma4:26b",
    });

    // Small delay to ensure different created_at
    await new Promise((r) => setTimeout(r, 10));

    // Insert a newer watermark summary
    await insertSummary(pool, {
      groupId,
      summaryType: "watermark",
      parameters: {
        fromExclusive: { sentAt: "2026-01-01T10:00:00.000Z", messageId: 1 },
        toInclusive: { sentAt: "2026-01-02T10:00:00.000Z", messageId: 10 },
        messageCount: 5,
        usedFallback: false,
      },
      output: { overview: "newer overview" },
      model: "gemma4:26b",
    });

    const result = await getLatestCatchupSummary(pool, groupId);
    expect(result).not.toBeNull();
    expect(result!.overview).toBe("newer overview");
    expect(result!.createdAt instanceof Date).toBe(true);
  });
});

describe("listSummariesByGroup", () => {
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

  it("returns summaries newest-first", async () => {
    const groupId = await upsertGroup(pool, { name: "SUM-list-order", source: "import" });

    // Insert 3 summaries with different created_at values
    await pool.query(
      `INSERT INTO summaries (group_id, summary_type, parameters, output, model, created_at)
       VALUES ($1, 'last_n', '{"n":10}', '{"overview":"oldest"}', 'modelA', '2026-01-01T10:00:00Z')`,
      [groupId],
    );
    await pool.query(
      `INSERT INTO summaries (group_id, summary_type, parameters, output, model, created_at)
       VALUES ($1, 'since', '{"since":"2026-01-01"}', '{"overview":"middle"}', 'modelB', '2026-01-02T10:00:00Z')`,
      [groupId],
    );
    await pool.query(
      `INSERT INTO summaries (group_id, summary_type, parameters, output, model, created_at)
       VALUES ($1, 'watermark', '{"fromWatermark":"abc","messageCount":5}', '{"overview":"newest"}', 'modelC', '2026-01-03T10:00:00Z')`,
      [groupId],
    );

    const results = await listSummariesByGroup(pool, groupId, 10);
    expect(results).toHaveLength(3);
    expect(results[0].output.overview).toBe("newest");
    expect(results[1].output.overview).toBe("middle");
    expect(results[2].output.overview).toBe("oldest");
  });

  it("respects the limit parameter", async () => {
    const groupId = await upsertGroup(pool, { name: "SUM-list-limit", source: "import" });

    for (let i = 0; i < 5; i++) {
      await insertSummary(pool, {
        groupId,
        summaryType: "last_n",
        parameters: { n: i },
        output: { overview: `summary ${i}` },
        model: "fake",
      });
    }

    const results = await listSummariesByGroup(pool, groupId, 3);
    expect(results).toHaveLength(3);
  });

  it("returns empty array for group with no summaries", async () => {
    const groupId = await upsertGroup(pool, { name: "SUM-list-empty", source: "import" });
    const results = await listSummariesByGroup(pool, groupId, 50);
    expect(results).toHaveLength(0);
  });

  it("createdAt is a Date object", async () => {
    const groupId = await upsertGroup(pool, { name: "SUM-list-date", source: "import" });
    await insertSummary(pool, {
      groupId,
      summaryType: "last_n",
      parameters: { n: 5 },
      output: { overview: "date test" },
      model: "fake",
    });

    const results = await listSummariesByGroup(pool, groupId, 1);
    expect(results).toHaveLength(1);
    expect(results[0].createdAt).toBeInstanceOf(Date);
  });

  it("correctly maps all fields including id as number", async () => {
    const groupId = await upsertGroup(pool, { name: "SUM-list-fields", source: "import" });
    const params = { fromWatermark: "xyz", messageCount: 42 };
    const overview = "כל הפרטים כאן";

    await insertSummary(pool, {
      groupId,
      summaryType: "watermark",
      parameters: params,
      output: { overview },
      model: "gemma2",
    });

    const results = await listSummariesByGroup(pool, groupId, 1);
    expect(results).toHaveLength(1);
    const row = results[0];
    expect(typeof row.id).toBe("number");
    expect(Number.isFinite(row.id)).toBe(true);
    expect(row.summaryType).toBe("watermark");
    expect(row.parameters).toEqual(params);
    expect(row.output).toEqual({ overview });
    expect(row.model).toBe("gemma2");
    expect(row.createdAt).toBeInstanceOf(Date);
  });
});
