import type http from "node:http";
import { findGroupByName } from "../../db/repositories/groups.js";
import { getMessagesAround } from "../../db/repositories/messages.js";
import type { ServerDeps } from "./context.js";

/**
 * GET /api/messages?chat=<name>&aroundId=<id>&limit=<n>
 *
 * Read-only window of messages around a cited message, powering the Ask
 * source-jump thread view. Mirrors handleSummaries' data access (findGroupByName
 * + deps.pool) so it inherits the same tenancy treatment as /api/summaries.
 */
export async function handleMessages(
  url: URL,
  res: http.ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const chat = url.searchParams.get("chat");
  const aroundRaw = url.searchParams.get("aroundId");
  const aroundId = aroundRaw === null ? Number.NaN : Number.parseInt(aroundRaw, 10);
  if (!chat || !Number.isFinite(aroundId)) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Missing chat or aroundId." }));
    return;
  }

  let limit = 20;
  const rawLimit = url.searchParams.get("limit");
  if (rawLimit !== null) {
    const parsed = Number.parseInt(rawLimit, 10);
    limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 60) : 20;
  }

  try {
    const grp = await findGroupByName(deps.pool, chat);
    if (!grp) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
      return;
    }
    const rows = await getMessagesAround(deps.pool, grp.id, aroundId, limit);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        rows.map((m) => ({
          id: m.id,
          sender: m.sender,
          text: m.text,
          sentAt: m.sentAt.toISOString(),
          fromMe: m.fromMe,
        })),
      ),
    );
  } catch {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to load messages." }));
  }
}
