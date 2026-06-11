// ── Embedder ────────────────────────────────────────────────────────────────
// Turns text into dense vectors for semantic retrieval. Both sides of the ask
// flow use it: the backfill embeds stored messages, the EmbeddingRetriever embeds
// the question. Privacy constraint: this MUST stay local (Ollama on OLLAMA_HOST) —
// message content never leaves the device.

/** A source of dense embeddings for text. Inject a fake in tests. */
export interface Embedder {
  /** Model tag (stored alongside each vector so we can detect model drift). */
  readonly model: string;
  /** Vector dimension this embedder emits. */
  readonly dimension: number;
  /**
   * Embed a batch of texts, returning one vector per input in the SAME order.
   * Empty input yields an empty array (no network call).
   */
  embed(texts: string[]): Promise<number[][]>;
}

/** Minimal fetch surface — injectable so tests don't hit the network. */
type FetchImpl = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<Response>;

export type OllamaEmbedderOptions = {
  host: string;
  model: string;
  dimension: number;
  /** Per-request timeout (ms). Default 5 min — generous for a cold model load. */
  timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: FetchImpl;
};

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Embedder backed by Ollama's /api/embed endpoint (the batch form: `input` accepts
 * an array and returns one vector per element). Validates that the returned shape
 * matches the configured dimension so a model/config mismatch fails loudly rather
 * than writing garbage vectors.
 */
export class OllamaEmbedder implements Embedder {
  readonly model: string;
  readonly dimension: number;
  private readonly host: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchImpl;

  constructor(opts: OllamaEmbedderOptions) {
    this.host = opts.host.replace(/\/$/, "");
    this.model = opts.model;
    this.dimension = opts.dimension;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.host}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Ollama not reachable at ${this.host} (${m}). Is it running? Try 'ollama serve'.`,
      );
    }
    if (!res.ok) {
      throw new Error(`Ollama embeddings failed at ${this.host}: HTTP ${res.status}.`);
    }

    const body = (await res.json()) as { embeddings?: number[][] };
    const vectors = body.embeddings;
    if (!Array.isArray(vectors) || vectors.length !== texts.length) {
      throw new Error(
        `Ollama embeddings returned ${vectors?.length ?? 0} vectors for ${texts.length} inputs.`,
      );
    }
    for (const v of vectors) {
      if (!Array.isArray(v) || v.length !== this.dimension) {
        throw new Error(
          `Ollama model '${this.model}' returned dim ${v?.length ?? 0}, expected ${this.dimension}.`,
        );
      }
    }
    return vectors;
  }
}
