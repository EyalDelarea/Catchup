import { describe, expect, it, vi } from "vitest";
import { runBackfillBatch } from "./media-backfill-loop.js";

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
    expect(deps.markPresentMedia).toHaveBeenCalledWith(1, expect.anything());
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
});
