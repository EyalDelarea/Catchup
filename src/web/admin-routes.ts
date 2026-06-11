import type http from "node:http";
import type { SessionHealth } from "../collector/tenant-session-registry.js";
import { listTenantStats } from "../db/repositories/operator-stats.js";

/**
 * T5 — operator/admin dashboard API (the cross-tenant view).
 *
 * Two independent guards stack here:
 *  1. The server only calls this with `isOperator` true when the authenticated user's
 *     email is in config.auth.operatorEmails — a tenant session can never reach it.
 *  2. The data comes from the BYPASSRLS operator pool (the only place allowed to read
 *     across tenants), joined with live per-tenant session health from the registry.
 */

/** Minimal registry surface the admin view needs (the real registry satisfies it). */
export interface AdminRegistry {
  snapshot(): SessionHealth[];
}

export type AdminRoutesOptions = {
  operatorPool: import("pg").Pool;
  registry: AdminRegistry;
};

export type AdminContext = { isOperator: boolean };

export function makeAdminRoutes(opts: AdminRoutesOptions) {
  const { operatorPool, registry } = opts;

  const handle = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    ctx: AdminContext,
  ): Promise<boolean> => {
    if (!url.pathname.startsWith("/api/admin/")) return false;
    if (!ctx.isOperator) {
      json(res, 403, { error: "Operator access required." });
      return true;
    }
    try {
      if (req.method === "GET" && url.pathname === "/api/admin/tenants") {
        json(res, 200, await tenantsView());
        return true;
      }
      if (req.method === "GET" && url.pathname === "/api/admin/health") {
        json(res, 200, await healthView());
        return true;
      }
      json(res, 404, { error: "Not found." });
    } catch (err) {
      process.stderr.write(
        `Error handling ${url.pathname}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
      json(res, 500, { error: "Internal server error." });
    }
    return true;
  };

  /** Per-tenant stats (operator pool) joined with live session status (registry). */
  const tenantsView = async () => {
    const [stats, health] = [await listTenantStats(operatorPool), registry.snapshot()];
    const byTenant = new Map(health.map((h) => [h.tenantId, h.status]));
    return stats.map((s) => ({
      ...s,
      // A tenant with no live session is "offline" (vs the registry's session states).
      sessionStatus: byTenant.get(s.tenantId) ?? "offline",
    }));
  };

  /** Instance-wide rollups for the operator header. */
  const healthView = async () => {
    const stats = await listTenantStats(operatorPool);
    const health = registry.snapshot();
    return {
      tenantCount: stats.length,
      activeTenants: stats.filter((s) => s.status === "active").length,
      totalMessages: stats.reduce((n, s) => n + s.messageCount, 0),
      connectedSessions: health.filter((h) => h.status === "connected").length,
      failedSessions: health.filter((h) => h.status === "failed" || h.status === "logged-out")
        .length,
    };
  };

  return { handle };
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
