import { describe, expect, it, vi } from "vitest";
import { recoverOnReconnect } from "./reconnect-recovery.js";

const baseDeps = () => ({
  isStale: () => true,
  activeSince: new Date(0),
  selectActiveGroups: vi.fn(async () => [
    { id: 1, name: "A" },
    { id: 2, name: "B" },
  ]),
  // group 2 has nothing stored → no lower bound → skipped
  getNewestAnchorSentAt: vi.fn(async (groupId: number) =>
    groupId === 1 ? new Date(1000) : null,
  ),
  gapFill: vi.fn(async () => ({ fetched: 3, durationMs: 5, partial: false })),
  logger: { info: vi.fn() },
});

describe("recoverOnReconnect", () => {
  it("skips entirely when heartbeat is fresh (not a real outage)", async () => {
    const deps = { ...baseDeps(), isStale: () => false };
    const res = await recoverOnReconnect(deps);
    expect(res).toEqual({ groups: 0, recovered: 0 });
    expect(deps.selectActiveGroups).not.toHaveBeenCalled();
  });

  it("gap-fills each active group with a stored anchor and logs recovery", async () => {
    const deps = baseDeps();
    const res = await recoverOnReconnect(deps);

    // group 1 fills (anchor present); group 2 skipped (no anchor)
    expect(deps.gapFill).toHaveBeenCalledTimes(1);
    expect(deps.gapFill).toHaveBeenCalledWith(1, new Date(1000));
    expect(res).toEqual({ groups: 2, recovered: 3 });
    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ evt: "reconnect-sync", groupId: 1, recovered: 3 }),
      expect.any(String),
    );
  });

  it("never throws if a single group's gapFill rejects", async () => {
    const deps = baseDeps();
    deps.gapFill = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(recoverOnReconnect(deps)).resolves.toEqual(
      expect.objectContaining({ groups: 2, recovered: 0 }),
    );
  });
});
