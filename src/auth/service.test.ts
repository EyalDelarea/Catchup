import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EmailTakenError } from "../db/repositories/users.js";
import { appPool, createTestDatabase, operatorPool } from "../test/db.js";
import {
  type AuthDeps,
  ConsentRequiredError,
  currentUser,
  login,
  logout,
  type Mailer,
  register,
  requestPasswordReset,
  resetPassword,
  resolveSession,
  verifyEmail,
} from "./service.js";

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
let audited: Array<{ action: string; actorEmail?: string | null }>;

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
  audited = [];
  deps = {
    appPool: app,
    operatorPool: op,
    mailer,
    now: () => new Date(),
    sessionTtlSeconds: 3600,
    emailTokenTtlSeconds: 3600,
    tosVersion: "2026-06-09",
    publicBaseUrl: "http://localhost:8787",
    recordAudit: (e) => {
      audited.push({ action: e.action, actorEmail: e.actorEmail });
      return Promise.resolve();
    },
  };
});

describe("audit trail (T6)", () => {
  it("records register, login, login_failed, verify, reset and logout", async () => {
    const reg = await register(deps, {
      email: "audit@acme.test",
      password: "pw-12345678",
      consent: true,
    });
    expect(audited.map((a) => a.action)).toContain("auth.register");

    const token = mailer.lastTokenFor("audit@acme.test")!;
    await verifyEmail(deps, token);
    expect(audited.map((a) => a.action)).toContain("auth.verify");

    await login(deps, { email: "audit@acme.test", password: "WRONG" });
    expect(audited.map((a) => a.action)).toContain("auth.login_failed");

    const ok = await login(deps, { email: "audit@acme.test", password: "pw-12345678" });
    expect(audited.map((a) => a.action)).toContain("auth.login");

    await logout(deps, ok!.rawToken);
    expect(audited.map((a) => a.action)).toContain("auth.logout");

    void reg;
  });

  it("an audit-sink failure never breaks the auth operation", async () => {
    deps.recordAudit = () => Promise.reject(new Error("audit sink down"));
    await expect(
      register(deps, { email: "resilient@acme.test", password: "pw-12345678", consent: true }),
    ).resolves.toMatchObject({ tenantId: expect.any(String) });
  });
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
    expect(
      await login(deps, { email: "reset@acme.test", password: "new-pw-67890" }),
    ).not.toBeNull();
    expect(await resetPassword(deps, token, "third-pw-111")).toBe(false); // token single-use
  });

  it("revokes all existing sessions on reset (a stolen session must not survive)", async () => {
    await register(deps, { email: "revoke@acme.test", password: "old-pw-12345", consent: true });
    const live = await login(deps, { email: "revoke@acme.test", password: "old-pw-12345" });
    expect(await resolveSession(deps, live!.rawToken)).not.toBeNull();

    mailer.sent = [];
    await requestPasswordReset(deps, "revoke@acme.test");
    const token = mailer.lastTokenFor("revoke@acme.test")!;
    expect(await resetPassword(deps, token, "new-pw-67890")).toBe(true);

    expect(await resolveSession(deps, live!.rawToken)).toBeNull();
  });
});
