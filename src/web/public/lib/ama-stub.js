/**
 * ama-stub.js — Ask-Me-Anything placeholder responder.
 *
 * The UI is complete; this returns a canned reply so the real retrieval logic
 * can be swapped in later by replacing `ask()`'s body with an API call. No DOM.
 */

export const CANNED_REPLY = "התשובות יחוברו בקרוב — ה־UI כבר מוכן ✨";

/** Create a fresh conversation state object. */
export function createConversation() {
  return { messages: [] };
}

/**
 * Ask a question. Pushes a user bubble + a canned assistant reply.
 * Empty/whitespace questions are ignored. Returns the same conversation.
 * @param {{messages: Array<{role:string,text:string}>}} conv
 * @param {string} question
 */
export function ask(conv, question) {
  const q = (question || "").trim();
  if (!q) return conv;
  conv.messages.push({ role: "user", text: q });
  conv.messages.push({ role: "assistant", text: CANNED_REPLY });
  return conv;
}
