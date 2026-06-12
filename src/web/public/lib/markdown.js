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
  const bolded = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  // [Chat name] → bidi-isolated chip. In RTL Hebrew text an inline bracketed
  // tag (often a Latin name with emoji/dates) gets mirrored and scrambled by
  // the bidi algorithm — the brackets flip and the run breaks the line. <bdi>
  // isolates the run so it renders correctly, and the chip styling visually
  // separates "which chat" from "what happened". The literal brackets are
  // dropped in favour of the chip. Applied after bold so it never splits a
  // <strong> tag.
  return bolded.replace(/\[([^\]\n]+)\]/g, '<bdi class="chat-tag">$1</bdi>');
}

/**
 * Strip inline source-citation markers the model emits, e.g. `^[#3, #5]` or
 * `[#1], [#2]`. The product surfaces sources via the tappable `.src` / `.sum-jump`
 * affordance (which carries the real messageId), so the raw `[#n]` numbers are
 * noise that the design never shows — drop them, including any leading caret and
 * the comma joiners between a run of them. Only `#`-prefixed brackets are touched,
 * so chat tags (`[Bar Hevr]`) and other brackets survive.
 *
 * @param {string} text - already HTML-escaped text
 * @returns {string}
 */
function stripCitations(text) {
  return text.replace(/\s*\^?\s*\[#[^\]\n]*\](?:\s*,?\s*\^?\s*\[#[^\]\n]*\])*/g, "");
}

/**
 * Render a single line of inline Markdown (bold + chat tags) to safe HTML, with
 * citation markers stripped. Use for text that lives inside its own element (a
 * summary bullet `<li>`, a card line) where the block-level wrapping of
 * {@link renderMarkdown} (`<p>`/`<ul>`) would be wrong.
 *
 * @param {string} text - raw single-line text (may contain model output)
 * @returns {string} - safe inline HTML; empty string for empty input
 */
export function renderInline(text) {
  if (text == null || String(text).trim() === "") return "";
  return applyInline(stripCitations(escapeHtml(String(text))));
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

  // 2. Drop inline source-citation markers (`^[#3, #5]`) — the source-jump
  //    affordance carries the real messageId, so these raw numbers are noise.
  const cleaned = stripCitations(escaped);

  // 3. Split into blank-line-separated blocks
  const rawBlocks = cleaned.split(/\n{2,}/);

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
