import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test/db.js";
import { createAdminPool } from "../client.js";
import { DEFAULT_TENANT_ID } from "../tenant-context.js";
import {
  createTenant,
  getTenant,
  listTenants,
  markTenantDeleted,
  purgeTenantData,
} from "./tenants.js";

/**
 * US3 — provisioning + lifecycle + the hard data-deletion path. Tenant management is
 * operator-level (the tenants table is not itself RLS-scoped), so these run on the
 * admin/operator connection.
 */

let admin: pg.Pool;

beforeAll(async () => {
  const uri = await createTestDatabase();
  admin = createAdminPool(uri);
});

afterAll(async () => {
  await admin?.end();
});

describe("createTenant / getTenant / listTenants", () => {
  it("creates an active tenant and reads it back", async () => {
    const t = await createTenant(admin, { name: "Acme" });
    expect(t.id).toMatch(/[0-9a-f-]{36}/);
    expect(t.status).toBe("active");

    const got = await getTenant(admin, t.id);
    expect(got?.name).toBe("Acme");
  });

  it("lists tenants including the default", async () => {
    const ids = (await listTenants(admin)).map((t) => t.id);
    expect(ids).toContain(DEFAULT_TENANT_ID);
  });
});

describe("markTenantDeleted", () => {
  it("sets status=deleted and a deleted_at timestamp", async () => {
    const t = await createTenant(admin, { name: "ToDelete" });
    await markTenantDeleted(admin, t.id);
    const got = await getTenant(admin, t.id);
    expect(got?.status).toBe("deleted");
    expect(got?.deletedAt).toBeInstanceOf(Date);
  });
});

describe("purgeTenantData (FR-013)", () => {
  it("removes all of a tenant's scoped rows and leaves other tenants intact", async () => {
    const victim = randomUUID();
    await admin.query(`INSERT INTO tenants (id, name, status) VALUES ($1, 'Victim', 'active')`, [
      victim,
    ]);
    // One group per tenant (admin bypasses RLS; set tenant_id explicitly).
    await admin.query(
      `INSERT INTO groups (tenant_id, name, source) VALUES ($1, 'victim-g', 'import')`,
      [victim],
    );
    await admin.query(
      `INSERT INTO groups (tenant_id, name, source) VALUES ($1, 'keep-g', 'import')`,
      [DEFAULT_TENANT_ID],
    );

    await purgeTenantData(admin, victim);

    const victimRows = await admin.query(`SELECT 1 FROM groups WHERE tenant_id = $1`, [victim]);
    expect(victimRows.rows).toHaveLength(0);
    const keepRows = await admin.query(`SELECT 1 FROM groups WHERE name = 'keep-g'`);
    expect(keepRows.rows).toHaveLength(1);
  });
});
