import type pg from "pg";
import type { Cursor } from "../db/repositories/read-watermarks.js";
import type { InsertSummaryInput } from "../db/repositories/summaries.js";
import type { PreparedCatchup } from "./prepare-catchup.js";
import type { SummaryPrompt } from "./summarizer.js";

export type { InsertSummaryInput };

/**
 * The "ready" state from prepareCatchup with the full text already generated.
 * Passed to persistCatchupResult so the server can stream tokens independently
 * and then commit with the same helper that summarizeAndPersist uses.
 */
export type CatchupResultToPersist = {
  pool: pg.Pool;
  groupId: number;
  summaryType: "watermark";
  parameters: Record<string, unknown>;
  fullText: string;
  model: string;
  newWatermark: Cursor;
  insertSummary: (pool: pg.Pool, input: InsertSummaryInput) => Promise<number>;
  updateWatermark: (pool: pg.Pool, groupId: number, cursor: Cursor) => Promise<void>;
};

/**
 * Shared commit step for a completed catchup run.
 *
 * Writes the summary row FIRST, then advances the watermark.
 * Shared between the non-streaming scheduled-job path (summarizeAndPersist)
 * and the streaming serve path (/api/summarize?mode=catchup).
 *
 * Returns the new summary row id.
 */
export async function persistCatchupResult(opts: CatchupResultToPersist): Promise<number> {
  const {
    pool,
    groupId,
    summaryType,
    parameters,
    fullText,
    model,
    newWatermark,
    insertSummary,
    updateWatermark,
  } = opts;

  const summaryId = await insertSummary(pool, {
    groupId,
    summaryType,
    parameters,
    output: { overview: fullText.trim() },
    model,
  });

  await updateWatermark(pool, groupId, newWatermark);

  return summaryId;
}

/**
 * Injected dependencies for summarizeAndPersist.
 * All I/O is injected for testability — no live Ollama or DB required in tests.
 */
export type SummarizeAndPersistDeps = {
  pool: pg.Pool;
  /** Resolves the group name → prepared catchup state (cache-hit / empty / ready). */
  prepareCatchup: (
    pool: pg.Pool,
    groupName: string,
    fallbackN: number,
    tokenBudget: number,
  ) => Promise<PreparedCatchup>;
  /** Calls the summarization model and returns the full output text. */
  summarize: (prompt: SummaryPrompt) => Promise<string>;
  /** Persists the summary row. */
  insertSummary: (pool: pg.Pool, input: InsertSummaryInput) => Promise<number>;
  /** Advances the read watermark for the group. */
  updateWatermark: (pool: pg.Pool, groupId: number, cursor: Cursor) => Promise<void>;
  /** Ollama model label stored in the summary row. */
  model: string;
  /** Token budget passed to prepareCatchup. */
  tokenBudget: number;
  /** Group name used to resolve the group in prepareCatchup. */
  groupName: string;
};

export type SummarizeResult = { status: "generated" | "cache-hit" };

/**
 * Shared, non-streaming summarize-and-cache core.
 *
 * 1. prepareCatchup — if cache-hit or no messages, returns { status: 'cache-hit' } (no writes).
 * 2. Calls the injected summarize(prompt) for the full text.
 * 3. insertSummary — writes the summary row FIRST.
 * 4. updateWatermark — advances the read cursor only after the summary is committed.
 *    A failure in step 3 throws before reaching step 4 (no partial state).
 *
 * Used by both the scheduled job handler and (after T008 refactor) the on-demand
 * serve path. Only token streaming differs between the two callers.
 */
export async function summarizeAndPersist(
  deps: SummarizeAndPersistDeps,
  groupId: number,
): Promise<SummarizeResult> {
  const {
    pool,
    prepareCatchup,
    summarize,
    insertSummary,
    updateWatermark,
    model,
    tokenBudget,
    groupName,
  } = deps;

  const FALLBACK_N = 25;
  const prepared = await prepareCatchup(pool, groupName, FALLBACK_N, tokenBudget);

  if (prepared.kind === "cache-hit" || prepared.kind === "empty") {
    return { status: "cache-hit" };
  }

  // kind === "ready"
  const fullText = await summarize(prepared.prompt);

  // Shared commit step: summary first, watermark second (no partial state).
  await persistCatchupResult({
    pool,
    groupId: prepared.groupId,
    summaryType: prepared.summaryType,
    parameters: prepared.parameters,
    fullText,
    model,
    newWatermark: prepared.newWatermark,
    insertSummary,
    updateWatermark,
  });

  return { status: "generated" };
}
