import type pg from "pg";
import type { NormalizedMessage } from "../../importer/types.js";

// ---------------------------------------------------------------------------
// Read queries
// ---------------------------------------------------------------------------

/**
 * Count readable messages for a group, using the same predicate as select.ts:
 * non-system; COALESCE(completed transcript, text_content) non-null and non-empty.
 */
export async function countReadableByGroup(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
): Promise<number> {
  const { rows } = await client.query<{ count: string }>(
    `
    SELECT COUNT(*) AS count
    FROM messages m
    LEFT JOIN transcripts t ON t.message_id = m.id AND t.status = 'completed'
    WHERE m.group_id = $1
      AND m.message_type <> 'system'
      AND COALESCE(t.transcript, m.text_content) IS NOT NULL
      AND length(trim(COALESCE(t.transcript, m.text_content))) > 0
    `,
    [groupId],
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Newest readable message timestamp for a group (any source — live OR imported),
 * using the same readable predicate as countReadableByGroup, or null when the group
 * has no readable messages. This is the correct pre-outage baseline for the boot
 * recovery signal: countReadableSince(group, getNewestReadableSentAt(group)) is ~0
 * unless genuinely newer messages arrive. (getNewestAnchor is external_id-filtered
 * for paging and is NOT a valid measurement baseline for imported groups.)
 */
export async function getNewestReadableSentAt(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
): Promise<Date | null> {
  const { rows } = await client.query<{ newest: Date | null }>(
    `
    SELECT MAX(m.sent_at) AS newest
    FROM messages m
    LEFT JOIN transcripts t ON t.message_id = m.id AND t.status = 'completed'
    WHERE m.group_id = $1
      AND m.message_type <> 'system'
      AND COALESCE(t.transcript, m.text_content) IS NOT NULL
      AND length(trim(COALESCE(t.transcript, m.text_content))) > 0
    `,
    [groupId],
  );
  return rows[0]?.newest ?? null;
}

/**
 * Count readable messages for a group strictly newer than `since` — same readable
 * predicate as countReadableByGroup, plus sent_at > since. Used as the boot-time
 * recovery signal (how many messages came back after the pre-outage snapshot).
 */
export async function countReadableSince(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
  since: Date,
): Promise<number> {
  const { rows } = await client.query<{ count: string }>(
    `
    SELECT COUNT(*) AS count
    FROM messages m
    LEFT JOIN transcripts t ON t.message_id = m.id AND t.status = 'completed'
    WHERE m.group_id = $1
      AND m.sent_at > $2
      AND m.message_type <> 'system'
      AND COALESCE(t.transcript, m.text_content) IS NOT NULL
      AND length(trim(COALESCE(t.transcript, m.text_content))) > 0
    `,
    [groupId, since],
  );
  return Number(rows[0]?.count ?? 0);
}

export type Anchor = {
  externalId: string;
  sentAt: Date;
  fromMe: boolean;
  remoteJid: string;
};

/**
 * Return the newest message for the group that has a non-null external_id,
 * joined to the group's whatsapp_id as remoteJid.
 * fromMe is COALESCE(from_me, false).
 * Returns null when no anchorable message exists or the group has no whatsapp_id.
 */
/**
 * Return the oldest sent_at timestamp for readable messages in a group,
 * or null when the group has no messages.
 * "Readable" uses the same predicate as countReadableByGroup.
 */
export async function getOldestSentAt(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
): Promise<Date | null> {
  const { rows } = await client.query<{ oldest: Date | null }>(
    `
    SELECT MIN(m.sent_at) AS oldest
    FROM messages m
    LEFT JOIN transcripts t ON t.message_id = m.id AND t.status = 'completed'
    WHERE m.group_id = $1
      AND m.message_type <> 'system'
      AND COALESCE(t.transcript, m.text_content) IS NOT NULL
      AND length(trim(COALESCE(t.transcript, m.text_content))) > 0
    `,
    [groupId],
  );
  return rows[0]?.oldest ?? null;
}

export async function getNewestAnchor(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
): Promise<Anchor | null> {
  const { rows } = await client.query<{
    external_id: string;
    sent_at: Date;
    from_me: boolean;
    whatsapp_id: string;
  }>(
    `
    SELECT m.external_id,
           m.sent_at,
           COALESCE(m.from_me, false) AS from_me,
           g.whatsapp_id
    FROM messages m
    JOIN groups g ON g.id = m.group_id
    WHERE m.group_id = $1
      AND m.external_id IS NOT NULL
      AND g.whatsapp_id IS NOT NULL
    ORDER BY m.sent_at DESC, m.id DESC
    LIMIT 1
    `,
    [groupId],
  );

  if (rows.length === 0) return null;

  const row = rows[0]!;
  return {
    externalId: row.external_id,
    sentAt: row.sent_at,
    fromMe: row.from_me,
    remoteJid: row.whatsapp_id,
  };
}

/**
 * True if a message with this (group_id, external_id) is already stored.
 *
 * Used by the live collector to skip the expensive — and occasionally
 * crash-prone — media download + insert for messages WhatsApp re-pushes on
 * every reconnect (the recent-history batch). Matches the (group_id, external_id)
 * partial unique index, so a hit here is exactly a row insertMessages would
 * reject as a duplicate.
 */
export async function messageExistsByExternalId(
  client: pg.Pool | pg.PoolClient,
  groupId: number,
  externalId: string,
): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM messages WHERE group_id = $1 AND external_id = $2 LIMIT 1`,
    [groupId, externalId],
  );
  return rows.length > 0;
}

type MessageRow = NormalizedMessage & {
  participantId: number | null;
};

type InsertResult = {
  inserted: number;
  skipped: number;
  /** IDs of newly inserted rows (empty when all were skipped). */
  ids: number[];
};

/**
 * Batch-insert normalized messages using ON CONFLICT (group_id, dedupe_key) DO NOTHING.
 * Returns { inserted, skipped } counts.
 *
 * Each row requires a pre-resolved participantId (nullable for system messages).
 */
export async function insertMessages(
  client: pg.Pool | pg.PoolClient,
  rows: MessageRow[],
): Promise<InsertResult> {
  if (rows.length === 0) {
    return { inserted: 0, skipped: 0, ids: [] };
  }

  let insertedTotal = 0;
  const insertedIds: number[] = [];

  // Insert one row at a time to accurately track rowCount per insert.
  // For large batches this could be optimized with unnest(), but correctness is
  // the priority for Chunk 1; batching optimization is deferred.
  for (const row of rows) {
    try {
      const result = await client.query<{ id: number }>(
        `
        INSERT INTO messages
          (group_id, participant_id, import_id, source, external_id, message_type,
           text_content, media_filename, media_path, media_status, sent_at, dedupe_key,
           from_me)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (group_id, dedupe_key) DO NOTHING
        RETURNING id
        `,
        [
          row.groupId,
          row.participantId,
          row.importId,
          row.source,
          row.externalId ?? null,
          row.messageType,
          row.textContent,
          row.mediaFilename,
          row.mediaPath,
          row.mediaStatus,
          row.sentAt,
          row.dedupeKey,
          row.fromMe ?? null,
        ],
      );
      const count = result.rowCount ?? 0;
      insertedTotal += count;
      for (const r of result.rows) {
        insertedIds.push(r.id);
      }
    } catch (err: unknown) {
      // Guard against edge-case unique violation on (group_id, external_id) partial index.
      // The dedupe_key conflict already handles the common duplicate path; this catch
      // handles the rare case where two live messages share the same external_id but
      // differ in dedupe_key (should not happen in practice, but we log and skip).
      const pgErr = err as { code?: string };
      if (pgErr.code === "23505") {
        // Unique violation — silently treat as a skipped duplicate (counted in the
        // returned `skipped` total). Logging per-row floods bulk history syncs, which
        // legitimately re-receive thousands of already-stored messages.
      } else {
        throw err;
      }
    }
  }

  return {
    inserted: insertedTotal,
    skipped: rows.length - insertedTotal,
    ids: insertedIds,
  };
}
