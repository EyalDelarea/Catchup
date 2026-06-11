import { describe, expect, it } from "vitest";
import { buildPrompt, estimateTokens } from "./prompt.js";
import type { SelectedMessage } from "./select.js";

const msgs: SelectedMessage[] = [
  { sentAt: new Date("2026-01-01T10:00:00Z"), sender: "Dana", content: "נצא לטיול ב-12 ביולי" },
  { sentAt: new Date("2026-01-01T10:05:00Z"), sender: "Avi", content: "מי מביא אוהל?" },
];

/** Build N fake SelectedMessage objects for volume tests. */
function makeMessages(n: number): SelectedMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    sentAt: new Date(Date.UTC(2026, 0, 1, 10, i % 60)),
    sender: `User${i % 5}`,
    content: `Message number ${i}`,
  }));
}

describe("buildPrompt", () => {
  it("renders user messages with sender + content", () => {
    const { user } = buildPrompt(msgs);
    expect(user).toContain("Dana");
    expect(user).toContain("מי מביא אוהל?");
  });

  describe("source-line indexing", () => {
    it("prefixes each transcript line with a 1-based [#N] index", () => {
      const { user } = buildPrompt(msgs);
      expect(user).toContain("[#1] ");
      expect(user).toContain("[#2] ");
    });

    it("maps each index to its messages.id when present", () => {
      const withIds = [
        { ...msgs[0]!, messageId: 5001 },
        { ...msgs[1]!, messageId: 5002 },
      ];
      const { indexMap } = buildPrompt(withIds);
      expect(indexMap.get(1)).toBe(5001);
      expect(indexMap.get(2)).toBe(5002);
    });

    it("leaves indexMap empty when messages carry no messageId", () => {
      expect(buildPrompt(msgs).indexMap.size).toBe(0);
    });

    it("instructs the model to tag bullets with ^N source markers", () => {
      const { system } = buildPrompt(msgs);
      expect(system).toContain("^N");
      expect(system).toContain("[#N]");
    });
  });

  describe("BASE_INSTRUCTIONS — section contract", () => {
    it("instructs the model to produce a Hebrew markdown summary with ## headings", () => {
      const { system } = buildPrompt(msgs);
      // Must mention markdown / ## headings explicitly
      expect(system).toContain("##");
    });

    it("includes all four required section names", () => {
      const { system } = buildPrompt(msgs);
      expect(system).toContain("תקציר");
      expect(system).toContain("נושאים עיקריים");
      expect(system).toContain("החלטות ומשימות");
      expect(system).toContain("שאלות פתוחות");
    });

    it("mentions the optional per-person section (לפי משתתף)", () => {
      const { system } = buildPrompt(msgs);
      expect(system).toContain("לפי משתתף");
    });

    it("enforces the relevant-only / omit-empty-sections rule", () => {
      const { system } = buildPrompt(msgs);
      // Should mention omitting sections that have no content
      const lower = system.toLowerCase();
      expect(
        lower.includes("omit") ||
          lower.includes("only when") ||
          lower.includes("no content") ||
          lower.includes("has content") ||
          lower.includes("relevant"),
      ).toBe(true);
    });

    it("enforces the Hebrew same-language rule (R6)", () => {
      const { system } = buildPrompt(msgs);
      expect(system.toLowerCase()).toContain("same language");
    });

    it("instructs naming the responsible person for action items when stated", () => {
      const { system } = buildPrompt(msgs);
      // Must mention naming the owner/responsible person
      const lower = system.toLowerCase();
      expect(
        lower.includes("owner") ||
          lower.includes("responsible") ||
          lower.includes("stated") ||
          system.includes("אחראי") ||
          system.includes("בעל"),
      ).toBe(true);
    });

    it("enforces the no-invent / no-pad rule", () => {
      const { system } = buildPrompt(msgs);
      expect(system.toLowerCase()).toContain("do not pad or invent");
    });

    it("does NOT contain the old prose-only / no-headings instruction", () => {
      const { system } = buildPrompt(msgs);
      expect(system.toLowerCase()).not.toContain("no preamble, headings, or json");
      expect(system.toLowerCase()).not.toContain("prose only");
    });

    it("still instructs the model to reply with summary only (no preamble)", () => {
      const { system } = buildPrompt(msgs);
      const lower = system.toLowerCase();
      expect(
        lower.includes("no preamble") ||
          lower.includes("reply with") ||
          lower.includes("summary only"),
      ).toBe(true);
    });
  });

  describe("message-count length directive", () => {
    it("< 25 messages: brief / תקציר tier guidance", () => {
      const { system } = buildPrompt(makeMessages(10));
      const lower = system.toLowerCase();
      expect(lower.includes("brief") || lower.includes("concise") || lower.includes("short")).toBe(
        true,
      );
    });

    it("25–99 messages: several sections tier guidance", () => {
      const { system } = buildPrompt(makeMessages(50));
      const lower = system.toLowerCase();
      expect(lower.includes("section") || lower.includes("several")).toBe(true);
    });

    it("100–299 messages: comprehensive / multiple sections tier guidance", () => {
      const { system } = buildPrompt(makeMessages(120));
      const lower = system.toLowerCase();
      expect(
        lower.includes("comprehensive") ||
          lower.includes("all relevant") ||
          lower.includes("multiple"),
      ).toBe(true);
    });

    it(">= 300 messages: extensive / all sections in depth tier guidance", () => {
      const { system } = buildPrompt(makeMessages(350));
      const lower = system.toLowerCase();
      expect(
        lower.includes("extensive") || lower.includes("in depth") || lower.includes("thorough"),
      ).toBe(true);
    });

    it("boundary: exactly 25 messages uses the mid tier (not brief)", () => {
      const { system: sys10 } = buildPrompt(makeMessages(10));
      const { system: sys25 } = buildPrompt(makeMessages(25));
      expect(sys25).not.toEqual(sys10);
    });

    it("boundary: exactly 100 messages uses the comprehensive tier", () => {
      const { system: sys50 } = buildPrompt(makeMessages(50));
      const { system: sys100 } = buildPrompt(makeMessages(100));
      expect(sys100).not.toEqual(sys50);
    });

    it("boundary: exactly 300 messages uses the extensive tier", () => {
      const { system: sys150 } = buildPrompt(makeMessages(150));
      const { system: sys300 } = buildPrompt(makeMessages(300));
      expect(sys300).not.toEqual(sys150);
    });

    it("all tiers retain the same-language and no-padding instructions", () => {
      for (const n of [5, 50, 150, 350]) {
        const { system } = buildPrompt(makeMessages(n));
        expect(system.toLowerCase()).toContain("same language");
        expect(system.toLowerCase()).toContain("do not pad or invent");
      }
    });

    it("small vs large message count yields different length guidance text", () => {
      const { system: small } = buildPrompt(makeMessages(5));
      const { system: large } = buildPrompt(makeMessages(350));
      expect(small).not.toEqual(large);
    });
  });
});

describe("estimateTokens", () => {
  it("approximates ~chars/4 and grows with input", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
    expect(estimateTokens("a".repeat(800))).toBeGreaterThan(estimateTokens("a".repeat(400)));
  });
});
