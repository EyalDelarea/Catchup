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
 * `output` is normalized: `overview` is always the full markdown; v2 rows also
 * carry `tldr` + sectioned bullets (`{text, sourceMessageId?}`), v1 rows are
 * sectioned best-effort with no source links.
 * @param {string} group  - Exact group display name
 * @param {number} [limit] - Optional positive integer (default 50, max 200 server-side)
 * @returns {Promise<Array<{
 *   id: number,
 *   summaryType: "last_n"|"since"|"watermark",
 *   parameters: Record<string, unknown>,
 *   output: { version: 1|2, overview: string, tldr: string, topics: Array<{text:string, sourceMessageId?:number}>, decisions: Array<object>, openQuestions: Array<object>, actionItems: Array<object> },
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
 * Fetch a window of messages around a cited message, for the Ask source-jump
 * thread view.
 *
 * @param {{chat: string, aroundId: number, limit?: number}} params
 * @returns {Promise<Array<{id: number, sender: string, text: string, sentAt: string, fromMe: boolean}>>}
 */
export function getMessages({ chat, aroundId, limit }) {
  const qs = new URLSearchParams({ chat, aroundId: String(aroundId) });
  if (limit) qs.set("limit", String(limit));
  return fetch(`/api/messages?${qs.toString()}`).then((r) => {
    if (!r.ok) throw new Error(`messages ${r.status}`);
    return r.json();
  });
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
 *   cached(data)   — {summary, generatedAt}             — served from cache (summary = normalized structured summary); stream ends here
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

/**
 * Open an SSE stream to /api/ask and wire up event handlers.
 *
 * params:
 *   { q: "<question>" }            — required free-form question
 *   { q, chat: "<group name>" }    — optional: restrict retrieval to one chat
 *
 * handlers (all optional):
 *   phase(data)     — {phase: "searching"|"synthesizing"}  — progress before tokens
 *   token(data)     — {delta}                              — incremental answer token
 *   citations(data) — {citations: [{n, messageId, chat, sender, sentAt}]}
 *   done(data)      — {candidateCount}                     — stream ends here
 *   error(data)     — {message}                            — server-side error; stream ends here
 *
 * The caller is responsible for calling .close() on the returned EventSource
 * on "done" / "error". The native onerror fires when the connection drops;
 * we close automatically in that case and report it via handlers.error.
 *
 * @param {{q: string, chat?: string}} params
 * @param {Partial<Record<string, Function>>} handlers
 * @returns {EventSource}
 */
export function askStream(params, handlers = {}) {
  const qs = new URLSearchParams({ q: params.q });
  if (params.chat) qs.set("chat", params.chat);

  const es = new EventSource(`/api/ask?${qs}`);

  for (const event of ["phase", "token", "citations", "done", "error"]) {
    es.addEventListener(event, (e) => {
      handlers[event]?.(JSON.parse(e.data));
    });
  }

  es.onerror = () => {
    es.close();
    handlers.error?.({});
  };

  return es;
}

/**
 * Fetch all chats with their scope state (Sources / onboarding).
 * @returns {Promise<Array<{group: string, source: string, messageCount: number, lastMessageAt: string|null, included: boolean, categoryId: number|null, removed: boolean}>>}
 */
export function getScopes() {
  return fetch("/api/scopes").then((r) => {
    if (!r.ok) throw new Error(`scopes ${r.status}`);
    return r.json();
  });
}

/**
 * Apply a batch of scope updates. Same-origin (cookies + JSON) so the CSRF guard passes.
 * @param {Array<{group: string, included?: boolean, categoryId?: number|null, removed?: boolean}>} updates
 * @returns {Promise<{updated: number}>}
 */
export function putScopes(updates) {
  return fetch("/api/scopes", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ updates }),
  }).then((r) => {
    if (!r.ok) throw new Error(`putScopes ${r.status}`);
    return r.json();
  });
}

/**
 * Fetch the tenant's scope categories.
 * @returns {Promise<Array<{id: number, name: string, isSystem: boolean, sortOrder: number}>>}
 */
export function getScopeCategories() {
  return fetch("/api/scope-categories").then((r) => {
    if (!r.ok) throw new Error(`scope-categories ${r.status}`);
    return r.json();
  });
}

/**
 * Create a scope category.
 * @param {string} name
 * @returns {Promise<{id: number, name: string, isSystem: boolean, sortOrder: number}>}
 */
export function createScopeCategory(name) {
  return fetch("/api/scope-categories", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  }).then((r) => {
    if (!r.ok) throw new Error(`createScopeCategory ${r.status}`);
    return r.json();
  });
}

/**
 * Wipe the suggestion engine's learned feedback bias (§8 "איפוס למידה").
 * @returns {Promise<unknown>}
 */
export function resetSuggestionLearning() {
  return fetch("/api/suggestions/reset-learning", { method: "POST" }).then((r) => {
    if (!r.ok) throw new Error(`resetSuggestionLearning ${r.status}`);
    return r.json().catch(() => ({}));
  });
}

/**
 * @typedef {{
 *   digestTimes: string,
 *   morningNotification: boolean,
 *   engineConfig: Record<string, unknown>,
 *   theme: string|null
 * }} Preferences
 * `digestTimes` is a CSV of HH:MM ("08:00,18:00"); `engineConfig` is an opaque
 * blob owned by the suggestion engine (S6). When nothing is saved the server
 * returns env defaults.
 */

