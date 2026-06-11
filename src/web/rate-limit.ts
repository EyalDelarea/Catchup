/**
 * rate-limit.ts — a tiny in-memory fixed-window rate limiter.
 *
 * Used to throttle the unauthenticated /api/auth/* surface (register provisions a tenant
 * + a memory-hard argon2 hash per call; login is brute-forceable; request-reset can be
 * used to email-bomb). Single-process and in-memory by design — this is a self-hosted,
 * single-instance app, so a shared store (Redis) would be over-engineering. If the app
 * ever runs multiple replicas behind a load balancer, swap this for a shared backend.
 *
 * The clock is injected so windows are deterministic in tests.
 */

export type RateLimitDecision = {
  allowed: boolean;
  /** Seconds until the window resets (for the Retry-After header). 0 when allowed. */
  retryAfterSec: number;
};

export type RateLimiterOptions = {
  /** Max requests permitted per key within a window. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Injectable clock (epoch ms). Defaults to Date.now. */
  now?: () => number;
  /**
   * Sweep expired entries once the map grows past this many keys, so a flood of unique
   * keys (e.g. spoofed IPs) can't grow the map unbounded.
   */
  maxKeys?: number;
};

export type RateLimiter = {
  /** Record a hit for `key` and decide whether it is allowed. */
  check(key: string): RateLimitDecision;
};

type Window = { count: number; resetAt: number };

export function makeRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const { max, windowMs } = opts;
  const now = opts.now ?? Date.now;
  const maxKeys = opts.maxKeys ?? 10_000;
  const windows = new Map<string, Window>();

  const prune = (t: number): void => {
    for (const [key, w] of windows) {
      if (t >= w.resetAt) windows.delete(key);
    }
  };

  return {
    check(key: string): RateLimitDecision {
      const t = now();
      if (windows.size > maxKeys) prune(t);

      const existing = windows.get(key);
      if (!existing || t >= existing.resetAt) {
        windows.set(key, { count: 1, resetAt: t + windowMs });
        return { allowed: true, retryAfterSec: 0 };
      }

      existing.count += 1;
      if (existing.count > max) {
        return { allowed: false, retryAfterSec: Math.ceil((existing.resetAt - t) / 1000) };
      }
      return { allowed: true, retryAfterSec: 0 };
    },
  };
}
