import type { SuggestionKind } from "../db/repositories/suggestions.js";
import type { Draft, PerChatEntry } from "./suggest-pipeline.js";
import { buildSuggestPrompt } from "./suggest-prompts.js";
import type { Summarizer } from "./summarizer.js";

/**
 * Parse the model's JSON-array output into validated {@link Draft}s. Pure +
 * total: tolerant of surrounding prose (extracts the first `[...]`), drops items
 * with an out-of-scope groupId or empty text, and never throws. Bad/empty input
 * yields `[]`.
 */
export function parseSuggestDrafts(
  raw: string,
  kind: SuggestionKind,
  validGroupIds: Set<number>,
): Draft[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const drafts: Draft[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const groupId = typeof o.groupId === "number" ? o.groupId : Number(o.groupId);
    const proposedText = typeof o.proposedText === "string" ? o.proposedText.trim() : "";
    if (!Number.isFinite(groupId) || !validGroupIds.has(groupId) || proposedText === "") continue;
    const reason = typeof o.reason === "string" ? o.reason.trim() : "";
    // The extractor's input is summary text with no message ids, so any
    // `sourceMessageId` the model emits is fabricated — passing it through would
    // break the suggestions→messages(id) FK (the 23503 crash) or, on a
    // coincidental hit, mis-cite an unrelated message. Suggestions carry none.
    drafts.push({ kind, groupId, proposedText, reason, sourceMessageId: null });
  }
  return drafts;
}

/**
 * The runtime `extract` dependency for the suggest.generate handler: one
 * non-streaming Ollama call per kind, parsed via {@link parseSuggestDrafts}.
 */
export function makeOllamaExtractor(summarizer: Summarizer) {
  return async function extract(kind: SuggestionKind, perChat: PerChatEntry[]): Promise<Draft[]> {
    const validGroupIds = new Set(perChat.map((p) => p.groupId));
    const { overview } = await summarizer.summarize(buildSuggestPrompt(kind, perChat));
    return parseSuggestDrafts(overview, kind, validGroupIds);
  };
}
