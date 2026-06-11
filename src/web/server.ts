import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { currentUser } from "../auth/service.js";
import { DEFAULT_TENANT_ID, scopedPool } from "../db/tenant-context.js";
import { makeAdminRoutes } from "./admin-routes.js";
import { makeAuthRoutes } from "./auth-routes.js";
import { handleAsk } from "./handlers/ask.js";
import type { ServerDeps } from "./handlers/context.js";
import { handleGroups } from "./handlers/groups.js";
import { handleMessages } from "./handlers/messages.js";
import { handlePreferences } from "./handlers/preferences.js";
import { handleScopeCategories } from "./handlers/scope-categories.js";
import { handleScopes } from "./handlers/scopes.js";
import { handleStatus } from "./handlers/status.js";
import { handleSuggestions } from "./handlers/suggestions.js";
import { handleSummaries } from "./handlers/summaries.js";
import { handleSummarize } from "./handlers/summarize.js";
import { handleTotalSummary } from "./handlers/total-summary.js";
import { makeOnboardingRoutes } from "./onboarding-routes.js";

export type { ServerDeps } from "./handlers/context.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.join(__dirname, "public", "index.html");

const SPA_PATHS = new Set(["/", "/verify", "/reset", "/admin"]);

export function createServer(deps: ServerDeps): http.Server {
  const authRoutes = deps.auth
    ? makeAuthRoutes({ deps: deps.auth.deps, cookieSecure: deps.auth.cookieSecure })
    : null;
  const onboardingRoutes = deps.onboarding
    ? makeOnboardingRoutes({ registry: deps.onboarding })
    : null;
  const adminRoutes = deps.admin
    ? makeAdminRoutes({
        operatorPool: deps.admin.operatorPool,
        registry: deps.admin.registry,
        recordAudit: deps.admin.recordAudit,
      })
    : null;

  const handleRequest = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && SPA_PATHS.has(url.pathname)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(INDEX_HTML, "utf8"));
      return;
    }

    // Auth endpoints answer for themselves (they are exactly the routes that must
    // work without a session) and short-circuit the gate below.
    if (authRoutes && (await authRoutes.handle(req, res, url))) return;

    if (url.pathname.startsWith("/api/")) {
      // Establish the request's tenant, then scope ALL data access to it. In
      // single-user mode that's the default tenant — identical behavior to before,
      // now explicitly attributed.
      let tenantId = DEFAULT_TENANT_ID;
      let session = null;
      if (deps.auth?.required) {
        session = authRoutes ? await authRoutes.session(req) : null;
        if (!session) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Not authenticated." }));
          return;
        }
        tenantId = session.tenantId;
        // A session alone isn't enough when email verification is enforced — otherwise the
        // verify step is cosmetic (a registrant is auto-logged-in before verifying).
        if (deps.auth.requireEmailVerified) {
          const user = await currentUser(deps.auth.deps, session);
          if (!user?.emailVerified) {
            res.writeHead(403, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "Email verification required." }));
            return;
          }
        }
      }
      // Admin (cross-tenant) — gated on the session user's email being an operator.
      // Computed here so a tenant session can never reach the admin pool.
      if (adminRoutes && url.pathname.startsWith("/api/admin/")) {
        let isOperator = false;
        let operatorEmail: string | null = null;
        if (session && deps.auth && deps.admin) {
          const user = await currentUser(deps.auth.deps, session);
          if (user != null && deps.admin.operatorEmails.includes(user.email.toLowerCase())) {
            isOperator = true;
            operatorEmail = user.email;
          }
        }
        if (await adminRoutes.handle(req, res, url, { isOperator, operatorEmail })) return;
      }
      // Onboarding talks to the registry, not the DB pool — route it with the raw
      // tenantId before the pool-scoped dispatch.
      if (onboardingRoutes && (await onboardingRoutes.handle(req, res, url, tenantId))) return;
      const scoped: ServerDeps = { ...deps, pool: scopedPool(deps.pool, () => tenantId) };
      dispatchApi(url, req, res, scoped);
      return;
    }

    // Generic static asset handler — must come after all /api/* routes
    if (req.method === "GET") {
      void handleStatic(url.pathname, res);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  };

  return http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      process.stderr.write(
        `Error handling ${req.url}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: "Internal server error." }));
    });
  });
}

function dispatchApi(
  url: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ServerDeps,
): void {
  if (req.method === "GET" && url.pathname === "/api/groups") {
    handleGroups(res, deps);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/summarize") {
    if (blockCrossOrigin(req, res)) return;
    void handleSummarize(url, req, res, deps);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/total-summary") {
    if (blockCrossOrigin(req, res)) return;
    void handleTotalSummary(url, req, res, deps);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/ask") {
    void handleAsk(url, req, res, deps);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/status") {
    void handleStatus(res, deps);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/summaries") {
    void handleSummaries(url, res, deps);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/messages") {
    void handleMessages(url, res, deps);
    return;
  }
  if (url.pathname === "/api/scopes" && (req.method === "GET" || req.method === "PUT")) {
    if (req.method === "PUT" && blockCrossOrigin(req, res)) return;
    void handleScopes(url, req, res, deps);
    return;
  }
  if (url.pathname === "/api/scope-categories" && (req.method === "GET" || req.method === "POST")) {
    if (req.method === "POST" && blockCrossOrigin(req, res)) return;
    void handleScopeCategories(url, req, res, deps);
    return;
  }
  if (url.pathname === "/api/preferences" && (req.method === "GET" || req.method === "PUT")) {
    if (req.method === "PUT" && blockCrossOrigin(req, res)) return;
    void handlePreferences(url, req, res, deps);
    return;
  }
  if (url.pathname.startsWith("/api/suggestions")) {
    if ((req.method === "PUT" || req.method === "POST") && blockCrossOrigin(req, res)) return;
    void handleSuggestions(url, req, res, deps);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not found");
}

/**
 * CSRF defense for the state-changing GET endpoints (/api/summarize, /api/total-summary):
 * they advance the read watermark + spend LLM compute, but can't move to POST because the
 * browser consumes them via EventSource (GET only, no custom headers). So validate the
 * request's Origin/Referer against its own host instead.
 *
 * Returns true when the request is cross-origin and must be rejected. A same-origin
 * request passes; a request with NEITHER Origin nor Referer also passes (a same-origin
 * top-level GET navigation often omits both) — but a cross-site trigger leaks either an
 * Origin (fetch/form) or the attacker's Referer (window.open / link navigation), which is
 * exactly what this blocks. Combined with the SameSite=Lax session cookie.
 */
export function isCrossOrigin(req: http.IncomingMessage): boolean {
  const host = req.headers.host;
  if (!host) return false; // nothing to compare against — don't block
  const candidate = req.headers.origin ?? req.headers.referer;
  if (!candidate) return false; // no Origin/Referer present
  try {
    return new URL(candidate).host !== host;
  } catch {
    return true; // malformed Origin/Referer → treat as cross-origin
  }
}

function blockCrossOrigin(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (!isCrossOrigin(req)) return false;
  res.writeHead(403, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "Cross-origin request rejected." }));
  return true;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
};

async function handleStatic(pathname: string, res: http.ServerResponse): Promise<void> {
  const publicDir = path.resolve(__dirname, "public");
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
    return;
  }
  const resolved = path.resolve(path.join(publicDir, decoded));
  // Block path traversal
  if (!resolved.startsWith(publicDir + path.sep) && resolved !== publicDir) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
    return;
  }
  // Read the file directly rather than stat-then-read: a separate existence
  // check would be a TOCTOU race. A missing file or a directory both throw
  // here (ENOENT / EISDIR) and resolve to 404.
  let data: Buffer;
  try {
    data = fs.readFileSync(resolved);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
    return;
  }
  const ext = path.extname(resolved).toLowerCase();
  const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
  // Single-user LAN tool: revalidate every load so a redeploy never serves stale JS/CSS.
  res.writeHead(200, { "content-type": contentType, "cache-control": "no-cache" });
  res.end(data);
}
