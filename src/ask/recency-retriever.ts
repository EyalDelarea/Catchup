import type pg from "pg";
import type { Candidate, RetrieveQuery, Retriever } from "./retriever.js";

/**
 * Recency retriever: returns the most recent messages in the window, newest
 * first, optionally scoped to one chat.
 *
 * Why this exists alongside the lexical retriever: a natural-language question
 * like "מה גיא שאל אותי היום" rarely shares content words with the actual replies
 * ("כנס", "אה", a link), so lexical FTS returns none of the relevant messages.
 * Such questions are really "recap this recent window" — recency surfaces the
 * actual recent messages so synthesis has real context. Fused with lexical via
 * RRF (see `fuse`), so it supplements rather than replaces keyword hits.
 *
 * Unlike the lexical retriever, the returned content concat is also what we rank
 * on, so media-only messages (NULL text_content but with a description or
 * transcript) are retrievable here.
 */
export class RecencyRetriever implements Retriever {
  constructor(private readonly pool: pg.Pool) {}

  async retrieve(q: RetrieveQuery): Promise<Candidate[]> {
    const params: unknown[] = [q.window.since, q.window.until, q.limit];
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
             ) AS content
      FROM messages m
      JOIN groups g ON g.id = m.group_id
      LEFT JOIN participants p ON p.id = m.participant_id
      LEFT JOIN transcripts t ON t.message_id = m.id AND t.status = 'completed'
      LEFT JOIN media_analyses a ON a.message_id = m.id AND a.status = 'completed'
      WHERE m.message_type <> 'system'
        AND m.sent_at >= $1 AND m.sent_at <= $2
        ${chatFilter}
      ORDER BY m.sent_at DESC
      LIMIT $3
      `,
      params,
    );

    // Score monotonic with recency so RRF input order (newest first) is stable.
    return rows.map((r) => ({
      messageId: Number(r.id),
      chat: r.chat,
      sender: r.sender,
      sentAt: r.sent_at,
      content: r.content,
      score: r.sent_at.getTime(),
    }));
  }
}
