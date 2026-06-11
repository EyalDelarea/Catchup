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
