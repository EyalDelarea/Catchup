// ── Inline SVG icon registry ────────────────────────────
//
// `currentColor`-driven so icons inherit text color and theme automatically.
// Ported from the prototype `Icon` set; extend `PATHS` as later slices need
// more glyphs (sparkle, filter, lock, bolt, shield, back, send, …).

const PATHS = {
  sun:
    '<circle cx="12" cy="12" r="4"/>'
    + '<path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  // ── Settings (§8) glyphs ──────────────────────────────
  sliders:
    '<path d="M5 8h14M5 16h14"/>'
    + '<circle cx="9" cy="8" r="2.2"/><circle cx="15" cy="16" r="2.2"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.4 7.9-8 9-4.6-1.1-8-4-8-9V6z"/>',
  sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>',
  bolt: '<path d="M13 3 5 13h6l-1 8 8-10h-6z"/>',
  lock:
    '<rect x="5" y="11" width="14" height="10" rx="2.5"/>'
    + '<path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  cloud: '<path d="M7 18a4 4 0 0 1-.5-8 5.5 5.5 0 0 1 10.6-1.3A3.8 3.8 0 0 1 17.5 18z"/>',
  trash:
    '<path d="M4 7h16M9 7V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v2"/>'
    + '<path d="M6 7l1 13a1.5 1.5 0 0 0 1.5 1.4h7A1.5 1.5 0 0 0 17 20l1-13"/>',
  bell:
    '<path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6"/>'
    + '<path d="M10.5 20a1.7 1.7 0 0 0 3 0"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/>',
  filter: '<path d="M3 5h18l-7 8.5V20l-4-2.2v-4.3z"/>',
  check: '<path d="M20 6.5 9.5 17 4 11.5"/>',
  chevL: '<path d="M14.5 6 8.5 12l6 6"/>',
  chevR: '<path d="M9.5 6 15.5 12l-6 6"/>',
  // ── Today (§2) glyphs ─────────────────────────────────
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  calendar:
    '<rect x="4" y="5" width="16" height="16" rx="2.5"/>'
    + '<path d="M8 3v4M16 3v4M4 10h16"/>',
  message: '<path d="M21 11.5a7.5 7.5 0 0 1-10.7 6.79L4 20l1.71-4.3A7.5 7.5 0 1 1 21 11.5z"/>',
  pencil:
    '<path d="M4 20h4L18.5 9.5a2 2 0 0 0-2.83-2.83L5 17.5z"/>'
    + '<path d="M14 7l3 3"/>',
  checks: '<path d="M3 13l3 3 7-8M13 16l1 1 7-8"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/>',
  flame: '<path d="M12 3s5 4 5 9a5 5 0 0 1-10 0c0-2 1-3.2 1-3.2s.2 2 1.6 2.6C9.2 11 12 9 12 3z"/>',
  arrowL: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  // ── People (§5) + Meetings/To-dos (§6) glyphs ─────────
  users:
    '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/>'
    + '<path d="M16 5.2a3.2 3.2 0 0 1 0 5.6M17.5 20a5.5 5.5 0 0 0-3-4.9"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.4"/>',
};

/**
 * Render an inline SVG icon as an HTML string.
 * @param {string} name - key in PATHS
 * @param {{size?: number, cls?: string}} [opts]
 * @returns {string} svg markup, or "" for an unknown name
 */
export function icon(name, { size = 20, cls = "" } = {}) {
  const p = PATHS[name];
  if (!p) return "";
  const klass = cls ? `ic ${cls}` : "ic";
  return (
    `<svg class="${klass}" width="${size}" height="${size}" viewBox="0 0 24 24" `
    + 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" '
    + `stroke-linejoin="round" aria-hidden="true">${p}</svg>`
  );
}
