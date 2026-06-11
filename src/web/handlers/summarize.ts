import type http from "node:http";
import { findGroupByName } from "../../db/repositories/groups.js";
import { countReadableByGroup, getOldestSentAt } from "../../db/repositories/messages.js";
import { upsertWatermark } from "../../db/repositories/read-watermarks.js";
import { insertSummary } from "../../db/repositories/summaries.js";
import { normalizeSummaryOutput } from "../../summarization/normalize.js";
import { parseStructuredSummary } from "../../summarization/parse-structured.js";
import { prepareSummary } from "../../summarization/prepare.js";
import { prepareCatchup } from "../../summarization/prepare-catchup.js";
import { persistCatchupResult } from "../../summarization/run-summary.js";
import type { Selection } from "../../summarization/select.js";
import { sseFrame } from "../sse.js";
import { CATCHUP_FALLBACK_N, type ServerDeps } from "./context.js";

export async function handleSummarize(
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
      // Parse the streamed prose into the fielded schema once, at completion.
      const structured = parseStructuredSummary(full, prepared.indexMap);
      // Commit only after the stream completes successfully.
      // Shared persist helper: summary row first, watermark second (no partial state).
      const summaryId = await persistCatchupResult({
        pool: deps.pool,
        groupId: prepared.groupId,
        summaryType: prepared.summaryType,
        parameters: prepared.parameters,
        output: structured,
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
        summary: normalizeSummaryOutput(structured),
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
    const structured = parseStructuredSummary(full, prepared.indexMap);
    const summaryId = await insertSummary(deps.pool, {
      groupId: prepared.groupId,
      summaryType: prepared.summaryType,
      parameters: prepared.parameters,
      output: structured,
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
      summary: normalizeSummaryOutput(structured),
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
