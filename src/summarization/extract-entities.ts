import type { SummaryBullet } from "./summarizer.js";

/** A meeting/todo to upsert, keyed by its source message. */
export type ExtractedItem = {
  title: string;
  owner: string | null;
  groupId: number;
  sourceMessageId: number;
};

export type ExtractedEntities = {
  meetings: ExtractedItem[];
  todos: ExtractedItem[];
};

// A decision bullet is treated as a MEETING when it reads like one: a clock time,
// or a meeting/appointment keyword. Otherwise it's a TODO.
const MEETING_RE =
  /\d{1,2}:\d{2}|פגיש|מפגש|להיפגש|ביום\s|יום\s(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)|מחר|מחרתיים/;

/** Match a known participant name appearing in the bullet text → owner, else null. */
function detectOwner(text: string, participantNames: string[]): string | null {
  for (const name of participantNames) {
    if (name && name.length >= 2 && text.includes(name)) return name;
  }
  return null;
}

/**
 * Map a structured summary's `decisions[]` bullets into meeting/todo rows for one
 * chat. Pure + deterministic: only bullets that carry a `sourceMessageId` become
 * rows (so they dedup + jump to source); a clock-time/meeting-keyword bullet is a
 * meeting, the rest are todos. `owner` is a known participant name found in the
 * text, when any.
 */
export function extractEntities(
  decisions: SummaryBullet[],
  groupId: number,
  participantNames: string[] = [],
): ExtractedEntities {
  const meetings: ExtractedItem[] = [];
  const todos: ExtractedItem[] = [];
  for (const b of decisions) {
    const title = b.text.trim();
    if (!title || b.sourceMessageId === undefined) continue;
    const item: ExtractedItem = {
      title,
      owner: detectOwner(title, participantNames),
      groupId,
      sourceMessageId: b.sourceMessageId,
    };
    (MEETING_RE.test(title) ? meetings : todos).push(item);
  }
  return { meetings, todos };
}
