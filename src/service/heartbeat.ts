/**
 * heartbeat.ts — Periodic service_status heartbeat loop.
 *
 * `startHeartbeat` fires one heartbeat immediately, then repeats every
 * `intervalMs` milliseconds until `stop()` is called. The underlying
 * DB function is injected for testability (defaults to the real
 * `recordHeartbeat` from the service-status repository).
 *
 * `markConnected` is a thin wrapper around `setCollectorConnected` that
 * the `serve` wiring calls on Baileys open/close events.
 */
import type pg from "pg";
import {
  recordHeartbeat as dbRecordHeartbeat,
  setCollectorConnected as dbSetCollectorConnected,
} from "../db/repositories/service-status.js";
import { markHeartbeat } from "./liveness.js";

// ---------------------------------------------------------------------------
// Injectable function types (for unit testing without a real DB)
// ---------------------------------------------------------------------------

export type RecordHeartbeatFn = (pool: pg.Pool | pg.PoolClient) => Promise<void>;
export type SetConnectedFn = (pool: pg.Pool | pg.PoolClient, connected: boolean) => Promise<void>;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type HeartbeatDeps = {
  pool: pg.Pool | pg.PoolClient;
  intervalMs: number;
  /** Override for unit tests; defaults to the real repository function. */
  recordHeartbeat?: RecordHeartbeatFn;
};

export type HeartbeatHandle = {
  stop: () => void;
};

/**
 * Start the heartbeat loop.
 * - Immediately records one heartbeat.
 * - Continues recording every `intervalMs` milliseconds until `stop()` is called.
 *
 * Returns a handle with a `stop()` method to cancel the interval.
 */
export function startHeartbeat(deps: HeartbeatDeps): HeartbeatHandle {
  const { pool, intervalMs } = deps;
  const record: RecordHeartbeatFn = deps.recordHeartbeat ?? dbRecordHeartbeat;

  // Fire immediately (async, swallow errors — heartbeat must not crash the process)
  markHeartbeat();
  void record(pool).catch((err: unknown) => {
    console.warn("[heartbeat] immediate heartbeat failed:", err);
  });

  // Then on each interval
  const handle = setInterval(() => {
    markHeartbeat();
    void record(pool).catch((err: unknown) => {
      console.warn("[heartbeat] interval heartbeat failed:", err);
    });
  }, intervalMs);

  return {
    stop() {
      clearInterval(handle);
    },
  };
}

/**
 * Thin wrapper around `setCollectorConnected`.
 * Called by `serve` wiring on Baileys connection open/close events.
 *
 * @param pool     Database pool.
 * @param connected  true = connected; false = disconnected.
 * @param setConnected  Injectable override for tests (defaults to real repo fn).
 */
export async function markConnected(
  pool: pg.Pool | pg.PoolClient,
  connected: boolean,
  setConnected: SetConnectedFn = dbSetCollectorConnected
): Promise<void> {
  await setConnected(pool, connected);
}
