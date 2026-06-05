import pg from "pg";
import { loadConfig } from "../config.js";
import { insertSummary } from "../db/repositories/summaries.js";
import { prepareSummary } from "./prepare.js";
import type { Selection } from "./select.js";
import { OllamaSummarizer, type Summarizer, type SummaryOutput } from "./summarizer.js";

export type RunSummarizeInput = {
  groupName: string;
  selection: Selection;
};

export type RunSummarizeResult =
  | { kind: "empty" }
  | { kind: "ok"; output: SummaryOutput; summaryId: number };

type RunSummarizeDeps = {
  databaseUrl: string;
  summarizer: Summarizer;
  /** Model label recorded on the row. */
  model: string;
  tokenBudget: number;
};

export async function runSummarize(
  input: RunSummarizeInput,
  deps?: Partial<RunSummarizeDeps>,
): Promise<RunSummarizeResult> {
  const config = loadConfig();
  const databaseUrl = deps?.databaseUrl ?? config.databaseUrl;
  const model = deps?.model ?? config.summarization.model;
  const tokenBudget = deps?.tokenBudget ?? config.summarization.tokenBudget;
  const summarizer: Summarizer =
    deps?.summarizer ??
    new OllamaSummarizer({
      host: config.summarization.ollamaHost,
      model: config.summarization.model,
      numCtx: config.summarization.numCtx,
    });

  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const prepared = await prepareSummary(pool, input.groupName, input.selection, tokenBudget);
    if (prepared.kind === "empty") return { kind: "empty" };

    const output = await summarizer.summarize(prepared.prompt);
    const summaryId = await insertSummary(pool, {
      groupId: prepared.groupId,
      summaryType: prepared.summaryType,
      parameters: prepared.parameters,
      output,
      model,
    });
    return { kind: "ok", output, summaryId };
  } finally {
    await pool.end();
  }
}
