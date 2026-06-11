import type { SuggestionKind } from "../db/repositories/suggestions.js";

/**
 * The suggestion-engine config. Lives opaquely in the S5 prefs store
 * (`user_preferences.engine_config`) and is written by the §8 Settings panel
 * (`lib/prefs.js` shape: `{ on, kinds, proact }`). The worker reads it through
 * {@link loadEngineConfig}; unknown extra fields are ignored here.
 */
export type EngineConfig = {
  /** Master switch. Default OFF — the engine is opt-in. */
  on: boolean;
  /** Per-kind enable flags. */
  kinds: Record<SuggestionKind, boolean>;
  /** Proactiveness level (Hebrew labels, matching the UI). */
  proact: "עדין" | "מאוזן" | "יוזם";
};

const KINDS: SuggestionKind[] = ["task", "meeting", "followup", "recap"];

function defaults(): EngineConfig {
  return { on: false, kinds: { task: true, meeting: true, followup: true, recap: true }, proact: "מאוזן" };
}

/** Coerce the opaque stored blob into a typed {@link EngineConfig}, filling gaps. */
export function loadEngineConfig(raw: unknown): EngineConfig {
  const d = defaults();
  if (!raw || typeof raw !== "object") return d;
  const src = raw as Record<string, unknown>;
  const kinds = { ...d.kinds };
  if (src.kinds && typeof src.kinds === "object") {
    for (const k of KINDS) {
      const v = (src.kinds as Record<string, unknown>)[k];
      if (typeof v === "boolean") kinds[k] = v;
    }
  }
  const proact =
    src.proact === "עדין" || src.proact === "מאוזן" || src.proact === "יוזם" ? src.proact : d.proact;
  return { on: typeof src.on === "boolean" ? src.on : d.on, kinds, proact };
}

/**
 * Daily suggestion cap by proactiveness: עדין = 1, מאוזן = 3, יוזם = ∞ (no cap).
 */
export function proactivenessCap(proact: EngineConfig["proact"]): number {
  if (proact === "עדין") return 1;
  if (proact === "יוזם") return Number.POSITIVE_INFINITY;
  return 3; // מאוזן
}

/** The enabled kinds, in stable order. */
export function enabledKinds(config: EngineConfig): SuggestionKind[] {
  return KINDS.filter((k) => config.kinds[k]);
}
