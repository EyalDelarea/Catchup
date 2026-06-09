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

/**
 * HTTP statuses from the WhatsApp media CDN that mean the bytes are
 * unrecoverable for us: 403 (the signed URL's `oe` expiry has passed), 404/410
 * (the encrypted blob was garbage-collected). Normally Baileys would refresh an
 * expired URL via `reuploadRequest`, but that peer-data path is broken on this
 * Baileys/account (see deep-history-via-full-sync), so these are all terminal.
 */
const GONE_STATUS = new Set([403, 404, 410]);

/** Textual fallback for errors that carry no statusCode (older/wrapped errors). */
const REUPLOAD_GONE = /\b403\b|\b404\b|\b410\b|not.?found|no longer available|gone/i;

/**
 * Extract the HTTP status from a download error. Baileys throws a Boom
 * (`output.statusCode`); other clients use `err.statusCode` or, axios-style,
 * `err.response.status`. Check all three.
 */
function statusOf(err: unknown): number | undefined {
  const e = err as {
    output?: { statusCode?: unknown };
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  const s = e?.output?.statusCode ?? e?.statusCode ?? e?.response?.status;
  return typeof s === "number" ? s : undefined;
}

/**
 * A download failure is "gone" (terminal) when the CDN status is in
 * {@link GONE_STATUS}, or — for errors without a status — when the message text
 * looks like a not-found/gone error. Baileys' "Failed to fetch stream" message
 * has NO embedded code, so the statusCode check is what actually catches it.
 */
function isGoneError(err: unknown): boolean {
  const status = statusOf(err);
  if (status !== undefined) return GONE_STATUS.has(status);
  const msg = err instanceof Error ? err.message : String(err);
  return REUPLOAD_GONE.test(msg);
}

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
  /**
   * Retire pending rows whose signed URL already expired (returns the count).
   * Run once per batch BEFORE selecting so the doomed rows never enter the queue
   * and their secrets are pruned promptly. Optional for testing.
   */
  sweepExpired?: () => Promise<number>;
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
  if (deps.sweepExpired) {
    const retired = await deps.sweepExpired();
    if (retired > 0)
      deps.log?.(`[media-backfill] retired ${retired} expired (unrecoverable) media`);
  }
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
      const status = statusOf(err);
      const msg = err instanceof Error ? err.message : String(err);
      // Surface the HTTP status in the recorded error so last_error is diagnosable
      // (the raw Baileys message — "Failed to fetch stream" — omits the code).
      const detail = status === undefined ? msg : `${msg} [HTTP ${status}]`;
      if (isGoneError(err)) {
        await deps.markUnrecoverable(row.messageId, detail);
      } else {
        await deps.recordAttempt(row.messageId, detail);
      }
      deps.log?.(`[media-backfill] message ${row.messageId} download failed: ${detail}`);
      continue;
    }

    // Persist + enqueue phase — any failure here is infrastructure, never "gone":
    // always a transient retry (the row stays pending; re-download is idempotent).
    // markPresentMedia (the state gate) is intentionally LAST: if enqueue throws,
    // download_state stays 'pending' so the row is retried next sweep.
    // Re-enqueue on retry is safe because the analysis worker guards with
    // hasAnalysis / hasTranscript checks on messageId.
    try {
      const path = await deps.writeFile(row.messageId, row.mediaKind, bytes);
      await deps.markPresentMessage(row.messageId, path);
      const job = analysisJobFor(row.mediaKind);
      if (job) await deps.enqueue(job, { messageId: String(row.messageId) });
      await deps.markPresentMedia(row.messageId, null);
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
