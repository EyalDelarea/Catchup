import { describe, expect, it } from "vitest";
import { resolveRelativeDay, resolveWindow } from "./time.js";

// Tuesday, 2026-06-09 12:00 UTC noon to avoid TZ edge flakiness.
const NOW = new Date("2026-06-09T12:00:00Z");

describe("resolveRelativeDay", () => {
  it("resolves tomorrow / מחר", () => {
    expect(resolveRelativeDay("מה קורה מחר?", NOW)?.toISOString().slice(0, 10)).toBe("2026-06-10");
    expect(resolveRelativeDay("what about tomorrow", NOW)?.toISOString().slice(0, 10)).toBe(
      "2026-06-10",
    );
  });
  it("resolves yesterday / אתמול", () => {
    expect(resolveRelativeDay("אתמול", NOW)?.toISOString().slice(0, 10)).toBe("2026-06-08");
  });
  it("resolves next Monday / יום שני הבא to the upcoming Monday", () => {
    // 2026-06-09 is Tuesday → next Monday is 2026-06-15.
    expect(resolveRelativeDay("עם מי קבעתי ליום שני הבא?", NOW)?.toISOString().slice(0, 10)).toBe(
      "2026-06-15",
    );
    expect(resolveRelativeDay("plans for next monday", NOW)?.toISOString().slice(0, 10)).toBe(
      "2026-06-15",
    );
  });
  it("returns null when no relative expression is present", () => {
    expect(resolveRelativeDay("מי שלח לי קישור", NOW)).toBeNull();
  });
  it("returns UTC-midnight-aligned dates", () => {
    expect(resolveRelativeDay("מחר", NOW)?.toISOString()).toBe("2026-06-10T00:00:00.000Z");
    expect(resolveRelativeDay("plans for next monday", NOW)?.toISOString()).toBe(
      "2026-06-15T00:00:00.000Z",
    );
  });
  it("does not match מחר inside a longer word like מחרוזת", () => {
    expect(resolveRelativeDay("מה המחרוזת שקיבלתי", NOW)).toBeNull();
  });
});

describe("resolveWindow", () => {
  it("applies the lookback to since and a future buffer to until", () => {
    const w = resolveWindow("מי שלח לי קישור", NOW, 90);
    expect(w.since.toISOString().slice(0, 10)).toBe("2026-03-11"); // 90 days back
    expect(w.until.getTime()).toBeGreaterThan(NOW.getTime());
  });
  it("extends until past a referenced future day", () => {
    const w = resolveWindow("עם מי קבעתי ליום שני הבא?", NOW, 90);
    expect(w.until.getTime()).toBeGreaterThanOrEqual(new Date("2026-06-15T00:00:00Z").getTime());
  });
  it("produces UTC-midnight-aligned since", () => {
    const w = resolveWindow("שאלה", NOW, 90);
    expect(w.since.toISOString()).toBe("2026-03-11T00:00:00.000Z");
  });
});
