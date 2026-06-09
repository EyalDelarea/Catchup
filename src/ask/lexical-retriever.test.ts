import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertGroup } from "../db/repositories/groups.js";
import { insertMessages } from "../db/repositories/messages.js";
import { upsertParticipant } from "../db/repositories/participants.js";
import type { NormalizedMessage } from "../importer/types.js";
import { createTestDatabase } from "../test/db.js";
import { extractTerms, LexicalRetriever } from "./lexical-retriever.js";

describe("extractTerms", () => {
  it("splits on whitespace/punctuation and keeps content tokens", () => {
    expect(extractTerms("מי שלח לי קישור?")).toContain("קישור");
    expect(extractTerms("who sent the link")).toContain("link");
  });

  it("drops bare boolean operator words that would break websearch_to_tsquery", () => {
    expect(extractTerms("or")).toEqual([]);
    expect(extractTerms("מסיבה or חלב")).toEqual(["מסיבה", "חלב"]);
  });
});

describe("LexicalRetriever", () => {
  let pool: pg.Pool;
  let groupId: number;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
    // upsertGroup takes { name, source } — no whatsappId at this level
    groupId = await upsertGroup(pool, { name: "חברים", source: "import" });
    const pid = await upsertParticipant(pool, "דנה");
    const base = (over: Partial<NormalizedMessage> & { dedupeKey: string; sentAt: Date }) => ({
      groupId,
      importId: null,
      source: "import" as const,
      externalId: null,
      senderName: "דנה" as string | null,
      messageType: "text" as const,
      textContent: null,
      mediaFilename: null,
      mediaPath: null,
      mediaStatus: null,
      fromMe: false,
      participantId: pid,
      ...over,
    });
    await insertMessages(pool, [
      base({
        textContent: "בא נעשה מסיבה ביום שני",
        dedupeKey: "k1",
        sentAt: new Date("2026-06-08T19:00:00Z"),
      }),
      base({
        textContent: "אל תשכח לקנות חלב",
        dedupeKey: "k2",
        sentAt: new Date("2026-06-07T10:00:00Z"),
      }),
      base({
        textContent: "מסיבה ישנה מאוד",
        dedupeKey: "k3",
        sentAt: new Date("2020-01-01T10:00:00Z"),
      }),
    ]);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  it("returns messages matching the query terms within the window", async () => {
    const r = new LexicalRetriever(pool);
    const out = await r.retrieve({
      question: "מסיבה",
      window: { since: new Date("2026-01-01T00:00:00Z"), until: new Date("2026-12-31T00:00:00Z") },
      limit: 10,
    });
    const contents = out.map((c) => c.content);
    expect(contents.some((c) => c.includes("מסיבה ביום שני"))).toBe(true);
    expect(out.some((c) => c.content.includes("חלב"))).toBe(false); // no term match
    expect(out.some((c) => c.content.includes("ישנה מאוד"))).toBe(false); // outside window
    expect(out[0]!.chat).toBe("חברים");
    expect(out[0]!.sender).toBe("דנה");
  });

  it("ORs across multiple terms (matches messages containing ANY term)", async () => {
    const r = new LexicalRetriever(pool);
    const out = await r.retrieve({
      question: "מסיבה חלב",
      window: { since: new Date("2026-01-01T00:00:00Z"), until: new Date("2026-12-31T00:00:00Z") },
      limit: 10,
    });
    const joined = out.map((c) => c.content).join(" | ");
    expect(joined).toContain("מסיבה ביום שני"); // matched on מסיבה
    expect(joined).toContain("חלב"); // matched on חלב — proves OR, not AND
  });
});
