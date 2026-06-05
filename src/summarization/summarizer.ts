import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

export type SummaryOutput = {
  /** Prose summary in the conversation's language ("what you missed"). */
  overview: string;
};

export type SummaryPrompt = {
  system: string;
  user: string;
};

/**
 * A summarization engine. summarize() sends an assembled prompt to a model and
 * returns the prose summary. Throws on transport/empty-output failure.
 */
export interface Summarizer {
  summarize(prompt: SummaryPrompt): Promise<SummaryOutput>;
}

/** A summarizer that can stream its output token-by-token (for the web UI). */
export interface StreamingSummarizer {
  summarizeStream(prompt: SummaryPrompt, opts?: { signal?: AbortSignal }): AsyncGenerator<string>;
}

/**
 * FetchImpl used by OllamaSummarizer.
 *
 * Non-streaming calls receive the full body and return a JSON-able Response.
 * Streaming calls need a ReadableStream body — for the node:http transport we
 * implement a minimal shim that wraps the IncomingMessage in a ReadableStream.
 *
 * Injectable for tests (pass a fake); production defaults to the node:http
 * transport to avoid undici's 300s headersTimeout (same pattern as
 * OllamaVisionAnalyzer — see src/vision/ollama-analyzer.ts).
 */
type FetchImpl = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }
) => Promise<Response>;

/** Default socket-inactivity timeout — generous for cold Ollama model loads. */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 15 min

/**
 * node:http(s) transport with a generous socket timeout.
 * Mirrors the transport in src/vision/ollama-analyzer.ts but wraps the
 * IncomingMessage in a ReadableStream so streaming callers work too.
 */
function nodeHttpTransport(timeoutMs: number): FetchImpl {
  return (url, init) =>
    new Promise<Response>((resolve, reject) => {
      const u = new URL(url);
      const mod = u.protocol === "https:" ? https : http;
      const req = mod.request(
        {
          hostname: u.hostname,
          port: u.port,
          path: u.pathname + u.search,
          method: init.method,
          headers: { ...init.headers, "content-length": String(Buffer.byteLength(init.body)) },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const ok = status >= 200 && status < 300;

          // Wrap IncomingMessage in a ReadableStream so streaming paths work.
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              res.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
              res.on("end", () => controller.close());
              res.on("error", (err) => controller.error(err));
            },
            cancel() {
              res.destroy();
            },
          });

          resolve(
            new Response(body, {
              status,
              headers: { "content-type": res.headers["content-type"] ?? "application/json" },
            }) as Response & { ok: boolean; status: number }
          );
        }
      );
      req.on("error", reject);
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`OllamaSummarizer: socket timeout after ${timeoutMs}ms`));
      });

      // Honor abort signal
      if (init.signal) {
        if (init.signal.aborted) {
          req.destroy(new DOMException("aborted", "AbortError"));
          return;
        }
        init.signal.addEventListener("abort", () => {
          req.destroy(new DOMException("aborted", "AbortError"));
        }, { once: true });
      }

      req.write(init.body);
      req.end();
    });
}

export type OllamaSummarizerOptions = {
  host: string;
  model: string;
  numCtx: number;
  /**
   * Injectable for tests; defaults to the node:http transport (avoids
   * undici's 300s headersTimeout on cold/large model loads).
   */
  fetchImpl?: FetchImpl;
  /** Socket inactivity timeout in ms (default 15 min). */
  timeoutMs?: number;
};

export class OllamaSummarizer implements Summarizer, StreamingSummarizer {
  private readonly host: string;
  private readonly model: string;
  private readonly numCtx: number;
  private readonly fetchImpl: FetchImpl;

  constructor(opts: OllamaSummarizerOptions) {
    this.host = opts.host.replace(/\/$/, "");
    this.model = opts.model;
    this.numCtx = opts.numCtx;
    this.fetchImpl = opts.fetchImpl ?? nodeHttpTransport(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  async summarize(prompt: SummaryPrompt, opts?: { signal?: AbortSignal }): Promise<SummaryOutput> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.host}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // No `format`: requesting JSON/structured output makes some models
        // (gemma4:26b) degenerate into repetition loops on short Hebrew input.
        // Plain prose is reliable; repeat_penalty>1 further guards against loops.
        body: JSON.stringify({
          model: this.model,
          stream: false,
          options: { num_ctx: this.numCtx, temperature: 0.2, repeat_penalty: 1.3 },
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
          ],
        }),
        signal: opts?.signal,
      });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      throw new Error(`Ollama not reachable at ${this.host} (${m}). Is it running? Try 'ollama serve'.`);
    }

    if (!res.ok) {
      throw new Error(`Ollama not reachable at ${this.host}: HTTP ${res.status}.`);
    }

    const body = (await res.json()) as { message?: { content?: string } };
    const text = (body.message?.content ?? "").trim();
    if (text.length === 0) {
      throw new Error("Empty model output (no summary text returned).");
    }
    return { overview: text };
  }

  async *summarizeStream(prompt: SummaryPrompt, opts?: { signal?: AbortSignal }): AsyncGenerator<string> {
    // If already aborted before we even start, return immediately.
    if (opts?.signal?.aborted) return;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.host}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          stream: true,
          options: { num_ctx: this.numCtx, temperature: 0.2, repeat_penalty: 1.3 },
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
          ],
        }),
        signal: opts?.signal,
      });
    } catch (err) {
      // Treat AbortError as a clean stop — not a crash.
      if (err instanceof Error && err.name === "AbortError") return;
      const m = err instanceof Error ? err.message : String(err);
      throw new Error(`Ollama not reachable at ${this.host} (${m}). Is it running? Try 'ollama serve'.`);
    }
    if (!res.ok) throw new Error(`Ollama not reachable at ${this.host}: HTTP ${res.status}.`);
    if (!res.body) throw new Error("Ollama returned no response body.");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      // Check abort before each read so we stop promptly.
      if (opts?.signal?.aborted) {
        await reader.cancel().catch(() => {});
        return;
      }
      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        ({ done, value } = await reader.read());
      } catch (err) {
        // AbortError thrown by reader.read() when the signal fires — clean stop.
        if (err instanceof Error && err.name === "AbortError") {
          await reader.cancel().catch(() => {});
          return;
        }
        throw err;
      }
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let obj: { message?: { content?: string }; done?: boolean };
        try { obj = JSON.parse(line); } catch { continue; }
        const delta = obj.message?.content;
        if (delta) yield delta;
        if (obj.done) return;
      }
    }
  }
}
