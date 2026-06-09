import type pg from "pg";

export type UpsertMessageMediaInput = {
  messageId: number;
  mediaKind: "image" | "video" | "audio" | "sticker" | "document";
  mimeType: string | null;
  mediaKey: Buffer | null;
  directPath: string | null;
  url: string | null;
  fileEncSha256: Buffer | null;
  fileSha256: Buffer | null;
  mediaKeyTs: number | null;
  fileLength: number | null;
  waMessage: Buffer | null;
  downloadState: "pending" | "present" | "unrecoverable" | "pruned";
};

export async function upsertMessageMedia(
  client: pg.Pool | pg.PoolClient,
  input: UpsertMessageMediaInput,
): Promise<void> {
  await client.query(
    `
    INSERT INTO message_media
      (message_id, media_kind, mime_type, media_key, direct_path, url,
       file_enc_sha256, file_sha256, media_key_ts, file_length, wa_message,
       download_state, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
    ON CONFLICT (message_id) DO UPDATE SET
      media_kind      = EXCLUDED.media_kind,
      mime_type       = EXCLUDED.mime_type,
      media_key       = COALESCE(message_media.media_key, EXCLUDED.media_key),
      wa_message      = COALESCE(message_media.wa_message, EXCLUDED.wa_message),
      file_enc_sha256 = COALESCE(message_media.file_enc_sha256, EXCLUDED.file_enc_sha256),
      file_sha256     = COALESCE(message_media.file_sha256, EXCLUDED.file_sha256),
      media_key_ts    = COALESCE(message_media.media_key_ts, EXCLUDED.media_key_ts),
      direct_path     = EXCLUDED.direct_path,
      url             = EXCLUDED.url,
      file_length     = EXCLUDED.file_length,
      download_state  = CASE
                          WHEN message_media.download_state = 'pending'
                          THEN EXCLUDED.download_state
                          ELSE message_media.download_state
                        END,
      updated_at      = now()
    `,
    [
      input.messageId,
      input.mediaKind,
      input.mimeType,
      input.mediaKey,
      input.directPath,
      input.url,
      input.fileEncSha256,
      input.fileSha256,
      input.mediaKeyTs,
      input.fileLength,
      input.waMessage,
      input.downloadState,
    ],
  );
}

export type PendingMedia = {
  messageId: number;
  mediaKind: "image" | "video" | "audio" | "sticker" | "document";
  waMessage: Buffer | null;
};

export async function selectPendingMedia(
  client: pg.Pool | pg.PoolClient,
  limit: number,
): Promise<PendingMedia[]> {
  const { rows } = await client.query<{
    message_id: string;
    media_kind: PendingMedia["mediaKind"];
    wa_message: Buffer | null;
  }>(
    `
    SELECT mm.message_id, mm.media_kind, mm.wa_message
    FROM message_media mm
    JOIN messages m ON m.id = mm.message_id
    WHERE mm.download_state = 'pending'
    ORDER BY m.sent_at ASC, mm.message_id ASC
    LIMIT $1
    `,
    [limit],
  );
  return rows.map((r) => ({
    messageId: Number(r.message_id),
    mediaKind: r.media_kind,
    waMessage: r.wa_message,
  }));
}

export async function markMediaPresent(
  client: pg.Pool | pg.PoolClient,
  messageId: number,
  directPath: string | null,
): Promise<void> {
  await client.query(
    `UPDATE message_media
       SET download_state='present', direct_path=COALESCE($2, direct_path),
           last_error=NULL, updated_at=now()
     WHERE message_id=$1`,
    [messageId, directPath],
  );
}

export async function markMediaUnrecoverable(
  client: pg.Pool | pg.PoolClient,
  messageId: number,
  error: string,
): Promise<void> {
  await client.query(
    `UPDATE message_media
       SET download_state='unrecoverable', last_error=$2, updated_at=now()
     WHERE message_id=$1`,
    [messageId, error],
  );
}

export async function recordMediaAttempt(
  client: pg.Pool | pg.PoolClient,
  messageId: number,
  error: string,
): Promise<void> {
  await client.query(
    `UPDATE message_media
       SET attempts = attempts + 1, last_error=$2, updated_at=now()
     WHERE message_id=$1`,
    [messageId, error],
  );
}

export async function pruneMediaSecrets(
  client: pg.Pool | pg.PoolClient,
  messageId: number,
): Promise<void> {
  await client.query(
    `UPDATE message_media
       SET media_key=NULL, wa_message=NULL, direct_path=NULL, url=NULL,
           download_state='pruned', updated_at=now()
     WHERE message_id=$1`,
    [messageId],
  );
}
