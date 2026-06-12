/**
 * demo-data.js — fabricated placeholder data for screenshots / offline preview.
 *
 * Activated only when the page URL has a `?demo=` query (off by default, never
 * touches the API or any real WhatsApp data). Used to produce README images
 * with dummy content. Group names/summaries here are invented examples.
 */

const MIN = 60 * 1000;
const now = Date.now();
const ago = (ms) => new Date(now - ms).toISOString();

/** Invented groups — fresh ones first, then stale. */
export const DEMO_GROUPS = [
  { name: "צוות עבודה", source: "group", messageCount: 0, lastMessageAt: ago(9 * MIN) },
  { name: "משפחה ❤️", source: "group", messageCount: 0, lastMessageAt: ago(42 * MIN) },
  { name: "חברים מהטיול", source: "group", messageCount: 0, lastMessageAt: ago(3 * 60 * MIN) },
  { name: "ועד הבית", source: "group", messageCount: 0, lastMessageAt: ago(2 * 24 * 60 * MIN) },
  { name: "מועדון ריצה 🏃", source: "group", messageCount: 0, lastMessageAt: ago(4 * 24 * 60 * MIN) },
  { name: "קבוצת לימוד", source: "group", messageCount: 0, lastMessageAt: ago(9 * 24 * 60 * MIN) },
];

/** Per-group dummy summaries, keyed by group name — each contextually coherent
 *  so the family chat shows family content, the work chat work content, etc.
 *  These mirror the v2 structured shape returned by the API (`getSummaries`):
 *  `overview` is the full markdown; `tldr`/`topics`/`decisions`/`openQuestions`
 *  carry the structured fields. Topic bullets may carry a `sourceMessageId` so
 *  the source-jump is exercised in demo mode. The `^[#N]` markers in `overview`
 *  prove the citation-stripping path. */
export const DEMO_SUMMARIES = {
  "משפחה ❤️": {
    version: 2,
    overview: [
      "**ארוחת שישי:** נפגשים אצל סבתא ב־19:00, אמא מביאה קינוח. ^[#1]",
      "",
      "**יום הולדת:** מתאמים הפתעה לאבא בסוף החודש — דנה אוספת כסף למתנה. ^[#2]",
      "",
      "**הסעות:** מי אוסף את הילדים מהחוג ביום רביעי? יואב התנדב. ^[#3]",
    ].join("\n"),
    tldr: "מתואמת ארוחת שישי אצל סבתא, מתוכננת הפתעת יום הולדת לאבא ונסגרו הסעות לחוג.",
    topics: [
      { lead: "ארוחת שישי", text: "נפגשים אצל סבתא ב־19:00, אמא מביאה קינוח.", sourceMessageId: 101 },
      { lead: "יום הולדת", text: "הפתעה לאבא בסוף החודש — דנה אוספת כסף למתנה.", sourceMessageId: 102 },
    ],
    decisions: [
      { text: "יואב אוסף את הילדים מהחוג ביום רביעי." },
    ],
    openQuestions: [
      { text: "מה התקציב למתנה לאבא?" },
    ],
  },
  "צוות עבודה": {
    version: 2,
    overview: [
      "**פגישת צוות:** נקבעה ליום שלישי 10:00, נטע תשלח הזמנה ביומן. ^[#1]",
      "",
      "**משימות פתוחות:** דני מסיים את המסמך עד חמישי; רוני בודקת את התקציב. ^[5, #8]",
      "",
      "**החלטה:** עוברים לכלי הניהול החדש מתחילת החודש הבא. ^[#12]",
    ].join("\n"),
    tldr: "נקבעה פגישת צוות לשלישי, חולקו משימות לסיום השבוע והוחלט לעבור לכלי ניהול חדש.",
    topics: [
      { lead: "פגישת צוות", text: "נקבעה ליום שלישי 10:00, נטע תשלח הזמנה ביומן.", sourceMessageId: 201 },
      { lead: "משימות", text: "דני מסיים את המסמך עד חמישי; רוני בודקת את התקציב.", sourceMessageId: 202 },
    ],
    decisions: [
      { text: "עוברים לכלי הניהול החדש מתחילת החודש הבא." },
    ],
    openQuestions: [
      { text: "מי מוביל את ההטמעה של הכלי החדש?" },
    ],
  },
  "חברים מהטיול": {
    version: 2,
    overview: [
      "**מפגש הבא:** מציעים פיקניק בפארק בשבת הקרובה אחה״צ. ^[#1]",
      "",
      "**תמונות:** מאיה העלתה אלבום מהטיול הצפוני — שווה לראות. ^[#4]",
      "",
      "**טיול הבא:** מתלבטים בין הגולן למדבר יהודה לחופשת הסתיו. ^[#7]",
    ].join("\n"),
    tldr: "מתוכנן פיקניק בשבת, מאיה שיתפה אלבום מהטיול הצפוני והקבוצה מתלבטת ביעד הבא.",
    topics: [
      { lead: "מפגש הבא", text: "פיקניק בפארק בשבת הקרובה אחה״צ.", sourceMessageId: 301 },
      { lead: "תמונות", text: "מאיה העלתה אלבום מהטיול הצפוני.", sourceMessageId: 302 },
    ],
    decisions: [],
    openQuestions: [
      { text: "לאן יוצאים בחופשת הסתיו — הגולן או מדבר יהודה?" },
    ],
  },
};

/** Fallback summary for any group without a tailored entry. */
export const DEMO_SUMMARY = DEMO_SUMMARIES["צוות עבודה"];

/** A dummy total-summary highlights block (markdown). */
export const DEMO_TOTAL_HIGHLIGHTS = [
  "## מה קרה היום",
  "- **צוות עבודה:** נקבעה פגישה ליום שלישי.",
  "- **משפחה:** מתאמים ארוחה משותפת לשבת.",
  "- **חברים מהטיול:** מחפשים תאריך למפגש הבא.",
].join("\n");

/** Dummy per-chat breakdown for the total view. */
export const DEMO_TOTAL_PERCHAT = [
  { name: "צוות עבודה", messageCount: 128, summary: "תיאום פגישה ומשימות לשבוע." },
  { name: "משפחה ❤️", messageCount: 64, summary: "תכנון ארוחה משפחתית בשבת." },
  { name: "חברים מהטיול", messageCount: 31, summary: "רעיונות למפגש הבא." },
];
