import type http from "node:http";
import {
  decideSuggestion,
  listPendingDeck,
  resetLearning,
  type SuggestionDecision,
} from "../../db/repositories/suggestions.js";
import { listTotalSummaries } from "../../db/repositories/total-summaries.js";
import type { ServerDeps } from "./context.js";
import { readJsonBody } from "./scopes.js";

const ACTION_TO_DECISION: Record<string, SuggestionDecision> = {
  accept: "accepted",
  edit: "edited",
  snooze: "snoozed",
  discard: "discarded",
};

/**
 * GET  /api/suggestions                 — today's deck + info cards.
 * PUT  /api/suggestions/:id             — decide a suggestion {action, finalText?}.
 * POST /api/suggestions/reset-learning  — wipe the feedback bias (§8).
 * Writes are CSRF-guarded by dispatchApi.
 */
export async function handleSuggestions(
  url: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const path = url.pathname;
  if (req.method === "GET" && path === "/api/suggestions") return getDeck(res, deps);
  if (req.method === "POST" && path === "/api/suggestions/reset-learning") return reset(res, deps);
  if (req.method === "PUT") {
    const m = /^\/api\/suggestions\/(\d+)$/.exec(path);
    if (m) return decide(Number(m[1]), req, res, deps);
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "Not found." }));
}

async function getDeck(res: http.ServerResponse, deps: ServerDeps): Promise<void> {
  try {
    const suggestions = await listPendingDeck(deps.pool);
    const [latest] = await listTotalSummaries(deps.pool, 1);
    const info = latest
      ? {
          highlights: latest.output.highlights,
          perChat: latest.output.perChat.map((p) => ({ chat: p.name, summary: p.summary })),
        }
      : { highlights: "", perChat: [] };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ suggestions, info }));
  } catch {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to load suggestions." }));
  }
}

async function decide(
  id: number,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const body = await readJsonBody(req);
  const action = typeof body?.action === "string" ? (body.action as string) : "";
  const decision = ACTION_TO_DECISION[action];
  if (!decision) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "action must be accept|edit|snooze|discard." }));
    return;
  }
  const finalText = typeof body?.finalText === "string" ? (body.finalText as string) : null;
  try {
    const ok = await decideSuggestion(deps.pool, id, decision, finalText);
    res.writeHead(ok ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(ok ? { ok: true } : { error: "Unknown suggestion." }));
  } catch {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to decide." }));
  }
}

async function reset(res: http.ServerResponse, deps: ServerDeps): Promise<void> {
  try {
    await resetLearning(deps.pool);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } catch {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to reset." }));
  }
}
