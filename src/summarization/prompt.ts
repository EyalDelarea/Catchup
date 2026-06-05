import type { SelectedMessage } from "./select.js";
import type { SummaryPrompt } from "./summarizer.js";

const BASE_INSTRUCTIONS = [
  "You summarize a WhatsApp group conversation for someone who missed it.",
  "Write a Hebrew markdown summary using ## section headings, in this exact order,",
  "OMITTING any section that has no substantive content:",
  "",
  "## תקציר",
  "(1–2 line TL;DR — always include this)",
  "",
  "## נושאים עיקריים",
  "(bulleted list of key topics/threads — include only when content exists)",
  "",
  "## החלטות ומשימות",
  "(bulleted decisions and action items — name the owner/responsible person when the chat stated one — include only when content exists)",
  "",
  "## שאלות פתוחות",
  "(bulleted unresolved questions — include only when content exists)",
  "",
  "## לפי משתתף",
  "(optional — notable per-person points — include only when genuinely useful)",
  "",
  "Rules:",
  "- Include a section ONLY when it has real content. A sparse chat may be just ## תקציר.",
  "- Be detailed and specific: make each bullet a full, informative sentence that captures the concrete details actually mentioned — who said/decided what, names, numbers, dates, places, links, and outcomes — not a vague one-word fragment.",
  "- Do not pad or invent content; detail must come from what was actually said. If little of substance was discussed, say so briefly and honestly.",
  "- Write the summary in the SAME LANGUAGE as the conversation (Hebrew in → Hebrew out).",
  "- Reply with the summary only — no preamble before the first ## heading.",
].join("\n");

/**
 * Return a message-count-aware length directive to append to the system prompt.
 * Tiers are calibrated to guide section depth without overriding the "don't pad" rule.
 */
function lengthDirective(count: number): string {
  if (count < 25) {
    return "Length guidance: this is a brief, small exchange — keep it concise, but still include any section that has real content (## תקציר plus topics/decisions/questions when present) and give each point its concrete specifics rather than a bare fragment.";
  }
  if (count < 100) {
    return "Length guidance: write several sections in good detail — ## תקציר plus the relevant topic, decision, and question sections, each as a bulleted list where every bullet is an informative sentence with the specifics that were discussed.";
  }
  if (count < 300) {
    return "Length guidance: write a comprehensive, detailed summary covering all relevant sections — main topics broken out, decisions with their owners, and open questions — with enough detail that a reader who missed the chat fully understands what happened.";
  }
  return "Length guidance: write an extensive, thorough summary that populates all relevant sections in depth, walking through every significant thread, all major decisions (with owners when stated), open questions, and notable per-person points — rich and specific, but never invented.";
}

/** Render a selected message as one transcript line. */
function renderLine(m: SelectedMessage): string {
  const ts = m.sentAt.toISOString().slice(0, 16).replace("T", " ");
  return `[${ts}] ${m.sender}: ${m.content}`;
}

/** Assemble the system + user prompt from selected messages. Pure function. */
export function buildPrompt(messages: SelectedMessage[]): SummaryPrompt {
  const transcript = messages.map(renderLine).join("\n");
  const system = `${BASE_INSTRUCTIONS}\n${lengthDirective(messages.length)}`;
  return {
    system,
    user: `Conversation:\n${transcript}`,
  };
}

/** Rough token estimate (~4 chars/token) for the over-budget guard. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
