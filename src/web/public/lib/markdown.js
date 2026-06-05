/**
 * markdown.js — Minimal, safe Markdown-to-HTML renderer for WhatsApp-Sum summary cards.
 *
 * Browser ES module (plain JS, no TypeScript, no DOM dependencies, no external libraries).
 * Pure function — deterministic, safe to unit-test in Node.
 *
 * Supported subset:
 *   ## heading   → <h3>
 *   ### heading  → <h4>
 *   **bold**     → <strong>
 *   - item / * item (consecutive lines) → <ul><li>…</li></ul>
 *   blank-line-separated blocks → <p>…</p>
 *   single \n inside a block → <br>
 *   plain prose → <p>
 *   empty/whitespace → ""
 *
 * Security: HTML is escaped FIRST (FR-010) so no raw model output becomes live markup.
 */

/**
 * Escape HTML special characters so model/user text is never interpreted as markup.
 *
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Apply inline transforms (bold) to an already-escaped string.
 *
 * @param {string} text - HTML-escaped text
 * @returns {string}
 */
function applyInline(text) {
  // **bold** → <strong>bold</strong> (non-greedy, within a line)
  return text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

/**
 * Render a block of lines (no blank-line gaps within) to HTML.
 * The lines are already HTML-escaped.
 *
 * @param {string[]} lines
 * @returns {string}
 */
function renderBlock(lines) {
  if (lines.length === 0) return "";

  // Heading: single-line block starting with ## or ###
  if (lines.length === 1) {
    const line = lines[0];
    if (line.startsWith("### ")) {
      return `<h4>${applyInline(line.slice(4))}</h4>`;
    }
    if (line.startsWith("## ")) {
      return `<h3>${applyInline(line.slice(3))}</h3>`;
    }
  }

  // Check if ALL lines in the block are bullet items
  const isBullet = (l) => l.startsWith("- ") || l.startsWith("* ");
  if (lines.every(isBullet)) {
    const items = lines.map((l) => `<li>${applyInline(l.slice(2))}</li>`).join("");
    return `<ul>${items}</ul>`;
  }

  // Mixed block: may start with a heading line followed by prose/bullets.
  // Split into sub-blocks separated by heading lines, re-render each.
  // For simplicity: if the first line is a heading, emit it then render the rest.
  const firstLine = lines[0];
  if (firstLine.startsWith("### ") || firstLine.startsWith("## ")) {
    const heading = renderBlock([firstLine]);
    const rest = renderBlock(lines.slice(1));
    return heading + rest;
  }

  // Paragraph: join with <br> for single newlines
  const inner = lines.map((l) => applyInline(l)).join("<br>");
  return `<p>${inner}</p>`;
}

/**
 * Convert a minimal Markdown subset to a safe HTML string.
 *
 * @param {string} md - Raw markdown string (may contain model output or plain prose)
 * @returns {string}  - Safe HTML string; empty string for empty/whitespace-only input
 */
export function renderMarkdown(md) {
  if (!md || md.trim() === "") return "";

  // 1. Escape HTML FIRST — nothing from md reaches the DOM as raw markup
  const escaped = escapeHtml(md);

  // 2. Split into blank-line-separated blocks
  const rawBlocks = escaped.split(/\n{2,}/);

  const parts = [];

  for (const rawBlock of rawBlocks) {
    const lines = rawBlock
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0);

    if (lines.length === 0) continue;

    // If a block mixes bullet and non-bullet lines, or heading + bullets,
    // split at heading-starting lines so each sub-block is homogeneous.
    const subBlocks = [];
    let current = [];

    for (const line of lines) {
      const isHeading = line.startsWith("## ") || line.startsWith("### ");
      if (isHeading && current.length > 0) {
        subBlocks.push(current);
        current = [line];
      } else if (isHeading) {
        current = [line];
        subBlocks.push(current);
        current = [];
      } else {
        current.push(line);
      }
    }
    if (current.length > 0) subBlocks.push(current);

    for (const sub of subBlocks) {
      const rendered = renderBlock(sub);
      if (rendered) parts.push(rendered);
    }
  }

  return parts.join("");
}
