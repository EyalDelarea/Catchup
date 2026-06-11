import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { askStream } from "../ask/ask.js";
import type { Embedder } from "../ask/embedder.js";
import { EmbeddingRetriever } from "../ask/embedding-retriever.js";
import { LexicalRetriever } from "../ask/lexical-retriever.js";
import { RecencyRetriever } from "../ask/recency-retriever.js";
import type { Retriever } from "../ask/retriever.js";
import { type AuthDeps, currentUser } from "../auth/service.js";
import { findGroupByName, listGroups } from "../db/repositories/groups.js";
import { countReadableByGroup, getOldestSentAt } from "../db/repositories/messages.js";
import { upsertWatermark } from "../db/repositories/read-watermarks.js";
import { insertSummary, listSummariesByGroup } from "../db/repositories/summaries.js";
import { insertTotalSummary } from "../db/repositories/total-summaries.js";
import { DEFAULT_TENANT_ID, scopedPool } from "../db/tenant-context.js";
import type { JobType } from "../jobs/job-types.js";
import { buildStatusReport, DEFAULT_STALENESS_MS } from "../service/status.js";
import { prepareSummary } from "../summarization/prepare.js";
import { prepareCatchup } from "../summarization/prepare-catchup.js";
import { persistCatchupResult } from "../summarization/run-summary.js";
import type { Selection } from "../summarization/select.js";
import type { StreamingSummarizer } from "../summarization/summarizer.js";
import { generateTotalSummary } from "../summarization/total-summary.js";
import { type AdminRegistry, makeAdminRoutes } from "./admin-routes.js";
import { makeAuthRoutes } from "./auth-routes.js";
import { makeOnboardingRoutes, type OnboardingRegistry } from "./onboarding-routes.js";
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
  /** Retrievers for the ask flow. Defaults to the lexical/recency/embedding set when absent. */
  askRetrievers?: Retriever[];
  /**
   * Embedder for semantic retrieval. When present, an EmbeddingRetriever is fused
   * into the default set. When absent (e.g. Ollama not configured), the ask flow
   * gracefully falls back to lexical (+ recency) only.
   */
  embedder?: Embedder;
  /**
   * T2 auth wiring. When absent, the server runs exactly as before (single-user, no
   * login) except every /api request is tenant-scoped to the default tenant. When
   * `required` is true (multi-tenant mode), /api/* outside /api/auth/* demands a valid
   * session and runs scoped to THAT session's tenant.
   */
  auth?: {
    deps: AuthDeps;
    cookieSecure: boolean;
    required: boolean;
  };
  /**
   * T4 onboarding: the per-tenant WhatsApp session registry. When present, the
   * /api/onboarding/* endpoints (QR stream + link + status) are served, scoped to the
   * authenticated tenant. Absent → onboarding endpoints 404 (single-user CLI linking).
   */
  onboarding?: OnboardingRegistry;
  /**
   * T5 operator dashboard: cross-tenant admin view. `/api/admin/*` is reachable only by
   * a logged-in user whose email is in `operatorEmails`; the data comes from the
   * BYPASSRLS `operatorPool` joined with live session health (`registry`).
   */
  admin?: {
    operatorPool: pg.Pool;
    registry: AdminRegistry;
    operatorEmails: string[];
    /** T6: audit sink so operator access to the cross-tenant view is logged. */
    recordAudit?: (entry: import("../db/repositories/audit.js").AuditEntry) => Promise<void>;
  };
};

/** SPA entry pages: / plus the landing paths used in verify/reset emails + /admin. */
const SPA_PATHS = new Set(["/", "/verify", "/reset", "/admin"]);

