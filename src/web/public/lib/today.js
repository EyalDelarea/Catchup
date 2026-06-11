// ── Today view-logic (pure) ─────────────────────────────
//
// Deterministic helpers over the /api/suggestions payload, kept out of the DOM
// layer so they can be unit-tested. The Today screen (§2) is a Stories-style
// card deck: read-only **info** cards (cross-chat highlights) lead, then the
// actionable **suggestion** cards (the engine). The DOM layer in app.js just
// assembles markup from the structures these functions return.
//
// Contract (GET /api/suggestions):
//   { suggestions: Array<{ id, kind, chat, proposedText, reason, sourceMessageId }>,
//     info: { highlights, perChat: Array<{ chat, summary }> } }

/**
 * @typedef {"task"|"meeting"|"followup"|"recap"} SuggestionKind
 * @typedef {{
 *   type: "suggestion", id: number, kind: SuggestionKind, chat: string,
 *   proposedText: string, reason: string, sourceMessageId: number|null
 * }} SuggestionCard
 * @typedef {{ type: "info", id: string, variant: "highlights", body: string }
 *   | { type: "info", id: string, variant: "perchat", chat: string, body: string }} InfoCard
 * @typedef {SuggestionCard | InfoCard} Card
 */

/**
 * Per-kind copy + commit affordances. `title(chat)` builds the headline,
 * `editable` decides whether a draft input (true) or a recap preview (false)
 * is shown, and `commit*` drives the full-width primary button + flash toast.
 * @type {Record<SuggestionKind, {
 *   icon: string, kicker: string, title: (chat: string) => string, prompt: string,
 *   editable: boolean, commitIcon: string, commitLabel: string, flash: string
 * }>}
 */
export const SUGGESTION_KINDS = {
  task: {
    icon: "checks",
    kicker: "הצעת משימה",
    title: (chat) => `זיהיתי משימה ב${chat}`,
    prompt: "ערכו לפני ההוספה — זו טיוטה שלכם",
    editable: true,
    commitIcon: "plus",
    commitLabel: "הוסף משימה",
    flash: "נוסף למשימות ✓",
  },
  meeting: {
    icon: "calendar",
    kicker: "הצעת פגישה",
    title: (chat) => `לתאם פגישה עם ${chat}?`,
    prompt: "ערכו לפני ההוספה — זו טיוטה שלכם",
    editable: true,
    commitIcon: "calendar",
    commitLabel: "הוסף ליומן",
    flash: "נוסף ליומן ✓",
  },
  followup: {
    icon: "user",
    kicker: "הצעת פולואו-אפ",
    title: (chat) => `כדאי לחזור ל${chat}`,
    prompt: "ערכו לפני ההוספה — זו טיוטה שלכם",
    editable: true,
    commitIcon: "bell",
    commitLabel: "קבע תזכורת",
    flash: "תזכורת נקבעה ✓",
  },
  recap: {
    icon: "sparkle",
    kicker: "סיכום חכם",
    title: (chat) => `סיכום מוכן ל${chat}`,
    prompt: "ריכזתי את העיקר — להציג?",
    editable: false,
    commitIcon: "message",
    commitLabel: "פתח סיכום",
    flash: "נפתח ✓",
  },
};

/** The kinds counted in the quick-tiles row, in display order. */
export const TILE_KINDS = /** @type {SuggestionKind[]} */ (["task", "meeting", "followup"]);

/**
 * Resolve a suggestion's per-kind config, falling back to `task` for an unknown
 * kind so the UI never renders an empty card.
 * @param {string} kind
 */
export function suggestionConfig(kind) {
  return SUGGESTION_KINDS[/** @type {SuggestionKind} */ (kind)] ?? SUGGESTION_KINDS.task;
}

/** True for a renderable suggestion entry (has a numeric id + known/any kind). */
function isValidSuggestion(s) {
  return !!s && typeof s === "object" && Number.isFinite(s.id) && typeof s.kind === "string";
}

/**
 * Build the ordered card deck from a (possibly missing / 404) payload.
 *
 * Order: read-only **info** cards first (highlights, then one per chat), then
 * the actionable **suggestion** cards. Leading with the cross-chat digest gives
 * the Stories deck a "context → action" narrative and lets the deck drain to the
 * DoneState once every suggestion is acted on. Defensive throughout — a null
 * body, missing arrays, or malformed entries are skipped rather than thrown on.
 *
 * @param {{ suggestions?: unknown, info?: unknown } | null | undefined} data
 * @returns {Card[]}
 */
