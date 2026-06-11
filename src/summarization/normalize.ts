import { parseStructuredSummary } from "./parse-structured.js";
import type { SummaryBullet, SummaryOutput } from "./summarizer.js";

/**
 * A summary in the consistent shape the API + front-end render from, regardless
 * of whether the stored row is structured (S3+) or legacy prose. `version` tells
 * the UI whether bullets may carry tappable `sourceMessageId`s (2) or never (1).
 */
export type NormalizedSummary = {
  version: 1 | 2;
  /** Full markdown — backs "העתק סיכום" and the legacy render fallback. */
  overview: string;
  /** TL;DR (## תקציר) — the new §3 card's summary section. */
  tldr: string;
  topics: SummaryBullet[];
  decisions: SummaryBullet[];
  openQuestions: SummaryBullet[];
  actionItems: SummaryBullet[];
};

/**
 * Normalize a stored {@link SummaryOutput} for rendering. Structured rows pass
 * through; legacy prose rows are sectioned best-effort (no source links) so old
 * history still renders with headings. `overview` is always the full markdown.
 * Never throws.
 */
export function normalizeSummaryOutput(output: SummaryOutput): NormalizedSummary {
  if ("version" in output && output.version === 2) {
    return {
      version: 2,
      overview: output.overview,
      tldr: output.tldr,
      topics: output.topics,
      decisions: output.decisions,
      openQuestions: output.openQuestions,
      actionItems: output.actionItems,
    };
  }

  // Legacy prose: reuse the structured parser with an empty index map, so the
  // four ## sections are split but no bullet can resolve a source message.
  const prose = output.overview ?? "";
  const parsed = parseStructuredSummary(prose, new Map());
  return {
    version: 1,
    overview: prose,
    tldr: parsed.tldr,
    topics: parsed.topics,
    decisions: parsed.decisions,
    openQuestions: parsed.openQuestions,
    actionItems: parsed.actionItems,
  };
}
