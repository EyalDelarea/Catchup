import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { askStream } from "../ask/ask.js";
import { LexicalRetriever } from "../ask/lexical-retriever.js";
import type { Retriever } from "../ask/retriever.js";
import { findGroupByName, listGroups } from "../db/repositories/groups.js";
import { countReadableByGroup, getOldestSentAt } from "../db/repositories/messages.js";
import { upsertWatermark } from "../db/repositories/read-watermarks.js";
import { insertSummary, listSummariesByGroup } from "../db/repositories/summaries.js";
import { insertTotalSummary } from "../db/repositories/total-summaries.js";
import type { JobType } from "../jobs/job-types.js";
import { buildStatusReport, DEFAULT_STALENESS_MS } from "../service/status.js";
import { prepareSummary } from "../summarization/prepare.js";
import { prepareCatchup } from "../summarization/prepare-catchup.js";
import { persistCatchupResult } from "../summarization/run-summary.js";
import type { Selection } from "../summarization/select.js";
import type { StreamingSummarizer } from "../summarization/summarizer.js";
import { generateTotalSummary } from "../summarization/total-summary.js";
import { sseFrame } from "./sse.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.join(__dirname, "public", "index.html");

const CATCHUP_FALLBACK_N = 25;

export type ServerDeps = {
  pool: pg.Pool;
  summarizer: StreamingSummarizer;
  tokenBudget: number;
  model: string;
  /** Best-effort queue depths. If absent, all depths are null. */
  getQueueDepths?: () => Promise<Partial<Record<JobType, number>>>;
  /** How old a heartbeat can be before service is considered stale (ms). Default 5 min. */
  stalenessMs?: number;
  /** Optional: current collector liveness. When absent, stale defaults to false. */
  getLiveness?: () => { healthy: boolean; lastHeartbeatAt: Date | null };
  /** Optional: run a bounded backfill for a group before summarizing. */
  backfill?: (
    groupId: number,
  ) => Promise<{ fetched: number; durationMs: number; partial: boolean }>;
  /** Target window for backfill (default 25). */
  backfillTargetWindow?: number;
  /** Optional structured logger (pino). Used to record backfill outcomes for the trace/dashboard. */
  logger?: { info: (obj: Record<string, unknown>, msg?: string) => void };
  /** Retrievers for the ask flow. Defaults to [LexicalRetriever(pool)] when absent. */
  askRetrievers?: Retriever[];
};

export function createServer(deps: ServerDeps): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(INDEX_HTML, "utf8"));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/groups") {
      listGroups(deps.pool)
        .then((groups) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(groups));
        })
        .catch((err) => {
          process.stderr.write(
            `Error handling /api/groups: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
          );
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error." }));
        });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/summarize") {
      void handleSummarize(url, req, res, deps);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/total-summary") {
      void handleTotalSummary(url, req, res, deps);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/ask") {
      void handleAsk(url, req, res, deps);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
      void handleStatus(res, deps);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/summaries") {
      void handleSummaries(url, res, deps);
      return;
    }
    // Generic static asset handler — must come after all /api/* routes
    if (req.method === "GET") {
      void handleStatic(url.pathname, res);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  });
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
};

async function handleStatic(pathname: string, res: http.ServerResponse): Promise<void> {
  const publicDir = path.resolve(__dirname, "public");
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
    return;
  }
  const resolved = path.resolve(path.join(publicDir, decoded));
  // Block path traversal
  if (!resolved.startsWith(publicDir + path.sep) && resolved !== publicDir) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
    return;
  }
  // Read the file directly rather than stat-then-read: a separate existence
  // check would be a TOCTOU race. A missing file or a directory both throw
  // here (ENOENT / EISDIR) and resolve to 404.
  let data: Buffer;
  try {
    data = fs.readFileSync(resolved);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
    return;
  }
  const ext = path.extname(resolved).toLowerCase();
  const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
  // Single-user LAN tool: revalidate every load so a redeploy never serves stale JS/CSS.
  res.writeHead(200, { "content-type": contentType, "cache-control": "no-cache" });
  res.end(data);
}

async function handleSummaries(
  url: URL,
  res: http.ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const group = url.searchParams.get("group");
  if (!group) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Missing group." }));
    return;
  }
  // Parse and clamp limit
  const rawLimit = url.searchParams.get("limit");
  let limit = 50;
  if (rawLimit !== null) {
    const parsed = parseInt(rawLimit, 10);
    limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : 50;
  }
  try {
    const grp = await findGroupByName(deps.pool, group);
    if (!grp) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([]));
      return;
    }
    const summaries = await listSummariesByGroup(deps.pool, grp.id, limit);
    const serialized = summaries.map((s) => ({
      id: s.id,
      summaryType: s.summaryType,
      parameters: s.parameters,
      output: s.output,
      model: s.model,
      createdAt: s.createdAt.toISOString(),
    }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(serialized));
  } catch (err) {
    process.stderr.write(
      `Error handling /api/summaries: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Internal server error." }));
  }
}

async function handleStatus(res: http.ServerResponse, deps: ServerDeps): Promise<void> {
  const getQueueDepths = deps.getQueueDepths ?? (async () => ({}));
  const stalenessMs = deps.stalenessMs ?? DEFAULT_STALENESS_MS;
  try {
    const report = await buildStatusReport({ pool: deps.pool, getQueueDepths, stalenessMs });
    const rawLiveness = deps.getLiveness?.() ?? null;
    const liveness = rawLiveness
      ? {
          healthy: rawLiveness.healthy,
          lastHeartbeatAt: rawLiveness.lastHeartbeatAt?.toISOString() ?? null,
        }
      : null;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ...report, liveness }));
  } catch {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "status unavailable" }));
  }
}

