/**
 * ask-jobs.js — async Ask job store.
 *
 * Pure data module (no DOM, no network). Each question fired from the Ask panel
 * becomes a job that survives in-session navigation; app.js drives the SSE and
 * the DOM and calls these to track lifecycle + notification (bell/panel/toast)
 * state. Scope is a group-name string or null (all-chats).
 *
 * Job: { id, q, scope, status:'working'|'ready'|'error', ts, read, answer, citations }
 * - born `read:true` (an in-flight question never counts as unread)
 * - becomes unread only when it settles `ready` while the user is elsewhere
 */

/** Create a fresh job store. */
export function createJobStore() {
  return { jobs: [] };
}

/** Append a new working job (pushed in send order; ts drives ordering). */
export function addJob(store, { id, q, scope, ts }) {
  const job = {
    id,
    q,
    scope: scope ?? null,
    status: "working",
    ts,
    read: true,
    answer: null,
    citations: [],
  };
  store.jobs.push(job);
  return job;
}

/** Find a job by id, or null. */
export function findJob(store, id) {
  return store.jobs.find((j) => j.id === id) ?? null;
}

/** Settle (or update) a job. Returns the job, or null if unknown. */
export function settleJob(store, id, { status, answer, citations, read } = {}) {
  const job = findJob(store, id);
  if (!job) return null;
  if (status !== undefined) job.status = status;
  if (answer !== undefined) job.answer = answer;
  if (citations !== undefined) job.citations = citations;
  if (read !== undefined) job.read = read;
  return job;
}

/** True if a working job already exists for this scope (one in-flight per scope). */
export function workingForScope(store, scope) {
  const s = scope ?? null;
  return store.jobs.some((j) => j.status === "working" && j.scope === s);
}

/** Mark one ready job read. */
export function markRead(store, id) {
  const job = findJob(store, id);
  if (job) job.read = true;
  return job;
}

/** Mark every ready job in a scope read (called when the user views that scope). */
export function markScopeRead(store, scope) {
  const s = scope ?? null;
  for (const j of store.jobs) {
    if (j.status === "ready" && j.scope === s) j.read = true;
  }
}

/** Mark every ready job read (the panel's "mark all"). */
export function markAllRead(store) {
  for (const j of store.jobs) {
    if (j.status === "ready") j.read = true;
  }
}

/** Count of ready+unread jobs across all scopes — the bell badge. */
export function unreadCount(store) {
  return store.jobs.filter((j) => j.status === "ready" && !j.read).length;
}

/** Ready jobs newest-first — the notification panel list. */
export function readyNewestFirst(store) {
  return store.jobs.filter((j) => j.status === "ready").slice().reverse();
}
