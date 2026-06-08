/**
 * merge.ts — merge two group rows that are the SAME person under different
 * WhatsApp identities (an @lid chat and an @s.whatsapp.net chat).
 *
 * WhatsApp's LID migration leaves a person split across two chats: one keyed by
 * @lid (often already named) and one by the phone JID (often a bare number).
 * mergeGroups consolidates the duplicate into the survivor and names it.
 *
 * Safety:
 * - Messages are moved with dedupe guards: a dup message that already exists in
 *   the survivor (same dedupe_key, or same external_id) is dropped instead of
 *   moved, so neither unique index (group_id,dedupe_key)/(group_id,external_id)
 *   is violated.
 * - imports (FK ON DELETE RESTRICT) are repointed to the survivor.
 * - read_watermarks + summaries (FK ON DELETE CASCADE) are removed with the dup.
 * - The dup is deleted BEFORE the survivor is (re)named, so UNIQUE(name) can't
 *   collide on the name the dup currently holds.
 *
 * The caller is responsible for running this inside a transaction (BEGIN/COMMIT)
 * so a failure rolls the whole pair back.
 */
import type pg from "pg";

export type MergeBridge = {
  /** @s.whatsapp.net → @lid (normalized), or null. */
  lidForPn: (pn: string) => Promise<string | null>;
  /** @lid → @s.whatsapp.net (normalized), or null. */
  pnForLid: (lid: string) => Promise<string | null>;
};

export type MergeCandidate = {
  survivorId: number;
  survivorJid: string;
  survivorMsgs: number;
  dupId: number;
  dupJid: string;
  dupMsgs: number;
  /** The resolved name the survivor will be given. */
  name: string;
};

type GroupStat = {
  id: number;
  jid: string;
  name: string;
  msgs: number;
  lastMs: number;
  resolved: boolean;
};

/**
 * Find duplicate-chat pairs: an UNNAMED chat (name == jid) whose lid<->pn sibling
 * is a different, already-NAMED chat. The survivor is the more recently active
 * chat (so future messages keep landing in it); the survivor inherits the named
 * sibling's name. Each pair is discovered once (only the unnamed side iterates).
 */
export async function findMergeCandidates(
  pool: pg.Pool | pg.PoolClient,
  bridge: MergeBridge,
): Promise<MergeCandidate[]> {
  const { rows } = await pool.query<{
    id: string;
    whatsapp_id: string;
    name: string;
    msgs: string;
    last_ms: string | null;
  }>(
    `SELECT g.id, g.whatsapp_id, g.name,
            COUNT(m.id) AS msgs,
            COALESCE(EXTRACT(EPOCH FROM MAX(m.sent_at)) * 1000, 0)::bigint AS last_ms
     FROM groups g
     LEFT JOIN messages m ON m.group_id = g.id
     WHERE g.whatsapp_id IS NOT NULL
     GROUP BY g.id`,
  );

  const byJid = new Map<string, GroupStat>();
  for (const r of rows) {
    const stat: GroupStat = {
      id: Number(r.id),
      jid: r.whatsapp_id,
      name: r.name,
      msgs: Number(r.msgs),
      lastMs: Number(r.last_ms),
      resolved: r.name !== r.whatsapp_id,
    };
    byJid.set(stat.jid, stat);
  }

  const candidates: MergeCandidate[] = [];
  for (const u of byJid.values()) {
    if (u.resolved) continue; // only unnamed chats look for a named sibling

    let siblingJid: string | null = null;
    if (u.jid.endsWith("@s.whatsapp.net")) siblingJid = await bridge.lidForPn(u.jid);
    else if (u.jid.endsWith("@lid")) siblingJid = await bridge.pnForLid(u.jid);
    if (!siblingJid || siblingJid === u.jid) continue;

    const sibling = byJid.get(siblingJid);
    if (!sibling || !sibling.resolved || sibling.id === u.id) continue;

    // Survivor = more recently active (keeps receiving future messages).
    const [survivor, dup] = u.lastMs >= sibling.lastMs ? [u, sibling] : [sibling, u];
    candidates.push({
      survivorId: survivor.id,
      survivorJid: survivor.jid,
      survivorMsgs: survivor.msgs,
      dupId: dup.id,
      dupJid: dup.jid,
      dupMsgs: dup.msgs,
      name: sibling.name, // the named side's name
    });
  }
  return candidates;
}

export type MergeResult = {
  movedMessages: number;
  deletedDuplicateMessages: number;
  movedImports: number;
};

export async function mergeGroups(
  client: pg.Pool | pg.PoolClient,
  opts: { survivorId: number; dupId: number; name: string },
): Promise<MergeResult> {
  const { survivorId, dupId, name } = opts;
  if (survivorId === dupId) {
    throw new Error("mergeGroups: survivorId and dupId must differ");
  }

  // 1. Move dup messages that do NOT collide with the survivor on either unique
  //    index. (group_id is rewritten; message ids are preserved, so message-id
  //    FKs such as watermark_message_id stay valid.)
  const moved = await client.query(
    `UPDATE messages d SET group_id = $1
     WHERE d.group_id = $2
       AND NOT EXISTS (
         SELECT 1 FROM messages s WHERE s.group_id = $1 AND s.dedupe_key = d.dedupe_key
       )
       AND NOT EXISTS (
         SELECT 1 FROM messages s2
         WHERE s2.group_id = $1 AND d.external_id IS NOT NULL AND s2.external_id = d.external_id
       )`,
    [survivorId, dupId],
  );

  // 2. Delete the remaining (colliding) dup messages so the dup group can go.
  const deleted = await client.query(`DELETE FROM messages WHERE group_id = $1`, [dupId]);

  // 3. Repoint imports (ON DELETE RESTRICT) onto the survivor.
  const movedImports = await client.query(`UPDATE imports SET group_id = $1 WHERE group_id = $2`, [
    survivorId,
    dupId,
  ]);

  // 4. Delete the dup group — cascades its read_watermarks + summaries, and frees
  //    its name for the survivor.
  await client.query(`DELETE FROM groups WHERE id = $1`, [dupId]);

  // 5. Name the survivor.
  await client.query(`UPDATE groups SET name = $2 WHERE id = $1`, [survivorId, name]);

  return {
    movedMessages: moved.rowCount ?? 0,
    deletedDuplicateMessages: deleted.rowCount ?? 0,
    movedImports: movedImports.rowCount ?? 0,
  };
}
