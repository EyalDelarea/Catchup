import type { BiasEntry, SuggestionKind } from "../db/repositories/suggestions.js";

/** A per-chat summary entry from the total summary (the extraction input). */
export type PerChatEntry = { groupId: number; name: string; summary: string };

/** A draft suggestion produced by the extractor for one kind. */
export type Draft = {
  kind: SuggestionKind;
  groupId: number;
  proposedText: string;
  reason: string;
  sourceMessageId?: number | null;
};

/** Suppression thresholds: suppress a (kind,chat) with enough discards and a low accept ratio. */
export const SUPPRESS_MIN_NEG = 2;
export const SUPPRESS_MAX_RATIO = 0.34;

/** Keep only per-chat entries whose group is in the included set (S4). Pure. */
export function filterInScope(perChat: PerChatEntry[], includedGroupIds: Set<number>): PerChatEntry[] {
  return perChat.filter((p) => includedGroupIds.has(p.groupId));
}

/**
 * The set of `${kind}:${groupId}` keys to suppress: a pair the user has discarded
 * at least SUPPRESS_MIN_NEG times with an accept ratio below SUPPRESS_MAX_RATIO.
 * Pure — derived from the feedback bias map.
 */
export function suppressedKeys(bias: Map<string, BiasEntry>): Set<string> {
  const out = new Set<string>();
  for (const [key, { pos, neg }] of bias) {
    const total = pos + neg;
    if (neg >= SUPPRESS_MIN_NEG && total > 0 && pos / total < SUPPRESS_MAX_RATIO) {
      out.add(key);
    }
  }
  return out;
}

/** Drop drafts whose (kind,groupId) is suppressed. Pure. */
export function applySuppression(drafts: Draft[], suppressed: Set<string>): Draft[] {
  return drafts.filter((d) => !suppressed.has(`${d.kind}:${d.groupId}`));
}

/**
 * Stable, deterministic rank for capping: higher net positive bias for the
 * draft's (kind,chat) first; ties keep input order (so the extractor's own
 * ordering is honored). Returns a new sorted array. Pure.
 */
export function rankDrafts(drafts: Draft[], bias: Map<string, BiasEntry>): Draft[] {
  const score = (d: Draft): number => {
    const b = bias.get(`${d.kind}:${d.groupId}`);
    return b ? b.pos - b.neg : 0;
  };
  return drafts
    .map((d, i) => ({ d, i }))
    .sort((a, b) => score(b.d) - score(a.d) || a.i - b.i)
    .map((x) => x.d);
}

/** Keep the top `cap` drafts (Infinity → no cap). Pure. */
export function capDrafts(drafts: Draft[], cap: number): Draft[] {
  return Number.isFinite(cap) ? drafts.slice(0, Math.max(0, cap)) : drafts;
}
