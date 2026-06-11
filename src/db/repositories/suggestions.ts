import type pg from "pg";

export type SuggestionKind = "task" | "meeting" | "followup" | "recap";
export type SuggestionDecision = "accepted" | "edited" | "snoozed" | "discarded";

/** A draft to persist as a pending suggestion (from the generation pipeline). */
export type NewSuggestion = {
  totalSummaryId: number;
  kind: SuggestionKind;
  groupId: number;
  proposedText: string;
  reason: string;
  sourceMessageId?: number | null;
};

/** A deck card as served to the Today UI (pending, scope-filtered). */
export type DeckSuggestion = {
  id: number;
  kind: SuggestionKind;
  chat: string;
  proposedText: string;
  reason: string;
  sourceMessageId: number | null;
};

/** Per-(kind, chat) decision tallies driving the generation bias. */
export type BiasEntry = { pos: number; neg: number };

/** Bulk-insert generated drafts as `pending` suggestions. */
export async function insertSuggestions(
  client: pg.Pool | pg.PoolClient,
  drafts: NewSuggestion[],
): Promise<void> {
  for (const d of drafts) {
    await client.query(
      `INSERT INTO suggestions
         (total_summary_id, kind, group_id, proposed_text, reason, source_message_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [d.totalSummaryId, d.kind, d.groupId, d.proposedText, d.reason, d.sourceMessageId ?? null],
    );
  }
}

/**
 * Today's deck: pending suggestions (and snoozed ones whose snooze has elapsed)
 * for included chats only (S4 default-on: a chat with no scope row is included).
 * Joined to the group name. Newest first.
 */
export async function listPendingDeck(
  client: pg.Pool | pg.PoolClient,
): Promise<DeckSuggestion[]> {
  const { rows } = await client.query<{
    id: string;
    kind: SuggestionKind;
    chat: string;
    proposed_text: string;
    reason: string;
    source_message_id: string | null;
  }>(
    `
    SELECT s.id, s.kind, g.name AS chat, s.proposed_text, s.reason, s.source_message_id
    FROM suggestions s
    JOIN groups g ON g.id = s.group_id
    LEFT JOIN chat_scopes cs ON cs.group_id = s.group_id
    WHERE (s.status = 'pending'
           OR (s.status = 'snoozed' AND s.snoozed_until IS NOT NULL AND s.snoozed_until <= now()))
      AND (cs.id IS NULL OR (cs.included AND cs.removed_at IS NULL))
    ORDER BY s.created_at DESC, s.id DESC
    `,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    kind: r.kind,
    chat: r.chat,
    proposedText: r.proposed_text,
    reason: r.reason,
    sourceMessageId: r.source_message_id === null ? null : Number(r.source_message_id),
  }));
}

/**
 * Record a user's decision: update the suggestion row AND append to the feedback
 * log in one statement. `accepted`/`edited` store `finalText`; `snoozed` defers
 * ~20h (resurfaces next morning); `discarded` removes it from the deck.
 */
export async function decideSuggestion(
  client: pg.Pool | pg.PoolClient,
  id: number,
  decision: SuggestionDecision,
  finalText?: string | null,
): Promise<boolean> {
  const snoozeUntil = decision === "snoozed" ? "now() + interval '20 hours'" : "NULL";
  const finalValue = decision === "accepted" || decision === "edited" ? (finalText ?? null) : null;
  const { rowCount } = await client.query(
    `
    WITH upd AS (
      UPDATE suggestions
      SET status = $2, final_text = $3, snoozed_until = ${snoozeUntil}, decided_at = now()
      WHERE id = $1
      RETURNING id, kind, group_id
    )
    INSERT INTO suggestion_feedback (suggestion_id, kind, group_id, decision)
    SELECT id, kind, group_id, $2 FROM upd
    `,
    [id, decision, finalValue],
  );
  return (rowCount ?? 0) > 0;
}

/** Per-(kind, chat) bias tallies: edited+accepted = positive, discarded = negative. */
export async function loadBias(
  client: pg.Pool | pg.PoolClient,
): Promise<Map<string, BiasEntry>> {
  const { rows } = await client.query<{
    kind: SuggestionKind;
    group_id: string;
    pos: string;
    neg: string;
  }>(
    `
    SELECT kind, group_id,
           count(*) FILTER (WHERE decision IN ('accepted','edited')) AS pos,
           count(*) FILTER (WHERE decision = 'discarded')            AS neg
    FROM suggestion_feedback
    GROUP BY kind, group_id
    `,
  );
  const map = new Map<string, BiasEntry>();
  for (const r of rows) {
    map.set(`${r.kind}:${Number(r.group_id)}`, { pos: Number(r.pos), neg: Number(r.neg) });
  }
  return map;
}

/** reset-learning (§8): wipe the bias log for the tenant. Today's deck is untouched. */
export async function resetLearning(client: pg.Pool | pg.PoolClient): Promise<void> {
  await client.query(`DELETE FROM suggestion_feedback`);
}
