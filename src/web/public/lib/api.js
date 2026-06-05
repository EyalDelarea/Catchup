/**
 * api.js — Thin client API wrapper for the WhatsApp-Sum web UI.
 *
 * Browser ES module (plain JS, no TypeScript).
 * Uses browser globals: fetch and EventSource.
 * No DOM manipulation — purely data-fetching logic.
 *
 * NOT unit-tested here because fetch/EventSource are browser globals
 * without a DOM/browser test environment. Keep this module thin and
 * correct — all business logic belongs in time.js or the view layer.
 */

/**
 * Fetch the list of groups.
 *
 * @returns {Promise<Array<{name: string, source: string, messageCount: number, lastMessageAt: string|null}>>}
 */
export function getGroups() {
  return fetch("/api/groups").then((r) => r.json());
}

/**
 * Fetch the current service/system status.
 *
 * @returns {Promise<{
 *   service: { up: boolean, collectorConnected: boolean, lastHeartbeatAt: string|null, lastQrAt: string|null, stale: boolean },
 *   queues: Record<string, { depth: number }>,
 *   jobs: { pending: number, running: number, done: number, failed: number, dead: number },
 *   generatedAt: string,
 *   liveness: { healthy: boolean, lastHeartbeatAt: string|null } | null
 * }>}
 */
export function getStatus() {
  return fetch("/api/status").then((r) => r.json());
}

/**
 * Fetch stored summaries for a group (history view).
 *
 * @param {string} group  - Exact group display name
 * @param {number} [limit] - Optional positive integer (default 50, max 200 server-side)
 * @returns {Promise<Array<{
 *   id: number,
 *   summaryType: "last_n"|"since"|"watermark",
 *   parameters: Record<string, unknown>,
 *   output: { overview: string },
 *   model: string,
 *   createdAt: string
 * }>>}
 */
export function getSummaries(group, limit) {
  const url =
    `/api/summaries?group=${encodeURIComponent(group)}` +
    (limit ? `&limit=${limit}` : "");
  return fetch(url).then((r) => r.json());
}

/**
 * Open an SSE stream to /api/summarize and wire up event handlers.
 *
 * params shape (one of):
 *   { mode: "catchup" }           — summarize from the user's read watermark
 *   { last: N }                   — last N messages
 *   { since: "<ISO datetime>" }   — all messages since the given UTC timestamp
 *
 * handlers (all optional):
 *   syncing(data)  — {phase, fetched, fetchMs, partial} — progress while fetching messages
 *   status(data)   — {messages, usedFallback, stale}    — pre-summarise metadata
 *   token(data)    — {delta}                            — incremental LLM output token
 *   cached(data)   — {summary, generatedAt}             — served from cache; stream ends here
 *   empty()        — no messages found; stream ends here
 *   done(data)     — {summaryId, elapsedMs, fetchMs, summarizeMs, fetched, partial, stale}
 *   error(data)    — {message}                          — server-side error; stream ends here
 *
 * The caller is responsible for calling .close() on the returned EventSource when done
 * (on "cached", "empty", "done", "error"). The native onerror fires when the connection
 * drops; we close automatically in that case.
 *
 * @param {Record<string, string|number>} params
 * @param {Partial<Record<string, Function>>} handlers
 * @returns {EventSource}
 */
export function summarizeStream(params, handlers = {}) {
  const qs = new URLSearchParams(
    Object.fromEntries(
      Object.entries(params).map(([k, v]) => [k, String(v)])
    )
  );

  const es = new EventSource(`/api/summarize?${qs}`);

  // Events that carry JSON data
  const dataEvents = ["syncing", "status", "token", "cached", "done", "error"];
  for (const event of dataEvents) {
    es.addEventListener(event, (e) => {
      handlers[event]?.(JSON.parse(e.data));
    });
  }

  // "empty" carries no data payload
  es.addEventListener("empty", () => {
    handlers.empty?.();
  });

  // Native connection error — close the stream to avoid dangling connections
  es.onerror = () => {
    es.close();
  };

  return es;
}
