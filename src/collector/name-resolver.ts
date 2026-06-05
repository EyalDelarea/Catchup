/**
 * name-resolver.ts — Proactive bulk group-name resolution.
 *
 * Resolves display names for all groups that still show their raw JID as name
 * (i.e. name == whatsapp_id). Called once on session 'connected' so quiet
 * groups (those that never received a new live message) get resolved without
 * waiting for the next message.
 *
 * Resolution strategy per JID type:
 * - @g.us   → groupSubject(jid): fetch the WhatsApp group subject via session.
 * - anything else (@lid, @s.whatsapp.net, …) → representativeSenderName: look up
 *   the most-recent participant display_name from stored messages in that group.
 *   groupSubject is NEVER called for non-@g.us JIDs.
 *
 * Each group is wrapped in try/catch so one failure (including a UNIQUE(name)
 * collision) never aborts the batch. Never throws.
 */
import type pg from "pg";
import {
  listUnresolvedGroups,
  representativeSenderName,
  updateDisplayName,
} from "../db/repositories/groups.js";

export type NameResolverDeps = {
  /** Fetch the WhatsApp group subject for a @g.us JID. Only called for @g.us. */
  groupSubject: (jid: string) => Promise<string>;
};

export type ResolveResult = {
  resolved: number;
};

/**
 * Resolve display names for all groups whose name still equals their raw JID.
 *
 * - For @g.us groups: call groupSubject(jid) to get the WhatsApp subject.
 * - For all other JIDs (e.g. @lid, @s.whatsapp.net): look up the most-recent
 *   participant display_name from stored messages (no network call needed).
 * - Each group is wrapped individually so failures never abort the batch.
 * - Never throws.
 *
 * Returns the count of groups whose name was successfully updated.
 */
export async function resolveAllGroupNames(
  pool: pg.Pool | pg.PoolClient,
  deps: NameResolverDeps
): Promise<ResolveResult> {
  let resolved = 0;

  let unresolved: { id: number; whatsappId: string }[];
  try {
    unresolved = await listUnresolvedGroups(pool);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[name-resolver] failed to list unresolved groups: ${msg}\n`);
    return { resolved: 0 };
  }

  for (const { id, whatsappId } of unresolved) {
    try {
      let name: string | null = null;

      if (whatsappId.endsWith("@g.us")) {
        const subject = await deps.groupSubject(whatsappId);
        if (subject && subject.trim()) {
          name = subject.trim();
        }
      } else {
        // @lid, @s.whatsapp.net, or any other type: use stored participant name
        name = await representativeSenderName(pool, id);
      }

      if (name) {
        const updated = await updateDisplayName(pool, whatsappId, name);
        if (updated) {
          resolved++;
        }
      }
    } catch (err) {
      // One failure must never abort the batch (incl. UNIQUE name collisions)
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[name-resolver] skipped ${whatsappId}: ${msg}\n`
      );
    }
  }

  return { resolved };
}
