import type pg from "pg";
import { siblingForJid } from "../db/repositories/identity-links.js";
import { findMergeCandidates, type MergeBridge, mergeGroups } from "../db/repositories/merge.js";
import { withTenant } from "../db/tenant-context.js";
import { getLogger } from "../logging/log.js";

const log = getLogger("identity-reconcile");

/**
 * Reconcile lid/phone duplicate chats for one tenant using ONLY the durable
 * identity_links map — no live WhatsApp session required. Reuses the dedupe-safe
 * mergeGroups engine, with a SAVEPOINT per pair so one bad pair never aborts the
 * batch. Returns the number of pairs merged.
 */
export async function reconcileIdentities(pool: pg.Pool, tenantId: string): Promise<number> {
  return withTenant(pool, tenantId, async (client) => {
    // DB-backed bridge: same shape the live session provides, sourced from the map.
    const bridge: MergeBridge = {
      lidForPn: (pn) => siblingForJid(client, pn),
      pnForLid: (lid) => siblingForJid(client, lid),
    };

    const candidates = await findMergeCandidates(client, bridge);
    let merged = 0;
    let skipped = 0;
    for (const c of candidates) {
      try {
        await client.query("SAVEPOINT reconcile_pair");
        await mergeGroups(client, { survivorId: c.survivorId, dupId: c.dupId, name: c.name });
        await client.query("RELEASE SAVEPOINT reconcile_pair");
        merged++;
      } catch (err) {
        skipped++;
        log.warn(
          { survivorId: c.survivorId, dupId: c.dupId, err },
          "reconcile pair failed, skipping",
        );
        await client.query("ROLLBACK TO SAVEPOINT reconcile_pair").catch(() => {});
      }
    }
    if (merged > 0 || skipped > 0) {
      log.info({ merged, skipped }, "identity reconcile complete");
    }
    return merged;
  });
}
