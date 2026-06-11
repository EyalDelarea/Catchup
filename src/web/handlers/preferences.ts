import type http from "node:http";
import { loadConfig } from "../../config.js";
import { getPreferences, upsertPreferences } from "../../db/repositories/user-preferences.js";
import { parseTimes } from "../../scheduler/schedule.js";
import type { ServerDeps } from "./context.js";
import { readJsonBody } from "./scopes.js";

// Env digest default for the no-row fallback. Resolved lazily so importing this
// handler can never throw on a missing/odd env; falls back to the column default.
let cachedDefault: string | undefined;
function defaultDigestTimes(): string {
  if (cachedDefault === undefined) {
    try {
      cachedDefault = loadConfig().digest.times;
    } catch {
      cachedDefault = "08:00,18:00";
    }
  }
  return cachedDefault;
}

/**
 * GET  /api/preferences — the tenant's prefs (env defaults when none saved).
 * PUT  /api/preferences — partial update; CSRF-guarded by dispatchApi.
 */
export async function handlePreferences(
  _url: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  if (req.method === "GET") return getPrefs(res, deps);
  if (req.method === "PUT") return putPrefs(req, res, deps);
  res.writeHead(405, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "Method not allowed." }));
}

async function getPrefs(res: http.ServerResponse, deps: ServerDeps): Promise<void> {
  try {
    const prefs = (await getPreferences(deps.pool)) ?? {
      digestTimes: defaultDigestTimes(),
      morningNotification: true,
      engineConfig: {},
      theme: null,
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(prefs));
  } catch {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to load preferences." }));
  }
}

async function putPrefs(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const body = await readJsonBody(req);
  if (!body) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Malformed body." }));
    return;
  }

  const patch: Parameters<typeof upsertPreferences>[1] = {};
  if (typeof body["digestTimes"] === "string") {
    const spec = body["digestTimes"] as string;
    try {
      if (parseTimes(spec).length === 0) throw new Error("empty");
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "digestTimes must be non-empty CSV of HH:MM." }));
      return;
    }
    patch.digestTimes = spec;
  }
  if (typeof body["morningNotification"] === "boolean") {
    patch.morningNotification = body["morningNotification"] as boolean;
  }
  if (typeof body["engineConfig"] === "object" && body["engineConfig"] !== null) {
    patch.engineConfig = body["engineConfig"] as Record<string, unknown>;
  }
  if (typeof body["theme"] === "string" || body["theme"] === null) {
    patch.theme = body["theme"] as string | null;
  }

  try {
    const updated = await upsertPreferences(deps.pool, patch);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(updated));
  } catch {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to save preferences." }));
  }
}
