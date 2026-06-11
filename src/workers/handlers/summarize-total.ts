import type pg from "pg";
import type { InsertTotalSummaryInput } from "../../db/repositories/total-summaries.js";
import type { Job } from "../../jobs/job-types.js";
import type { TotalSummaryOutput } from "../../summarization/total-types.js";

export type SummarizeTotalHandlerDeps = {
  pool: pg.Pool;
  generateTotalSummary: (range: { since: Date }) => Promise<TotalSummaryOutput>;
  insertTotalSummary: (pool: pg.Pool, input: InsertTotalSummaryInput) => Promise<number>;
  model: string;
  /**
   * Optional (S6): after the total summary is committed, enqueue suggestion
   * generation for it. Best-effort — a failure here must NOT fail the digest.
   */
  enqueueSuggestGenerate?: (totalSummaryId: number, tenantId?: string) => Promise<void>;
};

/**
 * Factory for the summarize.total job handler. Parses `since`, runs the
 * map-reduce total summary, and persists one scheduled total_summaries row.
 * Throws on bad payload / generation failure so the bus retries.
 */
export function makeSummarizeTotalHandler(deps: SummarizeTotalHandlerDeps) {
  return async function summarizeTotalHandler(job: Job<"summarize.total">): Promise<void> {
    const since = new Date(job.payload.since);
    if (Number.isNaN(since.getTime())) {
      throw new Error(`Invalid since in summarize.total payload: ${job.payload.since}`);
    }
    const output = await deps.generateTotalSummary({ since });
    const totalSummaryId = await deps.insertTotalSummary(deps.pool, {
      rangeKind: "scheduled",
      parameters: { since: since.toISOString() },
      output,
      model: deps.model,
    });

    // S6: chain suggestion generation off the committed aggregate. Best-effort —
    // never let an enqueue hiccup fail the digest the user is waiting on.
    if (deps.enqueueSuggestGenerate) {
      try {
        await deps.enqueueSuggestGenerate(totalSummaryId, job.payload.tenantId);
      } catch (err) {
        process.stderr.write(
          `[summarize.total] suggest.generate enqueue failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  };
}
