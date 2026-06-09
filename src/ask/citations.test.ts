import { describe, expect, it } from "vitest";
import type { Candidate } from "./retriever.js";
import { parseCitations } from "./citations.js";

const cands: Candidate[] = [
  { messageId: 101, chat: "גיבוש", sender: "יוסי", sentAt: new Date("2026-06-09T09:10:00Z"), content: "a", score: 1 },
  { messageId: 102, chat: "משפחה", sender: "אמא", sentAt: new Date("2026-06-07T12:00:00Z"), content: "b", score: 1 },
];

describe("parseCitations", () => {
  it("extracts [n] and [n, m] markers and maps to candidate metadata", () => {
    const out = parseCitations("קבעת עם יוסי [1], אמא ביקשה חלב [2].", cands);
    expect(out.map((c) => c.messageId)).toEqual([101, 102]);
    expect(out[0]).toMatchObject({ n: 1, messageId: 101, sender: "יוסי", chat: "גיבוש" });
  });
  it("dedupes repeated citations and preserves first-seen order", () => {
    const out = parseCitations("[1] ... [1] ... [2]", cands);
    expect(out.map((c) => c.n)).toEqual([1, 2]);
  });
  it("drops out-of-range indices", () => {
    const out = parseCitations("see [9] and [1]", cands);
    expect(out.map((c) => c.n)).toEqual([1]);
  });
});
