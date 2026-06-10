import type { Candidate } from "./retriever.js";

/** A resolved citation: the 1-based marker number + the message it points to. */
export type Citation = {
  n: number;
  messageId: number;
  chat: string;
  sender: string;
  sentAt: Date;
};

/**
 * Extract `[n]` / `[n, m]` markers from the answer text and map each to the
 * candidate at index n-1. Deduped by n (first-seen order), out-of-range indices
 * dropped (the model occasionally invents a number).
 */
export function parseCitations(answer: string, candidates: Candidate[]): Citation[] {
  const seen = new Set<number>();
  const out: Citation[] = [];
  const groups = answer.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g);
  for (const g of groups) {
    for (const numStr of g[1]!.split(",")) {
      const n = Number(numStr.trim());
      if (!Number.isInteger(n) || seen.has(n)) continue;
      const c = candidates[n - 1];
      if (!c) continue; // out of range
      seen.add(n);
      out.push({ n, messageId: c.messageId, chat: c.chat, sender: c.sender, sentAt: c.sentAt });
    }
  }
  return out;
}
