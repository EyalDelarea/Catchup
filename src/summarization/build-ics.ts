import type { MeetingRow } from "../db/repositories/agenda.js";

// ── Local iCalendar (.ics) export (S8) ──────────────────
//
// The constitution forbids outbound third-party integrations ("nothing leaves
// the box"). So instead of syncing to Google Calendar, S7's local `meetings`
// are exported as a standard `.ics` file the user imports into ANY calendar
// themselves — nothing leaves the device automatically. This is a pure builder.

/** Escape a text value per RFC 5545 (commas, semicolons, backslashes, newlines). */
function escapeText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

/** Format a Date as an iCal UTC timestamp: YYYYMMDDTHHMMSSZ. */
function icsStamp(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/**
 * Build a VCALENDAR string from meetings. Only meetings with a known `startsAt`
 * become VEVENTs (an event needs a DTSTART); undated meetings are skipped — the
 * agenda still shows them in-app. `now` is injected for deterministic tests.
 * Pure — no IO, nothing leaves the box.
 */
export function buildIcs(meetings: MeetingRow[], now: Date): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Catchup//CatchApp//HE",
    "CALSCALE:GREGORIAN",
  ];
  const stamp = icsStamp(now);
  for (const m of meetings) {
    if (!m.startsAt) continue;
    const desc = [m.owner ? `אחראי: ${m.owner}` : "", m.chat ? `צ׳אט: ${m.chat}` : ""]
      .filter(Boolean)
      .join(" · ");
    lines.push(
      "BEGIN:VEVENT",
      `UID:meeting-${m.id}@catchapp`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsStamp(m.startsAt)}`,
      `SUMMARY:${escapeText(m.title)}`,
      ...(desc ? [`DESCRIPTION:${escapeText(desc)}`] : []),
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  // RFC 5545 uses CRLF line endings.
  return `${lines.join("\r\n")}\r\n`;
}
