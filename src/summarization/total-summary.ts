import type pg from "pg";
import { prepareSummary } from "./prepare.js";
import { selectActiveGroups } from "./select-active-groups.js";
import type { SummaryPrompt } from "./summarizer.js";
import { buildTotalPrompt } from "./total-prompt.js";
import type { PerChatSummary, TotalSummaryOutput } from "./total-types.js";

export type { PerChatSummary, TotalSummaryOutput };

export type GenerateTotalSummaryDeps = {
  pool: pg.Pool;
  /** Streaming summarizer; used for both per-chat (accumulated) and reduce. */
  summarizeStream: (
    prompt: SummaryPrompt,
    opts?: { signal?: AbortSignal },
  ) => AsyncGenerator<string>;
  tokenBudget: number;
};

export type GenerateTotalSummaryOpts = {
  signal?: AbortSignal;
  /** Called before each chat is summarized (for UI progress). */
  onChatStart?: (info: { index: number; total: number; name: string }) => void;
  /** Called with each reduce-phase token (for streaming highlights to the UI). */
  onHighlightToken?: (delta: string) => void;
};

/** Shown when no chat had content in the range. */
const EMPTY_HIGHLIGHTS = "## דורש תשומת לב\n- אין פעילות בטווח.";

/** Accumulate a streaming summarizer into a single string. */
async function collect(
  gen: AsyncGenerator<string>,
  onDelta?: (d: string) => void,
): Promise<string> {
  let text = "";
  for await (const delta of gen) {
    text += delta;
    onDelta?.(delta);
  }
  return text.trim();
}

/**
 * Map-reduce total summary across all active chats in the range.
 *  - map: per active chat, reuse prepareSummary + the streaming summarizer to
 *    build a structured per-chat summary (accumulated, not streamed to the UI).
 *  - reduce: one call extracts cross-cutting highlights (streamed to the UI).
 * Aborts cleanly if opts.signal fires.
 */
export async function generateTotalSummary(
  deps: GenerateTotalSummaryDeps,
  range: { since: Date },
  opts: GenerateTotalSummaryOpts = {},
): Promise<TotalSummaryOutput> {
  const groups = await selectActiveGroups(deps.pool, range);
  const perChat: PerChatSummary[] = [];

  for (let i = 0; i < groups.length; i++) {
    if (opts.signal?.aborted) break;
    const g = groups[i]!;
    opts.onChatStart?.({ index: i + 1, total: groups.length, name: g.name });

    try {
      const prepared = await prepareSummary(
        deps.pool,
        g.name,
        { since: range.since },
        deps.tokenBudget,
      );
      if (prepared.kind === "empty") continue;

      const summary = await collect(deps.summarizeStream(prepared.prompt, { signal: opts.signal }));
      perChat.push({
        groupId: g.id,
        name: g.name,
        messageCount: prepared.messageCount,
        summary,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[generateTotalSummary] chat "${g.name}" failed, skipping: ${msg}\n`);
      if (opts.signal?.aborted) break;
    }
  }

  if (perChat.length === 0) {
    return { highlights: EMPTY_HIGHLIGHTS, perChat: [] };
  }

  const reducePrompt = buildTotalPrompt(perChat);
  const highlights = await collect(
    deps.summarizeStream(reducePrompt, { signal: opts.signal }),
    opts.onHighlightToken,
  );

  return { highlights, perChat };
}
