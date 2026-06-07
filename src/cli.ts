#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import "dotenv/config";
import { loadConfig } from "./config.js";
import { runImport } from "./importer/run-import.js";
import type { JobBus } from "./jobs/job-bus.js";

const program = new Command();

program
  .name("catchup")
  .description("Local-first WhatsApp export importer and summarizer")
  .version("0.1.0");

program
  .command("import")
  .description(
    "Import a WhatsApp export. Single-file: import <path> --name <name>. Bulk: import --folder <dir>",
  )
  .argument("[path]", "Path to exported WhatsApp chat file (.txt or .zip)")
  .option("--name <name>", "Group or chat display name (required for single-file mode)")
  .option("--folder <dir>", "Folder to scan for .txt/.zip exports and enqueue as background jobs")
  .action(async (filePath: string | undefined, options: { name?: string; folder?: string }) => {
    const { folder, name } = options;

    // ── --folder mode ─────────────────────────────────────────────────────
    if (folder !== undefined) {
      // Mutual exclusion: --folder cannot be combined with <path> or --name
      if (filePath !== undefined) {
        process.stderr.write(
          "Error: --folder and a positional <path> are mutually exclusive. Use one or the other.\n",
        );
        process.exit(1);
      }
      if (name !== undefined) {
        process.stderr.write(
          "Error: --folder and --name are mutually exclusive. --name is only for single-file mode.\n",
        );
        process.exit(1);
      }

      // Validate directory exists
      if (!fs.existsSync(folder)) {
        process.stderr.write(`Error: Folder not found: ${folder}\n`);
        process.exit(1);
      }
      if (!fs.statSync(folder).isDirectory()) {
        process.stderr.write(`Error: Not a directory: ${folder}\n`);
        process.exit(1);
      }

      try {
        const { enqueueFolder } = await import("./importer/bulk-import.js");

        // Test-only seam: an in-memory bus discards jobs when the process
        // exits, so it is gated on NODE_ENV=test and can NEVER be activated
        // in production (where it would silently swallow enqueued jobs).
        let bus: JobBus;
        if (process.env["USE_IN_MEMORY_BUS"] === "1" && process.env["NODE_ENV"] === "test") {
          const { InMemoryJobBus } = await import("./jobs/in-memory-bus.js");
          const { InMemoryJobRunRecorder } = await import("./jobs/job-run-recorder.js");
          bus = new InMemoryJobBus(new InMemoryJobRunRecorder());
        } else {
          const { RabbitMqJobBus } = await import("./jobs/rabbitmq-bus.js");
          const { PostgresJobRunRecorder } = await import("./jobs/job-run-recorder.js");
          const { createDbClient } = await import("./db/client.js");
          const config = loadConfig();
          const dbClient = createDbClient();
          const recorder = new PostgresJobRunRecorder(dbClient);
          bus = new RabbitMqJobBus({ url: config.broker.url, recorder });
        }

        const result = await enqueueFolder(bus, folder);
        console.log(`Enqueued ${result.enqueued} import jobs.`);
        await bus.close();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: Failed to enqueue folder: ${message}\n`);
        process.exit(1);
      }
      return;
    }

    // ── Single-file mode (original behaviour, unchanged) ──────────────────
    if (filePath === undefined) {
      process.stderr.write(
        "Error: A file path is required in single-file mode. Use import <path> --name <name>.\n",
      );
      process.exit(1);
    }

    if (name === undefined) {
      process.stderr.write("Error: --name <name> is required in single-file mode.\n");
      process.exit(1);
    }

    // T018 — error: missing file
    if (!fs.existsSync(filePath)) {
      process.stderr.write(`Error: File not found: ${filePath}\n`);
      process.exit(1);
    }

    // T018 — error: unsupported extension
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== ".txt" && ext !== ".zip") {
      process.stderr.write(
        `Error: Unsupported file type "${ext}". Only .txt and .zip exports are supported.\n`,
      );
      process.exit(1);
    }

    try {
      const result = await runImport({ filePath, name });
      // Contract output: Imported "<name>": <inserted> new, <skipped> duplicate, <media> media files.
      console.log(
        `Imported "${result.groupName}": ${result.inserted} new, ${result.skipped} duplicate, ${result.mediaFiles} media files.`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Error: Import failed: ${message}\n`);
      process.exit(1);
    }
  });

