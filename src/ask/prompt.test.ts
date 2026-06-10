import { describe, expect, it } from "vitest";
import { buildAskPrompt } from "./prompt.js";
import type { Candidate } from "./retriever.js";

const NOW = new Date("2026-06-09T12:00:00Z");
const cands: Candidate[] = [
  {
    messageId: 101,
    chat: "גיבוש",
    sender: "יוסי",
    sentAt: new Date("2026-06-09T09:10:00Z"),
    content: "ערב יום שני אצלי ב-20:00",
    score: 1,
  },
  {
    messageId: 102,
    chat: "משפחה",
    sender: "אמא",
    sentAt: new Date("2026-06-07T12:00:00Z"),
    content: "אל תשכח חלב",
    score: 0.5,
  },
];

describe("buildAskPrompt", () => {
  it("numbers candidates [1..N] and embeds the question + now", () => {
    const p = buildAskPrompt("עם מי קבעתי ליום שני?", cands, NOW);
    expect(p.user).toContain("[1] (יוסי, גיבוש,");
    expect(p.user).toContain("[2] (אמא, משפחה,");
    expect(p.user).toContain("עם מי קבעתי ליום שני?");
    expect(p.system).toMatch(/\[n\]|\[מספר\]|בסוגריים/); // cite-by-number instruction
  });
  it("does not request JSON output", () => {
    const p = buildAskPrompt("x", cands, NOW);
    expect(p.system.toLowerCase()).not.toContain("json");
  });
});
