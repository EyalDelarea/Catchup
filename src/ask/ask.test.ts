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
    async *summarizeStream(_p: SummaryPrompt) {
      yield answer;
    },
  };
}
const cands: Candidate[] = [
  {
    messageId: 101,
    chat: "גיבוש",
    sender: "יוסי",
    sentAt: NOW,
    content: "ערב יום שני ב-20:00",
    score: 1,
  },
];

describe("ask", () => {
  it("retrieves, synthesizes, and returns answer + parsed citations", async () => {
    const res = await ask(
      {
        summarizer: fakeSummarizer("קבעת עם יוסי [1]."),
        retrievers: [fakeRetriever(cands)],
        tokenBudget: 24000,
      },
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
      {
        summarizer: {
          async *summarizeStream() {
            called = true;
            yield "should not run";
          },
        },
        retrievers: [fakeRetriever([])],
        tokenBudget: 24000,
      },
      "שאלה",
      NOW,
    );
    expect(called).toBe(false);
    expect(res.citations).toEqual([]);
    expect(res.candidateCount).toBe(0);
    expect(res.answer).toContain("אין מידע");
  });

  it("degrades to the surviving retrievers when one throws (e.g. a hung embedder)", async () => {
    const throwing: Retriever = {
      retrieve: async () => {
        throw new Error("embedder unavailable");
      },
    };
    const res = await ask(
      {
        summarizer: fakeSummarizer("קבעת עם יוסי [1]."),
        retrievers: [throwing, fakeRetriever(cands)],
        tokenBudget: 24000,
      },
      "עם מי קבעתי?",
      NOW,
    );
    // The failed retriever is dropped; the good one's candidate still answers.
    expect(res.candidateCount).toBe(1);
    expect(res.citations.map((c) => c.messageId)).toEqual([101]);
  });

  it("trims lowest-ranked candidates to fit a tiny token budget", async () => {
    const many: Candidate[] = Array.from({ length: 5 }, (_, i) => ({
      messageId: 200 + i,
      chat: "c",
      sender: "s",
      sentAt: NOW,
      content: "תוכן ארוך מאוד ".repeat(20),
      score: 5 - i, // descending score → already rank-ordered
    }));
    const res = await ask(
      {
        summarizer: fakeSummarizer("ok [1]."),
        retrievers: [fakeRetriever(many)],
        // Tiny budget, sized to the prompt: with this candidate size the assembled
        // prompt is ~245 tokens for 1 candidate and ~576 for all 5, so 400 forces a
        // partial trim (keeps the top few, drops the rest).
        tokenBudget: 400,
      },
      "שאלה",
      NOW,
    );
    // budget is tiny, so not all 5 survive, but at least the top-ranked one does
    expect(res.candidateCount).toBeGreaterThan(0);
    expect(res.candidateCount).toBeLessThan(5);
  });
});

describe("askStream", () => {
  it("yields token(s), then citations, then done", async () => {
    const events = [];
    for await (const ev of askStream(
      {
        summarizer: fakeSummarizer("קבעת עם יוסי [1]."),
        retrievers: [fakeRetriever(cands)],
        tokenBudget: 24000,
      },
      "עם מי קבעתי?",
      NOW,
    ))
      events.push(ev);
    // Phases announced before tokens: searching, then synthesizing.
    const phases = events.filter((e) => e.type === "phase").map((e) => e.phase);
    expect(phases).toEqual(["searching", "synthesizing"]);
    expect(events.some((e) => e.type === "token")).toBe(true);
    const citationsEv = events.find((e) => e.type === "citations");
    expect(citationsEv?.citations?.map((c) => c.messageId)).toEqual([101]);
    expect(events.at(-1)).toMatchObject({ type: "done", candidateCount: 1 });
  });

  it("yields NO_INFO token, empty citations, and done(0) when nothing retrieved (no model call)", async () => {
    let called = false;
    const events = [];
    for await (const ev of askStream(
      {
        summarizer: {
          async *summarizeStream() {
            called = true;
            yield "x";
          },
        },
        retrievers: [fakeRetriever([])],
        tokenBudget: 24000,
      },
      "שאלה",
      NOW,
    ))
      events.push(ev);
    expect(called).toBe(false);
    // "searching" is announced, but never "synthesizing" — the model never ran.
    const phases = events.filter((e) => e.type === "phase").map((e) => e.phase);
    expect(phases).toEqual(["searching"]);
    expect(events.find((e) => e.type === "token")?.delta).toContain("אין מידע");
    expect(events.find((e) => e.type === "citations")?.citations).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "done", candidateCount: 0 });
  });
});
