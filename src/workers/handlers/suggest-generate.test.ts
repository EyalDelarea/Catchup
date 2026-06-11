import { describe, expect, it, vi } from "vitest";
import type { Job } from "../../jobs/job-types.js";
import type { Draft, PerChatEntry } from "../../summarization/suggest-pipeline.js";
import { makeSuggestGenerateHandler, type SuggestGenerateDeps } from "./suggest-generate.js";

const job: Job<"suggest.generate"> = {
  id: "1",
  type: "suggest.generate",
  payload: { totalSummaryId: 7, tenantId: "t" },
  attempts: 0,
  maxAttempts: 3,
};

const perChat: PerChatEntry[] = [
  { groupId: 1, name: "a", summary: "s1" },
  { groupId: 2, name: "b", summary: "s2" },
];

function makeDeps(over: Partial<SuggestGenerateDeps> = {}): SuggestGenerateDeps {
  return {
    pool: {} as never,
    loadPerChat: vi.fn().mockResolvedValue(perChat),
    loadIncludedGroupIds: vi.fn().mockResolvedValue([1, 2]),
    loadEngineConfigRaw: vi.fn().mockResolvedValue({ on: true, proact: "מאוזן" }),
    loadBias: vi.fn().mockResolvedValue(new Map()),
    extract: vi.fn().mockResolvedValue([]),
    insertSuggestions: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

describe("suggestGenerateHandler", () => {
  it("no-ops when the master switch is off", async () => {
    const deps = makeDeps({ loadEngineConfigRaw: vi.fn().mockResolvedValue({ on: false }) });
    await makeSuggestGenerateHandler(deps)(job);
    expect(deps.insertSuggestions).not.toHaveBeenCalled();
    expect(deps.extract).not.toHaveBeenCalled();
  });

  it("extracts per enabled kind, scope-filters, caps, and persists", async () => {
    // one draft per chat per kind; balanced cap = 3
    const extract = vi.fn(async (kind, inScope: PerChatEntry[]) =>
      inScope.map((p): Draft => ({ kind, groupId: p.groupId, proposedText: `${kind}-${p.groupId}`, reason: "r" })),
    );
    const deps = makeDeps({
      loadIncludedGroupIds: vi.fn().mockResolvedValue([1]), // group 2 excluded
      loadEngineConfigRaw: vi.fn().mockResolvedValue({
        on: true,
        kinds: { task: true, meeting: false, followup: false, recap: false },
        proact: "מאוזן",
      }),
      extract,
    });
    await makeSuggestGenerateHandler(deps)(job);

    // only kind 'task' enabled, only group 1 in scope → 1 draft
    expect(extract).toHaveBeenCalledTimes(1);
    const [, persisted] = (deps.insertSuggestions as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ totalSummaryId: 7, kind: "task", groupId: 1 });
  });

  it("caps to 1 under עדין proactiveness", async () => {
    const extract = vi.fn(async (kind, inScope: PerChatEntry[]) =>
      inScope.map((p): Draft => ({ kind, groupId: p.groupId, proposedText: "x", reason: "r" })),
    );
    const deps = makeDeps({
      loadEngineConfigRaw: vi.fn().mockResolvedValue({ on: true, kinds: { task: true }, proact: "עדין" }),
      extract,
    });
    await makeSuggestGenerateHandler(deps)(job);
    const [, persisted] = (deps.insertSuggestions as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(persisted).toHaveLength(1);
  });
});
