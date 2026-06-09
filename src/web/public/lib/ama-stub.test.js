import { describe, it, expect } from "vitest";
import { CANNED_REPLY, createConversation, ask } from "./ama-stub.js";

describe("ama-stub", () => {
  it("starts empty", () => {
    expect(createConversation().messages).toEqual([]);
  });

  it("ignores empty / whitespace questions", () => {
    const c = createConversation();
    ask(c, "   ");
    expect(c.messages).toEqual([]);
  });

  it("appends a user bubble then a canned assistant reply", () => {
    const c = createConversation();
    ask(c, "מה קרה אתמול?");
    expect(c.messages).toEqual([
      { role: "user", text: "מה קרה אתמול?" },
      { role: "assistant", text: CANNED_REPLY },
    ]);
  });

  it("trims the question and returns the conversation", () => {
    const c = createConversation();
    const out = ask(c, "  שלום  ");
    expect(out).toBe(c);
    expect(c.messages[0].text).toBe("שלום");
  });
});
