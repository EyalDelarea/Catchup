import { describe, expect, it } from "vitest";
import type { SummaryPrompt } from "../summarization/summarizer.js";
import { ask, askStream } from "./ask.js";
import type { Candidate, RetrieveQuery, Retriever } from "./retriever.js";

const NOW = new Date("2026-06-09T12:00:00Z");

function fakeRetriever(cands: Candidate[]): Retriever {
  return { retrieve: async (_q: RetrieveQuery) => cands };
}
function fakeSummarizer(answer: string) {
  return {
    async *summarizeStream(_p: SummaryPrompt) { yield answer; },
  };
}
const cands: Candidate[] = [
  { messageId: 101, chat: "גיבוש", sender: "יוסי", sentAt: NOW, content: "ערב יום שני ב-20:00", score: 1 },
];

describe("ask", () => {
  it("retrieves, synthesizes, and returns answer + parsed citations", async () => {
    const res = await ask(
      { pool: {} as never, summarizer: fakeSummarizer("קבעת עם יוסי [1]."), retrievers: [fakeRetriever(cands)], tokenBudget: 24000 },
      "עם מי קבעתי?",
      NOW,
    );
    expect(res.answer).toContain("יוסי");
    expect(res.citations.map((c) => c.messageId)).toEqual([101]);
    expect(res.candidateCount).toBe(1);
  });

  it("short-circuits with a no-info answer when nothing is retrieved (no model call)", async () => {
    let called = false;
    const res = await ask(
      { pool: {} as never, summarizer: { async *summarizeStream() { called = true; yield "should not run"; } }, retrievers: [fakeRetriever([])], tokenBudget: 24000 },
      "שאלה",
      NOW,
    );
    expect(called).toBe(false);
    expect(res.citations).toEqual([]);
    expect(res.candidateCount).toBe(0);
    expect(res.answer).toContain("אין מידע");
  });
});

describe("askStream", () => {
  it("yields token(s), then citations, then done", async () => {
    const events = [];
    for await (const ev of askStream(
      { pool: {} as never, summarizer: fakeSummarizer("קבעת עם יוסי [1]."), retrievers: [fakeRetriever(cands)], tokenBudget: 24000 },
      "עם מי קבעתי?",
      NOW,
    )) events.push(ev);
    expect(events.some((e) => e.type === "token")).toBe(true);
    const citationsEv = events.find((e) => e.type === "citations");
    expect(citationsEv?.citations?.map((c) => c.messageId)).toEqual([101]);
    expect(events.at(-1)).toMatchObject({ type: "done", candidateCount: 1 });
  });
});
