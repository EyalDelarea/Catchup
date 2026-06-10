/**
 * ama-conversation.js — Ask-Me-Anything conversation state.
 *
 * Pure data module (no DOM, no network) driven by the /api/ask SSE events:
 * `beginQuestion` adds the user bubble + a pending assistant reply, then the
 * stream handlers call `appendToken` / `finishAnswer` / `failAnswer` on it.
 */

const GENERIC_ERROR = "שגיאה בקבלת תשובה.";

/** Create a fresh conversation state object. */
export function createConversation() {
  return { messages: [] };
}

/**
 * Start a question: push a user bubble and a pending assistant reply.
 * Empty/whitespace questions are ignored.
 * @param {{messages: Array<object>}} conv
 * @param {string} question
 * @returns {object|null} the pending assistant message, or null if ignored
 */
export function beginQuestion(conv, question) {
  const q = (question || "").trim();
  if (!q) return null;
  conv.messages.push({ role: "user", text: q });
  const reply = { role: "assistant", text: "", pending: true, citations: [], error: null };
  conv.messages.push(reply);
  return reply;
}

/** Append a streamed answer token to the pending reply. */
export function appendToken(reply, delta) {
  reply.text += delta;
}

/** Mark the reply complete and attach its resolved citations. */
export function finishAnswer(reply, citations) {
  reply.pending = false;
  reply.citations = Array.isArray(citations) ? citations : [];
}

/** Mark the reply failed, keeping any partial text already streamed. */
export function failAnswer(reply, message) {
  reply.pending = false;
  reply.error = message || GENERIC_ERROR;
}
