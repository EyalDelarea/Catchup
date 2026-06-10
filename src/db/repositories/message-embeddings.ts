import type pg from "pg";
import { toVectorLiteral } from "../../ask/embedder.js";

/** A message that still needs an embedding, with its display/embeddable content. */
export type PendingEmbedding = {
  messageId: number;
  content: string;
};

/**
 * The same content concat used by the retrievers: text plus any media description
 * or transcript, so media-only messages (NULL text_content) are still embeddable.
 * Empty-content rows (e.g. a sticker with no analysis yet) are excluded — there is
 * nothing meaningful to embed, and they'd just waste model calls.
 */
const CONTENT_CONCAT = `
  concat_ws(' — ',
    NULLIF(trim(m.text_content), ''),
    NULLIF(trim(a.description), ''),
    NULLIF(trim(t.transcript), '')
  )
`;

/**
 * Recent-first batch of messages that have no embedding row yet. Drives the
 * backfill: re-running picks up where it left off (rows that got embedded no longer
 * match the anti-join), so it is resumable and idempotent without a cursor table.
 * Optional chat scope mirrors the retrievers' `chat` filter.
 */
export async function selectMessagesNeedingEmbedding(
  client: pg.Pool | pg.PoolClient,
  opts: { limit: number; chat?: string },
): Promise<PendingEmbedding[]> {
  const params: unknown[] = [opts.limit];
  let chatFilter = "";
  if (opts.chat) {
    params.push(opts.chat);
    chatFilter = `AND g.name = $${params.length}`;
  }

  const { rows } = await client.query<{ id: string; content: string }>(
    `
    SELECT m.id, ${CONTENT_CONCAT} AS content
    FROM messages m
    JOIN groups g ON g.id = m.group_id
    LEFT JOIN transcripts t ON t.message_id = m.id AND t.status = 'completed'
    LEFT JOIN media_analyses a ON a.message_id = m.id AND a.status = 'completed'
    WHERE m.message_type <> 'system'
      AND NOT EXISTS (SELECT 1 FROM message_embeddings e WHERE e.message_id = m.id)
      AND ${CONTENT_CONCAT} <> ''
      ${chatFilter}
    ORDER BY m.sent_at DESC
    LIMIT $1
    `,
    params,
  );

  return rows.map((r) => ({ messageId: Number(r.id), content: r.content }));
}

/**
 * Insert (or replace) the embedding for a message. ON CONFLICT (message_id) makes
 * re-embedding idempotent — a second backfill pass, or a re-embed after a model
 * change, overwrites in place. tenant_id is left to its column default, which
 * resolves to the active `app.tenant_id` GUC (RLS) or the default tenant.
 */
export async function upsertEmbedding(
  client: pg.Pool | pg.PoolClient,
  input: { messageId: number; embedding: number[]; model: string },
): Promise<void> {
  await client.query(
    `
    INSERT INTO message_embeddings (message_id, embedding, model)
    VALUES ($1, $2::vector, $3)
    ON CONFLICT (message_id) DO UPDATE
      SET embedding = EXCLUDED.embedding,
          model     = EXCLUDED.model,
          created_at = now()
    `,
    [input.messageId, toVectorLiteral(input.embedding), input.model],
  );
}

/** How many messages have an embedding — for progress reporting in the backfill. */
export async function countEmbeddedMessages(client: pg.Pool | pg.PoolClient): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    "SELECT count(*) AS n FROM message_embeddings",
  );
  return Number(rows[0]?.n ?? 0);
}
