import { parseStructuredSummary } from "./parse-structured.js";
import type { SummaryBullet, SummaryOutput } from "./summarizer.js";

/**
 * A summary in the consistent shape the API + front-end render from, regardless
 * of whether the stored row is structured (S3+) or legacy prose. `version` tells
 * the UI whether bullets may carry tappable `sourceMessageId`s (2) or never (1).
 */
export type NormalizedSummary = {
  version: 1 | 2;
  overview: string;
  topics: SummaryBullet[];
  decisions: SummaryBullet[];
  openQuestions: SummaryBullet[];
  actionItems: SummaryBullet[];
  /** Verbatim markdown — backs "העתק סיכום" and the render fallback. */
  raw: string;
};

/**
 * Normalize a stored {@link SummaryOutput} for rendering. Structured rows pass
 * through; legacy prose rows are sectioned best-effort (no source links) so old
 * history still renders with headings. Never throws.
 */
export function normalizeSummaryOutput(output: SummaryOutput): NormalizedSummary {
  if ("version" in output && output.version === 2) {
    return {
      version: 2,
      overview: output.overview,
      topics: output.topics,
      decisions: output.decisions,
      openQuestions: output.openQuestions,
      actionItems: output.actionItems,
      raw: output.raw,
    };
  }

  // Legacy prose: reuse the structured parser with an empty index map, so the
  // four ## sections are split but no bullet can resolve a source message.
  const prose = output.overview ?? "";
  const parsed = parseStructuredSummary(prose, new Map());
  return {
    version: 1,
    overview: parsed.overview,
    topics: parsed.topics,
    decisions: parsed.decisions,
    openQuestions: parsed.openQuestions,
    actionItems: parsed.actionItems,
    raw: prose,
  };
}
