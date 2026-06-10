import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertGroup } from "../db/repositories/groups.js";
import {
  selectMessagesNeedingEmbedding,
  upsertEmbedding,
} from "../db/repositories/message-embeddings.js";
import { insertMessages } from "../db/repositories/messages.js";
import { upsertParticipant } from "../db/repositories/participants.js";
import type { NormalizedMessage } from "../importer/types.js";
import { createTestDatabase } from "../test/db.js";
import type { Embedder } from "./embedder.js";
import { runEmbeddingBackfill } from "./embedding-backfill.js";
import { EmbeddingRetriever } from "./embedding-retriever.js";

const DIM = 1024;

/** Build a sparse unit-ish vector with given dims set — distinct "concepts". */
function concept(...dims: number[]): number[] {
  const v = new Array(DIM).fill(0);
  for (const d of dims) v[d] = 1;
  return v;
}

/**
 * Deterministic fake embedder that maps Hebrew text to a small concept space by
 * keyword, so semantically related question/message pairs land near each other in
 * cosine space without invoking a real model. Mirrors the Embedder contract the
 * retriever and backfill depend on.
 */
const fakeEmbedder: Embedder = {
  model: "fake-test",
  dimension: DIM,
  embed: (texts) =>
    Promise.resolve(
      texts.map((t) => {
        if (/שאל|מסיבה|מתי/.test(t)) return concept(0); // "question / party" topic
        if (/חלב|לקנות|סופר/.test(t)) return concept(1); // "groceries" topic
        if (/כלב|תמונה|רוזי/.test(t)) return concept(2); // "dog photo" topic
        return concept(3); // unrelated
      }),
    ),
};

describe("EmbeddingRetriever (integration, pgvector)", () => {
  let pool: pg.Pool;
  let ids: number[];

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
    const groupId = await upsertGroup(pool, { name: "גיא דלריאה", source: "import" });
    const pid = await upsertParticipant(pool, "גיא");
    const base = (over: Partial<NormalizedMessage> & { dedupeKey: string; sentAt: Date }) => ({
      groupId,
      importId: null,
      source: "import" as const,
      externalId: null,
      senderName: "גיא" as string | null,
      messageType: "text" as const,
      textContent: null,
      mediaFilename: null,
      mediaPath: null,
      mediaStatus: null,
      fromMe: false,
      participantId: pid,
      ...over,
    });

    const res = await insertMessages(pool, [
      // [0] question/party
      base({
        textContent: "מתי המסיבה ביום שישי?",
        dedupeKey: "q1",
        sentAt: new Date("2026-06-09T19:00:00Z"),
      }),
      // [1] groceries
      base({
        textContent: "אל תשכח לקנות חלב בסופר",
        dedupeKey: "q2",
        sentAt: new Date("2026-06-09T10:00:00Z"),
      }),
      // [2] media-only: NULL text_content, description carries the meaning
      base({
        messageType: "media",
        textContent: null,
        dedupeKey: "q3",
        sentAt: new Date("2026-06-09T12:00:00Z"),
      }),
    ]);
    ids = res.ids;

    // Attach a media description to message [2] so its content concat is non-empty.
    await pool.query(
      `INSERT INTO media_analyses (message_id, kind, description, engine, status)
       VALUES ($1, 'image', 'תמונה של הכלב רוזי בפארק', 'test', 'completed')`,
      [ids[2]],
    );

    // Embed everything via the real backfill loop (exercises repo + idempotency).
    await runEmbeddingBackfill(
      {
        selectPending: (l) => selectMessagesNeedingEmbedding(pool, { limit: l }),
        embed: (texts) => fakeEmbedder.embed(texts),
        upsert: (messageId, embedding) =>
          upsertEmbedding(pool, { messageId, embedding, model: fakeEmbedder.model }),
      },
      { limit: 100, batchSize: 10 },
    );
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  const window = {
    since: new Date("2026-01-01T00:00:00Z"),
    until: new Date("2026-12-31T00:00:00Z"),
  };

  it("ranks the semantically-closest message first, even with zero shared words", async () => {
    const r = new EmbeddingRetriever(pool, fakeEmbedder);
    // The question shares NO surface words with "מתי המסיבה ביום שישי" beyond intent;
    // a keyword search would miss it. Semantic match should still surface it on top.
    const out = await r.retrieve({ question: "מה גיא שאל אותי", window, limit: 10 });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]!.content).toContain("המסיבה");
    expect(out[0]!.score).toBeGreaterThan(0.9); // cosine sim near 1 for same concept
    expect(out[0]!.chat).toBe("גיא דלריאה");
    expect(out[0]!.sender).toBe("גיא");
  });

  it("retrieves media-only messages via their description (NULL text_content)", async () => {
    const r = new EmbeddingRetriever(pool, fakeEmbedder);
    const out = await r.retrieve({ question: "תמונה של כלב", window, limit: 10 });
    expect(out[0]!.content).toContain("רוזי");
    expect(out[0]!.messageId).toBe(Number(ids[2])); // ids come back as bigint strings
  });

  it("honors the chat scope filter", async () => {
    const r = new EmbeddingRetriever(pool, fakeEmbedder);
    const inScope = await r.retrieve({
      question: "מה גיא שאל אותי",
      window,
      chat: "גיא דלריאה",
      limit: 10,
    });
    expect(inScope.length).toBeGreaterThan(0);
    const noScope = await r.retrieve({
      question: "מה גיא שאל אותי",
      window,
      chat: "לא קיים",
      limit: 10,
    });
    expect(noScope).toEqual([]);
  });

  it("excludes messages outside the time window", async () => {
    const r = new EmbeddingRetriever(pool, fakeEmbedder);
    const out = await r.retrieve({
      question: "מה גיא שאל אותי",
      window: { since: new Date("2020-01-01"), until: new Date("2020-12-31") },
      limit: 10,
    });
    expect(out).toEqual([]);
  });

  it("is idempotent: re-running the backfill embeds nothing new", async () => {
    const pending = await selectMessagesNeedingEmbedding(pool, { limit: 100 });
    expect(pending).toEqual([]); // all already embedded
  });

  it("degrades to [] when the embedder fails (so RRF falls back to other retrievers)", async () => {
    const throwingEmbedder: Embedder = {
      model: "boom",
      embed: () => Promise.reject(new Error("ollama down")),
    };
    const r = new EmbeddingRetriever(pool, throwingEmbedder);
    // A failing embedding model must NOT reject the whole ask — it yields no
    // candidates, leaving lexical/recency to answer.
    await expect(r.retrieve({ question: "מה גיא שאל אותי", window, limit: 10 })).resolves.toEqual(
      [],
    );
  });
});
