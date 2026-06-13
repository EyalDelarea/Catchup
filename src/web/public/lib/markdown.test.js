/**
 * markdown.test.js — Tests for renderMarkdown (Vitest, plain JS)
 *
 * Run: npx vitest run src/web/public/lib/markdown.test.js
 */

import { describe, it, expect } from "vitest";
import { renderInline, renderMarkdown } from "./markdown.js";

describe("renderMarkdown — headings", () => {
  it("## heading → <h3>", () => {
    const out = renderMarkdown("## כותרת");
    expect(out).toContain("<h3>כותרת</h3>");
  });

  it("### heading → <h4>", () => {
    const out = renderMarkdown("### כותרת קטנה");
    expect(out).toContain("<h4>כותרת קטנה</h4>");
  });

  it("## heading does not produce <h3> for non-heading lines", () => {
    const out = renderMarkdown("זה לא כותרת");
    expect(out).not.toContain("<h3>");
  });
});

describe("renderMarkdown — bold", () => {
  it("**text** → <strong>text</strong>", () => {
    const out = renderMarkdown("**מודגש**");
    expect(out).toContain("<strong>מודגש</strong>");
  });

  it("bold mid-sentence", () => {
    const out = renderMarkdown("הנה **מילה מודגשת** בתוך משפט");
    expect(out).toContain("<strong>מילה מודגשת</strong>");
  });
});

describe("renderMarkdown — chat tags (bidi isolation)", () => {
  it("[Chat] → bidi-isolated chip without the literal brackets", () => {
    const out = renderMarkdown("- [Bar Hevr] בדיקה");
    expect(out).toContain('<bdi class="chat-tag">Bar Hevr</bdi>');
    expect(out).not.toContain("[Bar Hevr]");
  });

  it("isolates a tag containing emoji and dates", () => {
    const out = renderMarkdown("- [Flopi 06.06.26 🎉] משהו קרה");
    expect(out).toContain('<bdi class="chat-tag">Flopi 06.06.26 🎉</bdi>');
  });

  it("wraps multiple tags on one line", () => {
    const out = renderMarkdown("- [A] ו [B] גם");
    const count = (out.match(/class="chat-tag"/g) || []).length;
    expect(count).toBe(2);
  });
});

describe("renderMarkdown — bullet lists", () => {
  it("consecutive '- ' lines → <ul> with <li> per item", () => {
    const out = renderMarkdown("- א\n- ב");
    expect(out).toContain("<ul>");
    expect(out).toContain("<li>א</li>");
    expect(out).toContain("<li>ב</li>");
  });

  it("'* ' bullet syntax also works", () => {
    const out = renderMarkdown("* ראשון\n* שני");
    expect(out).toContain("<ul>");
    expect(out).toContain("<li>ראשון</li>");
    expect(out).toContain("<li>שני</li>");
  });

  it("bullet list is wrapped in a single <ul>", () => {
    const out = renderMarkdown("- א\n- ב\n- ג");
    const ulCount = (out.match(/<ul>/g) || []).length;
    expect(ulCount).toBe(1);
  });
});

describe("renderMarkdown — paragraphs", () => {
  it("two blocks separated by blank line → two <p>", () => {
    const out = renderMarkdown("בלוק ראשון\n\nבלוק שני");
    const pCount = (out.match(/<p>/g) || []).length;
    expect(pCount).toBe(2);
  });

  it("single newline inside a block → <br>", () => {
    const out = renderMarkdown("שורה אחת\nשורה שניה");
    expect(out).toContain("<br>");
  });
});

describe("renderMarkdown — plain prose (no markdown)", () => {
  it("plain prose → wrapped in <p>", () => {
    const out = renderMarkdown("זוהי פסקה פשוטה ללא מרקדאון");
    expect(out).toContain("<p>");
    expect(out).not.toContain("<h3>");
    expect(out).not.toContain("<ul>");
  });
});

describe("renderMarkdown — HTML escaping (FR-010)", () => {
  it("<script> tag is escaped, not live markup", () => {
    const out = renderMarkdown("<script>alert(1)</script>");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("& is escaped to &amp;", () => {
    const out = renderMarkdown("a & b");
    expect(out).toContain("&amp;");
  });

  it("< is escaped to &lt;", () => {
    const out = renderMarkdown("a < b");
    expect(out).toContain("&lt;");
  });

  it("> is escaped to &gt;", () => {
    const out = renderMarkdown("a > b");
    expect(out).toContain("&gt;");
  });

  it('" is escaped to &quot;', () => {
    const out = renderMarkdown('say "hello"');
    expect(out).toContain("&quot;");
  });

  it("' is escaped to &#39;", () => {
    const out = renderMarkdown("it's fine");
    expect(out).toContain("&#39;");
  });
});

describe("renderMarkdown — empty / whitespace input", () => {
  it("empty string → empty string", () => {
    expect(renderMarkdown("")).toBe("");
  });

  it("whitespace-only → empty string", () => {
    expect(renderMarkdown("   \n  \n  ")).toBe("");
  });
});

describe("renderMarkdown — citation markers", () => {
  it("strips a single `^[#3, #5]` marker", () => {
    const out = renderMarkdown("גיא פרסם את לוח הזמנים ^[#3, #5].");
    expect(out).not.toContain("#3");
    expect(out).not.toContain("[#");
    expect(out).toContain("לוח הזמנים");
  });

  it("strips a run of separate `[#1], [#2]` markers", () => {
    const out = renderMarkdown("אין עליו מפתח [#1], [#2].");
    expect(out).not.toContain("[#");
    expect(out).not.toContain("#2");
  });

  it("keeps chat tags (no #) intact", () => {
    const out = renderMarkdown("- [Bar Hevr] עדכון ^[#7]");
    expect(out).toContain('<bdi class="chat-tag">Bar Hevr</bdi>');
    expect(out).not.toContain("[#");
  });
});

describe("renderInline", () => {
  it("renders **bold** without block wrapping", () => {
    const out = renderInline("**זמינות לעזרה:** אייל עדכן");
    expect(out).toContain("<strong>זמינות לעזרה:</strong>");
    expect(out).not.toContain("<p>");
    expect(out).not.toContain("<ul>");
  });

  it("strips inline citation markers", () => {
    const out = renderInline("אין עליו מפתח ^[#1], [#2].");
    expect(out).not.toContain("[#");
    expect(out).not.toContain("**");
    expect(out).toContain("אין עליו מפתח");
  });

  it("escapes HTML before transforming", () => {
    const out = renderInline("<b>x</b> **y**");
    expect(out).not.toContain("<b>x</b>");
    expect(out).toContain("&lt;b&gt;");
    expect(out).toContain("<strong>y</strong>");
  });

  it("empty / null → empty string", () => {
    expect(renderInline("")).toBe("");
    expect(renderInline(null)).toBe("");
    expect(renderInline("   ")).toBe("");
  });
});

describe("renderMarkdown — realistic mixed sample", () => {
  it("heading + bullets + paragraph all render correctly", () => {
    const md = [
      "## תקציר",
      "סיכום קצר של השיחה.",
      "",
      "## נושאים עיקריים",
      "- נושא ראשון",
      "- נושא שני",
      "",
      "הערות נוספות בפסקה.",
    ].join("\n");

    const out = renderMarkdown(md);

    expect(out).toContain("<h3>תקציר</h3>");
    expect(out).toContain("<h3>נושאים עיקריים</h3>");
    expect(out).toContain("<ul>");
    expect(out).toContain("<li>נושא ראשון</li>");
    expect(out).toContain("<li>נושא שני</li>");
    expect(out).toContain("<p>");
  });
});
