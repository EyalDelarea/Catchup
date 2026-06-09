import type pg from "pg";
import { estimateTokens } from "../summarization/prompt.js";
import type { StreamingSummarizer } from "../summarization/summarizer.js";
import { type Citation, parseCitations } from "./citations.js";
import { buildAskPrompt } from "./prompt.js";
import { type Candidate, fuse, type Retriever } from "./retriever.js";
import { resolveWindow } from "./time.js";

export type AskDeps = {
  pool: pg.Pool;
  summarizer: StreamingSummarizer;
  /** One or more retrievers; their results are merged by RRF. PR1: [lexical]. */
  retrievers: Retriever[];
  tokenBudget: number;
  /** Past lookback for the retrieval window. Default 90 days. */
  lookbackDays?: number;
  /** Max candidates fed to synthesis. Default 30. */
  defaultLimit?: number;
};

export type AskOpts = { chat?: string; limit?: number; signal?: AbortSignal };
export type AskResult = { answer: string; citations: Citation[]; candidateCount: number };

const NO_INFO = "אין מידע בטווח הזמן שנבדק.";

/** Retrieve+fuse candidates for a question. Shared by ask() and askStream(). */
async function gather(deps: AskDeps, question: string, now: Date, opts: AskOpts): Promise<Candidate[]> {
  const window = resolveWindow(question, now, deps.lookbackDays ?? 90);
  const limit = opts.limit ?? deps.defaultLimit ?? 30;
  const lists = await Promise.all(
    deps.retrievers.map((r) => r.retrieve({ question, window, chat: opts.chat, limit })),
  );
  return fuse(lists).slice(0, limit);
}

/** Trim lowest-ranked candidates until the assembled prompt fits the budget. */
function fitBudget(question: string, candidates: Candidate[], now: Date, budget: number): Candidate[] {
  let kept = candidates;
  while (kept.length > 0) {
    const p = buildAskPrompt(question, kept, now);
    if (estimateTokens(p.system + p.user) <= budget) break;
    kept = kept.slice(0, -1);
  }
  return kept;
}

/** Non-streaming ask: returns the full answer + resolved citations. */
export async function ask(deps: AskDeps, question: string, now: Date, opts: AskOpts = {}): Promise<AskResult> {
  const candidates = fitBudget(question, await gather(deps, question, now, opts), now, deps.tokenBudget);
  if (candidates.length === 0) return { answer: NO_INFO, citations: [], candidateCount: 0 };
  const prompt = buildAskPrompt(question, candidates, now);
  let answer = "";
  for await (const delta of deps.summarizer.summarizeStream(prompt, { signal: opts.signal })) {
    answer += delta;
  }
  answer = answer.trim();
  return { answer, citations: parseCitations(answer, candidates), candidateCount: candidates.length };
}

export type AskEvent =
  | { type: "token"; delta: string }
  | { type: "citations"; citations: Citation[] }
  | { type: "done"; candidateCount: number };

/** Streaming ask for SSE: yields answer tokens, then citations, then done. */
export async function* askStream(deps: AskDeps, question: string, now: Date, opts: AskOpts = {}): AsyncGenerator<AskEvent> {
  const candidates = fitBudget(question, await gather(deps, question, now, opts), now, deps.tokenBudget);
  if (candidates.length === 0) {
    yield { type: "token", delta: NO_INFO };
    yield { type: "citations", citations: [] };
    yield { type: "done", candidateCount: 0 };
    return;
  }
  const prompt = buildAskPrompt(question, candidates, now);
  let answer = "";
  for await (const delta of deps.summarizer.summarizeStream(prompt, { signal: opts.signal })) {
    answer += delta;
    yield { type: "token", delta };
  }
  yield { type: "citations", citations: parseCitations(answer.trim(), candidates) };
  yield { type: "done", candidateCount: candidates.length };
}
