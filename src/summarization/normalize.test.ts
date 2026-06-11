import { describe, expect, it } from "vitest";
import { normalizeSummaryOutput } from "./normalize.js";
import type { StructuredSummary } from "./summarizer.js";

describe("normalizeSummaryOutput", () => {
  it("passes a v2 structured summary through unchanged", () => {
    const structured: StructuredSummary = {
      version: 2,
      overview: "## תקציר\nתמצית\n## נושאים עיקריים\n- נושא ^1",
      tldr: "תמצית",
      topics: [{ text: "נושא", sourceMessageId: 42 }],
      decisions: [],
      openQuestions: [],
      actionItems: [],
    };
    const out = normalizeSummaryOutput(structured);
    expect(out.version).toBe(2);
    expect(out.tldr).toBe("תמצית");
    expect(out.topics).toEqual([{ text: "נושא", sourceMessageId: 42 }]);
    expect(out.overview).toBe(structured.overview);
  });

  it("sections a legacy prose row best-effort, as v1 with no jumps", () => {
    const legacy = { overview: "## תקציר\nשיחה.\n\n## נושאים עיקריים\n- נושא ראשון\n- נושא שני" };
    const out = normalizeSummaryOutput(legacy);
    expect(out.version).toBe(1);
    expect(out.overview).toBe(legacy.overview); // full prose retained
    expect(out.tldr).toBe("שיחה.");
    expect(out.topics).toEqual([{ text: "נושא ראשון" }, { text: "נושא שני" }]);
    expect(out.topics.every((b) => b.sourceMessageId === undefined)).toBe(true);
  });

  it("falls back to raw prose when a legacy row has no headings", () => {
    const legacy = { overview: "פסקה חופשית בלי כותרות." };
    const out = normalizeSummaryOutput(legacy);
    expect(out.version).toBe(1);
    expect(out.overview).toBe("פסקה חופשית בלי כותרות.");
    expect(out.tldr).toBe("פסקה חופשית בלי כותרות.");
    expect(out.topics).toEqual([]);
  });
});
