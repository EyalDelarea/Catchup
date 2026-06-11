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

// The dummy hash is computed once (lazily) and reused — the first missing-user login pays
// the one-time hashing cost; every call after pays only the verify cost, which is what we
// want to match against a real login.
let dummyHash: Promise<string> | null = null;

/**
 * Spend an argon2 verify against a throwaway hash. Call this on the "user not found" login
 * branch so a missing account costs the same wall-clock time as a wrong password, closing
 * the timing side-channel that would otherwise enumerate accounts. The result is
 * intentionally discarded.
 */
export async function spendDummyVerify(plaintext: string): Promise<void> {
  if (!dummyHash) dummyHash = hashPassword("timing-equalizer-not-a-real-credential");
  await verifyPassword(await dummyHash, plaintext);
}