async function handleSummarize(
  url: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const ac = new AbortController();
  const abortOnClose = () => ac.abort();
  req.on("close", abortOnClose);
  res.on("close", abortOnClose);

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const send = (event: string, data: unknown) => res.write(sseFrame(event, data));
  try {
    const group = url.searchParams.get("group");
    const last = url.searchParams.get("last");
    const sinceRaw = url.searchParams.get("since");
    const mode = url.searchParams.get("mode");
    if (!group) {
      send("error", { message: "Missing group." });
      res.end();
      return;
    }

    // Parse since early so the backfill step can use it.
    let sinceDate: Date | null = null;
    if (sinceRaw != null) {
      const d = new Date(sinceRaw);
      if (!Number.isNaN(d.getTime())) sinceDate = d;
    }
    // Keep the alias used by the rest of the handler.
    const since = sinceRaw;

    // --- backfill step (runs before any mode branch) ---
    const liveness = deps.getLiveness?.();
    const stale = liveness ? !liveness.healthy : false;
    let fetchMs = 0,
      fetched = 0,
      backfillPartial = false;
    if (deps.backfill && deps.getLiveness && liveness?.healthy) {
      const grp = await findGroupByName(deps.pool, group);
      if (grp) {
        const window = deps.backfillTargetWindow ?? 25;
        const held = await countReadableByGroup(deps.pool, grp.id);
        const underWindow = held < window;
        // Check if requested since-cutoff predates our oldest stored message.
        let sinceOutrangesHistory = false;
        if (!underWindow && sinceDate != null) {
          const oldest = await getOldestSentAt(deps.pool, grp.id);
          sinceOutrangesHistory = oldest == null || sinceDate < oldest;
        }
        if (underWindow || sinceOutrangesHistory) {
          send("syncing", { phase: "start" });
          const r = await deps.backfill(grp.id);
          fetchMs = r.durationMs;
          fetched = r.fetched;
          backfillPartial = r.partial;
          send("syncing", { phase: "done", fetched, fetchMs, partial: backfillPartial });
          deps.logger?.info(
            { evt: "backfill", group, groupId: grp.id, fetched, fetchMs, partial: backfillPartial },
            "backfill",
          );
        }
      }
    }

    // --- catchup path ---
    if (mode === "catchup") {
      if (last || since) {
        send("error", { message: "Use only one of catchup, last, or since." });
        res.end();
        return;
      }
      const prepared = await prepareCatchup(deps.pool, group, CATCHUP_FALLBACK_N, deps.tokenBudget);
      if (prepared.kind === "empty") {
        send("empty", {});
        res.end();
        return;
      }
      if (prepared.kind === "cache-hit") {
        send("cached", {
          summary: prepared.summary,
          generatedAt: prepared.generatedAt.toISOString(),
        });
        res.end();
        return;
      }
      // kind === "ready"
      send("status", {
        messages: prepared.messageCount,
        usedFallback: prepared.usedFallback,
        stale,
      });
      const start = Date.now();
      let full = "";
      for await (const delta of deps.summarizer.summarizeStream(prepared.prompt, {
        signal: ac.signal,
      })) {
        full += delta;
        send("token", { delta });
      }
      // Guard: if the client disconnected, do NOT commit partial summary or advance watermark.
      if (ac.signal.aborted) return;
      // Commit only after the stream completes successfully.
      // Shared persist helper: summary row first, watermark second (no partial state).
      const summaryId = await persistCatchupResult({
        pool: deps.pool,
        groupId: prepared.groupId,
        summaryType: prepared.summaryType,
        parameters: prepared.parameters,
        fullText: full,
        model: deps.model,
        newWatermark: prepared.newWatermark,
        insertSummary,
        updateWatermark: upsertWatermark,
      });
      deps.logger?.info(
        {
          evt: "summarize",
          op: "summary",
          durationMs: Date.now() - start,
          messages: prepared.messageCount,
          mode: "catchup",
        },
        "summary done",
      );
      send("done", {
        summaryId,
        elapsedMs: Date.now() - start,
        messageCount: prepared.messageCount,
        usedFallback: prepared.usedFallback,
        fetchMs,
        summarizeMs: Date.now() - start,
        fetched,
        partial: backfillPartial,
        stale,
      });
      res.end();
      return;
    }

    // --- existing last/since path ---
    if (last && since) {
      send("error", { message: "Use only one of last or since." });
      res.end();
      return;
    }

    let selection: Selection;
    if (since) {
      const d = new Date(since);
      if (Number.isNaN(d.getTime())) {
        send("error", { message: `Invalid since date "${since}".` });
        res.end();
        return;
      }
      selection = { since: d };
    } else {
      const n = last ? Number(last) : 25;
      if (!Number.isInteger(n) || n <= 0) {
        send("error", { message: "last must be a positive integer." });
        res.end();
        return;
      }
      selection = { last: n };
    }

    const prepared = await prepareSummary(deps.pool, group, selection, deps.tokenBudget);
    if (prepared.kind === "empty") {
      send("empty", {});
      res.end();
      return;
    }

    send("status", { messages: prepared.messageCount, stale });
    const start = Date.now();
    let full = "";
    for await (const delta of deps.summarizer.summarizeStream(prepared.prompt, {
      signal: ac.signal,
    })) {
      full += delta;
      send("token", { delta });
    }
    // Guard: if the client disconnected, do NOT commit partial summary.
    if (ac.signal.aborted) return;
    const summaryId = await insertSummary(deps.pool, {
      groupId: prepared.groupId,
      summaryType: prepared.summaryType,
      parameters: prepared.parameters,
      output: { overview: full.trim() },
      model: deps.model,
    });
    deps.logger?.info(
      {
        evt: "summarize",
        op: "summary",
        durationMs: Date.now() - start,
        messages: prepared.messageCount,
        mode: since ? "since" : "last",
      },
      "summary done",
    );
    send("done", {
      summaryId,
      elapsedMs: Date.now() - start,
      fetchMs,
      summarizeMs: Date.now() - start,
      fetched,
      partial: backfillPartial,
      stale,
    });
    res.end();
  } catch (err) {
    send("error", { message: err instanceof Error ? err.message : String(err) });
    res.end();
  }
}

