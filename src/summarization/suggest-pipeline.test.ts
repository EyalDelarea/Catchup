import { describe, expect, it } from "vitest";
import type { BiasEntry } from "../db/repositories/suggestions.js";
import {
  applySuppression,
  capDrafts,
  type Draft,
  filterInScope,
  rankDrafts,
  suppressedKeys,
} from "./suggest-pipeline.js";

const draft = (over: Partial<Draft> = {}): Draft => ({
  kind: "task",
  groupId: 1,
  proposedText: "x",
  reason: "r",
  ...over,
});

describe("filterInScope", () => {
  it("keeps only included groups", () => {
    const perChat = [
      { groupId: 1, name: "a", summary: "s" },
      { groupId: 2, name: "b", summary: "s" },
    ];
    expect(filterInScope(perChat, new Set([1])).map((p) => p.groupId)).toEqual([1]);
  });
});

describe("suppressedKeys", () => {
  it("suppresses pairs with enough discards and a low accept ratio", () => {
    const bias = new Map<string, BiasEntry>([
      ["task:1", { pos: 0, neg: 3 }], // ratio 0 → suppress
      ["task:2", { pos: 5, neg: 1 }], // ratio high → keep
      ["meeting:3", { pos: 1, neg: 1 }], // neg < min → keep
    ]);
    expect(suppressedKeys(bias)).toEqual(new Set(["task:1"]));
  });
});

describe("applySuppression", () => {
  it("drops suppressed (kind,group) drafts", () => {
    const drafts = [draft({ groupId: 1 }), draft({ groupId: 2 })];
    expect(applySuppression(drafts, new Set(["task:1"])).map((d) => d.groupId)).toEqual([2]);
  });
});

describe("rankDrafts", () => {
  it("orders by net bias, ties keep input order", () => {
    const drafts = [
      draft({ groupId: 1, proposedText: "low" }),
      draft({ groupId: 2, proposedText: "high" }),
      draft({ groupId: 3, proposedText: "mid" }),
    ];
    const bias = new Map<string, BiasEntry>([
      ["task:1", { pos: 0, neg: 0 }],
      ["task:2", { pos: 5, neg: 0 }],
      ["task:3", { pos: 1, neg: 0 }],
    ]);
    expect(rankDrafts(drafts, bias).map((d) => d.proposedText)).toEqual(["high", "mid", "low"]);
  });
});

describe("capDrafts", () => {
  it("keeps top N, and all when Infinity", () => {
    const drafts = [draft(), draft(), draft()];
    expect(capDrafts(drafts, 2)).toHaveLength(2);
    expect(capDrafts(drafts, Number.POSITIVE_INFINITY)).toHaveLength(3);
    expect(capDrafts(drafts, 0)).toHaveLength(0);
  });
});