program
  .command("collect")
  .description("Start live WhatsApp message collection (links via QR code on first run)")
  .action(async () => {
    const config = loadConfig();
    const authDir = path.join(config.dataDir, "baileys-auth");
    const dbUrl = config.databaseUrl;

    // Import lazily to avoid loading Baileys at startup for non-collect commands
    const [{ startSession }, { handleIncomingMessage }, pg] = await Promise.all([
      import("./collector/session.js"),
      import("./collector/collector.js"),
      import("pg"),
    ]);

    const pool = new pg.default.Pool({ connectionString: dbUrl });
    let storedCount = 0;

    // SAFETY BANNER — make the outbound posture unmistakable before linking.
    if (config.whatsapp.allowSend) {
      console.log(
        "⚠️  SENDING ENABLED (WHATSAPP_ALLOW_SEND=true): this tool may transmit to WhatsApp.",
      );
    } else {
      console.log(
        "🔒 Read-only mode: this tool will NOT send messages, read receipts, or presence.\n" +
          "   It is a passive observer. (Sending stays off unless you set WHATSAPP_ALLOW_SEND=true.)",
      );
    }

    const session = await startSession(authDir, config.whatsapp.allowSend);

    session.on("qr", () => {
      console.log("Scan the QR code above with WhatsApp to link your account.");
    });

    session.on("connected", () => {
      console.log("Collecting… stored 0 messages");
      // Proactive name resolution: resolve quiet groups that have never sent
      // a new live message (fire-and-forget; must not block collection startup).
      import("./collector/name-resolver.js")
        .then(({ resolveAllGroupNames }) =>
          resolveAllGroupNames(pool, {
            groupSubject: (jid) => session.groupSubject(jid),
          }),
        )
        .then(({ resolved }) => {
          if (resolved > 0) {
            console.log(`[name-resolver] resolved ${resolved} group name(s).`);
          }
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[name-resolver] error: ${msg}\n`);
        });
    });

    session.on("message", async (msg) => {
      try {
        const stored = await handleIncomingMessage(pool, msg, {
          dataDir: config.dataDir,
          downloadVoiceNote: (m) => session.downloadMedia(m),
          downloadImage: (m) => session.downloadMedia(m),
          downloadVideo: (m) => session.downloadMedia(m),
          groupSubject: (jid) => session.groupSubject(jid),
        });
        if (stored) {
          storedCount++;
          console.log(`Collecting… stored ${storedCount} messages`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Warning: failed to store message: ${message}\n`);
      }
    });

    // Graceful shutdown on Ctrl-C
    process.on("SIGINT", () => {
      console.log(`\nStopping collector. Stored ${storedCount} messages total.`);
      session.stop();
      pool
        .end()
        .catch(() => {})
        .finally(() => {
          process.exit(0);
        });
    });
  });

