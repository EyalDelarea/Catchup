/**
 * media-backfill-loop.ts — runs in the serve process, throttled deferred media download.
 *
 * The serve process owns the WhatsApp socket, so download (and reupload of an
 * expired directPath) happens here; the heavy AI analysis stays in the worker.
 * For each `pending` row we reconstruct the WAMessage from its proto blob, ask
 * Baileys to download (refreshing directPath via reuploadRequest if stale),
 * write the file, flip media_status='present', and enqueue the EXISTING
 * analysis job. Per-item failures never abort the batch.
 */
import type { PendingMedia } from "../db/repositories/message-media.js";
import type { JobType } from "../jobs/job-types.js";

/** Filename extension per media kind, for the backfill writeFile sink. */
export const MEDIA_EXTENSIONS: Record<string, string> = {
  image: ".jpg",
  video: ".mp4",
  audio: ".opus",
  sticker: ".webp",
  document: ".bin",
};

const REUPLOAD_GONE = /\b404\b|\b410\b|not.?found|no longer available/i;

export type BackfillDeps = {
  selectPending: (limit: number) => Promise<PendingMedia[]>;
  decodeWaMessage: (blob: Buffer) => unknown;
  download: (waMessage: unknown) => Promise<Buffer>;
  /** Persist bytes; returns the absolute path written. */
  writeFile: (messageId: number, kind: PendingMedia["mediaKind"], bytes: Buffer) => Promise<string>;
  markPresentMessage: (messageId: number, path: string) => Promise<void>;
  markPresentMedia: (messageId: number, directPath: string | null) => Promise<void>;
  markUnrecoverable: (messageId: number, error: string) => Promise<void>;
  recordAttempt: (messageId: number, error: string) => Promise<void>;
  enqueue: (type: JobType, payload: { messageId: string }) => Promise<void>;
  log?: (msg: string) => void;
};

function analysisJobFor(kind: PendingMedia["mediaKind"]): JobType | null {
  if (kind === "image") return "analyze.image";
  if (kind === "video") return "analyze.video";
  if (kind === "audio") return "transcribe.voicenote";
  return null; // sticker / document → no analysis
}

/** Process up to `limit` pending rows once. Returns the count downloaded. */
export async function runBackfillBatch(deps: BackfillDeps, limit: number): Promise<number> {
  const pending = await deps.selectPending(limit);
  let done = 0;

  for (const row of pending) {
    if (!row.waMessage) {
      await deps.markUnrecoverable(row.messageId, "no stored proto blob to reconstruct media");
      continue;
    }

    // Download phase — only here can media be genuinely "gone" (reupload 404/410).
    let bytes: Buffer;
    try {
      bytes = await deps.download(deps.decodeWaMessage(row.waMessage));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (REUPLOAD_GONE.test(msg)) {
        await deps.markUnrecoverable(row.messageId, msg);
      } else {
        await deps.recordAttempt(row.messageId, msg);
      }
      deps.log?.(`[media-backfill] message ${row.messageId} download failed: ${msg}`);
      continue;
    }

    // Persist + enqueue phase — any failure here is infrastructure, never "gone":
    // always a transient retry (the row stays pending; re-download is idempotent).
    try {
      const path = await deps.writeFile(row.messageId, row.mediaKind, bytes);
      await deps.markPresentMessage(row.messageId, path);
      await deps.markPresentMedia(row.messageId, null);
      const job = analysisJobFor(row.mediaKind);
      if (job) await deps.enqueue(job, { messageId: String(row.messageId) });
      done++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await deps.recordAttempt(row.messageId, msg);
      deps.log?.(`[media-backfill] message ${row.messageId} persist failed: ${msg}`);
    }
  }
  return done;
}

export type BackfillLoopHandle = { stop: () => void };

/**
 * Start a polling loop that runs `runBackfillBatch` every `intervalMs`, with a
 * fresh-batch guard so runs never overlap. Throttle via batchSize/intervalMs.
 */
export function startBackfillLoop(
  deps: BackfillDeps,
  opts: { intervalMs: number; batchSize: number },
): BackfillLoopHandle {
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await runBackfillBatch(deps, opts.batchSize);
    } catch (err) {
      deps.log?.(
        `[media-backfill] batch error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick().catch(() => {});
  }, opts.intervalMs);
  if (typeof timer.unref === "function") timer.unref();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
