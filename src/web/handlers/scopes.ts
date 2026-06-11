import type http from "node:http";
import { listScopes, type ScopeUpdate, upsertScopes } from "../../db/repositories/chat-scopes.js";
import { findGroupByName } from "../../db/repositories/groups.js";
import type { ServerDeps } from "./context.js";

const MAX_BODY_BYTES = 256 * 1024;

/** Read + parse a JSON object body, capped. Returns null on any malformation. */
export async function readJsonBody(
  req: http.IncomingMessage,
): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) return null;
      chunks.push(chunk as Buffer);
    }
  } catch {
    return null;
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * GET  /api/scopes — all chats with their scope state (default-on projection).
 * PUT  /api/scopes — apply a batch of scope updates.
 * Mirrors handleSummaries' data access (findGroupByName + deps.pool); the PUT is
 * CSRF-guarded by dispatchApi before this runs.
 */
export async function handleScopes(
  _url: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  if (req.method === "GET") return getScopes(res, deps);
  if (req.method === "PUT") return putScopes(req, res, deps);
  res.writeHead(405, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "Method not allowed." }));
}

async function getScopes(res: http.ServerResponse, deps: ServerDeps): Promise<void> {
  try {
    const scopes = await listScopes(deps.pool);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        scopes.map((s) => ({
          group: s.group,
          source: s.source,
          messageCount: s.messageCount,
          lastMessageAt: s.lastMessageAt ? s.lastMessageAt.toISOString() : null,
          included: s.included,
          categoryId: s.categoryId,
          removed: s.removed,
        })),
      ),
    );
  } catch {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to load scopes." }));
  }
}

async function putScopes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const body = await readJsonBody(req);
  const rawUpdates = body?.["updates"];
  if (!Array.isArray(rawUpdates)) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Body must be { updates: [...] }." }));
    return;
  }
  try {
    const updates: ScopeUpdate[] = [];
    for (const u of rawUpdates) {
      if (typeof u !== "object" || u === null) continue;
      const rec = u as Record<string, unknown>;
      const name = typeof rec["group"] === "string" ? (rec["group"] as string) : null;
      if (!name) continue;
      const grp = await findGroupByName(deps.pool, name);
      if (!grp) continue; // unknown group names are tolerated (skipped)
      const update: ScopeUpdate = { groupId: grp.id };
      if (typeof rec["included"] === "boolean") update.included = rec["included"] as boolean;
      if (rec["categoryId"] === null || typeof rec["categoryId"] === "number") {
        update.categoryId = rec["categoryId"] as number | null;
      }
      if (typeof rec["removed"] === "boolean") update.removed = rec["removed"] as boolean;
      updates.push(update);
    }
    await upsertScopes(deps.pool, updates);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ updated: updates.length }));
  } catch {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to update scopes." }));
  }
}
