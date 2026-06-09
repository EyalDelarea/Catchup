import { Algorithm, hash, verify } from "@node-rs/argon2";

/**
 * Password hashing with argon2id. Parameters are deliberately conservative defaults
 * suitable for an interactive login on modest self-hosted hardware (the CPU-only box).
 * argon2id encodes the salt + params into the returned PHC string, so no separate salt
 * column is needed.
 */
const OPTIONS = {
  algorithm: Algorithm.Argon2id,
  // memoryCost in KiB (19 MiB), timeCost iterations, parallelism — OWASP-ish baseline.
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, OPTIONS);
}

/**
 * Verify a plaintext against a stored argon2id hash. Returns false (never throws) on a
 * malformed/foreign hash so callers can treat "bad hash" and "wrong password" uniformly
 * without leaking which it was.
 */
export async function verifyPassword(storedHash: string, plaintext: string): Promise<boolean> {
  try {
    return await verify(storedHash, plaintext);
  } catch {
    return false;
  }
}