/**
 * Fetch the tenant's preferences.
 * @returns {Promise<Preferences>}
 */
export function getPreferences() {
  return fetch("/api/preferences").then((r) => {
    if (!r.ok) throw new Error(`preferences ${r.status}`);
    return r.json();
  });
}

/**
 * Apply a partial preferences update. Same-origin (cookies + JSON) so the CSRF
 * guard passes. `digestTimes`, when present, must be a non-empty CSV of HH:MM
 * (validated server-side — 400 on malformed). Returns the updated preferences.
 * @param {Partial<Preferences>} patch
 * @returns {Promise<Preferences>}
 */
export function putPreferences(patch) {
  return fetch("/api/preferences", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  }).then((r) => {
    if (!r.ok) throw new Error(`putPreferences ${r.status}`);
    return r.json();
  });
}

/**
 * @typedef {{
 *   id: number,
 *   kind: "task"|"meeting"|"followup"|"recap",
 *   chat: string,
 *   proposedText: string,
 *   reason: string,
 *   sourceMessageId: number|null
 * }} Suggestion
 */

/**
 * Fetch today's suggestion deck (§2 Today). `suggestions` is the pending deck —
 * already scope-filtered + capped server-side. `info` carries the read-only
 * cross-chat highlights for the info cards. Throws on a non-OK response; the
 * Today view treats that (e.g. a 404 while the engine endpoint is still being
 * built) as an empty deck and renders the empty state.
 * @returns {Promise<{
 *   suggestions: Suggestion[],
 *   info: { highlights: string, perChat: Array<{ chat: string, summary: string }> }
 * }>}
 */
export function getToday() {
  return fetch("/api/suggestions").then((r) => {
    if (!r.ok) throw new Error(`suggestions ${r.status}`);
    return r.json();
  });
}

/**
 * Act on a single suggestion. Same-origin (cookies + JSON) so the CSRF guard
 * passes. `accept` commits the suggestion's `proposedText`; `edit` commits
 * `finalText` (the user's edited draft); `snooze` defers it; `discard` removes
 * it from the deck. Returns the updated suggestion.
 * @param {number} id
 * @param {"accept"|"edit"|"snooze"|"discard"} action
 * @param {string} [finalText] - required for `edit`; the committed draft text
 * @returns {Promise<Suggestion>}
 */
export function actOnSuggestion(id, action, finalText) {
  const body = finalText === undefined ? { action } : { action, finalText };
  return fetch(`/api/suggestions/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => {
    if (!r.ok) throw new Error(`actOnSuggestion ${r.status}`);
    return r.json();
  });
}

/**
 * @typedef {{
 *   id: number,
 *   name: string,
 *   status: "active"|"cold-lead"|"warm"|"dormant",
 *   lastContactAt: string|null,
 *   openThreads: number,
 *   nextStep: string|null,
 *   sourceMessageId: number|null,
 *   chat: string|null
 * }} Person
 */

/**
 * Fetch the People/CRM list (§5). Derived server-side from messages. Throws on a
 * non-OK response; the People view treats that (e.g. a 404 while the endpoint is
 * still being built) as an empty list and renders the empty state.
 * @returns {Promise<Person[]>}
 */
export function getPeople() {
  return fetch("/api/people").then((r) => {
    if (!r.ok) throw new Error(`people ${r.status}`);
    return r.json();
  });
}

/**
 * @typedef {{
 *   id: number,
 *   title: string,
 *   startsAt: string|null,
 *   owner: string|null,
 *   chat: string,
 *   sourceMessageId: number
 * }} Meeting
 */

/**
 * Fetch extracted meetings (§6), optionally bounded by an ISO `from`/`to`
 * window. Throws on a non-OK response; the Agenda view renders an empty state.
 * @param {string} [from] - inclusive ISO lower bound
 * @param {string} [to] - exclusive ISO upper bound
 * @returns {Promise<Meeting[]>}
 */
export function getMeetings(from, to) {
  const qs = new URLSearchParams();
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  const suffix = qs.toString() ? `?${qs}` : "";
  return fetch(`/api/meetings${suffix}`).then((r) => {
    if (!r.ok) throw new Error(`meetings ${r.status}`);
    return r.json();
  });
}

/**
 * @typedef {{
 *   id: number,
 *   title: string,
 *   dueAt: string|null,
 *   owner: string|null,
 *   done: boolean,
 *   chat: string,
 *   sourceMessageId: number
 * }} Todo
 */

/**
 * Fetch extracted to-dos (§6). Throws on a non-OK response; the Agenda view
 * renders an empty state.
 * @returns {Promise<Todo[]>}
 */
export function getTodos() {
  return fetch("/api/todos").then((r) => {
    if (!r.ok) throw new Error(`todos ${r.status}`);
    return r.json();
  });
}

/**
 * Toggle a to-do's done state. Same-origin (cookies + JSON content-type) so the
 * CSRF guard passes. Returns the updated to-do.
 * @param {number} id
 * @param {boolean} done
 * @returns {Promise<Todo>}
 */
export function setTodoDone(id, done) {
  return fetch(`/api/todos/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ done }),
  }).then((r) => {
    if (!r.ok) throw new Error(`setTodoDone ${r.status}`);
    return r.json();
  });
}
