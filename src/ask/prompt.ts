import type { SummaryPrompt } from "../summarization/summarizer.js";
import type { Candidate } from "./retriever.js";

// Spike-validated instructions (gemma4:26b): cite [n], refuse when absent, no JSON.
// "מה X שאל/אמר" is a recap request, not a demand for a literal question — the model
// must not answer "no info" just because the messages aren't phrased as questions.
const SYSTEM = [
  "אתה עוזר שעונה על שאלות לגבי היסטוריית הודעות וואטסאפ של המשתמש.",
  "ענה אך ורק לפי ההודעות הממוספרות שתקבל. אל תמציא מידע.",
  'התייחס לשאלות כמו "מה X שאל אותי", "מה X אמר" או "על מה דיברנו" כבקשה לסכם את ההודעות הרלוונטיות — אל תדרוש שההודעה תהיה מנוסחת כשאלה מילולית; כל הודעה רלוונטית של אותו אדם או באותו נושא נחשבת לתשובה.',
  "אחרי כל טענה, ציין בסוגריים מרובעים את מספר/י ההודעה שעליהן היא מתבססת, למשל [2] או [2, 5].",
  "אמור במפורש שאין מידע רק כאשר אין כלל הודעות רלוונטיות — לא כאשר קיימות הודעות רלוונטיות אך אינן מנוסחות כשאלה.",
  "ענה באותה שפה של השאלה (עברית → עברית), בקצרה ולעניין.",
].join("\n");

/** Render one candidate as a numbered transcript line. n is 1-based. */
function renderCandidate(c: Candidate, n: number): string {
  const ts = c.sentAt.toISOString().slice(0, 16).replace("T", " ");
  return `[${n}] (${c.sender}, ${c.chat}, ${ts}): ${c.content}`;
}

/** Assemble the system + user prompt for the ask flow. Pure function. */
export function buildAskPrompt(
  question: string,
  candidates: Candidate[],
  now: Date,
): SummaryPrompt {
  const nowLine = `התאריך והשעה הנוכחיים: ${now.toISOString().slice(0, 16).replace("T", " ")} (UTC).`;
  const lines = candidates.map((c, i) => renderCandidate(c, i + 1)).join("\n");
  return {
    system: SYSTEM,
    user: `${nowLine}\n\nהודעות:\n${lines}\n\nשאלה: ${question}`,
  };
}
