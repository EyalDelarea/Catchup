import type pg from "pg";
import type { Candidate, RetrieveQuery, Retriever } from "./retriever.js";

/**
 * Tokenize a question into search terms: split on non-letter runs (Unicode-aware
 * so Hebrew is preserved), drop tokens shorter than 2 chars. Deliberately simple
 * — the OR-of-terms tsquery does the matching, ts_rank does the ranking.
 */
export function extractTerms(question: string): string[] {
  // Drop websearch_to_tsquery operator keywords: a query that reduces to only
  // one of these (e.g. "or") produces an empty tsquery, which PostgreSQL
  // rejects with "empty tsquery is not supported".
  const OPERATORS = new Set(["or", "and", "not"]);
  return question
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .filter((t) => !OPERATORS.has(t.toLowerCase()));
}

export class LexicalRetriever implements Retriever {
  constructor(private readonly pool: pg.Pool) {}

  async retrieve(q: RetrieveQuery): Promise<Candidate[]> {
    const terms = extractTerms(q.question);
    if (terms.length === 0) return [];
    // websearch_to_tsquery treats space as AND; we want OR across terms for recall.
    const tsquery = terms.join(" or ");

    const params: unknown[] = [tsquery, q.window.since, q.window.until, q.limit];
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
      rank: number;
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
             ts_rank(to_tsvector('simple', coalesce(m.text_content, '')),
                     websearch_to_tsquery('simple', $1)) AS rank
      FROM messages m
      JOIN groups g ON g.id = m.group_id
      LEFT JOIN participants p ON p.id = m.participant_id
      LEFT JOIN transcripts t ON t.message_id = m.id AND t.status = 'completed'
      LEFT JOIN media_analyses a ON a.message_id = m.id AND a.status = 'completed'
      WHERE m.message_type <> 'system'
        AND m.sent_at >= $2 AND m.sent_at <= $3
        -- FTS matches on text_content only (the GIN index column); returned content
        -- also includes transcript/description for display — PR2 (embeddings) covers those.
        AND to_tsvector('simple', coalesce(m.text_content, ''))
            @@ websearch_to_tsquery('simple', $1)
        ${chatFilter}
      ORDER BY rank DESC, m.sent_at DESC
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
      score: r.rank,
    }));
  }
}
