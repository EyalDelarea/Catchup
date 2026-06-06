import "dotenv/config";
import type { JobBus } from "../jobs/job-bus.js";
import type { Job, JobType } from "../jobs/job-types.js";
import type { Logger } from "../logging/logger.js";

export type HandlerMap = {
  [T in JobType]?: (job: Job<T>) => Promise<void>;
};

export type BuildWorkerOptions = {
  bus: JobBus;
  handlers: HandlerMap;
  concurrency: number;
  /** Optional logger; defaults to no-op so tests produce no output. */
  logger?: Logger;
};

/** A no-op logger used in tests so worker test output stays clean. */
const noopLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => noopLogger,
  level: "silent",
  silent: () => {},
  isLevelEnabled: () => false,
} as unknown as Logger;

/**
 * Job types that must always use prefetch=1 for backpressure (slow jobs).
 * Transcription, vision analysis, and group summarization are GPU/LLM-bound
 * and can take seconds to minutes per item, so we never pre-fetch more than
 * one at a time regardless of --concurrency.
 */
const PREFETCH_ONE_TYPES = new Set<JobType>([
  "transcribe.voicenote",
  "analyze.image",
  "analyze.video",
  "summarize.group",
  "summarize.total",
]);

/**
 * Normalize a job type to a coarse operation label for metrics/dashboards.
 * (Summaries log op="summary" from the web server; not a worker job.)
 */
export function opForJobType(type: JobType): string {
  switch (type) {
    case "transcribe.voicenote":
      return "audio";
    case "analyze.image":
      return "image";
    case "analyze.video":
      return "video";
    case "import.file":
      return "import";
    case "summarize.group":
      return "summary";
    case "summarize.total":
      return "summary";
    default:
      return type;
  }
}

/**
 * Testable worker wiring: registers each handler in the map via bus.consume.
 *
 * Prefetch policy:
 * - `transcribe.voicenote` → always prefetch=1 (slow, CPU/GPU-bound)
 * - all other types → prefetch=concurrency (from --concurrency / config)
 *
 * Returns a close function for graceful shutdown.
 * The returned promise rejects if any consumer registration fails at startup.
 */
export async function buildWorker(
  opts: BuildWorkerOptions,
): Promise<{ close: () => Promise<void> }> {
  const { bus, handlers, concurrency } = opts;
  const log = opts.logger ?? noopLogger;

  // Collect all consume() promises so a failed registration surfaces loudly.
  const registerPromises: Promise<void>[] = [];

  // Register each handler type with correlated per-job logging
  for (const [type, handler] of Object.entries(handlers) as Array<
    [JobType, (job: Job) => Promise<void>]
  >) {
    if (handler) {
      const prefetch = PREFETCH_ONE_TYPES.has(type) ? 1 : concurrency;

      const wrappedHandler = async (job: Job): Promise<void> => {
        // Build correlation context: common fields + payload-specific ids
        const payload = job.payload as Record<string, unknown>;
        const ctx: Record<string, unknown> = {
          jobId: job.id,
          jobType: job.type,
        };
        if (typeof payload["messageId"] === "string") ctx["messageId"] = payload["messageId"];
        if (typeof payload["filePath"] === "string") ctx["filePath"] = payload["filePath"];

        const child = log.child(ctx);
        child.info("job received");
        const startedAt = Date.now();
        const op = opForJobType(job.type);
        try {
          await handler(job);
          child.info({ durationMs: Date.now() - startedAt, op }, "job done");
        } catch (err) {
          child.error({ err, durationMs: Date.now() - startedAt, op }, "job failed");
          throw err; // rethrow so the bus can retry / dead-letter
        }
      };

      registerPromises.push(
        bus.consume(type, wrappedHandler as (job: Job<typeof type>) => Promise<void>, { prefetch }),
      );
    }
  }

  // Await all registrations: a failed consumer surfaces loudly instead of being swallowed.
  await Promise.all(registerPromises);

  return {
    close: () => bus.close(),
  };
}

// ── Production entrypoint ────────────────────────────────────────────────────

/**
 * main() wires production dependencies and starts consuming the requested
 * job types (passed via --types).
 */
