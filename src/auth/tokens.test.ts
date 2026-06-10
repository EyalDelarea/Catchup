import { describe, expect, it } from "vitest";
import { generateToken, hashToken, safeEqualHex } from "./tokens.js";

/**
 * Opaque session/verification tokens. The raw token goes to the client (cookie / email
 * link); only its SHA-256 hash is stored, so a DB leak does not expose live tokens.
 */
describe("tokens", () => {
  it("generates high-entropy URL-safe tokens that are unique", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("hashToken is deterministic and hides the raw token", () => {
    const t = generateToken();
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).not.toBe(t);
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("safeEqualHex compares equal-length hex in constant time", () => {
    const h = hashToken("abc");
    expect(safeEqualHex(h, h)).toBe(true);
    expect(safeEqualHex(h, hashToken("xyz"))).toBe(false);
    expect(safeEqualHex(h, "short")).toBe(false);
  });
});
