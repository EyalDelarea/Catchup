import type pg from "pg";
import { toVectorLiteral } from "../db/vector.js";
import type { Embedder } from "./embedder.js";
import type { Candidate, RetrieveQuery, Retriever } from "./retriever.js";

/**
 * Semantic retriever: embeds the question and returns the nearest messages by
 * cosine similarity over their stored embeddings.
 *
 * Why this exists alongside the lexical retriever: lexical FTS on Hebrew has poor
 * recall (~25% in an earlier spike) because a natural-language question rarely
 * shares surface words with the reply, and the 'simple' tsvector does no stemming.
 * Embeddings match on MEANING, so "מה גיא שאל אותי" can surface the actual question
 * even when no words overlap. Fused with lexical (+ recency when scoped) via RRF,
 * so it supplements rather than replaces keyword hits.
 *
 * Like recency (and unlike lexical), it ranks on the full content concat — so
 * media-only messages (NULL text_content but with a description or transcript) are
 * retrievable, provided they were embedded.
 *
 * Only messages that have been embedded are searchable; un-embedded messages are
 * simply invisible here (lexical/recency still cover them). Run `embed-backfill` to
 * populate embeddings.
 */
export class EmbeddingRetriever implements Retriever {
  constructor(
    private readonly pool: pg.Pool,
    private readonly embedder: Embedder,
  ) {}

  async retrieve(q: RetrieveQuery): Promise<Candidate[]> {
    const question = q.question.trim();
    if (question.length === 0) return [];

    // Semantic retrieval depends on a live embedding model (Ollama) plus the
    // pgvector query. If either fails, degrade to no candidates here so RRF falls
    // back to lexical (+ recency) rather than failing the whole ask — the other
    // retrievers (pure DB) don't share this network dependency. The failure is
    // logged (routed through pino by the serve console guard) for observability.
    try {
      const [vector] = await this.embedder.embed([question]);
      if (!vector) return [];
      const queryVec = toVectorLiteral(vector);

      // $1 query vector, $2 since, $3 until, $4 limit, [$5 chat]
      const params: unknown[] = [queryVec, q.window.since, q.window.until, q.limit];
      let chatFilter = "";
      if (q.chat) {
        params.push(q.chat);
        chatFilter = `AND g.name = $${params.length}`;
      }

      const { rows } = await this.pool.query<{
        id: string;
        chat: string;
        sender: string;
        sent_at: Date;
        content: string;
        score: number;
      }>(
        `
        SELECT m.id,
               g.name AS chat,
               COALESCE(p.display_name, 'Unknown') AS sender,
               m.sent_at,
               concat_ws(' — ',
                 NULLIF(trim(m.text_content), ''),
                 NULLIF(trim(a.description), ''),
                 NULLIF(trim(t.transcript), '')
               ) AS content,
               -- cosine distance (<=>) is in [0,2]; similarity = 1 - distance.
               1 - (e.embedding <=> $1::vector) AS score
        FROM message_embeddings e
        JOIN messages m ON m.id = e.message_id
        JOIN groups g ON g.id = m.group_id
        LEFT JOIN participants p ON p.id = m.participant_id
        LEFT JOIN transcripts t ON t.message_id = m.id AND t.status = 'completed'
        LEFT JOIN media_analyses a ON a.message_id = m.id AND a.status = 'completed'
        WHERE m.message_type <> 'system'
          AND m.sent_at >= $2 AND m.sent_at <= $3
          ${chatFilter}
        ORDER BY e.embedding <=> $1::vector
        LIMIT $4
        `,
        params,
      );

      return rows.map((r) => ({
        messageId: Number(r.id),
        chat: r.chat,
        sender: r.sender,
        sentAt: r.sent_at,
        content: r.content,
        score: r.score,
      }));
    } catch (err) {
      console.warn(
        `[ask] embedding retrieval failed; falling back to other retrievers: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }
}
