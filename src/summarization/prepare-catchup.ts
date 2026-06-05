import type pg from "pg";
import { findGroupByName } from "../db/repositories/groups.js";
import type { Cursor } from "../db/repositories/read-watermarks.js";
import { getWatermark } from "../db/repositories/read-watermarks.js";
import { getLatestCatchupSummary } from "../db/repositories/summaries.js";
import { buildPrompt, estimateTokens } from "./prompt.js";
import {
  firstPendingVisualMediaAfter,
  firstPendingVoiceNoteAfter,
  type SelectedMessageWithCursor,
  selectAfterCursor,
} from "./select.js";
import type { SummaryPrompt } from "./summarizer.js";

export type { Cursor };

export type PreparedCatchup =
  | { kind: "cache-hit"; summary: string; generatedAt: Date }
  | { kind: "empty" }
  | {
      kind: "ready";
      groupId: number;
      prompt: SummaryPrompt;
      summaryType: "watermark";
      parameters: {
        fromExclusive: { sentAt: string; messageId: number } | null;
        toInclusive: { sentAt: string; messageId: number };
        messageCount: number;
        usedFallback: boolean;
      };
      messageCount: number;
      newWatermark: Cursor;
      usedFallback: boolean;
    };

/**
 * Shared "first half" of the catch-up flow: resolves the group, looks up the
 * watermark, computes the barrier-truncated range (or first-run fallback), and
 * returns what the web layer needs to serve the cache or stream + commit.
 *
 * Performs NO writes — the caller commits the watermark and persists the
 * summary only after a successful stream.
 */
export async function prepareCatchup(
  client: pg.Pool | pg.PoolClient,
  groupName: string,
  fallbackN: number = 25,
  tokenBudget: number,
): Promise<PreparedCatchup> {
  // 1. Resolve group
  const group = await findGroupByName(client, groupName);
  if (!group) {
    throw new Error(`Unknown chat "${groupName}". Run 'groups' to list.`);
  }

  // 2. Get watermark
  const wm = await getWatermark(client, group.id);

  // 3. Compute range
  let range: SelectedMessageWithCursor[];
  let usedFallback: boolean;

  if (wm !== null) {
    // Incremental: messages strictly after the watermark, truncated at the barrier.
    // The barrier is the EARLIEST of two independent pending-media barriers:
    //   1. Pending voice note (no completed transcript): blocks because content may yet arrive.
    //   2. Pending visual media (no media_analyses row at all): blocks until analysis completes.
    //      A failed analysis row means we do NOT block (never-freeze guarantee).
    // Both barriers are fetched in parallel, then the earlier cursor wins.
    const all = await selectAfterCursor(client, group.id, wm.cursor);
    const [voiceBarrier, visualBarrier] = await Promise.all([
      firstPendingVoiceNoteAfter(client, group.id, wm.cursor),
      firstPendingVisualMediaAfter(client, group.id, wm.cursor),
    ]);

    // Pick the earliest non-null barrier cursor
    let barrier: Cursor | null = null;
    if (voiceBarrier !== null && visualBarrier !== null) {
      // Both present: take the one that comes first in conversation order
      const voiceFirst =
        voiceBarrier.sentAt < visualBarrier.sentAt ||
        (voiceBarrier.sentAt.getTime() === visualBarrier.sentAt.getTime() &&
          voiceBarrier.messageId < visualBarrier.messageId);
      barrier = voiceFirst ? voiceBarrier : visualBarrier;
    } else {
      barrier = voiceBarrier ?? visualBarrier;
    }

    if (barrier !== null) {
      // Keep only messages strictly before the barrier cursor
      range = all.filter(
        (m) =>
          m.sentAt < barrier!.sentAt ||
          (m.sentAt.getTime() === barrier!.sentAt.getTime() && m.messageId < barrier!.messageId),
      );
    } else {
      range = all;
    }
    usedFallback = false;
  } else {
    // First run: read all rows once and take the newest fallbackN.
    // Reading all rows on first run is acceptable — the range is bounded thereafter
    // by the watermark cursor on every subsequent call.
    const all = await selectAfterCursor(client, group.id, { sentAt: new Date(0), messageId: 0 });
    range = all.slice(-fallbackN);
    usedFallback = true;
  }

  // 4. Empty handling
  if (range.length === 0) {
    if (wm !== null) {
      const latest = await getLatestCatchupSummary(client, group.id);
      if (latest) {
        return { kind: "cache-hit", summary: latest.overview, generatedAt: latest.createdAt };
      }
    }
    return { kind: "empty" };
  }

  // 5. Build prompt and apply over-budget guard
  const prompt = buildPrompt(range);
  const tokens = estimateTokens(prompt.system + prompt.user);
  if (tokens > tokenBudget) {
    throw new Error(
      `Selection too large (~${tokens} tokens > budget ${tokenBudget}); narrow it with a smaller --last or a more recent --since.`,
    );
  }

  const last = range[range.length - 1]!;
  const newWatermark: Cursor = { sentAt: last.sentAt, messageId: last.messageId };

  const fromExclusive = wm
    ? { sentAt: wm.cursor.sentAt.toISOString(), messageId: wm.cursor.messageId }
    : null;

  const parameters = {
    fromExclusive,
    toInclusive: { sentAt: newWatermark.sentAt.toISOString(), messageId: newWatermark.messageId },
    messageCount: range.length,
    usedFallback,
  };

  return {
    kind: "ready",
    groupId: group.id,
    prompt,
    summaryType: "watermark",
    parameters,
    messageCount: range.length,
    newWatermark,
    usedFallback,
  };
}
