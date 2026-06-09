/** A retrieval time window. Retrieval is bounded to [since, until]. */
export type AskWindow = { since: Date; until: Date };

const DAY_MS = 24 * 60 * 60 * 1000;
/** How far into the future the window always extends, to catch just-made plans. */
const FUTURE_BUFFER_DAYS = 14;

// Weekday index (0=Sunday) keyed by English name and Hebrew name.
const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  ראשון: 0, שני: 1, שלישי: 2, רביעי: 3, חמישי: 4, שישי: 5, שבת: 6,
};

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}

/** The next occurrence of `weekday` strictly after `now` (1..7 days ahead). */
function nextWeekday(now: Date, weekday: number): Date {
  const cur = now.getUTCDay();
  let delta = (weekday - cur + 7) % 7;
  if (delta === 0) delta = 7; // "next" = the upcoming one, not today
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return addDays(base, delta);
}

/**
 * Resolve a single relative day expression in the question against an injected
 * `now`. Returns the absolute date (UTC midnight), or null if none is found.
 * Recognizes: tomorrow/מחר, yesterday/אתמול, next-week/שבוע הבא, and
 * next-<weekday> / <weekday> הבא|הקרוב in English and Hebrew.
 */
export function resolveRelativeDay(question: string, now: Date): Date | null {
  // Floor to UTC midnight so all returned dates are midnight-aligned.
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const q = question.toLowerCase();
  // Hebrew bare-word matches are guarded with Hebrew-letter boundaries to avoid false positives
  // (e.g. מחר inside מחרוזת). English uses standard \b word boundaries.
  if (/(?<![א-ת])מחר(?![א-ת])/.test(q) || /\btomorrow\b/.test(q)) return addDays(today, 1);
  if (/(?<![א-ת])אתמול(?![א-ת])/.test(q) || /\byesterday\b/.test(q)) return addDays(today, -1);
  if (/שבוע הבא/.test(q) || /\bnext week\b/.test(q)) return addDays(today, 7);

  for (const [name, idx] of Object.entries(WEEKDAYS)) {
    // \b after the English name prevents matching "next mondays" etc.
    // The Hebrew branch already requires an explicit suffix (הבא|הקרוב).
    const re = new RegExp(`(next\\s+${name}\\b)|(${name}\\s+(הבא|הקרוב))`);
    if (re.test(q)) return nextWeekday(today, idx);
  }
  return null;
}

/**
 * Build the retrieval window. `since` is `lookbackDays` before now; `until` is
 * now + FUTURE_BUFFER_DAYS, extended further if the question references a future
 * day. `now` is always injected for deterministic tests.
 */
export function resolveWindow(question: string, now: Date, lookbackDays = 90): AskWindow {
  // Floor to UTC midnight so since/until boundaries are always day-aligned.
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const since = addDays(today, -lookbackDays);
  let until = addDays(today, FUTURE_BUFFER_DAYS);
  const ref = resolveRelativeDay(question, now);
  if (ref && ref.getTime() > until.getTime()) until = addDays(ref, FUTURE_BUFFER_DAYS);
  return { since, until };
}
