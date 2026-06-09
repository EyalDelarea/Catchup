import { afterEach, describe, expect, it, vi } from "vitest";
import { runBackfillBatch, startBackfillLoop } from "./media-backfill-loop.js";

const baseDeps = (over: Partial<any> = {}) => ({
  selectPending: vi
    .fn()
    .mockResolvedValue([{ messageId: 1, mediaKind: "image", waMessage: Buffer.from([0xaa]) }]),
  decodeWaMessage: vi.fn().mockReturnValue({ key: { id: "X" } }),
  download: vi.fn().mockResolvedValue(Buffer.from([1, 2, 3])),
  writeFile: vi.fn().mockResolvedValue("/data/media/backfill/1.jpg"),
  markPresentMessage: vi.fn().mockResolvedValue(undefined),
  markPresentMedia: vi.fn().mockResolvedValue(undefined),
  markUnrecoverable: vi.fn().mockResolvedValue(undefined),
  recordAttempt: vi.fn().mockResolvedValue(undefined),
  enqueue: vi.fn().mockResolvedValue(undefined),
  ...over,
});

describe("runBackfillBatch", () => {
  it("downloads, marks present, and enqueues analyze.image", async () => {
    const deps = baseDeps();
    const n = await runBackfillBatch(deps as any, 10);
    expect(n).toBe(1);
    expect(deps.download).toHaveBeenCalledOnce();
    expect(deps.markPresentMessage).toHaveBeenCalledWith(1, "/data/media/backfill/1.jpg");
    expect(deps.markPresentMedia).toHaveBeenCalledWith(1, null);
    expect(deps.enqueue).toHaveBeenCalledWith("analyze.image", { messageId: "1" });
  });

  it("enqueues transcribe.voicenote for audio", async () => {
    const deps = baseDeps({
      selectPending: vi
        .fn()
        .mockResolvedValue([{ messageId: 2, mediaKind: "audio", waMessage: Buffer.from([1]) }]),
    });
    await runBackfillBatch(deps as any, 10);
    expect(deps.enqueue).toHaveBeenCalledWith("transcribe.voicenote", { messageId: "2" });
  });

  it("marks unrecoverable on a 404/NOT_FOUND download error", async () => {
    const deps = baseDeps({
      download: vi.fn().mockRejectedValue(new Error("media not found (404)")),
    });
    await runBackfillBatch(deps as any, 10);
    expect(deps.markUnrecoverable).toHaveBeenCalledWith(1, expect.stringContaining("404"));
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it("records a transient attempt (no state change) on a generic error", async () => {
    const deps = baseDeps({ download: vi.fn().mockRejectedValue(new Error("socket hiccup")) });
    await runBackfillBatch(deps as any, 10);
    expect(deps.recordAttempt).toHaveBeenCalledWith(1, expect.stringContaining("hiccup"));
    expect(deps.markUnrecoverable).not.toHaveBeenCalled();
  });

  it("skips a row whose blob is missing", async () => {
    const deps = baseDeps({
      selectPending: vi
        .fn()
        .mockResolvedValue([{ messageId: 3, mediaKind: "image", waMessage: null }]),
    });
    await runBackfillBatch(deps as any, 10);
    expect(deps.markUnrecoverable).toHaveBeenCalledWith(3, expect.stringContaining("blob"));
  });

  it("excludes stickers from analysis enqueue", async () => {
    const deps = baseDeps({
      selectPending: vi
        .fn()
        .mockResolvedValue([{ messageId: 4, mediaKind: "sticker", waMessage: Buffer.from([1]) }]),
    });
    await runBackfillBatch(deps as any, 10);
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it("enqueues analyze.video for video mediaKind", async () => {
    const deps = baseDeps({
      selectPending: vi
        .fn()
        .mockResolvedValue([{ messageId: 5, mediaKind: "video", waMessage: Buffer.from([1]) }]),
    });
    await runBackfillBatch(deps as any, 10);
    expect(deps.enqueue).toHaveBeenCalledWith("analyze.video", { messageId: "5" });
  });

  it("marks unrecoverable on a 410 download error", async () => {
    const deps = baseDeps({
      download: vi.fn().mockRejectedValue(new Error("resource gone (410)")),
    });
    await runBackfillBatch(deps as any, 10);
    expect(deps.markUnrecoverable).toHaveBeenCalledWith(1, expect.stringContaining("410"));
    expect(deps.recordAttempt).not.toHaveBeenCalled();
  });

  it("marks unrecoverable on a textual 'not found' download error (no status code)", async () => {
    const deps = baseDeps({
      download: vi.fn().mockRejectedValue(new Error("media not found")),
    });
    await runBackfillBatch(deps as any, 10);
    expect(deps.markUnrecoverable).toHaveBeenCalledWith(1, expect.stringContaining("not found"));
    expect(deps.recordAttempt).not.toHaveBeenCalled();
  });

  it("records transient attempt (not unrecoverable) when writeFile throws", async () => {
    const deps = baseDeps({
      writeFile: vi.fn().mockRejectedValue(new Error("disk full")),
    });
    await runBackfillBatch(deps as any, 10);
    expect(deps.recordAttempt).toHaveBeenCalledWith(1, expect.stringContaining("disk full"));
    expect(deps.markUnrecoverable).not.toHaveBeenCalled();
  });
});

describe("startBackfillLoop", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("no-overlap guard: skips second tick while first is still running", async () => {
    vi.useFakeTimers();

    // Create a deferred that we control — selectPending won't resolve until we say so.
    let releaseBatch!: () => void;
    const blockingPromise = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });

    const deps = baseDeps({
      selectPending: vi
        .fn()
        .mockReturnValueOnce(blockingPromise.then(() => []))
        .mockResolvedValue([]),
    });

    const loop = startBackfillLoop(deps as any, { intervalMs: 1000, batchSize: 10 });

    // Advance past two intervals — both ticks fire but only the first gets through.
    await vi.advanceTimersByTimeAsync(2500);
    expect(deps.selectPending).toHaveBeenCalledTimes(1);

    // Release the first batch; advance again — now a second run can start.
    releaseBatch();
    await vi.advanceTimersByTimeAsync(1000);
    expect(deps.selectPending).toHaveBeenCalledTimes(2);

    loop.stop();
  });

  it("stop() prevents further selectPending calls after stopping", async () => {
    vi.useFakeTimers();

    const deps = baseDeps({
      selectPending: vi.fn().mockResolvedValue([]),
    });

    const loop = startBackfillLoop(deps as any, { intervalMs: 1000, batchSize: 10 });

    await vi.advanceTimersByTimeAsync(1500);
    const callsBeforeStop = (deps.selectPending as ReturnType<typeof vi.fn>).mock.calls.length;

    loop.stop();

    await vi.advanceTimersByTimeAsync(3000);
    expect(deps.selectPending).toHaveBeenCalledTimes(callsBeforeStop);
  });
});
