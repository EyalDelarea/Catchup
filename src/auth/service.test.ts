import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appPool, createTestDatabase, operatorPool } from "../test/db.js";
import {
  type AuthDeps,
  ConsentRequiredError,
  type Mailer,
  currentUser,
  login,
  logout,
  register,
  requestPasswordReset,
  resetPassword,
  resolveSession,
  verifyEmail,
} from "./service.js";
import { EmailTakenError } from "../db/repositories/users.js";

class CapturingMailer implements Mailer {
  sent: { to: string; subject: string; body: string }[] = [];
  async send(to: string, subject: string, body: string): Promise<void> {
    this.sent.push({ to, subject, body });
  }
  lastTokenFor(to: string): string | null {
    const msg = [...this.sent].reverse().find((m) => m.to === to);
    return msg?.body.match(/token=([A-Za-z0-9_-]+)/)?.[1] ?? null;
  }
}

let app: pg.Pool;
let op: pg.Pool;
let mailer: CapturingMailer;
let deps: AuthDeps;

beforeAll(async () => {
  const uri = await createTestDatabase();
  app = appPool(uri);
  op = operatorPool(uri);
});

afterAll(async () => {
  await app?.end();
  await op?.end();
});

beforeEach(() => {
  mailer = new CapturingMailer();
  deps = {
    appPool: app,
    operatorPool: op,
    mailer,
    now: () => new Date(),
    sessionTtlSeconds: 3600,
    emailTokenTtlSeconds: 3600,
    tosVersion: "2026-06-09",
    publicBaseUrl: "http://localhost:8787",
  };
});

describe("registration", () => {
  it("provisions a tenant + user, sends a verify email, and starts unverified", async () => {
    const { tenantId, userId } = await register(deps, {
      email: "founder@acme.test",
      password: "pw-12345678",
      consent: true,
    });
    expect(tenantId).toBeTruthy();
    expect(mailer.lastTokenFor("founder@acme.test")).toBeTruthy();

    const me = await currentUser(deps, { tenantId, userId });
    expect(me?.emailVerified).toBe(false);
  });

  it("rejects registration without consent", async () => {
    await expect(
      register(deps, { email: "x@acme.test", password: "pw-12345678", consent: false }),
    ).rejects.toBeInstanceOf(ConsentRequiredError);
  });

  it("rejects a duplicate email and leaves no orphan tenant", async () => {
    await register(deps, { email: "dupe@acme.test", password: "pw-12345678", consent: true });
    const before = await op.query("SELECT count(*)::int AS n FROM tenants");
    await expect(
      register(deps, { email: "dupe@acme.test", password: "other-pw-1", consent: true }),
    ).rejects.toBeInstanceOf(EmailTakenError);
    const after = await op.query("SELECT count(*)::int AS n FROM tenants");
    expect(after.rows[0].n).toBe(before.rows[0].n); // no orphan tenant left behind
  });

  it("isolates two registrations into distinct tenants", async () => {
    const a = await register(deps, { email: "a@t.test", password: "pw-12345678", consent: true });
    const b = await register(deps, { email: "b@t.test", password: "pw-12345678", consent: true });
    expect(a.tenantId).not.toBe(b.tenantId);
  });
});

describe("login / session / logout", () => {
  it("logs in with correct credentials and resolves the session to the right tenant", async () => {
    const reg = await register(deps, {
      email: "login@acme.test",
      password: "pw-12345678",
      consent: true,
    });
    const res = await login(deps, { email: "login@acme.test", password: "pw-12345678" });
    expect(res).not.toBeNull();
    const resolved = await resolveSession(deps, res!.rawToken);
    expect(resolved?.tenantId).toBe(reg.tenantId);
    expect(resolved?.userId).toBe(reg.userId);
  });

  it("rejects wrong password and unknown email", async () => {
    await register(deps, { email: "real@acme.test", password: "pw-12345678", consent: true });
    expect(await login(deps, { email: "real@acme.test", password: "WRONG" })).toBeNull();
    expect(await login(deps, { email: "ghost@acme.test", password: "pw-12345678" })).toBeNull();
  });

  it("logout invalidates the session token", async () => {
    await register(deps, { email: "out@acme.test", password: "pw-12345678", consent: true });
    const res = await login(deps, { email: "out@acme.test", password: "pw-12345678" });
    await logout(deps, res!.rawToken);
    expect(await resolveSession(deps, res!.rawToken)).toBeNull();
  });
});

describe("email verification", () => {
  it("verifies the email via the emailed token (single-use)", async () => {
    const reg = await register(deps, {
      email: "verify@acme.test",
      password: "pw-12345678",
      consent: true,
    });
    const token = mailer.lastTokenFor("verify@acme.test")!;
    expect(await verifyEmail(deps, token)).toBe(true);
    expect((await currentUser(deps, reg))?.emailVerified).toBe(true);
    expect(await verifyEmail(deps, token)).toBe(false); // already consumed
  });
});

describe("password reset", () => {
  it("does not reveal whether an email exists", async () => {
    await requestPasswordReset(deps, "nobody@acme.test"); // must not throw
    expect(mailer.sent.length).toBe(0);
  });

  it("resets the password with a valid token and invalidates the old one", async () => {
    await register(deps, { email: "reset@acme.test", password: "old-pw-12345", consent: true });
    mailer.sent = [];
    await requestPasswordReset(deps, "reset@acme.test");
    const token = mailer.lastTokenFor("reset@acme.test")!;

    expect(await resetPassword(deps, token, "new-pw-67890")).toBe(true);
    expect(await login(deps, { email: "reset@acme.test", password: "old-pw-12345" })).toBeNull();
    expect(await login(deps, { email: "reset@acme.test", password: "new-pw-67890" })).not.toBeNull();
    expect(await resetPassword(deps, token, "third-pw-111")).toBe(false); // token single-use
  });
});
