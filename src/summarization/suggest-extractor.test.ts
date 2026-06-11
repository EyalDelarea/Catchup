import { describe, expect, it } from "vitest";
import { parseSuggestDrafts } from "./suggest-extractor.js";

const valid = new Set([1, 2]);

describe("parseSuggestDrafts", () => {
  it("parses a clean JSON array and tags the kind", () => {
    const raw = '[{"groupId":1,"proposedText":"לקנות חלב","reason":"כי","sourceMessageId":42}]';
    expect(parseSuggestDrafts(raw, "task", valid)).toEqual([
      { kind: "task", groupId: 1, proposedText: "לקנות חלב", reason: "כי", sourceMessageId: 42 },
    ]);
  });

  it("extracts the array out of surrounding prose", () => {
    const raw = 'הנה: [{"groupId":2,"proposedText":"פגישה"}] בהצלחה';
    const out = parseSuggestDrafts(raw, "meeting", valid);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ groupId: 2, sourceMessageId: null });
  });

  it("drops out-of-scope groupIds and empty text", () => {
    const raw =
      '[{"groupId":9,"proposedText":"x"},{"groupId":1,"proposedText":"  "},{"groupId":1,"proposedText":"ok"}]';
    expect(parseSuggestDrafts(raw, "task", valid).map((d) => d.proposedText)).toEqual(["ok"]);
  });

  it("returns [] for non-JSON / non-array / empty", () => {
    expect(parseSuggestDrafts("no json here", "task", valid)).toEqual([]);
    expect(parseSuggestDrafts('{"not":"array"}', "task", valid)).toEqual([]);
    expect(parseSuggestDrafts("[]", "task", valid)).toEqual([]);
  });
});