program
  .command("groups")
  .description("List imported WhatsApp groups and chats")
  .action(async () => {
    const { listGroups } = await import("./db/repositories/groups.js");
    const pg = await import("pg");
    const pool = new pg.default.Pool({ connectionString: loadConfig().databaseUrl });
    try {
      const groups = await listGroups(pool);
      if (groups.length === 0) {
        console.log("No chats stored yet.");
        return;
      }
      groups.forEach((g, i) => {
        console.log(`${i + 1}. ${g.name} (${g.source}, ${g.messageCount} messages)`);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Error: ${message}\n`);
      process.exit(1);
    } finally {
      await pool.end();
    }
  });

program
  .command("summarize")
  .description("Summarize an imported WhatsApp group or chat (runs locally via Ollama)")
  .argument("<name>", "Group or chat display name")
  .option("--last <count>", "Summarize the last N messages")
  .option("--since <date>", "Summarize messages since a date (YYYY-MM-DD)")
  .option("--out <file>", "Write the rendered summary to a file")
  .action(async (name: string, options: { last?: string; since?: string; out?: string }) => {
    // Arg validation (FR-023): exactly one of --last / --since; default --last 25.
    if (options.last !== undefined && options.since !== undefined) {
      process.stderr.write("Error: use only one of --last or --since.\n");
      process.exit(1);
    }
    let selection: { last: number } | { since: Date };
    if (options.since !== undefined) {
      const since = new Date(options.since);
      if (Number.isNaN(since.getTime())) {
        process.stderr.write(`Error: invalid --since date "${options.since}". Use YYYY-MM-DD.\n`);
        process.exit(1);
      }
      selection = { since };
    } else {
      const n = options.last !== undefined ? Number(options.last) : 25;
      if (!Number.isInteger(n) || n <= 0) {
        process.stderr.write(`Error: --last must be a positive integer (got "${options.last}").\n`);
        process.exit(1);
      }
      selection = { last: n };
    }

    const { runSummarize } = await import("./summarization/summarize.js");
    const { renderSummary } = await import("./summarization/render.js");
    try {
      const result = await runSummarize({ groupName: name, selection });
      if (result.kind === "empty") {
        console.log("Nothing to summarize for that selection.");
        return;
      }
      const text = renderSummary(result.output);
      if (options.out) {
        const fsp = await import("node:fs/promises");
        await fsp.writeFile(options.out, text + "\n", "utf8");
        console.log(`Saved summary to ${options.out}.`);
      } else {
        console.log(text);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${message}\n`);
      process.exit(1);
    }
  });

program
  .command("transcribe")
  .description("Transcribe pending Hebrew voice notes locally (nothing leaves the machine)")
  .option("--group <name>", "Only transcribe voice notes in this group")
  .action(async (options: { group?: string }) => {
    // Lazy import keeps faster-whisper/spawn out of other commands' startup.
    const { runTranscription } = await import("./transcription/run.js");
    try {
      const result = await runTranscription({ groupName: options.group });
      console.log(
        `Transcribed ${result.ok}, failed ${result.failed}, skipped ${result.skipped} voice notes.`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Error: Transcription failed: ${message}\n`);
      process.exit(1);
    }
  });

program
  .command("serve")
  .description("Start the local web UI for summarizing (stays on your machine)")
  .option("--port <port>", "Port to listen on")
  .option("--collect", "Also run the always-on live collector (links WhatsApp via QR on first run)")
  .action(async (options: { port?: string; collect?: boolean }) => {
    const config = loadConfig();
    const port = options.port ? Number(options.port) : config.web.port;
    if (!Number.isInteger(port) || port <= 0) {
      process.stderr.write(`Error: invalid --port "${options.port}".\n`);
      process.exit(1);
    }
    const [
      { createServer },
      { OllamaSummarizer },
      { RabbitMqJobBus },
      { PostgresJobRunRecorder },
      { createDbClient },
      pg,
      { backfillGroup },
      { isHealthy, getLastHeartbeatAt },
      { createLogger },
      { startScheduler },
      { parseTimes },
      { enqueueScheduledRun },
      { getLastRun, recordRun },
      { recoverOnReconnect },
      { selectActiveGroups },
      { getNewestAnchor },
      { getServiceStatus, isStale },
    ] = await Promise.all([
      import("./web/server.js"),
      import("./summarization/summarizer.js"),
      import("./jobs/rabbitmq-bus.js"),
      import("./jobs/job-run-recorder.js"),
      import("./db/client.js"),
      import("pg"),
      import("./collector/backfill.js"),
      import("./service/liveness.js"),
      import("./logging/logger.js"),
      import("./scheduler/runner.js"),
      import("./scheduler/schedule.js"),
      import("./scheduler/enqueue-run.js"),
      import("./db/repositories/scheduler-state.js"),
      import("./collector/reconnect-recovery.js"),
      import("./summarization/select-active-groups.js"),
      import("./db/repositories/messages.js"),
      import("./db/repositories/service-status.js"),
    ]);
    const webLogger = createLogger(config.logging);
    const pool = new pg.default.Pool({ connectionString: config.databaseUrl });
    const summarizer = new OllamaSummarizer({
      host: config.summarization.ollamaHost,
      model: config.summarization.model,
      numCtx: config.summarization.numCtx,
      temperature: config.summarization.temperature,
      repeatPenalty: config.summarization.repeatPenalty,
      numPredict: config.summarization.numPredict,
    });

    // Build a RabbitMQ bus for best-effort queue depth queries.
    // When --collect is active this same bus is reused for enqueuing transcription
    // jobs so we never create a second connection.
    const dbClient = createDbClient();
    const recorder = new PostgresJobRunRecorder(dbClient);
    const brokerBus = new RabbitMqJobBus({ url: config.broker.url, recorder });
    const getQueueDepths = async () => {
      const types = ["import.file", "transcribe.voicenote"] as const;
      const result: Record<string, number> = {};
      await Promise.all(
        types.map(async (type) => {
          try {
            result[type] = await brokerBus.depth(type);
          } catch {
            // broker unreachable for this type — omit so depth stays null
          }
        }),
      );
      return result as Partial<Record<(typeof types)[number], number>>;
    };

    // liveSession is set after startSession succeeds (in the --collect block below).
    // Typed as `any` to avoid a circular import with CollectorSession.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let liveSession: any = null;

    const collectDeps = options.collect
      ? {
          getLiveness: () => ({
            healthy: isHealthy(60_000),
            lastHeartbeatAt: getLastHeartbeatAt() != null ? new Date(getLastHeartbeatAt()!) : null,
          }),
          backfillTargetWindow: 25,
          backfill: async (groupId: number) => {
            if (!liveSession) return { fetched: 0, durationMs: 0, partial: true };
            const { rows } = await pool.query<{ whatsapp_id: string }>(
              "SELECT whatsapp_id FROM groups WHERE id=$1",
              [groupId],
            );
            const jid = rows[0]?.whatsapp_id;
            if (!jid) return { fetched: 0, durationMs: 0, partial: true };
            return backfillGroup({
              pool,
              groupId,
              dataDir: config.dataDir,
              targetWindow: 25,
              maxFetch: 200,
              timeoutMs: 10_000,
              fetchHistory: (
                c: number,
                a: import("./collector/backfill.js").AnchorKey,
                ts: number,
              ) => liveSession.fetchMessageHistory(c, a, ts),
              awaitHistory: (toMs: number) => liveSession.awaitHistorySync(jid, toMs),
              downloadVoiceNote: (m: import("@whiskeysockets/baileys").WAMessage) =>
                liveSession.downloadMedia(m),
            });
          },
        }
      : {};

    const server = createServer({
      pool,
      summarizer,
      tokenBudget: config.summarization.tokenBudget,
      model: config.summarization.model,
      getQueueDepths,
      logger: webLogger,
      ...collectDeps,
    });
    server.on("error", (err: Error) => {
      process.stderr.write(`Error: could not start server on port ${port}: ${err.message}\n`);
      process.exit(1);
    });
    server.listen(port, () => {
      console.log(`Web UI running at http://localhost:${port}  (Ctrl-C to stop)`);
    });

    // ── Scheduled digest runner ──────────────────────────────────────────────
    let schedulerHandle: { stop: () => void } = { stop: () => {} };
    try {
      const parsedTimes = parseTimes(config.digest.times);
      schedulerHandle = startScheduler({
        pool,
        bus: brokerBus,
        times: parsedTimes,
        enabled: config.digest.enabled,
        now: () => new Date(),
        setTimer: (cb, ms) => setTimeout(cb, ms),
        getLastRun,
        recordRun,
        enqueueRun: enqueueScheduledRun,
      });
      if (config.digest.enabled) {
        console.log(`[scheduler] digest scheduler started (times: ${config.digest.times})`);
      }
    } catch (err) {
      // Scheduler startup failure must NOT crash the web server
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[scheduler] startup error (web server continues): ${msg}\n`);
    }

    // ── Ops-sweep scheduler ──────────────────────────────────────────────────
    let opsSweepHandle: { stop: () => void } = { stop: () => {} };
    try {
      const { runOpsSweep } = await import("./ops/sweep.js");
      const { DEFAULT_STALENESS_MS } = await import("./service/status.js");
      const parsedOpsTimes = parseTimes(config.opsSweep.times);
      opsSweepHandle = startScheduler({
        pool,
        bus: brokerBus,
        times: parsedOpsTimes,
        enabled: config.opsSweep.enabled,
        now: () => new Date(),
        setTimer: (cb, ms) => setTimeout(cb, ms),
        getLastRun,
        recordRun,
        slotKeyPrefix: "ops",
        enqueueRun: async (poolArg, busArg) => {
          await runOpsSweep({
            pool: poolArg,
            bus: busArg,
            getQueueDepths,
            stalenessMs: DEFAULT_STALENESS_MS,
            cap: config.opsSweep.redriveCap,
            logger: webLogger,
            now: () => new Date(),
          });
        },
      });
      if (config.opsSweep.enabled) {
        console.log(`[scheduler] ops-sweep scheduler started (times: ${config.opsSweep.times})`);
      }
    } catch (err) {
      // Ops-sweep scheduler startup failure must NOT crash the web server
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[scheduler] ops-sweep startup error (web server continues): ${msg}\n`);
    }

    // ── --collect mode: start live collector in the same process ──────────────
    let liveHandle: { stop: () => void } | null = null;

    if (options.collect) {
      // Safety banner (same wording as the standalone `collect` command)
      if (config.whatsapp.allowSend) {
        console.log(
          "⚠️  SENDING ENABLED (WHATSAPP_ALLOW_SEND=true): this tool may transmit to WhatsApp.",
        );
      } else {
        console.log(
          "🔒 Read-only mode: this tool will NOT send messages, read receipts, or presence.\n" +
            "   It is a passive observer. (Sending stays off unless you set WHATSAPP_ALLOW_SEND=true.)",
        );
      }

      // Start collector — errors must not take down the web server
      try {
        const { startSession } = await import("./collector/session.js");
        const { attachCollector } = await import("./service/live-service.js");

        const authDir = path.join(config.dataDir, "baileys-auth");
        const session = await startSession(authDir, config.whatsapp.allowSend);
        liveSession = session;

        // Snapshot the heartbeat BEFORE the collector connects (the heartbeat loop
        // writes a fresh value immediately on connect). A stale value means the
        // server was genuinely down → run boot-time gap recovery once.
        const bootStatus = await getServiceStatus(pool);
        const bootWasStale = bootStatus ? isStale(bootStatus, 90_000) : true;
        let recoveryRan = false;

        // Gap-mode backfill: fill a single group's history backward to a timestamp.
        const gapFillGroup = async (groupId: number, stopAtSentAt: Date) => {
          if (!liveSession) return { fetched: 0, durationMs: 0, partial: true };
          const { rows } = await pool.query<{ whatsapp_id: string }>(
            "SELECT whatsapp_id FROM groups WHERE id=$1",
            [groupId],
          );
          const jid = rows[0]?.whatsapp_id;
          if (!jid) return { fetched: 0, durationMs: 0, partial: true };
          return backfillGroup({
            pool,
            groupId,
            dataDir: config.dataDir,
            targetWindow: 25, // unused in gap-mode but required by the type
            maxFetch: 500,
            timeoutMs: 20_000,
            stopAtSentAt,
            fetchHistory: (c: number, a: import("./collector/backfill.js").AnchorKey, ts: number) =>
              liveSession.fetchMessageHistory(c, a, ts),
            awaitHistory: (toMs: number) => liveSession.awaitHistorySync(jid, toMs),
            downloadVoiceNote: (m: import("@whiskeysockets/baileys").WAMessage) =>
              liveSession.downloadMedia(m),
          });
        };

        session.on("qr", () => {
          console.log("Scan the QR code above with WhatsApp to link your account.");
        });
        session.on("connected", () => {
          console.log("[collector] connected.");
          // Proactive name resolution on connect (fire-and-forget).
          import("./collector/name-resolver.js")
            .then(({ resolveAllGroupNames }) =>
              resolveAllGroupNames(pool, {
                groupSubject: (jid) => session.groupSubject(jid),
              }),
            )
            .then(({ resolved }) => {
              if (resolved > 0) {
                console.log(`[name-resolver] resolved ${resolved} group name(s).`);
              }
            })
            .catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              process.stderr.write(`[name-resolver] error: ${msg}\n`);
            });

          // Boot-time gap recovery: once per process, only if the pre-boot heartbeat
          // was stale (a real outage). Give the passive recent-sync (append /
          // history-set) ~8s to land a fresh top anchor before extending backward.
          if (!recoveryRan && bootWasStale) {
            recoveryRan = true;
            void (async () => {
              await new Promise((r) => setTimeout(r, 8000));
              const result = await recoverOnReconnect({
                isStale: () => true, // already gated by bootWasStale above
                activeSince: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000),
                selectActiveGroups: (range) => selectActiveGroups(pool, range),
                getNewestAnchorSentAt: async (groupId) =>
                  (await getNewestAnchor(pool, groupId))?.sentAt ?? null,
                gapFill: gapFillGroup,
                logger: webLogger,
              });
              if (result.recovered > 0) {
                console.log(
                  `[reconnect-sync] recovered ${result.recovered} message(s) across ${result.groups} group(s).`,
                );
              }
            })().catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              process.stderr.write(`[reconnect-sync] error: ${msg}\n`);
            });
          }
        });
        session.on("disconnected", () => {
          console.log("[collector] disconnected (will auto-reconnect).");
        });

        liveHandle = attachCollector({
          session,
          pool,
          bus: brokerBus,
          dataDir: config.dataDir,
          onError: (err) => {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(
              `[collector] message handler error (web server continues): ${msg}\n`,
            );
          },
        });

        console.log("[collector] started — web server and collector running together.");
      } catch (err) {
        // Collector startup failure must NOT exit (web server keeps running)
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[collector] startup error (web server continues): ${msg}\n`);
      }
    }

    // ── Graceful shutdown (SIGINT + SIGTERM) ─────────────────────────────────
    const gracefulShutdown = () => {
      // Stop schedulers first (prevents new enqueue calls)
      schedulerHandle.stop();
      opsSweepHandle.stop();
      // Stop collector wiring (if started)
      liveHandle?.stop();
      server.close();
      brokerBus.close().catch(() => {});
      dbClient.end().catch(() => {});
      pool
        .end()
        .catch(() => {})
        .finally(() => process.exit(0));
    };
    process.on("SIGINT", gracefulShutdown);
    process.on("SIGTERM", gracefulShutdown);
  });

program
  .command("analyze-backlog")
  .description(
    "Enqueue analyze jobs for present visual media that have no completed analysis (includes failed rows)",
  )
  .option("--limit <n>", "Maximum number of messages to enqueue")
  .option("--types <list>", "Comma-separated job types to enqueue", "analyze.image,analyze.video")
  .action(async (options: { limit?: string; types?: string }) => {
    const limit = options.limit !== undefined ? Number(options.limit) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
      process.stderr.write(`Error: --limit must be a positive integer (got "${options.limit}").\n`);
      process.exit(1);
    }

    const allowedTypes = new Set(
      (options.types ?? "analyze.image,analyze.video").split(",").map((s) => s.trim()),
    );

    const [
      { RabbitMqJobBus },
      { PostgresJobRunRecorder },
      { createDbClient },
      pg,
      { selectVisualMediaNeedingAnalysis },
    ] = await Promise.all([
      import("./jobs/rabbitmq-bus.js"),
      import("./jobs/job-run-recorder.js"),
      import("./db/client.js"),
      import("pg"),
      import("./db/repositories/media-analyses.js"),
    ]);

    const config = loadConfig();
    const pool = new pg.default.Pool({ connectionString: config.databaseUrl });
    const dbClient = createDbClient();
    const recorder = new PostgresJobRunRecorder(dbClient);
    const bus = new RabbitMqJobBus({ url: config.broker.url, recorder });

    try {
      const rows = await selectVisualMediaNeedingAnalysis(pool, limit);

      let enqueued = 0;
      for (const { messageId, kind } of rows) {
        const jobType = kind === "video" ? "analyze.video" : "analyze.image";
        if (!allowedTypes.has(jobType)) continue;
        await bus.enqueue(jobType, { messageId: String(messageId) });
        enqueued++;
      }

      console.log(`Enqueued ${enqueued} analyze job(s).`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Error: analyze-backlog failed: ${message}\n`);
      process.exit(1);
    } finally {
      await pool.end();
      await bus.close();
    }
  });

