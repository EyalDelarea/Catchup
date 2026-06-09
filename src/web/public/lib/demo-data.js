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

/** A dummy single-group summary (markdown). */
export const DEMO_SUMMARY = [
  "**פגישת צוות:** נקבעה ליום שלישי 10:00, נטע תשלח הזמנה ביומן.",
  "",
  "**משימות פתוחות:** דני מסיים את המסמך עד חמישי; רוני בודקת את התקציב.",
  "",
  "**החלטה:** עוברים לכלי הניהול החדש מתחילת החודש הבא.",
].join("\n");

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
