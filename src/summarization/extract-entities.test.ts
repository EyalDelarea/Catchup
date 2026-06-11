import { describe, expect, it } from "vitest";
import { extractEntities } from "./extract-entities.js";
import type { SummaryBullet } from "./summarizer.js";

const b = (text: string, sourceMessageId?: number): SummaryBullet =>
  sourceMessageId === undefined ? { text } : { text, sourceMessageId };

describe("extractEntities", () => {
  it("classifies a clock-time / meeting-keyword bullet as a meeting, rest as todos", () => {
    const decisions = [
      b("פגישה ביום חמישי 14:00 במשרד", 10),
      b("לשלוח את הדוח לדנה", 11),
      b("להיפגש עם הספק", 12),
    ];
    const { meetings, todos } = extractEntities(decisions, 5);
    expect(meetings.map((m) => m.sourceMessageId)).toEqual([10, 12]);
    expect(todos.map((t) => t.sourceMessageId)).toEqual([11]);
    expect(meetings[0]).toMatchObject({ groupId: 5, title: "פגישה ביום חמישי 14:00 במשרד" });
  });

  it("drops bullets without a sourceMessageId (can't dedup or jump)", () => {
    const { meetings, todos } = extractEntities([b("משימה ללא מקור")], 5);
    expect(meetings).toEqual([]);
    expect(todos).toEqual([]);
  });

  it("detects a known participant name as the owner", () => {
    const { todos } = extractEntities([b("דנה צריכה לאשר את התקציב", 20)], 5, ["דנה", "יוסי"]);
    expect(todos[0]?.owner).toBe("דנה");
  });

  it("leaves owner null when no known name appears", () => {
    const { todos } = extractEntities([b("לבדוק את השרת", 21)], 5, ["דנה"]);
    expect(todos[0]?.owner).toBeNull();
  });
});
