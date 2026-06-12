import { describe, expect, it } from "vitest";
import type { MeetingRow } from "../db/repositories/agenda.js";
import { buildIcs } from "./build-ics.js";

const now = new Date("2026-06-12T00:00:00.000Z");
const meeting = (over: Partial<MeetingRow> = {}): MeetingRow => ({
  id: 1,
  title: "פגישת צוות",
  startsAt: new Date("2026-06-15T11:00:00.000Z"),
  owner: "דנה",
  chat: "עבודה",
  sourceMessageId: 9,
  ...over,
});

describe("buildIcs", () => {
  it("wraps events in a VCALENDAR with a VEVENT per dated meeting", () => {
    const ics = buildIcs([meeting()], now);
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("UID:meeting-1@catchapp");
    expect(ics).toContain("DTSTART:20260615T110000Z");
    expect(ics).toContain("SUMMARY:פגישת צוות");
    expect(ics).toContain("DESCRIPTION:אחראי: דנה · צ׳אט: עבודה");
  });

  it("skips undated meetings (a VEVENT needs a DTSTART)", () => {
    const ics = buildIcs([meeting({ startsAt: null })], now);
    expect(ics).not.toContain("BEGIN:VEVENT");
  });

  it("escapes special characters per RFC 5545", () => {
    const ics = buildIcs([meeting({ title: "פגישה; חשובה, מאוד" })], now);
    expect(ics).toContain("SUMMARY:פגישה\\; חשובה\\, מאוד");
  });
});
