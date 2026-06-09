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
          lidForPn: (pn) => session.lidForPn(pn),
          pnForLid: (lid) => session.pnForLid(lid),
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
      { getNewestReadableSentAt, countReadableSince },
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
              lidForPn: (pn: string) => liveSession.lidForPn(pn),
              pnForLid: (l: string) => liveSession.pnForLid(l),
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
    let backfillHandle: { stop: () => void } | null = null;

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

      // Keep the collector alive when a media-download HTTP/2 stream aborts.
      // Such aborts surface as an unhandled 'error' event on a raw undici stream
      // (an uncaughtException), which bypasses the per-message handler's .catch
      // and would otherwise kill the whole process. The guard swallows only
      // transient stream/network aborts; real bugs still crash fast.
      const { installMediaStreamCrashGuard } = await import("./collector/crash-guard.js");
      installMediaStreamCrashGuard();

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

        // Capture each active group's newest-stored timestamp NOW, before connecting —
        // i.e. the pre-outage state. Recovery pages backward to this frozen value and
        // measures messages newer than it. Must be read before the passive sync raises
        // the newest, or the active fetch's anchor and stop would be identical (no-op).
        const bootSnapshots: Array<{ id: number; name: string; tLast: Date | null }> = [];
        if (bootWasStale) {
          const activeSince = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
          const activeGroups = await selectActiveGroups(pool, { since: activeSince });
          for (const g of activeGroups) {
            // Newest READABLE message (any source) — the correct measurement baseline.
            // (The active fetch uses its own external_id anchor inside backfillGroup.)
            const tLast = await getNewestReadableSentAt(pool, g.id);
            bootSnapshots.push({ id: g.id, name: g.name, tLast });
          }
          console.log(
            `[reconnect-sync] armed: snapshotted ${bootSnapshots.length} active group(s) (pre-boot heartbeat stale).`,
          );
        }

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
            lidForPn: (pn: string) => liveSession.lidForPn(pn),
            pnForLid: (l: string) => liveSession.pnForLid(l),
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
                snapshots: bootSnapshots,
                gapFill: gapFillGroup,
                countReadableSince: (groupId, since) => countReadableSince(pool, groupId, since),
                logger: webLogger,
              });
              console.log(
                `[reconnect-sync] done: recovered ${result.recovered} message(s) across ${result.groups} group(s).`,
              );
            })().catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              process.stderr.write(`[reconnect-sync] error: ${msg}\n`);
            });
          }
        });
        session.on("disconnected", () => {
          console.log("[collector] disconnected (will auto-reconnect).");
        });

        // Resolve chat/contact display names from WhatsApp's directory (the only
        // source for saved contact names and for groups we can't fetch a subject
        // for). Fire-and-forget; failures must never disturb collection.
        session.on("contacts", (contacts) => {
          void import("./collector/name-resolver.js")
            .then(({ resolveContactNames }) =>
              resolveContactNames(pool, contacts, {
                pnForLid: (lid) => session.pnForLid(lid),
              }),
            )
            .catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              process.stderr.write(`[name-resolver] contacts resolution error: ${msg}\n`);
            });
        });
        session.on("chats", (chats) => {
          void import("./collector/name-resolver.js")
            .then(({ resolveChatNames }) => resolveChatNames(pool, chats))
            .catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              process.stderr.write(`[name-resolver] chats resolution error: ${msg}\n`);
            });
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

        // ── Deferred media backfill loop ─────────────────────────────────────
        const { startBackfillLoop, MEDIA_EXTENSIONS } = await import(
          "./collector/media-backfill-loop.js"
        );
        const { proto } = await import("@whiskeysockets/baileys");
        const mediaRepo = await import("./db/repositories/message-media.js");
        const msgRepo = await import("./db/repositories/messages.js");
        const fsp = await import("node:fs/promises");
        const nodePath = await import("node:path");

        backfillHandle = startBackfillLoop(
          {
            selectPending: (limit) => mediaRepo.selectPendingMedia(pool, limit),
            decodeWaMessage: (blob) => proto.WebMessageInfo.decode(blob),
            download: (waMessage) =>
              liveSession.downloadMedia(waMessage as import("@whiskeysockets/baileys").WAMessage),
            writeFile: async (messageId, kind, bytes) => {
              const dir = nodePath.join(config.dataDir, "media", "backfill");
              await fsp.mkdir(dir, { recursive: true });
              const file = nodePath.join(dir, `bf-${messageId}${MEDIA_EXTENSIONS[kind] ?? ".bin"}`);
              await fsp.writeFile(file, bytes);
              return file;
            },
            markPresentMessage: (id, p) => msgRepo.markMessageMediaPresent(pool, id, p),
            markPresentMedia: (id, dp) => mediaRepo.markMediaPresent(pool, id, dp),
            markUnrecoverable: (id, e) => mediaRepo.markMediaUnrecoverable(pool, id, e),
            recordAttempt: (id, e) => mediaRepo.recordMediaAttempt(pool, id, e),
            enqueue: async (type, payload) => {
              await brokerBus.enqueue(type, payload);
            },
            log: (m) => process.stdout.write(`${m}\n`),
          },
          {
            intervalMs: Number(process.env["MEDIA_BACKFILL_INTERVAL_MS"]) || 15_000,
            batchSize: Number(process.env["MEDIA_BACKFILL_BATCH"]) || 3,
          },
        );

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
      backfillHandle?.stop();
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
  .command("media-backfill")
  .description(
    "Download + analyze media for messages stored without it (deferred backfill). Scans a fresh linked session.",
  )
  .option("--limit <n>", "Max messages to process", "50")
  .option(
    "--auth-dir <dir>",
    "Auth dir for the temporary device (default <dataDir>/baileys-fullsync-auth)",
  )
  .action(async (options: { limit?: string; authDir?: string }) => {
    const limit = Number(options.limit ?? "50");
    if (!Number.isInteger(limit) || limit <= 0) {
      process.stderr.write("Error: --limit must be a positive integer.\n");
      process.exit(1);
    }

    const config = loadConfig();
    const [
      { startSession },
      { runBackfillBatch, MEDIA_EXTENSIONS },
      { proto },
      mediaRepo,
      msgRepo,
      pgMod,
      fsp,
      nodePath,
      { RabbitMqJobBus },
      { PostgresJobRunRecorder },
      { createDbClient },
    ] = await Promise.all([
      import("./collector/session.js"),
      import("./collector/media-backfill-loop.js"),
      import("@whiskeysockets/baileys"),
      import("./db/repositories/message-media.js"),
      import("./db/repositories/messages.js"),
      import("pg"),
      import("node:fs/promises"),
      import("node:path"),
      import("./jobs/rabbitmq-bus.js"),
      import("./jobs/job-run-recorder.js"),
      import("./db/client.js"),
    ]);

    const pool = new pgMod.default.Pool({ connectionString: config.databaseUrl });
    const dbClient = createDbClient();
    const recorder = new PostgresJobRunRecorder(dbClient);
    const bus = new RabbitMqJobBus({ url: config.broker.url, recorder });
    const authDir = options.authDir ?? path.join(config.dataDir, "baileys-fullsync-auth");
    const session = await startSession(authDir, false, {});

    try {
      await new Promise<void>((resolve) => session.on("connected", () => resolve()));

      const total = await runBackfillBatch(
        {
          selectPending: (l) => mediaRepo.selectPendingMedia(pool, l),
          decodeWaMessage: (blob) => proto.WebMessageInfo.decode(blob),
          download: (m) => session.downloadMedia(m as import("@whiskeysockets/baileys").WAMessage),
          writeFile: async (messageId, kind, bytes) => {
            const dir = nodePath.join(config.dataDir, "media", "backfill");
            await fsp.mkdir(dir, { recursive: true });
            const file = nodePath.join(dir, `bf-${messageId}${MEDIA_EXTENSIONS[kind] ?? ".bin"}`);
            await fsp.writeFile(file, bytes);
            return file;
          },
          markPresentMessage: (id, p) => msgRepo.markMessageMediaPresent(pool, id, p),
          markPresentMedia: (id, dp) => mediaRepo.markMediaPresent(pool, id, dp),
          markUnrecoverable: (id, e) => mediaRepo.markMediaUnrecoverable(pool, id, e),
          recordAttempt: (id, e) => mediaRepo.recordMediaAttempt(pool, id, e),
          enqueue: async (type, payload) => {
            await bus.enqueue(type, payload);
          },
          log: (m) => process.stdout.write(`${m}\n`),
        },
        limit,
      );

      console.log(`Backfilled ${total} media file(s); analysis jobs enqueued.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Error: media-backfill failed: ${message}\n`);
      process.exit(1);
    } finally {
      session.stop();
      await bus.close();
      await pool.end();
    }
    process.exit(0);
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

program
  .command("merge-duplicate-chats")
  .description(
    "Merge @lid/@s.whatsapp.net duplicate chats of the same person (dry-run unless --apply)",
  )
  .option("--apply", "Actually perform the merges (default: dry-run, no writes)")
  .action(async (options: { apply?: boolean }) => {
    const config = loadConfig();
    const pg = await import("pg");
    const pool = new pg.default.Pool({ connectionString: config.databaseUrl });
    const { startSession } = await import("./collector/session.js");
    const { findMergeCandidates, mergeGroups } = await import("./db/repositories/merge.js");

    const session = await startSession(path.join(config.dataDir, "baileys-auth"), false);
    session.on("qr", () => {
      console.log("Scan the QR code above with WhatsApp to link your account.");
    });

    const run = async () => {
      // Give Baileys' lid<->pn mapping a moment to settle after connect.
      await new Promise((r) => setTimeout(r, 6000));
      const candidates = await findMergeCandidates(pool, {
        lidForPn: (pn) => session.lidForPn(pn),
        pnForLid: (lid) => session.pnForLid(lid),
      });

      if (candidates.length === 0) {
        console.log("No duplicate-chat pairs found.");
      } else {
        console.log(`Found ${candidates.length} duplicate-chat pair(s):`);
        for (const c of candidates) {
          console.log(
            `  "${c.name}"  keep ${c.survivorJid} (${c.survivorMsgs} msgs)  ⟵ merge ${c.dupJid} (${c.dupMsgs} msgs)`,
          );
        }
        if (options.apply) {
          let ok = 0;
          let moved = 0;
          let dropped = 0;
          for (const c of candidates) {
            const client = await pool.connect();
            try {
              await client.query("BEGIN");
              const res = await mergeGroups(client, {
                survivorId: c.survivorId,
                dupId: c.dupId,
                name: c.name,
              });
              await client.query("COMMIT");
              ok++;
              moved += res.movedMessages;
              dropped += res.deletedDuplicateMessages;
              console.log(
                `  ✓ "${c.name}" — moved ${res.movedMessages}, dropped ${res.deletedDuplicateMessages} dup`,
              );
            } catch (err) {
              await client.query("ROLLBACK").catch(() => {});
              const msg = err instanceof Error ? err.message : String(err);
              console.error(`  ✗ "${c.name}" (${c.survivorJid} ⟵ ${c.dupJid}): ${msg}`);
            } finally {
              client.release();
            }
          }
          console.log(
            `Applied ${ok}/${candidates.length} merge(s); moved ${moved} message(s), dropped ${dropped} duplicate(s).`,
          );
        } else {
          console.log(
            "\nDry-run only — no changes made. Re-run with --apply to perform these merges.",
          );
        }
      }
      session.stop();
      await pool.end();
    };

    await new Promise<void>((resolve) => {
      session.on("connected", () => {
        run()
          .catch(async (err) => {
            console.error("merge-duplicate-chats error:", err);
            session.stop();
            await pool.end().catch(() => {});
          })
          .finally(() => resolve());
      });
    });
    process.exit(0);
  });

program
  .command("full-sync")
  .description(
    "One-time full-history sync via a fresh linked device (scan QR once). " +
      "Persists whitelisted chats (--group) or every chat (--all).",
  )
  .option("--group <list>", "Comma-separated group name(s) or id(s) to keep (whitelist)")
  .option("--all", "Persist EVERY chat — full account backfill (no whitelist)")
  .option(
    "--auth-dir <dir>",
    "Auth dir for the temporary device (default <dataDir>/baileys-fullsync-auth)",
  )
  .action(async (options: { group?: string; all?: boolean; authDir?: string }) => {
    const all = options.all === true;
    if (all && options.group) {
      process.stderr.write("Error: use only one of --all or --group.\n");
      process.exit(1);
    }
    if (!all && !options.group) {
      process.stderr.write("Error: specify --group <list> or --all.\n");
      process.exit(1);
    }

    const config = loadConfig();
    const [{ startSession }, { handleIncomingMessage }, pgMod] = await Promise.all([
      import("./collector/session.js"),
      import("./collector/collector.js"),
      import("pg"),
    ]);
    const pool = new pgMod.default.Pool({ connectionString: config.databaseUrl });

    // whitelist === null → keep ALL chats (--all). Otherwise jid -> display name.
    let whitelist: Map<string, string> | null = null;
    if (!all) {
      whitelist = new Map<string, string>();
      for (const token of (options.group ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)) {
        const byId = /^\d+$/.test(token);
        const { rows } = await pool.query<{ name: string; whatsapp_id: string | null }>(
          byId
            ? "SELECT name, whatsapp_id FROM groups WHERE id=$1"
            : "SELECT name, whatsapp_id FROM groups WHERE name=$1",
          [byId ? Number(token) : token],
        );
        const row = rows[0];
        if (!row) {
          process.stderr.write(`Warning: no group matching "${token}" — skipping.\n`);
        } else if (!row.whatsapp_id) {
          process.stderr.write(
            `Warning: "${row.name}" has no whatsapp_id (import-only, not a live chat) — skipping.\n`,
          );
        } else {
          whitelist.set(row.whatsapp_id, row.name);
        }
      }
      if (whitelist.size === 0) {
        process.stderr.write("Error: no resolvable live chats in the whitelist.\n");
        await pool.end();
        process.exit(1);
      }
    }

    const authDir = options.authDir ?? path.join(config.dataDir, "baileys-fullsync-auth");
    console.log("🔄 Full-history sync — temporary device.");
    if (all) {
      console.log("   Mode: --all — persisting EVERY chat (full account backfill).");
    } else {
      console.log(
        `   Whitelist (only these are persisted): ${[...whitelist!.values()].join(", ")}`,
      );
    }
    console.log(`   Auth dir: ${authDir}`);

    const session = await startSession(authDir, false, {
      syncFullHistory: true,
      acceptAllHistory: true,
    });

    let kept = 0;
    let seen = 0;
    let lastProgress: number | null = null;
    let reported = false;
    let barTimer: ReturnType<typeof setInterval> | null = null;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    // WhatsApp pushes history in phases (RECENT first, then FULL over minutes).
    // `isLatest` fires on the EARLY batch, so it is NOT a "done" signal. Instead
    // declare completion when no new history chunk has arrived for this long.
    const QUIET_MS = 45_000;

    const renderBar = () => {
      const width = 24;
      const pct =
        lastProgress != null ? Math.max(0, Math.min(100, Math.round(lastProgress))) : null;
      const filled = pct != null ? Math.round((pct / 100) * width) : 0;
      const bar = "█".repeat(filled) + "░".repeat(width - filled);
      const pctStr = pct != null ? `${pct}%`.padStart(4) : " ??%";
      process.stdout.write(`\r  [${bar}] ${pctStr} · kept ${kept} · seen ${seen}    `);
    };

    const report = async () => {
      if (reported) return;
      reported = true;
      if (barTimer) clearInterval(barTimer);
      if (quietTimer) clearTimeout(quietTimer);
      process.stdout.write("\n");
      console.log(`📊 Done. Kept ${kept} new message(s); saw ${seen} across all chats.`);
      if (whitelist) {
        for (const [jid, name] of whitelist) {
          const { rows } = await pool.query<{ c: string; oldest: string | null }>(
            "SELECT count(*) AS c, min(sent_at)::text AS oldest FROM messages m JOIN groups g ON g.id=m.group_id WHERE g.whatsapp_id=$1",
            [jid],
          );
          console.log(`   ${name}: ${rows[0]?.c ?? 0} in DB, oldest ${rows[0]?.oldest ?? "none"}`);
        }
      } else {
        const { rows } = await pool.query<{ c: string; g: string; oldest: string | null }>(
          "SELECT count(*) AS c, count(DISTINCT group_id) AS g, min(sent_at)::text AS oldest FROM messages",
        );
        console.log(
          `   All chats: ${rows[0]?.c ?? 0} messages across ${rows[0]?.g ?? 0} chats, oldest ${rows[0]?.oldest ?? "none"}`,
        );
      }
      // Onboarding parity: resolve group display names from WhatsApp's directory
      // so onboarding ends with human names, not JIDs (mirrors collect/serve).
      try {
        const { resolveAllGroupNames } = await import("./collector/name-resolver.js");
        const { resolved } = await resolveAllGroupNames(pool, {
          groupSubject: (jid: string) => session.groupSubject(jid),
        });
        if (resolved > 0) console.log(`[name-resolver] resolved ${resolved} group name(s).`);
      } catch (err) {
        process.stderr.write(
          `[name-resolver] full-sync resolution error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      session.stop();
      await pool.end().catch(() => {});
      process.exit(0);
    };

    session.on("qr", () => {
      console.log(
        "\n📲 Scan the QR above: WhatsApp → Settings → Linked Devices → Link a Device.\n",
      );
    });
    // Declare completion once history has gone quiet for QUIET_MS.
    const resetQuiet = () => {
      if (reported) return;
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        process.stdout.write(`\n✅ No new history for ${QUIET_MS / 1000}s — sync complete.\n`);
        void report();
      }, QUIET_MS);
    };

    session.on("connected", () => {
      console.log(
        "✅ Linked. Receiving history sync… (auto-finishes when it goes quiet; Ctrl-C anytime)\n",
      );
      // Refresh the bar smoothly even between chunk events.
      barTimer = setInterval(renderBar, 500);
      resetQuiet();
    });
    session.on("message", (msg: import("@whiskeysockets/baileys").WAMessage) => {
      seen++;
      const jid = msg.key?.remoteJid;
      if (!jid || (whitelist && !whitelist.has(jid))) return;
      // Persist text/metadata only (no media downloads). --with-media is a future opt-in.
      void handleIncomingMessage(pool, msg, {
        dataDir: config.dataDir,
        lidForPn: (pn) => session.lidForPn(pn),
        pnForLid: (lid) => session.pnForLid(lid),
      })
        .then((stored) => {
          if (stored) kept++;
        })
        .catch((err: unknown) => {
          process.stderr.write(
            `\n[full-sync] persist error: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        });
    });
    session.on("history-progress", (info) => {
      if (info.progress != null) lastProgress = info.progress;
      renderBar();
      // Each chunk keeps the sync "alive"; completion is the absence of new chunks.
      resetQuiet();
    });
    process.on("SIGINT", () => void report());
    process.on("SIGTERM", () => void report());
  });

program.parse();
