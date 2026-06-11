import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test/db.js";
import { upsertScope } from "./chat-scopes.js";
import { upsertGroup } from "./groups.js";
import {
  decideSuggestion,
  insertSuggestions,
  listPendingDeck,
  loadBias,
  resetLearning,
} from "./suggestions.js";
import { insertTotalSummary } from "./total-summaries.js";

describe("suggestions repository", () => {
  let pool: pg.Pool;
  let totalId: number;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
    totalId = await insertTotalSummary(pool, {
      rangeKind: "since",
      parameters: { since: "2026-06-01" },
      output: { highlights: "h", perChat: [] },
      model: "test",
    });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("inserts pending suggestions and serves the included-chat deck", async () => {
    const gA = await upsertGroup(pool, { name: "sug-A", source: "import" });
    const gB = await upsertGroup(pool, { name: "sug-B", source: "import" });
    await insertSuggestions(pool, [
      {
        totalSummaryId: totalId,
        kind: "task",
        groupId: gA,
        proposedText: "לקנות חלב",
        reason: "כי",
      },
      {
        totalSummaryId: totalId,
        kind: "meeting",
        groupId: gB,
        proposedText: "פגישה",
        reason: "כי",
      },
    ]);

    let deck = await listPendingDeck(pool);
    const chats = deck.map((d) => d.chat);
    expect(chats).toContain("sug-A");
    expect(chats).toContain("sug-B");

    // excluding chat B drops its suggestion from the deck
    await upsertScope(pool, { groupId: gB, included: false });
    deck = await listPendingDeck(pool);
    expect(deck.map((d) => d.chat)).toContain("sug-A");
    expect(deck.map((d) => d.chat)).not.toContain("sug-B");
  });

  it("decideSuggestion updates status, logs feedback, and drops from the deck", async () => {
    const g = await upsertGroup(pool, { name: "sug-decide", source: "import" });
    await insertSuggestions(pool, [
      { totalSummaryId: totalId, kind: "task", groupId: g, proposedText: "x", reason: "r" },
    ]);
    const card = (await listPendingDeck(pool)).find((d) => d.chat === "sug-decide")!;

    expect(await decideSuggestion(pool, card.id, "accepted", "x")).toBe(true);
    expect((await listPendingDeck(pool)).some((d) => d.id === card.id)).toBe(false);

    const bias = await loadBias(pool);
    expect(bias.get(`task:${g}`)).toMatchObject({ pos: 1, neg: 0 });
  });

  it("counts discarded as negative and resetLearning wipes the bias", async () => {
    const g = await upsertGroup(pool, { name: "sug-bias", source: "import" });
    await insertSuggestions(pool, [
      { totalSummaryId: totalId, kind: "followup", groupId: g, proposedText: "y", reason: "r" },
    ]);
    const card = (await listPendingDeck(pool)).find((d) => d.chat === "sug-bias")!;
    await decideSuggestion(pool, card.id, "discarded");
    expect((await loadBias(pool)).get(`followup:${g}`)).toMatchObject({ pos: 0, neg: 1 });

    await resetLearning(pool);
    expect((await loadBias(pool)).size).toBe(0);
  });
});
