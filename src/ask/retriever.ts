import type { AskWindow } from "./time.js";

/** A retrieved candidate message, with a retriever-local rank score. */
export type Candidate = {
  messageId: number;
  chat: string; // groups.name
  sender: string; // participants.display_name, or "Unknown"
  sentAt: Date;
  content: string; // concat_ws(text_content, media description, transcript)
  score: number;
};

export type RetrieveQuery = {
  question: string;
  window: AskWindow;
  /** Optional group-name filter; when absent, search across all chats. */
  chat?: string;
  limit: number;
};

/** A source of candidate messages for a question. */
export interface Retriever {
  retrieve(q: RetrieveQuery): Promise<Candidate[]>;
}

/**
 * Reciprocal Rank Fusion: merge N ranked lists into one. Parameter-free beyond
 * `k` (standard default 60). A message ranked high by ANY list floats up; a
 * message ranked high by MULTIPLE lists floats highest. Deduped by messageId,
 * first-seen metadata wins. The returned `score` is the RRF score and REPLACES
 * any per-retriever score the input candidates carried. Sorted by score desc.
 */
export function fuse(lists: Candidate[][], k = 60): Candidate[] {
  const acc = new Map<number, { cand: Candidate; score: number }>();
  for (const list of lists) {
    list.forEach((c, rank) => {
      const inc = 1 / (k + rank + 1);
      const cur = acc.get(c.messageId);
      if (cur) cur.score += inc;
      else acc.set(c.messageId, { cand: c, score: inc });
    });
  }
  return [...acc.values()]
    .sort((a, b) => b.score - a.score)
    .map((e) => ({ ...e.cand, score: e.score }));
}
