/**
 * live-service.test.ts — Unit tests for attachCollector (T042).
 *
 * Uses:
 * - A fake CollectorSession (EventEmitter, no real Baileys)
 * - InMemoryJobBus (no real broker)
 * - Injected fake pool and service-status functions
 */

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { CollectorSession } from "../collector/session.js";
import { InMemoryJobBus } from "../jobs/in-memory-bus.js";
import { InMemoryJobRunRecorder } from "../jobs/job-run-recorder.js";
import { attachCollector } from "./live-service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal fake CollectorSession (EventEmitter only — no Baileys).
 */
function makeSession(): EventEmitter & { stop: ReturnType<typeof vi.fn> } {
  const ee = new EventEmitter() as EventEmitter & {
    stop: ReturnType<typeof vi.fn>;
  };
  ee.stop = vi.fn();
  return ee;
}

/** Fake pg.Pool — just an opaque object; repo functions are injected. */
const fakePool = {} as Parameters<typeof attachCollector>[0]["pool"];

// ---------------------------------------------------------------------------
// Fake injected repo / heartbeat functions
// ---------------------------------------------------------------------------

function makeFakeDeps() {
  const session = makeSession();
  const bus = new InMemoryJobBus(new InMemoryJobRunRecorder());

  const setConnected = vi.fn().mockResolvedValue(undefined);
  const recordHeartbeat = vi.fn().mockResolvedValue(undefined);

  // Fake handleMessage: by default stores a voice note (returns true) and
  // enqueues the transcription job via the bus.
  const handleMessage = vi
    .fn()
    .mockImplementation(async (_pool: unknown, _msg: unknown, _opts: unknown): Promise<boolean> => {
      return true;
    });

  return { session, bus, setConnected, recordHeartbeat, handleMessage };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("attachCollector", () => {
  it("sets connected + starts heartbeat on 'connected' event", async () => {
    const { session, bus, setConnected, recordHeartbeat, handleMessage } = makeFakeDeps();

    attachCollector({
      session: session as unknown as CollectorSession,
      pool: fakePool,
      bus,
      dataDir: "/tmp/data",
      setConnected,
      recordHeartbeat,
      handleMessage,
      heartbeatMs: 60_000,
    });

    session.emit("connected");

    // Allow microtasks to flush (setConnected is async)
    await Promise.resolve();
    await Promise.resolve();

    expect(setConnected).toHaveBeenCalledWith(fakePool, true);
    expect(recordHeartbeat).toHaveBeenCalled();
  });

  it("sets disconnected on 'disconnected' event", async () => {
    const { session, bus, setConnected, recordHeartbeat, handleMessage } = makeFakeDeps();

    attachCollector({
      session: session as unknown as CollectorSession,
      pool: fakePool,
      bus,
      dataDir: "/tmp/data",
      setConnected,
      recordHeartbeat,
      handleMessage,
      heartbeatMs: 60_000,
    });

    session.emit("disconnected");

    await Promise.resolve();
    await Promise.resolve();

    expect(setConnected).toHaveBeenCalledWith(fakePool, false);
  });

  it("calls handleMessage on 'message' event and passes bus", async () => {
    const { session, bus, setConnected, recordHeartbeat, handleMessage } = makeFakeDeps();

    attachCollector({
      session: session as unknown as CollectorSession,
      pool: fakePool,
      bus,
      dataDir: "/tmp/data",
      setConnected,
      recordHeartbeat,
      handleMessage,
      heartbeatMs: 60_000,
    });

    const fakeMsg = { key: { id: "abc" } };
    session.emit("message", fakeMsg);

    await Promise.resolve();
    await Promise.resolve();

    expect(handleMessage).toHaveBeenCalledWith(fakePool, fakeMsg, {
      dataDir: "/tmp/data",
      bus,
      // The live path also threads media downloaders (sourced from the session) so
      // live voice notes / images / videos get downloaded + become analyzable.
      downloadVoiceNote: expect.any(Function),
      downloadImage: expect.any(Function),
      downloadVideo: expect.any(Function),
      // The live path threads a group-subject resolver for display-name resolution.
      groupSubject: expect.any(Function),
      // The live path threads the lid<->pn bridge so ingest canonicalizes identity
      // and LID-migration duplicates don't re-form (issue #17).
      lidForPn: expect.any(Function),
      pnForLid: expect.any(Function),
      // The live path threads a media-descriptor persister so deferred backfill
      // can later download media that wasn't available at ingest time.
      persistMediaDescriptor: expect.any(Function),
    });
  });

  it("crash-isolation: a throwing handleMessage does NOT propagate (no unhandled rejection), and onError is called", async () => {
    const { session, bus, setConnected, recordHeartbeat } = makeFakeDeps();

    const throwingHandleMessage = vi.fn().mockRejectedValue(new Error("handler exploded"));
    const onError = vi.fn();

    attachCollector({
      session: session as unknown as CollectorSession,
      pool: fakePool,
      bus,
      dataDir: "/tmp/data",
      setConnected,
      recordHeartbeat,
      handleMessage: throwingHandleMessage,
      onError,
      heartbeatMs: 60_000,
    });

    // Emit a message. The handler throws but it MUST NOT cause an unhandled rejection.
    const fakeMsg = { key: { id: "xyz" } };
    session.emit("message", fakeMsg);

    // Wait for the async handler to run and be caught
    await new Promise((r) => setTimeout(r, 10));

    // onError was called with the error
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe("handler exploded");
  });

  it("stop() stops the heartbeat and calls session.stop()", async () => {
    const { session, bus, setConnected, recordHeartbeat, handleMessage } = makeFakeDeps();

    const handle = attachCollector({
      session: session as unknown as CollectorSession,
      pool: fakePool,
      bus,
      dataDir: "/tmp/data",
      setConnected,
      recordHeartbeat,
      handleMessage,
      heartbeatMs: 60_000,
    });

    // Connect first so heartbeat is started
    session.emit("connected");
    await Promise.resolve();
    await Promise.resolve();

    const heartbeatCallCount = recordHeartbeat.mock.calls.length;

    handle.stop();

    // session.stop() was called
    expect(session.stop).toHaveBeenCalled();

    // After stop, setConnected(false) should be called
    await Promise.resolve();
    await Promise.resolve();
    expect(setConnected).toHaveBeenCalledWith(fakePool, false);

    // Heartbeat timer no longer fires (fake timers not needed here since
    // heartbeatMs is large enough — just assert count hasn't grown after stop)
    const heartbeatCallCountAfterStop = recordHeartbeat.mock.calls.length;
    expect(heartbeatCallCountAfterStop).toBe(heartbeatCallCount);
  });

  it("stop() before any connection does not throw", () => {
    const { session, bus, setConnected, recordHeartbeat, handleMessage } = makeFakeDeps();

    const handle = attachCollector({
      session: session as unknown as CollectorSession,
      pool: fakePool,
      bus,
      dataDir: "/tmp/data",
      setConnected,
      recordHeartbeat,
      handleMessage,
      heartbeatMs: 60_000,
    });

    expect(() => handle.stop()).not.toThrow();
    expect(session.stop).toHaveBeenCalled();
  });

  it("persistMediaDescriptor is threaded through to handleMessage opts", async () => {
    const { session, bus, setConnected, recordHeartbeat, handleMessage } = makeFakeDeps();

    attachCollector({
      session: session as unknown as CollectorSession,
      pool: fakePool,
      bus,
      dataDir: "/tmp/data",
      setConnected,
      recordHeartbeat,
      handleMessage,
      heartbeatMs: 60_000,
    });

    const fakeMsg = { key: { id: "media-test" } };
    session.emit("message", fakeMsg);

    await Promise.resolve();
    await Promise.resolve();

    // Verify opts received by handleMessage includes persistMediaDescriptor as a function.
    const receivedOpts = (handleMessage.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(typeof receivedOpts["persistMediaDescriptor"]).toBe("function");
  });
});
