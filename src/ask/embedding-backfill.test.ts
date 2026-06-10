import { describe, expect, it } from "vitest";
import type { PendingEmbedding } from "../db/repositories/message-embeddings.js";
import { runEmbeddingBackfill } from "./embedding-backfill.js";

/**
 * A fake pending-set backed by an in-memory store: selectPending returns the next
 * un-embedded messages (recent-first order preserved by the caller), and upsert
 * marks them embedded — so the anti-join semantics of the real query are modeled
 * and we can prove resumability/idempotency without a DB.
 */
function fakeStore(messages: PendingEmbedding[]) {
  const embedded = new Map<number, number[]>();
  return {
    embedded,
    selectPending: async (limit: number): Promise<PendingEmbedding[]> =>
      messages.filter((m) => !embedded.has(m.messageId)).slice(0, limit),
    upsert: async (messageId: number, embedding: number[]): Promise<void> => {
      embedded.set(messageId, embedding);
    },
  };
}

const msgs = (n: number): PendingEmbedding[] =>
  Array.from({ length: n }, (_, i) => ({ messageId: i + 1, content: `msg ${i + 1}` }));

describe("runEmbeddingBackfill", () => {
  it("embeds every pending message in batches and stops when none remain", async () => {
    const store = fakeStore(msgs(5));
    const seenBatches: number[] = [];
    const res = await runEmbeddingBackfill(
      {
        selectPending: store.selectPending,
        upsert: store.upsert,
        embed: (texts) => {
          seenBatches.push(texts.length);
          return Promise.resolve(texts.map(() => [1, 2, 3]));
        },
      },
      { limit: 100, batchSize: 2 },
    );
    expect(res.embedded).toBe(5);
    expect(store.embedded.size).toBe(5);
    expect(seenBatches).toEqual([2, 2, 1]); // batched 2+2+1
  });

  it("respects the limit cap and leaves the rest for a later run", async () => {
    const store = fakeStore(msgs(10));
    const res = await runEmbeddingBackfill(
      {
        selectPending: store.selectPending,
        upsert: store.upsert,
        embed: (texts) => Promise.resolve(texts.map(() => [0])),
      },
      { limit: 3, batchSize: 5 },
    );
    expect(res.embedded).toBe(3);
    expect(store.embedded.size).toBe(3);
  });

  it("is resumable: a second run continues where the first stopped", async () => {
    const store = fakeStore(msgs(6));
    const embed = (texts: string[]) => Promise.resolve(texts.map(() => [9]));
    const first = await runEmbeddingBackfill(
      { selectPending: store.selectPending, upsert: store.upsert, embed },
      { limit: 4, batchSize: 2 },
    );
    const second = await runEmbeddingBackfill(
      { selectPending: store.selectPending, upsert: store.upsert, embed },
      { limit: 100, batchSize: 2 },
    );
    expect(first.embedded).toBe(4);
    expect(second.embedded).toBe(2); // only the remaining 2
    expect(store.embedded.size).toBe(6);
  });

  it("no-ops when nothing is pending", async () => {
    const store = fakeStore([]);
    const res = await runEmbeddingBackfill(
      {
        selectPending: store.selectPending,
        upsert: store.upsert,
        embed: () => Promise.reject(new Error("should not be called")),
      },
      { limit: 50, batchSize: 10 },
    );
    expect(res.embedded).toBe(0);
  });
});