async function handleTotalSummary(
  url: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const ac = new AbortController();
  const abortOnClose = () => ac.abort();
  req.on("close", abortOnClose);
  res.on("close", abortOnClose);

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const send = (event: string, data: unknown) => res.write(sseFrame(event, data));

  try {
    // since defaults to the last 24h when absent/invalid.
    const sinceRaw = url.searchParams.get("since");
    let since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    if (sinceRaw != null) {
      const d = new Date(sinceRaw);
      if (!Number.isNaN(d.getTime())) since = d;
    }

    const start = Date.now();
    const output = await generateTotalSummary(
      {
        pool: deps.pool,
        summarizeStream: (prompt, o) => deps.summarizer.summarizeStream(prompt, o),
        tokenBudget: deps.tokenBudget,
      },
      { since },
      {
        signal: ac.signal,
        onChatStart: (info) =>
          send("status", { phase: "chat", index: info.index, total: info.total, name: info.name }),
        onHighlightToken: (delta) => send("token", { delta }),
      },
    );

    // Client disconnected mid-stream → do not persist a partial result.
    if (ac.signal.aborted) return;

    const summaryId = await insertTotalSummary(deps.pool, {
      rangeKind: "since",
      parameters: { since: since.toISOString() },
      output,
      model: deps.model,
    });

    deps.logger?.info(
      {
        evt: "total-summary",
        op: "summary",
        durationMs: Date.now() - start,
        chats: output.perChat.length,
      },
      "total summary done",
    );

    send("done", {
      summaryId,
      elapsedMs: Date.now() - start,
      highlights: output.highlights,
      perChat: output.perChat,
    });
    res.end();
  } catch (err) {
    send("error", { message: err instanceof Error ? err.message : String(err) });
    res.end();
  }
}

async function handleAsk(
  url: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const ac = new AbortController();
  const abortOnClose = () => ac.abort();
  req.on("close", abortOnClose);
  res.on("close", abortOnClose);

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const send = (event: string, data: unknown) => res.write(sseFrame(event, data));

  try {
    const question = (url.searchParams.get("q") ?? "").trim();
    if (question.length === 0) {
      send("error", { message: "missing q parameter" });
      res.end();
      return;
    }
    const chat = url.searchParams.get("chat") ?? undefined;
    const retrievers = deps.askRetrievers ?? [new LexicalRetriever(deps.pool)];

    for await (const ev of askStream(
      { summarizer: deps.summarizer, retrievers, tokenBudget: deps.tokenBudget },
      question,
      new Date(),
      { chat },
    )) {
      if (ac.signal.aborted) return;
      if (ev.type === "token") send("token", { delta: ev.delta });
      else if (ev.type === "citations") send("citations", ev.citations);
      else send("done", { candidateCount: ev.candidateCount });
    }
    res.end();
  } catch (err) {
    process.stderr.write(
      `Error handling /api/ask: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    // SSE headers are already sent (200) before the try; errors are signaled
    // in-band via an `error` event rather than an HTTP status.
    send("error", { message: "Internal server error." });
    res.end();
  }
}
