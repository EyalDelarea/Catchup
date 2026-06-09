import { describe, expect, it } from "vitest";
import { type Candidate, fuse } from "./retriever.js";

function cand(id: number): Candidate {
  return {
    messageId: id,
    chat: "c",
    sender: "s",
    sentAt: new Date(0),
    content: `m${id}`,
    score: 0,
  };
}

describe("fuse (RRF)", () => {
  it("returns a single list unchanged in order, deduped", () => {
    const out = fuse([[cand(1), cand(2), cand(3)]]);
    expect(out.map((c) => c.messageId)).toEqual([1, 2, 3]);
  });
  it("ranks a message appearing high in BOTH lists above singletons", () => {
    const a = [cand(1), cand(2), cand(3)];
    const b = [cand(2), cand(9), cand(8)];
    const out = fuse([a, b]);
    expect(out[0]!.messageId).toBe(2); // top in list b, 2nd in list a → highest fused score
  });
  it("dedupes by messageId and preserves first-seen metadata", () => {
    const out = fuse([[cand(5)], [cand(5)]]);
    expect(out.length).toBe(1);
    expect(out[0]!.messageId).toBe(5);
  });
});
