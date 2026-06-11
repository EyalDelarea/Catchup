import { describe, expect, it } from "vitest";
import { makeRateLimiter } from "./rate-limit.js";

describe("makeRateLimiter", () => {
  it("allows up to max within a window, then blocks", () => {
    const now = 1_000;
    const rl = makeRateLimiter({ max: 3, windowMs: 60_000, now: () => now });

    expect(rl.check("ip").allowed).toBe(true);
    expect(rl.check("ip").allowed).toBe(true);
    expect(rl.check("ip").allowed).toBe(true);
    const blocked = rl.check("ip");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBe(60); // full window remaining
  });

  it("resets once the window elapses", () => {
    let now = 0;
    const rl = makeRateLimiter({ max: 1, windowMs: 10_000, now: () => now });

    expect(rl.check("ip").allowed).toBe(true);
    expect(rl.check("ip").allowed).toBe(false);

    now += 10_000; // window boundary reached
    expect(rl.check("ip").allowed).toBe(true);
  });

  it("tracks keys independently", () => {
    const now = 0;
    const rl = makeRateLimiter({ max: 1, windowMs: 60_000, now: () => now });

    expect(rl.check("a").allowed).toBe(true);
    expect(rl.check("b").allowed).toBe(true); // different key, own budget
    expect(rl.check("a").allowed).toBe(false);
  });

  it("computes retryAfterSec from the time left in the window", () => {
    let now = 0;
    const rl = makeRateLimiter({ max: 1, windowMs: 10_000, now: () => now });
    rl.check("ip");
    now += 3_000; // 7s left
    expect(rl.check("ip").retryAfterSec).toBe(7);
  });
});
