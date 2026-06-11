import type http from "node:http";
import type pg from "pg";
import { askStream } from "../../ask/ask.js";
import type { Embedder } from "../../ask/embedder.js";
import { EmbeddingRetriever } from "../../ask/embedding-retriever.js";
import { LexicalRetriever } from "../../ask/lexical-retriever.js";
import { RecencyRetriever } from "../../ask/recency-retriever.js";
import type { Retriever } from "../../ask/retriever.js";
import { sseFrame } from "../sse.js";
import type { ServerDeps } from "./context.js";

function defaultAskRetrievers(pool: pg.Pool, chat?: string, embedder?: Embedder): Retriever[] {
  const retrievers: Retriever[] = [new LexicalRetriever(pool)];
  if (embedder) retrievers.push(new EmbeddingRetriever(pool, embedder));
  if (chat) retrievers.push(new RecencyRetriever(pool));
  return retrievers;
}

export async function handleAsk(
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
