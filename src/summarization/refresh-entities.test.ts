import { describe, expect, it, vi } from "vitest";
import { materializeEntities } from "./refresh-entities.js";
import type { StructuredSummary, SummaryOutput } from "./summarizer.js";

const v2 = (decisions: StructuredSummary["decisions"] = []): StructuredSummary => ({
  version: 2,
  overview: "o",
  tldr: "t",
  topics: [],
  decisions,
  openQuestions: [],
  actionItems: [],
});

describe("materializeEntities (best-effort, logged)", () => {
  it("logs and swallows the error when extraction fails — never throws", async () => {
    const client = { query: vi.fn().mockRejectedValue(new Error("boom")) } as never;
    const logger = { warn: vi.fn() };
    const output: SummaryOutput = v2([{ text: "x", sourceMessageId: 1 }]);

    await expect(materializeEntities(client, 5, output, logger)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("skips non-v2 output without touching the client and without logging", async () => {
    const query = vi.fn();
    const client = { query } as never;
    const logger = { warn: vi.fn() };

    await expect(
      materializeEntities(client, 5, { overview: "legacy" }, logger),
    ).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
