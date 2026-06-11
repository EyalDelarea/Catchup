import http from "node:http";
import type { AddressInfo } from "node:net";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AuthDeps, Mailer } from "../auth/service.js";
import { appPool, createTestDatabase, operatorPool } from "../test/db.js";
import { makeAuthRoutes } from "./auth-routes.js";
import { makeRateLimiter } from "./rate-limit.js";

/**
 * Integration tests for the /api/auth/* HTTP surface, against the REAL repos and
 * RLS-enforced pools (catchup_app + catchup_operator) — the same wiring production uses.
 */

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
let server: http.Server;
let base: string;

function authDeps(): AuthDeps {
  return {
    appPool: app,
    operatorPool: op,
    mailer,
    now: () => new Date(),
    sessionTtlSeconds: 3600,
    emailTokenTtlSeconds: 3600,
    tosVersion: "test-1",
    publicBaseUrl: "http://localhost:0",
  };
}

async function post(
  path: string,
  body: unknown,
  cookie?: string,
): Promise<{ status: number; json: Record<string, unknown>; setCookie: string[] }> {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  return {
    status: r.status,
    json: text ? JSON.parse(text) : {},
    setCookie: r.headers.getSetCookie(),
  };
}

async function getMe(cookie?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${base}/api/auth/me`, {
    headers: cookie ? { cookie } : {},
  });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : {} };
}

function sessionCookie(setCookie: string[]): string {
  const c = setCookie.find((s) => s.startsWith("catchup_session="));
  expect(c).toBeTruthy();
  return c!.split(";")[0]!;
}

beforeAll(async () => {
  const uri = await createTestDatabase();
  app = appPool(uri);
  op = operatorPool(uri);
  mailer = new CapturingMailer();
  const routes = makeAuthRoutes({
    deps: authDeps(),
    cookieSecure: false,
    // These tests fire far more than the production default (10/min) at the same routes;
    // rate limiting is exercised separately below, so give the shared server lots of room.
    rateLimit: { max: 100_000, windowMs: 60_000 },
  });
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    void routes.handle(req, res, url).then((handled) => {
      if (!handled) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Not found");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await app?.end();
  await op?.end();
});

beforeEach(() => {
  mailer.sent = [];
});

describe("POST /api/auth/register", () => {
  it("registers, sets a session cookie (auto-login), sends a verify email", async () => {
    const r = await post("/api/auth/register", {
      email: "reg@http.test",
      password: "pw-12345678",
      consent: true,
    });
    expect(r.status).toBe(201);
    const cookie = sessionCookie(r.setCookie);
    expect(r.setCookie[0]).toContain("HttpOnly");
    expect(mailer.lastTokenFor("reg@http.test")).toBeTruthy();

    const me = await getMe(cookie);
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({ email: "reg@http.test", emailVerified: false });
  });

  it("400 without consent; 409 on duplicate email; 400 on short password / bad email", async () => {
    expect(
      (await post("/api/auth/register", { email: "x@y.test", password: "pw-12345678" })).status,
    ).toBe(400);
    await post("/api/auth/register", {
      email: "dupe@http.test",
      password: "pw-12345678",
      consent: true,
    });
    expect(
      (
        await post("/api/auth/register", {
          email: "dupe@http.test",
          password: "pw-12345678",
          consent: true,
        })
      ).status,
    ).toBe(409);
    expect(
      (await post("/api/auth/register", { email: "x@y.test", password: "short", consent: true }))
        .status,
    ).toBe(400);
    expect(
      (
        await post("/api/auth/register", {
          email: "not-an-email",
          password: "pw-12345678",
          consent: true,
        })
      ).status,
    ).toBe(400);
  });

  it("rejects a non-JSON body with 400 (no crash)", async () => {
    const r = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(r.status).toBe(400);
  });
});

describe("login / me / logout", () => {
  it("full session lifecycle", async () => {
    await post("/api/auth/register", {
      email: "cycle@http.test",
      password: "pw-12345678",
      consent: true,
    });

    const login = await post("/api/auth/login", {
      email: "cycle@http.test",
      password: "pw-12345678",
    });
    expect(login.status).toBe(200);
    const cookie = sessionCookie(login.setCookie);

    expect((await getMe(cookie)).status).toBe(200);
    expect((await getMe()).status).toBe(401);
    expect((await getMe("catchup_session=forged")).status).toBe(401);

    const out = await post("/api/auth/logout", {}, cookie);
    expect(out.status).toBe(204);
    // Logout clears the cookie (Max-Age=0)
    expect(out.setCookie.some((c) => c.includes("Max-Age=0"))).toBe(true);
    expect((await getMe(cookie)).status).toBe(401);
  });

  it("401 with identical body for wrong password and unknown email (no enumeration)", async () => {
    await post("/api/auth/register", {
      email: "enum@http.test",
      password: "pw-12345678",
      consent: true,
    });
    const wrongPw = await post("/api/auth/login", { email: "enum@http.test", password: "nope-99" });
    const noUser = await post("/api/auth/login", { email: "ghost@http.test", password: "nope-99" });
    expect(wrongPw.status).toBe(401);
    expect(noUser.status).toBe(401);
    expect(wrongPw.json).toEqual(noUser.json);
  });
});

describe("verify / reset flows over HTTP", () => {
  it("verifies the email via the emailed token", async () => {
    const reg = await post("/api/auth/register", {
      email: "v@http.test",
      password: "pw-12345678",
      consent: true,
    });
    const cookie = sessionCookie(reg.setCookie);
    const token = mailer.lastTokenFor("v@http.test")!;

    const ok = await post("/api/auth/verify", { token });
    expect(ok.status).toBe(200);
    expect((await getMe(cookie)).json).toMatchObject({ emailVerified: true });

    expect((await post("/api/auth/verify", { token })).status).toBe(400); // single-use
  });

  it("request-reset always returns 202; reset rotates the password and kills sessions", async () => {
    await post("/api/auth/register", {
      email: "r@http.test",
      password: "old-pw-12345",
      consent: true,
    });
    const login = await post("/api/auth/login", { email: "r@http.test", password: "old-pw-12345" });
    const cookie = sessionCookie(login.setCookie);

    expect((await post("/api/auth/request-reset", { email: "r@http.test" })).status).toBe(202);
    expect((await post("/api/auth/request-reset", { email: "ghost@http.test" })).status).toBe(202);

    const token = mailer.lastTokenFor("r@http.test")!;
    expect((await post("/api/auth/reset", { token, password: "new-pw-67890" })).status).toBe(200);

    // Old session is revoked, old password dead, new password works.
    expect((await getMe(cookie)).status).toBe(401);
    expect(
      (await post("/api/auth/login", { email: "r@http.test", password: "old-pw-12345" })).status,
    ).toBe(401);
    expect(
      (await post("/api/auth/login", { email: "r@http.test", password: "new-pw-67890" })).status,
    ).toBe(200);
  });
});

describe("rate limiting", () => {
  let rlServer: http.Server;
  let rlBase: string;

  beforeAll(async () => {
    // A dedicated server with a tight limiter (2/window) and a fixed clock, so the window
    // never elapses during the test.
    const routes = makeAuthRoutes({
      deps: authDeps(),
      cookieSecure: false,
      rateLimit: { limiter: makeRateLimiter({ max: 2, windowMs: 60_000, now: () => 1_000 }) },
    });
    rlServer = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      void routes.handle(req, res, url).then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end("nope");
        }
      });
    });
    await new Promise<void>((r) => rlServer.listen(0, r));
    rlBase = `http://localhost:${(rlServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => rlServer.close(() => r()));
  });

  it("429s a mutating auth route once the per-IP budget is exceeded", async () => {
    const hit = () =>
      fetch(`${rlBase}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "x@y.test", password: "whatever-123" }),
      });

    // First two are within budget (401 — no such user); the third is throttled.
    expect((await hit()).status).toBe(401);
    expect((await hit()).status).toBe(401);
    const throttled = await hit();
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).toBe("60");
  });
});
