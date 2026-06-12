import type pg from "pg";
import type {
  BiasEntry,
  NewSuggestion,
  SuggestionKind,
} from "../../db/repositories/suggestions.js";
import type { Job } from "../../jobs/job-types.js";
import {
  enabledKinds,
  loadEngineConfig,
  proactivenessCap,
} from "../../summarization/engine-config.js";
import {
  applySuppression,
  capDrafts,
  type Draft,
  filterInScope,
  type PerChatEntry,
  rankDrafts,
  suppressedKeys,
} from "../../summarization/suggest-pipeline.js";

export type SuggestGenerateDeps = {
  pool: pg.Pool;
  /** Read the total summary's per-chat entries by id. */
  loadPerChat: (pool: pg.Pool, totalSummaryId: number) => Promise<PerChatEntry[]>;
  /** Suggestible group ids — included AND not muted (S4 scope filter + §7 mute). */
  loadSuggestibleGroupIds: (pool: pg.Pool) => Promise<number[]>;
  /** The opaque engine_config blob from the S5 prefs store. */
  loadEngineConfigRaw: (pool: pg.Pool) => Promise<unknown>;
  /** Per-(kind,chat) feedback bias. */
  loadBias: (pool: pg.Pool) => Promise<Map<string, BiasEntry>>;
  /** Extract drafts for one kind from the in-scope per-chat summaries (Ollama). */
  extract: (
    kind: SuggestionKind,
    perChat: PerChatEntry[],
    bias: Map<string, BiasEntry>,
  ) => Promise<Draft[]>;
  insertSuggestions: (pool: pg.Pool, drafts: NewSuggestion[]) => Promise<void>;
};

/**
 * Factory for the `suggest.generate` job handler. Chained off a committed total
 * summary: gate on the master switch → scope-filter → per-enabled-kind extract →
 * suppress → rank → cap → persist as pending suggestions. The deterministic steps
 * are pure (suggest-pipeline); only `extract` touches Ollama. Throws on failure so
 * the bus retries — independently of the digest.
 */
export function makeSuggestGenerateHandler(deps: SuggestGenerateDeps) {
  return async function suggestGenerateHandler(job: Job<"suggest.generate">): Promise<void> {
    const totalSummaryId = job.payload.totalSummaryId;
    const config = loadEngineConfig(await deps.loadEngineConfigRaw(deps.pool));
    if (!config.on) return; // master switch off → clean no-op

    const perChat = await deps.loadPerChat(deps.pool, totalSummaryId);
    const suggestible = new Set(await deps.loadSuggestibleGroupIds(deps.pool));
    const inScope = filterInScope(perChat, suggestible);
    if (inScope.length === 0) return;

    const bias = await deps.loadBias(deps.pool);
    const suppressed = suppressedKeys(bias);

    let drafts: Draft[] = [];
    for (const kind of enabledKinds(config)) {
      const produced = await deps.extract(kind, inScope, bias);
      drafts.push(...produced);
    }

    drafts = applySuppression(drafts, suppressed);
    drafts = capDrafts(rankDrafts(drafts, bias), proactivenessCap(config.proact));
    if (drafts.length === 0) return;

    await deps.insertSuggestions(
      deps.pool,
      drafts.map((d) => ({
        totalSummaryId,
        kind: d.kind,
        groupId: d.groupId,
        proposedText: d.proposedText,
        reason: d.reason,
        sourceMessageId: d.sourceMessageId ?? null,
      })),
    );
  };
}
