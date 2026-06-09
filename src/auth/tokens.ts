import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Opaque bearer tokens for sessions and email verify/reset links. The RAW token is given
 * to the client once (cookie or email URL); only its SHA-256 hash is persisted. A DB leak
 * therefore exposes no usable token. SHA-256 (not argon2) is correct here because the
 * input is already 256 bits of CSPRNG entropy — there is nothing to brute-force.
 */

/** 32 random bytes, base64url — ~256 bits of entropy, URL/cookie safe. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Deterministic SHA-256 hex of a raw token, for storage and lookup. */
export function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/** Constant-time comparison of two hex strings of equal length. */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