program
  .command("digest-run")
  .description(
    "Manually trigger a scheduled digest run: enqueue summarize.group jobs for all changed groups",
  )
  .option("--all", "Enqueue all groups regardless of whether they have new messages")
  .action(async (options: { all?: boolean }) => {
    const [
      { RabbitMqJobBus },
      { PostgresJobRunRecorder },
      { createDbClient },
      pg,
      { enqueueScheduledRun },
    ] = await Promise.all([
      import("./jobs/rabbitmq-bus.js"),
      import("./jobs/job-run-recorder.js"),
      import("./db/client.js"),
      import("pg"),
      import("./scheduler/enqueue-run.js"),
    ]);

    const config = loadConfig();
    const pool = new pg.default.Pool({ connectionString: config.databaseUrl });
    const dbClient = createDbClient();
    const recorder = new PostgresJobRunRecorder(dbClient);
    const bus = new RabbitMqJobBus({ url: config.broker.url, recorder });

    try {
      const result = await enqueueScheduledRun(pool, bus, { all: options.all === true });
      console.log(`Enqueued ${result.enqueued} (skipped ${result.skipped})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Error: digest-run failed: ${message}\n`);
      process.exit(1);
    } finally {
      await pool.end();
      await bus.close();
    }
  });

program
  .command("ops-sweep")
  .description("Manually trigger one ops sweep: re-drive dead jobs and record a status snapshot")
  .action(async () => {
    const config = loadConfig();

    const [
      { RabbitMqJobBus },
      { PostgresJobRunRecorder },
      { createDbClient },
      pg,
      { runOpsSweep },
      { DEFAULT_STALENESS_MS },
    ] = await Promise.all([
      import("./jobs/rabbitmq-bus.js"),
      import("./jobs/job-run-recorder.js"),
      import("./db/client.js"),
      import("pg"),
      import("./ops/sweep.js"),
      import("./service/status.js"),
    ]);

    const pool = new pg.default.Pool({ connectionString: config.databaseUrl });
    const dbClient = createDbClient();
    const recorder = new PostgresJobRunRecorder(dbClient);
    const bus = new RabbitMqJobBus({ url: config.broker.url, recorder });

    const getQueueDepths = async () => {
      const types = ["import.file", "transcribe.voicenote"] as const;
      const result: Record<string, number> = {};
      await Promise.all(
        types.map(async (type) => {
          try {
            result[type] = await bus.depth(type);
          } catch {
            // broker unreachable for this type — omit so depth stays null
          }
        }),
      );
      return result as Partial<Record<(typeof types)[number], number>>;
    };

    try {
      const snap = await runOpsSweep({
        pool,
        bus,
        getQueueDepths,
        stalenessMs: DEFAULT_STALENESS_MS,
        cap: config.opsSweep.redriveCap,
        logger: undefined,
        now: () => new Date(),
      });
      console.log(
        `Ops sweep complete: re-driven ${snap.redriven}, flagged ${snap.flagged}, dead ${snap.jobsDead} (snapshot ${snap.id}).`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Error: ops-sweep failed: ${message}\n`);
      process.exit(1);
    } finally {
      await pool.end();
      await bus.close();
    }
  });

program
  .command("doctor")
  .description("Check every prerequisite and print ✅/❌ per check with fix hints")
  .action(async () => {
    const { defaultChecks, runChecks } = await import("./doctor/checks.js");
    const config = loadConfig();
    const results = await runChecks(defaultChecks(config));
    let allOk = true;
    for (const result of results) {
      if (result.ok) {
        let line = `✅ ${result.name}`;
        if (result.detail) line += ` — ${result.detail}`;
        console.log(line);
      } else {
        allOk = false;
        let line = `❌ ${result.name}`;
        if (result.detail) line += ` — ${result.detail}`;
        if (result.fix) line += ` — fix: ${result.fix}`;
        console.log(line);
      }
    }
    if (!allOk) process.exit(1);
  });

program.parse();
