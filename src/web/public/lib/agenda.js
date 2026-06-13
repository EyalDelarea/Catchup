// ── People + Meetings/To-dos view-logic (pure) ──────────
//
// Deterministic helpers over the /api/people, /api/meetings and /api/todos
// payloads, kept out of the DOM layer so they can be unit-tested. The People
// (§5) and Meetings & To-dos (§6) screens in app.js just assemble markup from
// the structures these functions return.
//
// All date math is done over the UTC calendar day (the leading `YYYY-MM-DD` of
// each ISO string) so grouping + the month grid are fully deterministic and
// time-zone independent.

// ── Avatar tint (shared by People rows + Meeting owners) ──

/**
 * Initials for a per-name tinted disc: first letter of up to the first two
 * words, skipping leading punctuation (e.g. "אבי (קבלן)" → "אק").
 * @param {string} name
 * @returns {string}
 */
export function initials(name) {
  const words = String(name ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return words
    .map((w) => {
      const letter = [...w].find((ch) => /\p{L}|\p{N}/u.test(ch));
      return letter ?? "";
    })
    .join("");
}

/**
 * Stable hue (0–359) hashed from a name, so the same person always gets the
 * same tint. A small FNV-ish rolling hash over code units.
 * @param {string} name
 * @returns {number}
 */
export function hueFromName(name) {
  const s = String(name ?? "");
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}

/**
 * Avatar tint for a name: a light disc background + a saturated ink, both in
 * oklch keyed off the name's hash hue (mirrors the prototype `Avatar`).
 * @param {string} name
 * @returns {{ initials: string, hue: number, bg: string, fg: string }}
 */
export function avatarTint(name) {
  const hue = hueFromName(name);
  return {
    initials: initials(name),
    hue,
    bg: `oklch(0.93 0.045 ${hue})`,
    fg: `oklch(0.42 0.09 ${hue})`,
  };
}

// ── People status ────────────────────────────────────────

/**
 * Hebrew label + warn flag for a person's status. `cold-lead` is the only warn
 * status (→ `--warn` badge). Unknown statuses fall back to the raw value.
 * @param {string} status
 * @returns {{ label: string, warn: boolean }}
 */
export function peopleStatusMeta(status) {
  switch (status) {
    case "cold-lead":
      return { label: "ליד מתקרר", warn: true };
    case "warm":
      return { label: "ליד חם", warn: false };
    case "active":
      return { label: "פעיל", warn: false };
    case "dormant":
      return { label: "רדום", warn: false };
    default:
      return { label: String(status ?? ""), warn: false };
  }
}

// ── Meetings: day grouping + month grid ──────────────────

/** UTC midnight epoch (ms) for a `YYYY-MM-DD` key, or NaN if unparseable. */
function utcOf(dayKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dayKey ?? ""));
  if (!m) return Number.NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * Relative-day classification of a `YYYY-MM-DD` key against `nowIso`.
 * @param {string} dayKey
 * @param {string} nowIso - reference "now" as an ISO string
 * @returns {"today"|"tomorrow"|"yesterday"|"other"}
 */
export function relativeDay(dayKey, nowIso) {
  const a = utcOf(dayKey);
  const b = utcOf(String(nowIso ?? "").slice(0, 10));
  if (Number.isNaN(a) || Number.isNaN(b)) return "other";
  const diff = Math.round((a - b) / 86_400_000);
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff === -1) return "yesterday";
  return "other";
}

/**
 * Group meetings into day buckets, chronologically. Each bucket carries the
 * `YYYY-MM-DD` key, its relative-day classification, and the meetings sorted by
 * start time. Meetings with a null `startsAt` collect into a trailing
 * `relative: "none"` bucket (key `null`) so they're never silently dropped.
 * @param {Array<{startsAt: string|null}>} meetings
 * @param {string} nowIso
 * @returns {Array<{ key: string|null, relative: string, items: Array }>}
 */
export function groupMeetingsByDay(meetings, nowIso) {
  const list = Array.isArray(meetings) ? meetings : [];
  /** @type {Map<string, Array>} */
  const byDay = new Map();
  const unscheduled = [];
  for (const m of list) {
    if (!m || typeof m !== "object") continue;
    const starts = typeof m.startsAt === "string" ? m.startsAt : null;
    if (!starts) {
      unscheduled.push(m);
      continue;
    }
    const key = starts.slice(0, 10);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(m);
  }
  const groups = [...byDay.keys()]
    .sort()
    .map((key) => ({
      key,
      relative: relativeDay(key, nowIso),
      items: byDay.get(key).slice().sort((a, b) => String(a.startsAt).localeCompare(String(b.startsAt))),
    }));
  if (unscheduled.length) {
    groups.push({ key: null, relative: "none", items: unscheduled });
  }
  return groups;
}

/**
 * Set of day-of-month numbers (1–31) that carry at least one meeting in the
 * given UTC year/month. Drives the calendar's event dots.
 * @param {Array<{startsAt: string|null}>} meetings
 * @param {number} year
 * @param {number} monthIndex - 0-based (Jan = 0)
 * @returns {Set<number>}
 */
export function eventDaySet(meetings, year, monthIndex) {
  const days = new Set();
  for (const m of Array.isArray(meetings) ? meetings : []) {
    const starts = m && typeof m.startsAt === "string" ? m.startsAt : null;
    if (!starts) continue;
    const mm = /^(\d{4})-(\d{2})-(\d{2})/.exec(starts);
    if (!mm) continue;
    if (Number(mm[1]) === year && Number(mm[2]) - 1 === monthIndex) {
      days.add(Number(mm[3]));
    }
  }
  return days;
}

/**
 * Build a month grid: leading `null` blanks for the days before the 1st
 * (week starts Sunday), then one cell per day flagged for today + events.
 * @param {number} year
 * @param {number} monthIndex - 0-based
 * @param {{ today?: number|null, events?: Set<number> }} [opts]
 * @returns {Array<null | { day: number, isToday: boolean, hasEvent: boolean }>}
 */
export function buildMonthGrid(year, monthIndex, { today = null, events = new Set() } = {}) {
  const firstDow = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
  const daysIn = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysIn; d++) {
    cells.push({ day: d, isToday: d === today, hasEvent: events.has(d) });
  }
  return cells;
}

// ── Source chip: message date ────────────────────────────

/**
 * Short Hebrew "day month" label for a source-message ISO timestamp, e.g.
 * "2026-06-09T..." → "9 ביוני". Used in the to-do/meeting source chip
 * ("רונית אדרי · 9 ביוני"). Formatted over the UTC day to stay consistent with
 * the rest of the agenda's UTC date math. Empty string for null/unparseable.
 * @param {string|null|undefined} iso
 * @returns {string}
 */
export function sourceDateLabel(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("he-IL", { day: "numeric", month: "long", timeZone: "UTC" });
}

// ── To-dos: progress ─────────────────────────────────────

/**
 * Checklist progress over a todo list.
 * @param {Array<{done?: boolean}>} todos
 * @returns {{ done: number, total: number, open: number, pct: number }}
 */
export function todoProgress(todos) {
  const list = Array.isArray(todos) ? todos : [];
  const total = list.length;
  const done = list.filter((t) => t && t.done).length;
  const open = total - done;
  const pct = total ? Math.round((done / total) * 100) : 0;
  return { done, total, open, pct };
}
