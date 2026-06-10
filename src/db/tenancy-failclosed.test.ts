import type pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { appPool, createTestDatabase } from "../test/db.js";
import { createAdminPool } from "./client.js";
import { DEFAULT_TENANT_ID } from "./tenant-context.js";

/**
 * US1 — fail-closed (FR-006 / SC-005): using the catchup_app role with NO tenant
 * context (no app.tenant_id GUC set), every scoped-table read returns zero rows and
 * every write is rejected. The system must fail closed, never open.
 */

let admin: pg.Pool;
let app: pg.Pool;

beforeAll(async () => {
  const uri = await createTestDatabase();
  admin = createAdminPool(uri);
  app = appPool(uri);
  // Seed a row for the default tenant via admin so "0 rows" is meaningful.
  await admin.query(`INSERT INTO groups (tenant_id, name, source) VALUES ($1, 'seed', 'import')`, [
    DEFAULT_TENANT_ID,
  ]);
});

afterAll(async () => {
  await app?.end();
  await admin?.end();
});

it("reads return zero rows when no tenant context is set", async () => {
  // No withTenant / no SET app.tenant_id — query directly on the app pool.
  const { rows } = await app.query(`SELECT * FROM groups`);
  expect(rows).toHaveLength(0);
});

it("writes are rejected when no tenant context is set", async () => {
  await expect(
    app.query(`INSERT INTO groups (name, source) VALUES ('nope', 'import')`),
  ).rejects.toThrow(/row-level security|policy/i);
});
