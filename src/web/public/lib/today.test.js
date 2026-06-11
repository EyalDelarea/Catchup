import { describe, expect, it } from "vitest";
import {
  buildDeck,
  clampIndex,
  commitActionFor,
  emptyTally,
  greeting,
  indexAfterRemoval,
  isSuggestion,
  leavingVariant,
  peekCount,
  recordTally,
  removeCardById,
  segmentFills,
  SUGGESTION_KINDS,
  suggestionConfig,
  tallyBits,
  tileCounts,
} from "./today.js";

const sug = (over = {}) => ({
  id: 1,
  kind: "task",
  chat: "צוות עבודה",
  proposedText: "להכין מצגת",
  reason: "4 הודעות פתוחות",
  sourceMessageId: 42,
  ...over,
});

describe("buildDeck", () => {
  it("orders info cards (highlights then per-chat) before suggestions", () => {
    const deck = buildDeck({
      suggestions: [sug({ id: 7 })],
      info: { highlights: "יום עמוס", perChat: [{ chat: "דנה", summary: "סיכום דנה" }] },
    });
    expect(deck.map((c) => c.type)).toEqual(["info", "info", "suggestion"]);
    expect(deck[0]).toMatchObject({ variant: "highlights", body: "יום עמוס" });
    expect(deck[1]).toMatchObject({ variant: "perchat", chat: "דנה", body: "סיכום דנה" });
    expect(deck[2]).toMatchObject({ type: "suggestion", id: 7 });
  });

  it("returns an empty deck for null / missing / 404-shaped payloads", () => {
    expect(buildDeck(null)).toEqual([]);
    expect(buildDeck(undefined)).toEqual([]);
    expect(buildDeck({})).toEqual([]);
    expect(buildDeck({ suggestions: "nope", info: 5 })).toEqual([]);
  });

  it("skips blank highlights and malformed per-chat / suggestion entries", () => {
    const deck = buildDeck({
      suggestions: [sug(), { id: "x", kind: "task" }, null, { kind: "task" }],
      info: { highlights: "   ", perChat: [{ chat: "", summary: "x" }, { chat: "a", summary: "  " }, 3] },
    });
    expect(deck).toHaveLength(1);
    expect(deck[0]).toMatchObject({ type: "suggestion", id: 1 });
  });

  it("normalizes a non-finite sourceMessageId to null", () => {
    const [card] = buildDeck({ suggestions: [sug({ sourceMessageId: undefined })] });
    expect(card.sourceMessageId).toBeNull();
  });

  it("gives info cards stable, unique ids", () => {
    const deck = buildDeck({ info: { highlights: "h", perChat: [{ chat: "a", summary: "s" }] } });
    expect(deck.map((c) => c.id)).toEqual(["info:highlights", "info:chat:a"]);
  });
});

describe("isSuggestion", () => {
  it("distinguishes suggestion cards from info cards", () => {
    const [info, suggestion] = buildDeck({ suggestions: [sug()], info: { highlights: "h" } });
    expect(isSuggestion(info)).toBe(false);
    expect(isSuggestion(suggestion)).toBe(true);
    expect(isSuggestion(null)).toBe(false);
  });
});

describe("suggestionConfig", () => {
  it("returns the matching kind config", () => {
    expect(suggestionConfig("meeting").commitLabel).toBe("הוסף ליומן");
    expect(suggestionConfig("recap").editable).toBe(false);
  });

  it("falls back to task for an unknown kind", () => {
    expect(suggestionConfig("zzz")).toBe(SUGGESTION_KINDS.task);
  });

  it("builds per-kind titles from the chat name", () => {
    expect(SUGGESTION_KINDS.meeting.title("יוסי")).toBe("לתאם פגישה עם יוסי?");
  });
});

describe("tileCounts", () => {
  it("counts suggestions per kind", () => {
    const counts = tileCounts([
      sug({ kind: "task" }),
      sug({ kind: "task" }),
      sug({ kind: "meeting" }),
      sug({ kind: "recap" }),
      sug({ kind: "bogus" }),
    ]);
    expect(counts).toEqual({ task: 2, meeting: 1, followup: 0, recap: 1 });
  });

  it("tolerates a non-array argument", () => {
    expect(tileCounts(undefined)).toEqual({ task: 0, meeting: 0, followup: 0, recap: 0 });
  });
});