export function buildDeck(data) {
  /** @type {Card[]} */
  const info = [];
  const infoSrc = data && typeof data === "object" ? /** @type {any} */ (data).info : null;
  if (infoSrc && typeof infoSrc === "object") {
    const highlights = typeof infoSrc.highlights === "string" ? infoSrc.highlights.trim() : "";
    if (highlights) {
      info.push({ type: "info", id: "info:highlights", variant: "highlights", body: highlights });
    }
    const perChat = Array.isArray(infoSrc.perChat) ? infoSrc.perChat : [];
    for (const row of perChat) {
      if (!row || typeof row !== "object") continue;
      const chat = typeof row.chat === "string" ? row.chat : "";
      const body = typeof row.summary === "string" ? row.summary.trim() : "";
      if (!chat || !body) continue;
      info.push({ type: "info", id: `info:chat:${chat}`, variant: "perchat", chat, body });
    }
  }

  /** @type {Card[]} */
  const suggestions = [];
  const sugSrc = data && typeof data === "object" ? /** @type {any} */ (data).suggestions : null;
  if (Array.isArray(sugSrc)) {
    for (const s of sugSrc) {
      if (!isValidSuggestion(s)) continue;
      suggestions.push({
        type: "suggestion",
        id: s.id,
        kind: s.kind,
        chat: typeof s.chat === "string" ? s.chat : "",
        proposedText: typeof s.proposedText === "string" ? s.proposedText : "",
        reason: typeof s.reason === "string" ? s.reason : "",
        sourceMessageId: Number.isFinite(s.sourceMessageId) ? s.sourceMessageId : null,
      });
    }
  }

  return [...info, ...suggestions];
}

/** Type guard: is this card an actionable suggestion? */
export function isSuggestion(card) {
  return !!card && card.type === "suggestion";
}

/**
 * Per-kind counts over the raw suggestion list, for the quick-tiles row.
 * @param {Array<{kind?: string}>} suggestions
 * @returns {Record<SuggestionKind, number>}
 */
export function tileCounts(suggestions) {
  const counts = { task: 0, meeting: 0, followup: 0, recap: 0 };
  for (const s of Array.isArray(suggestions) ? suggestions : []) {
    if (s && Object.prototype.hasOwnProperty.call(counts, s.kind)) counts[s.kind] += 1;
  }
  return counts;
}

/**
 * Decide how committing a suggestion maps onto the PUT action. A recap (or any
 * non-editable kind) always commits as `accept`. An editable draft commits as
 * `edit` when the user changed the text, else `accept`. Trims for comparison so
 * incidental whitespace doesn't count as an edit.
 * @param {{kind: string, proposedText: string}} suggestion
 * @param {string} draftValue
 * @returns {{action: "accept"|"edit", finalText: string}}
 */
export function commitActionFor(suggestion, draftValue) {
  const cfg = suggestionConfig(suggestion.kind);
  const text = draftValue ?? "";
  if (!cfg.editable) return { action: "accept", finalText: suggestion.proposedText };
  const changed = text.trim() !== String(suggestion.proposedText ?? "").trim();
  return changed ? { action: "edit", finalText: text } : { action: "accept", finalText: text };
}

/** The CSS leaving-animation variant for an action (drives `.story.leaving.<x>`). */
export function leavingVariant(action) {
  if (action === "snooze") return "snooze";
  if (action === "discard") return "snooze"; // dismiss slides the same way as snooze
  return "done"; // accept / edit
}

/** Clamp an index into `[0, length-1]` (or 0 for an empty deck). */
export function clampIndex(index, length) {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}

/** Remaining index after removing the card at `removedIndex` from a deck that
 *  is about to shrink to `newLength`. Keeps the viewer on the next card. */
export function indexAfterRemoval(currentIndex, removedIndex, newLength) {
  if (newLength <= 0) return 0;
  const next = removedIndex < currentIndex ? currentIndex - 1 : currentIndex;
  return clampIndex(next, newLength);
}

/** Remove a card by id, returning a new array (does not mutate). */
export function removeCardById(cards, id) {
  return cards.filter((c) => c.id !== id);
}

/** Up-to-2 peek cards behind the top card, to show the pile shrinking. */
export function peekCount(remaining) {
  return Math.max(0, Math.min(remaining - 1, 2));
}

/** Filled/empty state of each segment in the progress strip. */
export function segmentFills(activeIndex, total) {
  return Array.from({ length: Math.max(0, total) }, (_, k) => k <= activeIndex);
}

/** A fresh action tally for the DoneState. */
export function emptyTally() {
  return { add: 0, snooze: 0, discard: 0 };
}

/**
 * Fold an action into the running tally. `accept`/`edit` → committed (`add`);
 * `snooze`/`discard` keep their own buckets so the DoneState copy can phrase
 * "accepted N · deferred M" precisely.
 * @param {{add: number, snooze: number, discard: number}} tally
 * @param {"accept"|"edit"|"snooze"|"discard"} action
 */
export function recordTally(tally, action) {
  const next = { ...tally };
  if (action === "accept" || action === "edit") next.add += 1;
  else if (action === "snooze") next.snooze += 1;
  else if (action === "discard") next.discard += 1;
  return next;
}

/**
 * Hebrew summary fragments for the DoneState ("קיבלת N · דחית M").
 * @param {{add: number, snooze: number, discard: number}} tally
 * @returns {string[]}
 */
export function tallyBits(tally) {
  const bits = [];
  if (tally.add) bits.push(`קיבלת ${tally.add} ${tally.add === 1 ? "הצעה" : "הצעות"}`);
  const deferred = (tally.snooze || 0) + (tally.discard || 0);
  if (deferred) bits.push(`דחית ${deferred}`);
  return bits;
}

/** Time-aware greeting head (Hebrew). `hour` is 0–23. */
export function greeting(hour) {
  if (hour < 12) return "בוקר טוב";
  if (hour < 18) return "צהריים טובים";
  return "ערב טוב";
}
