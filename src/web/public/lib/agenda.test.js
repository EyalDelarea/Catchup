import { describe, expect, it } from "vitest";
import {
  avatarTint,
  buildMonthGrid,
  eventDaySet,
  groupMeetingsByDay,
  hueFromName,
  initials,
  peopleStatusMeta,
  relativeDay,
  sourceDateLabel,
  todoProgress,
} from "./agenda.js";

describe("initials", () => {
  it("takes the first letter of up to two words", () => {
    expect(initials("דנה כהן")).toBe("דכ");
    expect(initials("משה לוי שני")).toBe("מל");
  });

  it("skips leading punctuation inside a word", () => {
    expect(initials("אבי (קבלן)")).toBe("אק");
  });

  it("handles a single word and empty/blank input", () => {
    expect(initials("רונית")).toBe("ר");
    expect(initials("")).toBe("");
    expect(initials("   ")).toBe("");
    expect(initials(null)).toBe("");
  });
});

describe("hueFromName", () => {
  it("is deterministic and in range", () => {
    const h = hueFromName("יוסי טל");
    expect(h).toBe(hueFromName("יוסי טל"));
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(360);
  });

  it("differs for different names (generally)", () => {
    expect(hueFromName("משה לוי")).not.toBe(hueFromName("דנה כהן"));
  });
});

describe("avatarTint", () => {
  it("builds oklch bg/fg from the name hue", () => {
    const t = avatarTint("דנה כהן");
    expect(t.initials).toBe("דכ");
    expect(t.bg).toBe(`oklch(0.93 0.045 ${t.hue})`);
    expect(t.fg).toBe(`oklch(0.42 0.09 ${t.hue})`);
  });
});

describe("peopleStatusMeta", () => {
  it("maps cold-lead to a warn badge", () => {
    expect(peopleStatusMeta("cold-lead")).toEqual({ label: "ליד מתקרר", warn: true });
  });

  it("maps the non-warn statuses", () => {
    expect(peopleStatusMeta("active").warn).toBe(false);
    expect(peopleStatusMeta("warm").label).toBe("ליד חם");
    expect(peopleStatusMeta("dormant").label).toBe("רדום");
  });

  it("falls back to the raw value for an unknown status", () => {
    expect(peopleStatusMeta("mystery")).toEqual({ label: "mystery", warn: false });
    expect(peopleStatusMeta(null)).toEqual({ label: "", warn: false });
  });
});

describe("relativeDay", () => {
  const now = "2026-06-12T09:00:00.000Z";
  it("classifies today/tomorrow/yesterday", () => {
    expect(relativeDay("2026-06-12", now)).toBe("today");
    expect(relativeDay("2026-06-13", now)).toBe("tomorrow");
    expect(relativeDay("2026-06-11", now)).toBe("yesterday");
  });
  it("returns other for distant days and unparseable input", () => {
    expect(relativeDay("2026-06-20", now)).toBe("other");
    expect(relativeDay("nope", now)).toBe("other");
  });
});

describe("groupMeetingsByDay", () => {
  const now = "2026-06-12T09:00:00.000Z";
  const meetings = [
    { id: 1, startsAt: "2026-06-13T09:00:00Z", title: "ב" },
    { id: 2, startsAt: "2026-06-12T17:30:00Z", title: "א-late" },
    { id: 3, startsAt: "2026-06-12T14:00:00Z", title: "א-early" },
    { id: 4, startsAt: null, title: "ללא זמן" },
  ];

  it("buckets by UTC day, sorted chronologically", () => {
    const groups = groupMeetingsByDay(meetings, now);
    expect(groups.map((g) => g.key)).toEqual(["2026-06-12", "2026-06-13", null]);
    expect(groups[0].relative).toBe("today");
    expect(groups[1].relative).toBe("tomorrow");
    expect(groups[2].relative).toBe("none");
  });

  it("sorts meetings within a day by start time", () => {
    const groups = groupMeetingsByDay(meetings, now);
    expect(groups[0].items.map((m) => m.id)).toEqual([3, 2]);
  });

  it("collects null-start meetings into a trailing bucket", () => {
    const groups = groupMeetingsByDay(meetings, now);
    expect(groups.at(-1).items.map((m) => m.id)).toEqual([4]);
  });

  it("handles empty / non-array input", () => {
    expect(groupMeetingsByDay([], now)).toEqual([]);
    expect(groupMeetingsByDay(null, now)).toEqual([]);
  });
});

describe("eventDaySet", () => {
  const meetings = [
    { startsAt: "2026-06-10T09:00:00Z" },
    { startsAt: "2026-06-10T18:00:00Z" },
    { startsAt: "2026-06-12T14:00:00Z" },
    { startsAt: "2026-07-01T10:00:00Z" }, // different month
    { startsAt: null },
  ];
  it("collects day-of-month numbers for the given month only", () => {
    const set = eventDaySet(meetings, 2026, 5); // June (0-based)
    expect([...set].sort((a, b) => a - b)).toEqual([10, 12]);
  });
});

describe("buildMonthGrid", () => {
  it("pads leading blanks for the first weekday and flags today + events", () => {
    // June 2026: the 1st is a Monday (getUTCDay === 1).
    const cells = buildMonthGrid(2026, 5, { today: 12, events: new Set([10, 12]) });
    expect(cells.slice(0, 1)).toEqual([null]); // one blank before Monday
    const first = cells[1];
    expect(first).toEqual({ day: 1, isToday: false, hasEvent: false });
    const twelfth = cells.find((c) => c && c.day === 12);
    expect(twelfth).toEqual({ day: 12, isToday: true, hasEvent: true });
    const tenth = cells.find((c) => c && c.day === 10);
    expect(tenth.hasEvent).toBe(true);
    // June has 30 days → 1 blank + 30 day cells.
    expect(cells.filter(Boolean)).toHaveLength(30);
  });
});

describe("todoProgress", () => {
  it("computes done/open/pct", () => {
    const todos = [{ done: true }, { done: false }, { done: false }, { done: true }];
    expect(todoProgress(todos)).toEqual({ done: 2, total: 4, open: 2, pct: 50 });
  });
  it("is safe on an empty list", () => {
    expect(todoProgress([])).toEqual({ done: 0, total: 0, open: 0, pct: 0 });
    expect(todoProgress(null)).toEqual({ done: 0, total: 0, open: 0, pct: 0 });
  });
});

describe("sourceDateLabel", () => {
  it("formats an ISO date as a short Hebrew day + month (UTC)", () => {
    expect(sourceDateLabel("2026-06-09T07:30:00.000Z")).toBe("9 ביוני");
  });
  it("returns an empty string for null / unparseable input", () => {
    expect(sourceDateLabel(null)).toBe("");
    expect(sourceDateLabel(undefined)).toBe("");
    expect(sourceDateLabel("not-a-date")).toBe("");
  });
});
