import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";

/**
 * Password hashing core. argon2id, salted per-hash. These are pure (no DB) so they run
 * without Testcontainers.
 */
describe("password hashing", () => {
  it("produces an argon2id PHC string that is not the plaintext", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).not.toBe("correct horse battery staple");
    expect(hash.startsWith("$argon2id$")).toBe(true);
  });

  it("verifies a correct password", async () => {
    const hash = await hashPassword("s3cret-pw");
    expect(await verifyPassword(hash, "s3cret-pw")).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("s3cret-pw");
    expect(await verifyPassword(hash, "wrong-pw")).toBe(false);
  });

  it("salts: hashing the same password twice yields different hashes", async () => {
    const a = await hashPassword("same-pw");
    const b = await hashPassword("same-pw");
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, "same-pw")).toBe(true);
    expect(await verifyPassword(b, "same-pw")).toBe(true);
  });

  it("verify returns false (never throws) on a malformed hash", async () => {
    expect(await verifyPassword("not-a-real-hash", "whatever")).toBe(false);
  });
});
