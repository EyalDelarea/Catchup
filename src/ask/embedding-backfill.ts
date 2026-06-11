import type { PendingEmbedding } from "../db/repositories/message-embeddings.js";

/**
 * Collaborators for the backfill, injected so the loop is unit-testable without a
 * DB or a live model. `selectPending` returns the next recent-first batch of
 * un-embedded messages; `embed` turns a batch of texts into vectors; `upsert`
 * persists one vector.
 */
export type EmbeddingBackfillDeps = {
  selectPending: (limit: number) => Promise<PendingEmbedding[]>;
  embed: (texts: string[]) => Promise<number[][]>;
  upsert: (messageId: number, embedding: number[]) => Promise<void>;
  log?: (msg: string) => void;
};

export type EmbeddingBackfillOpts = {
  /** Max messages to process this run (cap on compute). */
  limit: number;
  /** Messages per model call + select batch. */
  batchSize: number;
};

export type EmbeddingBackfillResult = { embedded: number };

/**
 * Embed un-embedded messages, recent-first, in batches, until either `limit`
 * messages are done or no pending messages remain.
 *
 * Resumable + idempotent by construction: each iteration re-queries the pending
 * set (an anti-join against message_embeddings), so already-embedded rows drop out
 * and a re-run continues where a previous run (or crash) stopped. No cursor state.
 *
 * Recent-first because the ask feature's questions skew recent ("what did I miss
 * today / this week"), so the most useful messages get embedded first when a full
 * backfill is run incrementally.
 */
export async function runEmbeddingBackfill(
  deps: EmbeddingBackfillDeps,
  opts: EmbeddingBackfillOpts,
): Promise<EmbeddingBackfillResult> {
  const log = deps.log ?? (() => {});
  let embedded = 0;

  while (embedded < opts.limit) {
    const take = Math.min(opts.batchSize, opts.limit - embedded);
    const batch = await deps.selectPending(take);
    if (batch.length === 0) break;

    const vectors = await deps.embed(batch.map((b) => b.content));
    for (let i = 0; i < batch.length; i++) {
      const vec = vectors[i];
      if (!vec) continue;
      await deps.upsert(batch[i]!.messageId, vec);
    }

    embedded += batch.length;
    log(`embedded ${embedded} message(s)…`);
  }

  return { embedded };
}
