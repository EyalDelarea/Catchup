import type { StructuredSummary, SummaryBullet } from "./summarizer.js";

// ── Heading → bucket map ────────────────────────────────
// Matches the Hebrew ## headings the prompt emits. Unknown headings (e.g.
// "לפי משתתף") are intentionally ignored. actionItems has no heading of its own
// in S3 — the field is reserved for a later slice and stays empty here.
const HEADINGS: Record<string, "overview" | "topics" | "decisions" | "openQuestions"> = {
  תקציר: "overview",
  "נושאים עיקריים": "topics",
  "החלטות ומשימות": "decisions",
  "שאלות פתוחות": "openQuestions",
};

const HEADING_RE = /^\s*##\s+(.+?)\s*$/;
const BULLET_RE = /^\s*[-*]\s+(.*)$/;
const MARKER_RE = /\s*\^(\d+)\s*$/;

/**
 * Parse a Hebrew markdown summary blob into a fielded {@link StructuredSummary}.
 * Pure + total: a model that ignores the format yields `overview = raw` with
 * empty arrays rather than an error, and an out-of-range `^N` marker is dropped
 * (bullet text kept, `sourceMessageId` left undefined).
 *
 * @param raw verbatim model markdown
 * @param indexMap line index (`[#N]`) → messages.id, from the prompt selection
 */
export function parseStructuredSummary(
  raw: string,
  indexMap: Map<number, number>,
): StructuredSummary {
  const result: StructuredSummary = {
    version: 2,
    overview: "",
    topics: [],
    decisions: [],
    openQuestions: [],
    actionItems: [],
    raw,
  };

  const overviewLines: string[] = [];
  let current: "overview" | "topics" | "decisions" | "openQuestions" | null = null;
  let sawHeading = false;

  for (const line of raw.split("\n")) {
    const heading = line.match(HEADING_RE);
    if (heading) {
      sawHeading = true;
      current = HEADINGS[heading[1]!.trim()] ?? null;
      continue;
    }
    if (current === null) continue; // text before/under an unknown heading

    if (current === "overview") {
      const text = stripMarker(line.trim()).text;
      if (text) overviewLines.push(text);
      continue;
    }

    const bullet = line.match(BULLET_RE);
    if (!bullet) continue; // non-bullet noise inside a list section
    const body = bullet[1]!.trim();
    if (!body) continue;
    result[current].push(toBullet(body, indexMap));
  }

  // No recognized headings at all → the model ignored the format; keep the prose.
  result.overview = sawHeading ? overviewLines.join(" ") : raw.trim();
  return result;
}

/** Build a bullet, resolving a trailing `^N` marker against the index map. */
function toBullet(body: string, indexMap: Map<number, number>): SummaryBullet {
  const { text, n } = stripMarker(body);
  const id = n === null ? undefined : indexMap.get(n);
  return id === undefined ? { text } : { text, sourceMessageId: id };
}

/** Split a trailing `^N` source marker off a line. */
function stripMarker(line: string): { text: string; n: number | null } {
  const m = line.match(MARKER_RE);
  if (!m) return { text: line, n: null };
  return { text: line.slice(0, m.index).trim(), n: Number.parseInt(m[1]!, 10) };
}
