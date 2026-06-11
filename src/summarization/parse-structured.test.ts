import { describe, expect, it } from "vitest";
import { parseStructuredSummary } from "./parse-structured.js";

// index → messages.id, as built from the selection passed to the model.
const idx = new Map<number, number>([
  [1, 1001],
  [2, 1002],
  [3, 1003],
]);

describe("parseStructuredSummary", () => {
  it("parses the four Hebrew sections, bullets, and ^N source markers", () => {
    const raw = [
      "## תקציר",
      "הצוות סיכם את שבוע העבודה והחליט על דדליין.",
      "",
      "## נושאים עיקריים",
      "- דנה העלתה את נושא התקציב ^1",
      "- יוסי דיווח על התקדמות בפיתוח ^2",
      "",
      "## החלטות ומשימות",
      "- הוחלט לשחרר ביום חמישי ^3",
      "",
      "## שאלות פתוחות",
      "- מי אחראי על הבדיקות?",
    ].join("\n");

    const out = parseStructuredSummary(raw, idx);

    expect(out.version).toBe(2);
    expect(out.overview).toBe("הצוות סיכם את שבוע העבודה והחליט על דדליין.");
    expect(out.topics).toEqual([
      { text: "דנה העלתה את נושא התקציב", sourceMessageId: 1001 },
      { text: "יוסי דיווח על התקדמות בפיתוח", sourceMessageId: 1002 },
    ]);
    expect(out.decisions).toEqual([{ text: "הוחלט לשחרר ביום חמישי", sourceMessageId: 1003 }]);
    expect(out.openQuestions).toEqual([{ text: "מי אחראי על הבדיקות?" }]);
    expect(out.raw).toBe(raw);
  });

  it("handles a sparse תקציר-only summary", () => {
    const raw = "## תקציר\nשיחה קצרה ללא החלטות.";
    const out = parseStructuredSummary(raw, idx);
    expect(out.overview).toBe("שיחה קצרה ללא החלטות.");
    expect(out.topics).toEqual([]);
    expect(out.decisions).toEqual([]);
    expect(out.openQuestions).toEqual([]);
  });

  it("drops an out-of-range marker but keeps the bullet text", () => {
    const raw = "## נושאים עיקריים\n- בולט עם מרקר לא תקין ^99";
    const out = parseStructuredSummary(raw, idx);
    expect(out.topics).toEqual([{ text: "בולט עם מרקר לא תקין" }]);
    expect(out.topics[0]?.sourceMessageId).toBeUndefined();
  });

  it("treats bullets with no marker as plain (no sourceMessageId)", () => {
    const raw = "## החלטות ומשימות\n- החלטה ללא מקור\n* בולט עם כוכבית";
    const out = parseStructuredSummary(raw, idx);
    expect(out.decisions).toEqual([{ text: "החלטה ללא מקור" }, { text: "בולט עם כוכבית" }]);
  });

  it("never throws when the model ignored the format — overview = raw", () => {
    const raw = "סתם טקסט חופשי ללא כותרות בכלל.";
    const out = parseStructuredSummary(raw, idx);
    expect(out.version).toBe(2);
    expect(out.overview).toBe("סתם טקסט חופשי ללא כותרות בכלל.");
    expect(out.topics).toEqual([]);
    expect(out.raw).toBe(raw);
  });

  it("ignores unknown sections like ## לפי משתתף", () => {
    const raw = "## תקציר\nתמצית.\n\n## לפי משתתף\n- דנה: משהו";
    const out = parseStructuredSummary(raw, idx);
    expect(out.overview).toBe("תמצית.");
    expect(out.topics).toEqual([]);
    expect(out.decisions).toEqual([]);
  });

  it("reserves actionItems as empty in S3 (populated by a later slice)", () => {
    const raw = "## החלטות ומשימות\n- הוחלט משהו ^1";
    const out = parseStructuredSummary(raw, idx);
    expect(out.actionItems).toEqual([]);
  });
});
