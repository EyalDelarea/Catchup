import type { SuggestionKind } from "../db/repositories/suggestions.js";
import type { PerChatEntry } from "./suggest-pipeline.js";
import type { SummaryPrompt } from "./summarizer.js";

/** Per-kind Hebrew instruction for the extraction prompt. */
const KIND_INSTRUCTION: Record<SuggestionKind, string> = {
  task: "חלץ עד 3 משימות פעולה קונקרטיות שעל המשתמש לבצע, על סמך השיחות. כל משימה: משפט פעולה אחד.",
  meeting:
    "חלץ עד 3 פגישות/מפגשים מוצעים (כולל זמן ומקום אם הוזכרו). כל פריט: שורה אחת מוכנה ליומן.",
  followup: "חלץ עד 3 אנשים או שרשורים שכדאי למשתמש לחזור אליהם. כל פריט: שורת תזכורת אחת.",
  recap: "בחר עד 3 צ׳אטים ששווה לסכם בקצרה. עבור כל אחד, 2-3 בולטים קצרים.",
};

/**
 * Build the extraction prompt for one suggestion kind over the in-scope per-chat
 * summaries. Demands a STRICT JSON array so the extractor can parse it
 * deterministically. Pure — no IO. The model must echo a `sourceMessageId` from
 * the chat when one applies, so the §2 source chip + S2 jump work.
 */
export function buildSuggestPrompt(kind: SuggestionKind, perChat: PerChatEntry[]): SummaryPrompt {
  const system = [
    "אתה עוזר שמחלץ הצעות מתוך סיכומי צ׳אטים בוואטסאפ.",
    KIND_INSTRUCTION[kind],
    "החזר אך ורק מערך JSON תקין, ללא טקסט נוסף, בצורה:",
    '[{"groupId": <number>, "proposedText": "<hebrew>", "reason": "<hebrew, why>", "sourceMessageId": <number|null>}]',
    "אם אין פריטים רלוונטיים, החזר מערך ריק [].",
    "השתמש ב-groupId המדויק של הצ׳אט שממנו חולץ הפריט.",
  ].join("\n");

  const chats = perChat
    .map((p) => `### צ׳אט groupId=${p.groupId} (${p.name})\n${p.summary}`)
    .join("\n\n");

  return { system, user: `הסיכומים:\n${chats}` };
}
