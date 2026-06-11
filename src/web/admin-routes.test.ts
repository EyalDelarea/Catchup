import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SessionHealth } from "../collector/tenant-session-registry.js";
import { withTenant } from "../db/tenant-context.js";
import { appPool, createTestDatabase, operatorPool } from "../test/db.js";
import { makeAdminRoutes } from "./admin-routes.js";

/**
 * T5 operator dashboard API. The admin gate is the operator-email allowlist; the data
 * comes from the BYPASSRLS operator pool (cross-tenant) joined with live session health.
 */

let app: pg.Pool;
let op: pg.Pool;
let tenantA: string;
let server: http.Server;
let base: string;

const auditEvents: Array<{ action: string }> = [];

// `isOperator` is decided by the server (session email ∈ operatorEmails); admin-routes
// receives it as a boolean so the gate is trivially testable.
function startServer(isOperator: boolean, registrySnapshot: SessionHealth[] = []): Promise<void> {
  const routes = makeAdminRoutes({
    operatorPool: op,
    registry: { snapshot: () => registrySnapshot },
    recordAudit: (e) => {
      auditEvents.push({ action: e.action });
      return Promise.resolve();
    },
  });
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    void routes.handle(req, res, url, { isOperator }).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end("nope");
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      base = `http://localhost:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

beforeAll(async () => {
  const uri = await createTestDatabase();
  app = appPool(uri);
  op = operatorPool(uri);
  tenantA = randomUUID();
  await op.query(`INSERT INTO tenants (id, name) VALUES ($1, 'Acme A')`, [tenantA]);
  await withTenant(app, tenantA, async (c) => {
    await c.query(`INSERT INTO groups (name, source) VALUES ('a-grp', 'import')`);
  });
});

afterAll(async () => {
  await app?.end();
  await op?.end();
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
});

describe("admin gate", () => {
  it("403s a non-operator on every /api/admin/* route", async () => {
    await startServer(false);
    expect((await fetch(`${base}/api/admin/tenants`)).status).toBe(403);
  });
});

describe("GET /api/admin/tenants", () => {
  it("returns cross-tenant stats joined with live session status for operators", async () => {
    await startServer(true, [
      {
        tenantId: tenantA,
        status: "connected",
        restarts: 0,
        lastError: null,
        lastConnectedAt: null,
      },
    ]);
    const r = await fetch(`${base}/api/admin/tenants`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as Array<Record<string, unknown>>;
    const a = body.find((t) => t.tenantId === tenantA);
    expect(a).toMatchObject({ name: "Acme A", groupCount: 1, sessionStatus: "connected" });
    // A tenant with no live session reports "offline", not undefined.
    const other = body.find((t) => t.tenantId !== tenantA);
    expect(other?.sessionStatus).toBe("offline");
  });
});

describe("GET /api/admin/audit", () => {
  it("returns the audit trail and records the operator's own access (T6)", async () => {
    await op.query(
      `INSERT INTO audit_log (action, actor_email) VALUES ('auth.login', 'seed@audit.test')`,
    );
    auditEvents.length = 0;
    await startServer(true);
    const r = await fetch(`${base}/api/admin/audit?limit=10`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as Array<{ action: string }>;
    expect(body.some((e) => e.action === "auth.login")).toBe(true);
    // The operator viewing the trail is itself audited.
    expect(auditEvents.some((e) => e.action === "operator.access")).toBe(true);
  });
});

describe("GET /api/admin/health", () => {
  it("reports instance-wide rollups for operators", async () => {
    await startServer(true, [
      {
        tenantId: tenantA,
        status: "connected",
        restarts: 0,
        lastError: null,
        lastConnectedAt: null,
      },
    ]);
    const r = await fetch(`${base}/api/admin/health`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, number>;
    expect(body.tenantCount).toBeGreaterThanOrEqual(1);
    expect(body.connectedSessions).toBe(1);
  });
});
