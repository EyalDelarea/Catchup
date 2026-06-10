import { describe, expect, it } from "vitest";
import {
  appendToken,
  beginQuestion,
  createConversation,
  failAnswer,
  finishAnswer,
  setPhase,
} from "./ama-conversation.js";

describe("ama-conversation", () => {
  it("starts empty", () => {
    expect(createConversation().messages).toEqual([]);
  });

  it("ignores empty / whitespace questions", () => {
    const c = createConversation();
    expect(beginQuestion(c, "   ")).toBeNull();
    expect(c.messages).toEqual([]);
  });

  it("pushes a trimmed user bubble plus a pending assistant reply", () => {
    const c = createConversation();
    const reply = beginQuestion(c, "  מה קרה אתמול?  ");
    expect(c.messages[0]).toEqual({ role: "user", text: "מה קרה אתמול?" });
    expect(c.messages[1]).toBe(reply);
    expect(reply).toEqual({
      role: "assistant",
      text: "",
      pending: true,
      phase: null,
      citations: [],
      error: null,
    });
  });

  it("setPhase records progress while pending and untouched, then clears on first token", () => {
    const c = createConversation();
    const reply = beginQuestion(c, "שאלה");
    setPhase(reply, "searching");
    expect(reply.phase).toBe("searching");
    setPhase(reply, "synthesizing");
    expect(reply.phase).toBe("synthesizing");
    appendToken(reply, "תשובה");
    expect(reply.phase).toBeNull();
    // Once text has streamed, late phase events are ignored.
    setPhase(reply, "searching");
    expect(reply.phase).toBeNull();
  });

  it("accumulates streamed tokens onto the reply", () => {
    const c = createConversation();
    const reply = beginQuestion(c, "שאלה");
    appendToken(reply, "קבעת ");
    appendToken(reply, "עם דנה [1]");
    expect(reply.text).toBe("קבעת עם דנה [1]");
    expect(reply.pending).toBe(true);
  });

  it("finishAnswer attaches citations and clears pending", () => {
    const c = createConversation();
    const reply = beginQuestion(c, "שאלה");
    const citations = [
      { n: 1, messageId: 7, chat: "צוות", sender: "דנה", sentAt: "2026-06-09T18:00:00Z" },
    ];
    finishAnswer(reply, citations);
    expect(reply.pending).toBe(false);
    expect(reply.citations).toEqual(citations);
    expect(reply.error).toBeNull();
  });

  it("finishAnswer tolerates a missing citations payload", () => {
    const c = createConversation();
    const reply = beginQuestion(c, "שאלה");
    finishAnswer(reply, undefined);
    expect(reply.pending).toBe(false);
    expect(reply.citations).toEqual([]);
  });

  it("failAnswer clears pending and records the error message", () => {
    const c = createConversation();
    const reply = beginQuestion(c, "שאלה");
    appendToken(reply, "חלק מתשובה");
    failAnswer(reply, "השרת לא זמין");
    expect(reply.pending).toBe(false);
    expect(reply.error).toBe("השרת לא זמין");
    expect(reply.text).toBe("חלק מתשובה");
  });

  it("failAnswer falls back to a generic Hebrew error", () => {
    const c = createConversation();
    const reply = beginQuestion(c, "שאלה");
    failAnswer(reply, "");
    expect(reply.error).toBe("שגיאה בקבלת תשובה.");
  });
});
