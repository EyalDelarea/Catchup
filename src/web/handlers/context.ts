import type pg from "pg";
import type { Embedder } from "../../ask/embedder.js";
import type { Retriever } from "../../ask/retriever.js";
import type { AuthDeps } from "../../auth/service.js";
import type { JobType } from "../../jobs/job-types.js";
import type { StreamingSummarizer } from "../../summarization/summarizer.js";
import type { AdminRegistry } from "../admin-routes.js";
import type { OnboardingRegistry } from "../onboarding-routes.js";

/** Catchup-mode fallback window when a group has no read watermark yet. */
export const CATCHUP_FALLBACK_N = 25;

/**
 * Everything a request handler needs. Defined here (not in server.ts) so the per-endpoint
 * handlers in this directory and the router in server.ts can both import it without a
 * cycle; server.ts re-exports it for existing importers.
 */
export type ServerDeps = {
  pool: pg.Pool;
  summarizer: StreamingSummarizer;
  tokenBudget: number;
  model: string;
  /** Best-effort queue depths. If absent, all depths are null. */
  getQueueDepths?: () => Promise<Partial<Record<JobType, number>>>;
  /** How old a heartbeat can be before service is considered stale (ms). Default 5 min. */
  stalenessMs?: number;
  /** Optional: current collector liveness. When absent, stale defaults to false. */
  getLiveness?: () => { healthy: boolean; lastHeartbeatAt: Date | null };
  /** Optional: run a bounded backfill for a group before summarizing. */
  backfill?: (
    groupId: number,
  ) => Promise<{ fetched: number; durationMs: number; partial: boolean }>;
  /** Target window for backfill (default 25). */
  backfillTargetWindow?: number;
  /** Optional structured logger (pino). Used to record backfill outcomes for the trace/dashboard. */
  logger?: {
    info: (obj: Record<string, unknown>, msg?: string) => void;
    warn: (obj: Record<string, unknown>, msg?: string) => void;
  };
  /** Retrievers for the ask flow. Defaults to the lexical/recency/embedding set when absent. */
  askRetrievers?: Retriever[];
  /**
   * Embedder for semantic retrieval. When present, an EmbeddingRetriever is fused
   * into the default set. When absent (e.g. Ollama not configured), the ask flow
   * gracefully falls back to lexical (+ recency) only.
   */
  embedder?: Embedder;
  /**
   * T2 auth wiring. When absent, the server runs exactly as before (single-user, no
   * login) except every /api request is tenant-scoped to the default tenant. When
   * `required` is true (multi-tenant mode), /api/* outside /api/auth/* demands a valid
   * session and runs scoped to THAT session's tenant.
   */
  auth?: {
    deps: AuthDeps;
    cookieSecure: boolean;
    required: boolean;
    /**
     * When true, a session is not enough — the user's email must be verified to reach
     * anything outside /api/auth/*. Off by default (the dev log mailer can't deliver),
     * so single-user and unconfigured-SMTP deployments are unaffected.
     */
    requireEmailVerified?: boolean;
  };
  /**
   * T4 onboarding: the per-tenant WhatsApp session registry. When present, the
   * /api/onboarding/* endpoints (QR stream + link + status) are served, scoped to the
   * authenticated tenant. Absent → onboarding endpoints 404 (single-user CLI linking).
   */
  onboarding?: OnboardingRegistry;
  /**
   * T5 operator dashboard: cross-tenant admin view. `/api/admin/*` is reachable only by
   * a logged-in user whose email is in `operatorEmails`; the data comes from the
   * BYPASSRLS `operatorPool` joined with live session health (`registry`).
   */
  admin?: {
    operatorPool: pg.Pool;
    registry: AdminRegistry;
    operatorEmails: string[];
    /** T6: audit sink so operator access to the cross-tenant view is logged. */
    recordAudit?: (entry: import("../../db/repositories/audit.js").AuditEntry) => Promise<void>;
  };
};