describe("commitActionFor", () => {
  it("commits an unedited editable draft as accept", () => {
    expect(commitActionFor(sug(), "להכין מצגת")).toEqual({ action: "accept", finalText: "להכין מצגת" });
  });

  it("commits a changed editable draft as edit, carrying finalText", () => {
    expect(commitActionFor(sug(), "להכין מצגת מעודכנת")).toEqual({
      action: "edit",
      finalText: "להכין מצגת מעודכנת",
    });
  });

  it("ignores incidental surrounding whitespace", () => {
    expect(commitActionFor(sug(), "  להכין מצגת  ").action).toBe("accept");
  });

  it("always accepts a non-editable (recap) suggestion, keeping its proposedText", () => {
    const recap = sug({ kind: "recap", proposedText: "סיכום שבועי" });
    expect(commitActionFor(recap, "ignored")).toEqual({ action: "accept", finalText: "סיכום שבועי" });
  });
});

describe("leavingVariant", () => {
  it("maps actions onto the CSS leaving classes", () => {
    expect(leavingVariant("accept")).toBe("done");
    expect(leavingVariant("edit")).toBe("done");
    expect(leavingVariant("snooze")).toBe("snooze");
    expect(leavingVariant("discard")).toBe("snooze");
  });
});

describe("index helpers", () => {
  it("clamps into range and handles an empty deck", () => {
    expect(clampIndex(5, 3)).toBe(2);
    expect(clampIndex(-1, 3)).toBe(0);
    expect(clampIndex(2, 0)).toBe(0);
  });

  it("keeps the viewer on the next card after a removal", () => {
    // Removing a card before the cursor shifts the cursor back by one.
    expect(indexAfterRemoval(2, 0, 3)).toBe(1);
    // Removing the active card keeps the same index (now the following card).
    expect(indexAfterRemoval(2, 2, 3)).toBe(2);
    // Removing the last remaining card clamps to the new end.
    expect(indexAfterRemoval(3, 3, 3)).toBe(2);
    expect(indexAfterRemoval(0, 0, 0)).toBe(0);
  });

  it("removeCardById returns a new array without the card", () => {
    const cards = buildDeck({ suggestions: [sug({ id: 1 }), sug({ id: 2 })] });
    const out = removeCardById(cards, 1);
    expect(out.map((c) => c.id)).toEqual([2]);
    expect(cards).toHaveLength(2); // original untouched
  });
});

describe("peekCount", () => {
  it("caps the peek pile at 2", () => {
    expect(peekCount(1)).toBe(0);
    expect(peekCount(2)).toBe(1);
    expect(peekCount(5)).toBe(2);
    expect(peekCount(0)).toBe(0);
  });
});

describe("segmentFills", () => {
  it("fills segments up to and including the active index", () => {
    expect(segmentFills(1, 3)).toEqual([true, true, false]);
    expect(segmentFills(0, 0)).toEqual([]);
  });
});

describe("tally", () => {
  it("accumulates committed vs deferred actions", () => {
    let t = emptyTally();
    t = recordTally(t, "accept");
    t = recordTally(t, "edit");
    t = recordTally(t, "snooze");
    t = recordTally(t, "discard");
    expect(t).toEqual({ add: 2, snooze: 1, discard: 1 });
  });

  it("phrases the DoneState bits in Hebrew", () => {
    expect(tallyBits({ add: 1, snooze: 0, discard: 0 })).toEqual(["קיבלת 1 הצעה"]);
    expect(tallyBits({ add: 3, snooze: 1, discard: 1 })).toEqual(["קיבלת 3 הצעות", "דחית 2"]);
    expect(tallyBits(emptyTally())).toEqual([]);
  });
});

describe("greeting", () => {
  it("returns a time-aware Hebrew greeting", () => {
    expect(greeting(7)).toBe("בוקר טוב");
    expect(greeting(14)).toBe("צהריים טובים");
    expect(greeting(21)).toBe("ערב טוב");
  });
});