async function main(): Promise<void> {
  const [
    { loadConfig },
    { RabbitMqJobBus },
    { PostgresJobRunRecorder },
    { createDbClient },
    { makeImportFileHandler },
    { makeTranscribeVoicenoteHandler },
    { makeAnalyzeMediaHandler },
    { listUntranscribedVoiceNoteIdsByGroup, hasTranscript },
    { hasAnalysis, getVisualMediaPath, insertMediaAnalysis },
    { runImport },
    { transcribeOneNote },
    { analyzeMediaOne, normalizeImageWithFfmpeg },
    { analyzeVideo, extractFramesWithFfmpeg, extractAudioWithFfmpeg, fileSizeMbSync },
    { OllamaVisionAnalyzer },
    { IvritWhisperTranscriber },
    { createLogger },
    { pruneMediaFile },
    { resetStaleRunningJobs },
    pg,
  ] = await Promise.all([
    import("../config.js"),
    import("../jobs/rabbitmq-bus.js"),
    import("../jobs/job-run-recorder.js"),
    import("../db/client.js"),
    import("./handlers/import-file.js"),
    import("./handlers/transcribe-voicenote.js"),
    import("./handlers/analyze-media.js"),
    import("../db/repositories/transcripts.js"),
    import("../db/repositories/media-analyses.js"),
    import("../importer/run-import.js"),
    import("../transcription/run.js"),
    import("../vision/run.js"),
    import("../vision/analyze-video.js"),
    import("../vision/ollama-analyzer.js"),
    import("../transcription/ivrit-whisper.js"),
    import("../logging/logger.js"),
    import("../media/prune.js"),
    import("../db/repositories/job-runs.js"),
    import("pg"),
  ]);

  // Parse CLI args
  const args = process.argv.slice(2);
  const typesIdx = args.indexOf("--types");
  const concurrencyIdx = args.indexOf("--concurrency");

  const config = loadConfig();
  const logger = createLogger(config.logging);
  const concurrency =
    concurrencyIdx !== -1 ? Number(args[concurrencyIdx + 1]) : config.worker.concurrency;

  const dbClient = createDbClient();
  const recorder = new PostgresJobRunRecorder(dbClient);

  const bus = new RabbitMqJobBus({
    url: config.broker.url,
    recorder,
  });

  // Build a Postgres pool for the listUntranscribed query
  const pool = new pg.default.Pool({ connectionString: config.databaseUrl });

  // On startup, reset any orphaned 'running' rows from a previous crash/restart.
  const staleReset = await resetStaleRunningJobs(pool);
  if (staleReset > 0) {
    logger.warn(
      { staleReset },
      `Reset ${staleReset} stale 'running' job(s) to 'failed' on startup.`,
    );
  }

  const importFileHandler = makeImportFileHandler({
    runImport,
    listUntranscribed: async (result) => {
      return listUntranscribedVoiceNoteIdsByGroup(pool, result.groupName);
    },
    bus,
  });

  // Determine which types to register
  const requestedTypes: string[] =
    typesIdx !== -1 ? args[typesIdx + 1].split(",") : ["import.file"];

  const handlers: HandlerMap = {};
  if (requestedTypes.includes("import.file")) {
    handlers["import.file"] = importFileHandler;
  }
  if (requestedTypes.includes("transcribe.voicenote")) {
    const transcribeVoicenoteHandler = makeTranscribeVoicenoteHandler({
      isAlreadyTranscribed: (messageId) => hasTranscript(pool, messageId),
      transcribeOne: (messageId) =>
        transcribeOneNote(messageId, {
          databaseUrl: config.databaseUrl,
          transcriber: new IvritWhisperTranscriber({
            pythonPath: config.transcription.pythonPath,
            model: config.transcription.model,
            ffmpegPath: config.transcription.ffmpegPath,
          }),
          engine: config.transcription.model,
          ffmpegPath: config.transcription.ffmpegPath,
          convert: true,
          retainMedia: config.retainMedia,
          pruneMediaFile: (id) =>
            pruneMediaFile(pool, Number(id), { retainMedia: config.retainMedia }),
        }),
    });
    handlers["transcribe.voicenote"] = transcribeVoicenoteHandler;
  }
  if (requestedTypes.includes("analyze.image") || requestedTypes.includes("analyze.video")) {
    const ollamaAnalyzer = new OllamaVisionAnalyzer({
      host: config.summarization.ollamaHost,
      model: config.vision.model,
      numCtx: config.vision.numCtx,
    });
    // Video may use a different model (e.g. Gemma 4 multimodal) than image analysis.
    const videoAnalyzer =
      config.vision.videoModel === config.vision.model
        ? ollamaAnalyzer
        : new OllamaVisionAnalyzer({
            host: config.summarization.ollamaHost,
            model: config.vision.videoModel,
            numCtx: config.vision.numCtx,
          });
    const ffmpegPath = config.transcription.ffmpegPath;

    // Build a shared transcriber for video audio extraction.
    // open()/close() are called per analyzeVideo invocation via the injected function.
    const buildTranscribeAudio =
      () =>
      async (audioPath: string): Promise<string> => {
        const transcriber = new IvritWhisperTranscriber({
          pythonPath: config.transcription.pythonPath,
          model: config.transcription.model,
          ffmpegPath,
        });
        await transcriber.open();
        try {
          const { text } = await transcriber.transcribe(audioPath);
          return text;
        } finally {
          await transcriber.close();
        }
      };

    const analyzeMediaHandler = makeAnalyzeMediaHandler({
      hasAnalysis: (messageId) => hasAnalysis(pool, messageId),
      analyzeOne: (messageId, kind) =>
        analyzeMediaOne(messageId, kind, {
          pool,
          getVisualMediaPath: (id) => getVisualMediaPath(pool, id),
          visionAnalyzer: ollamaAnalyzer,
          normalizeImage: (imagePath) => normalizeImageWithFfmpeg(ffmpegPath, imagePath),
          insertMediaAnalysis: (input) => insertMediaAnalysis(pool, input),
          engineLabel: config.vision.model,
          // Video deps
          analyzeVideo: (input) =>
            analyzeVideo(
              {
                visionAnalyzer: videoAnalyzer,
                transcribeAudio: buildTranscribeAudio(),
                extractFrames: async (videoPath) => {
                  const { frames, dir } = await extractFramesWithFfmpeg(ffmpegPath, videoPath, {
                    fps: config.vision.videoFps,
                    maxFrames: config.vision.videoMaxFrames,
                  });
                  return { frames, dir };
                },
                extractAudio: (videoPath) => extractAudioWithFfmpeg(ffmpegPath, videoPath),
                maxVideoMb: config.vision.maxVideoMb,
                fileSizeMb: fileSizeMbSync,
              },
              input,
            ),
          getThumbnailPath: (_messageId) => Promise.resolve(null),
          retainMedia: config.retainMedia,
          pruneMediaFile: (id) => pruneMediaFile(pool, id, { retainMedia: config.retainMedia }),
        }),
    });

    if (requestedTypes.includes("analyze.image")) {
      handlers["analyze.image"] = (job) => analyzeMediaHandler(job, "analyze.image");
    }
    if (requestedTypes.includes("analyze.video")) {
      handlers["analyze.video"] = (job) => analyzeMediaHandler(job, "analyze.video");
    }
  }

  // summarize.group — handler wired in next phase (T009: topology registered here).
  // The job type, queues (jobs.summarize.group + .dead), and PREFETCH_ONE policy
  // are registered; the full handler implementation follows in the job-handler phase.
  if (requestedTypes.includes("summarize.group")) {
    const { makeSummarizeGroupHandler } = await import("./handlers/summarize-group.js");
    const { prepareCatchup } = await import("../summarization/prepare-catchup.js");
    const { insertSummary } = await import("../db/repositories/summaries.js");
    const { upsertWatermark } = await import("../db/repositories/read-watermarks.js");
    const { OllamaSummarizer } = await import("../summarization/summarizer.js");
    const ollamaSummarizer = new OllamaSummarizer({
      host: config.summarization.ollamaHost,
      model: config.summarization.model,
      numCtx: config.summarization.numCtx,
      temperature: config.summarization.temperature,
      repeatPenalty: config.summarization.repeatPenalty,
      numPredict: config.summarization.numPredict,
    });
    handlers["summarize.group"] = makeSummarizeGroupHandler({
      pool,
      prepareCatchup,
      summarize: async (prompt) => {
        const result = await ollamaSummarizer.summarize(prompt);
        return result.overview;
      },
      insertSummary,
      updateWatermark: upsertWatermark,
      model: config.summarization.model,
      tokenBudget: config.summarization.tokenBudget,
    });
  }

  if (requestedTypes.includes("summarize.total")) {
    const { makeSummarizeTotalHandler } = await import("./handlers/summarize-total.js");
    const { generateTotalSummary } = await import("../summarization/total-summary.js");
    const { insertTotalSummary } = await import("../db/repositories/total-summaries.js");
    const { OllamaSummarizer } = await import("../summarization/summarizer.js");
    const totalSummarizer = new OllamaSummarizer({
      host: config.summarization.ollamaHost,
      model: config.summarization.model,
      numCtx: config.summarization.numCtx,
      temperature: config.summarization.temperature,
      repeatPenalty: config.summarization.repeatPenalty,
      numPredict: config.summarization.numPredict,
    });
    handlers["summarize.total"] = makeSummarizeTotalHandler({
      pool,
      generateTotalSummary: (range) =>
        generateTotalSummary(
          {
            pool,
            summarizeStream: (prompt, o) => totalSummarizer.summarizeStream(prompt, o),
            tokenBudget: config.summarization.tokenBudget,
          },
          range,
        ),
      insertTotalSummary,
      model: config.summarization.model,
    });
  }

  const worker = await buildWorker({ bus, handlers, concurrency, logger });

  // Graceful shutdown (both SIGINT and SIGTERM)
  const gracefulShutdown = () => {
    void worker.close().then(() => {
      void pool.end();
      void dbClient.end();
      process.exit(0);
    });
  };
  process.on("SIGINT", gracefulShutdown);
  process.on("SIGTERM", gracefulShutdown);

  logger.info(
    { concurrency, types: Object.keys(handlers) },
    `Worker started (concurrency=${concurrency}, types=${Object.keys(handlers).join(",")})`,
  );
}

// Only run main when this file is the entrypoint
if (
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("worker.ts") || process.argv[1].endsWith("worker.js"))
) {
  main().catch((err) => {
    console.error("[worker] fatal error:", err);
    process.exit(1);
  });
}
