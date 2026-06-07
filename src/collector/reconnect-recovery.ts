/**
 * reconnect-recovery.ts — on boot/reconnect, recover messages missed during an
 * outage.
 *
 * The missed messages are not lost: they live on the user's phone. WhatsApp's
 * passive reconnect channels (append / messaging-history.set, see session.ts)
 * deliver the recent window and provide a "top" anchor; this orchestrator then
 * extends each active group's history backward to the last message we already
 * stored (the gap's lower bound), via the gap-mode of backfillGroup.
 *
 * Gated by heartbeat staleness so it does not fire on flaky 3-second reconnects.
 *
 * Pure and fully testable via injected dependencies — no real Baileys/DB.
 */

export type ReconnectRecoveryDeps = {
  /** True when last_heartbeat_at is older than the outage threshold (real outage). */
  isStale: () => boolean;
  /** Lower bound for "active" groups to recover (e.g. now - 14 days). */
  activeSince: Date;
  /** Chats with content on/after activeSince. */
  selectActiveGroups: (range: { since: Date }) => Promise<Array<{ id: number; name: string }>>;
  /** Newest stored message timestamp for a group (the gap's lower bound), or null if none. */
  getNewestAnchorSentAt: (groupId: number) => Promise<Date | null>;
  /** Gap-fill a group's history backward down to stopAtSentAt. Must not throw. */
  gapFill: (
    groupId: number,
    stopAtSentAt: Date,
  ) => Promise<{ fetched: number; durationMs: number; partial: boolean }>;
  /** Optional structured logger (pino-shaped). */
  logger?: { info: (obj: unknown, msg: string) => void };
};

export type ReconnectRecoveryResult = { groups: number; recovered: number };

/**
 * Recover messages missed during downtime. Returns how many active groups were
 * considered and how many messages were recovered in total. Never throws — a
 * single group's failure is logged and skipped.
 */
export async function recoverOnReconnect(
  deps: ReconnectRecoveryDeps,
): Promise<ReconnectRecoveryResult> {
  // Not a real outage (fresh heartbeat) — skip entirely.
  if (!deps.isStale()) return { groups: 0, recovered: 0 };

  const groups = await deps.selectActiveGroups({ since: deps.activeSince });
  let recovered = 0;

  for (const g of groups) {
    try {
      const tLast = await deps.getNewestAnchorSentAt(g.id);
      // Nothing stored → no lower bound to fill toward; the passive channels still
      // capture whatever WhatsApp volunteers for this group.
      if (tLast === null) continue;

      const r = await deps.gapFill(g.id, tLast);
      recovered += r.fetched;
      deps.logger?.info(
        {
          evt: "reconnect-sync",
          group: g.name,
          groupId: g.id,
          recovered: r.fetched,
          partial: r.partial,
          ms: r.durationMs,
        },
        "reconnect-sync",
      );
    } catch (err) {
      deps.logger?.info(
        {
          evt: "reconnect-sync",
          group: g.name,
          groupId: g.id,
          error: err instanceof Error ? err.message : String(err),
        },
        "reconnect-sync error",
      );
    }
  }

  return { groups: groups.length, recovered };
}