export function createServer(deps: ServerDeps): http.Server {
  const authRoutes = deps.auth
    ? makeAuthRoutes({ deps: deps.auth.deps, cookieSecure: deps.auth.cookieSecure })
    : null;
  const onboardingRoutes = deps.onboarding
    ? makeOnboardingRoutes({ registry: deps.onboarding })
    : null;
  const adminRoutes = deps.admin
    ? makeAdminRoutes({
        operatorPool: deps.admin.operatorPool,
        registry: deps.admin.registry,
        recordAudit: deps.admin.recordAudit,
      })
    : null;

  const handleRequest = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && SPA_PATHS.has(url.pathname)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(INDEX_HTML, "utf8"));
      return;
    }

    // Auth endpoints answer for themselves (they are exactly the routes that must
    // work without a session) and short-circuit the gate below.
    if (authRoutes && (await authRoutes.handle(req, res, url))) return;

    if (url.pathname.startsWith("/api/")) {
      // Establish the request's tenant, then scope ALL data access to it. In
      // single-user mode that's the default tenant — identical behavior to before,
      // now explicitly attributed.
      let tenantId = DEFAULT_TENANT_ID;
      let session = null;
      if (deps.auth?.required) {
        session = authRoutes ? await authRoutes.session(req) : null;
        if (!session) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Not authenticated." }));
          return;
        }
        tenantId = session.tenantId;
      }
      // Admin (cross-tenant) — gated on the session user's email being an operator.
      // Computed here so a tenant session can never reach the admin pool.
      if (adminRoutes && url.pathname.startsWith("/api/admin/")) {
        let isOperator = false;
        let operatorEmail: string | null = null;
        if (session && deps.auth && deps.admin) {
          const user = await currentUser(deps.auth.deps, session);
          if (user != null && deps.admin.operatorEmails.includes(user.email.toLowerCase())) {
            isOperator = true;
            operatorEmail = user.email;
          }
        }
        if (await adminRoutes.handle(req, res, url, { isOperator, operatorEmail })) return;
      }
      // Onboarding talks to the registry, not the DB pool — route it with the raw
      // tenantId before the pool-scoped dispatch.
      if (onboardingRoutes && (await onboardingRoutes.handle(req, res, url, tenantId))) return;
      const scoped: ServerDeps = { ...deps, pool: scopedPool(deps.pool, () => tenantId) };
      dispatchApi(url, req, res, scoped);
      return;
    }

    // Generic static asset handler — must come after all /api/* routes
    if (req.method === "GET") {
      void handleStatic(url.pathname, res);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  };

  return http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      process.stderr.write(
        `Error handling ${req.url}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: "Internal server error." }));
    });
  });
}

function dispatchApi(
  url: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ServerDeps,
): void {
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
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not found");
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

/**
 * Production retriever set for the ask flow. Lexical always runs. When an embedder
 * is configured we also fuse in semantic (embedding) retrieval — the general fix
 * for poor Hebrew lexical recall: a question can match a reply by MEANING even with
 * zero shared words. For a chat-scoped question we also fuse in recency: NL
 * questions like "מה גיא שאל אותי היום" rarely share content words with the replies,
 * so lexical alone returns none of the relevant messages — recency supplies the
 * actual recent context. We skip recency for all-chats questions, where "most
 * recent across every chat" would just be noise.
 */
function defaultAskRetrievers(pool: pg.Pool, chat?: string, embedder?: Embedder): Retriever[] {
  const retrievers: Retriever[] = [new LexicalRetriever(pool)];
  if (embedder) retrievers.push(new EmbeddingRetriever(pool, embedder));
  if (chat) retrievers.push(new RecencyRetriever(pool));
  return retrievers;
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
    const retrievers = deps.askRetrievers ?? defaultAskRetrievers(deps.pool, chat, deps.embedder);

    // Observability: log on arrival (so a hung/slow ask is still visible in
    // Loki) and again on completion with timings. component:"ask" is promoted
    // to a Loki stream label by the logger, so the ask dashboard can filter on
    // it; high-cardinality fields stay in the body.
    const start = Date.now();
    deps.logger?.info(
      { component: "ask", evt: "ask_start", chat: chat ?? null, scoped: Boolean(chat) },
      "ask start",
    );
    let firstTokenAt: number | null = null;
    let candidateCount = 0;

    for await (const ev of askStream(
      { summarizer: deps.summarizer, retrievers, tokenBudget: deps.tokenBudget },
      question,
      new Date(),
      { chat, signal: ac.signal },
    )) {
      if (ac.signal.aborted) break;
      if (ev.type === "phase") send("phase", { phase: ev.phase });
      else if (ev.type === "token") {
        if (firstTokenAt === null) firstTokenAt = Date.now();
        send("token", { delta: ev.delta });
      } else if (ev.type === "citations") send("citations", { citations: ev.citations });
      else {
        candidateCount = ev.candidateCount;
        send("done", { candidateCount: ev.candidateCount });
      }
    }
    deps.logger?.info(
      {
        component: "ask",
        evt: "ask",
        chat: chat ?? null,
        scoped: Boolean(chat),
        candidateCount,
        ttfbMs: firstTokenAt === null ? null : firstTokenAt - start,
        totalMs: Date.now() - start,
        aborted: ac.signal.aborted,
      },
      "ask done",
    );
    if (ac.signal.aborted) return;
    res.end();
  } catch (err) {
    process.stderr.write(
      `Error handling /api/ask: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    deps.logger?.info(
      {
        component: "ask",
        evt: "ask_error",
        message: err instanceof Error ? err.message : String(err),
      },
      "ask error",
    );
    // SSE headers are already sent (200) before the try; errors are signaled
    // in-band via an `error` event rather than an HTTP status.
    send("error", { message: "Internal server error." });
    res.end();
  }
}
