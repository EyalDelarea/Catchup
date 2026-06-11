import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertGroup } from "../db/repositories/groups.js";
import { insertMessages } from "../db/repositories/messages.js";
import { upsertParticipant } from "../db/repositories/participants.js";
import type { NormalizedMessage } from "../importer/types.js";
import { createTestDatabase } from "../test/db.js";
import { RecencyRetriever } from "./recency-retriever.js";

describe("RecencyRetriever", () => {
  let pool: pg.Pool;
  let groupId: number;
  let otherGroupId: number;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createTestDatabase() });
    groupId = await upsertGroup(pool, { name: "גיא", source: "import" });
    otherGroupId = await upsertGroup(pool, { name: "אחר", source: "import" });
    const pid = await upsertParticipant(pool, "גיא");
    const base = (over: Partial<NormalizedMessage> & { dedupeKey: string; sentAt: Date }) => ({
      groupId,
      importId: null,
      source: "import" as const,
      externalId: null,
      senderName: "גיא" as string | null,
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
      // Casual fragments that no NL question would lexically match — the real-world case.
      base({ textContent: "כנס", dedupeKey: "r1", sentAt: new Date("2026-06-10T12:00:00Z") }),
      base({ textContent: "אה", dedupeKey: "r2", sentAt: new Date("2026-06-10T12:10:00Z") }),
      base({ textContent: "זהו", dedupeKey: "r3", sentAt: new Date("2026-06-10T12:20:00Z") }),
      // Old message inside no recent window.
      base({ textContent: "ישן", dedupeKey: "r4", sentAt: new Date("2020-01-01T10:00:00Z") }),
      // A system message must be excluded.
      base({
        textContent: "joined",
        messageType: "system",
        dedupeKey: "r5",
        sentAt: new Date("2026-06-10T12:30:00Z"),
      }),
      // Message in a different chat — must be excluded when scoped.
      base({
        groupId: otherGroupId,
        textContent: "אחר",
        dedupeKey: "r6",
        sentAt: new Date("2026-06-10T12:40:00Z"),
      }),
    ]);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  }, 30_000);

  const window = {
    since: new Date("2026-06-01T00:00:00Z"),
    until: new Date("2026-06-30T00:00:00Z"),
  };

  it("returns the most recent non-system messages in the scoped chat, newest first", async () => {
    const r = new RecencyRetriever(pool);
    const out = await r.retrieve({ question: "מה דיברנו היום", window, chat: "גיא", limit: 10 });
    const contents = out.map((c) => c.content);
    expect(contents).toEqual(["זהו", "אה", "כנס"]); // newest → oldest, within window
    expect(contents).not.toContain("ישן"); // outside window
    expect(contents).not.toContain("joined"); // system excluded
    expect(contents).not.toContain("אחר"); // other chat excluded
    expect(out[0]!.chat).toBe("גיא");
    expect(out[0]!.sender).toBe("גיא");
  });

  it("ranks newer messages above older (score is monotonic with recency)", async () => {
    const r = new RecencyRetriever(pool);
    const out = await r.retrieve({ question: "x", window, chat: "גיא", limit: 10 });
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1]!.score).toBeGreaterThan(out[i]!.score);
    }
  });

  it("respects the limit", async () => {
    const r = new RecencyRetriever(pool);
    const out = await r.retrieve({ question: "x", window, chat: "גיא", limit: 2 });
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.content)).toEqual(["זהו", "אה"]);
  });

  it("searches across all chats when no chat scope is given", async () => {
    const r = new RecencyRetriever(pool);
    const out = await r.retrieve({ question: "x", window, limit: 10 });
    expect(out.map((c) => c.content)).toContain("אחר");
  });
});
