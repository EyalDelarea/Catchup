import http from "node:http";
import type { AddressInfo } from "node:net";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../auth/cookies.js";
import { type AuthDeps, login, type Mailer, register, verifyEmail } from "../auth/service.js";
import type { StreamingSummarizer } from "../summarization/summarizer.js";
import { appPool, createTestDatabase, operatorPool } from "../test/db.js";
import { createServer } from "./server.js";

/**
 * The requireEmailVerified gate: with a valid session but an unverified email, every
 * /api/* route outside /api/auth/* must 403 until the email is verified — otherwise the
 * verification step is cosmetic (a registrant is auto-logged-in before verifying).
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

const noopSummarizer: StreamingSummarizer = {
  // biome-ignore lint/correctness/useYield: the gate test never reaches summarization.
  async *summarizeStream() {},
};

let app: pg.Pool;
let op: pg.Pool;
let mailer: CapturingMailer;
let server: ReturnType<typeof createServer>;
let base: string;

beforeAll(async () => {
  const uri = await createTestDatabase();
  app = appPool(uri);
  op = operatorPool(uri);
  mailer = new CapturingMailer();
  const authDeps: AuthDeps = {
    appPool: app,
    operatorPool: op,
    mailer,
    now: () => new Date(),
    sessionTtlSeconds: 3600,
    emailTokenTtlSeconds: 3600,
    tosVersion: "test-1",
    publicBaseUrl: "http://localhost:0",
  };
  server = createServer({
    pool: app,
    summarizer: noopSummarizer,
    tokenBudget: 24000,
    model: "fake",
    auth: { deps: authDeps, cookieSecure: false, required: true, requireEmailVerified: true },
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await app?.end();
  await op?.end();
});

describe("requireEmailVerified gate", () => {
  it("403s an authenticated-but-unverified user, then 200s once verified", async () => {
    const email = "gate@http.test";
    await register({ ...depsForRegister() }, { email, password: "pw-12345678", consent: true });
    const opened = await login({ ...depsForRegister() }, { email, password: "pw-12345678" });
    const cookie = `${SESSION_COOKIE}=${opened!.rawToken}`;

    // Unauthenticated → 401 (the session gate still fires first).
    expect((await fetch(`${base}/api/groups`)).status).toBe(401);

    // Authenticated but unverified → 403.
    const blocked = await fetch(`${base}/api/groups`, { headers: { cookie } });
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as { error: string }).error).toBe(
      "Email verification required.",
    );

    // Verify the email, then the same request succeeds.
    const token = mailer.lastTokenFor(email)!;
    expect(await verifyEmail({ ...depsForRegister() }, token)).toBe(true);
    const allowed = await fetch(`${base}/api/groups`, { headers: { cookie } });
    expect(allowed.status).toBe(200);
  });
});

// register/login/verifyEmail need the same AuthDeps the server was built with. Rebuild a
// thin copy pointing at the same pools + mailer (the server keeps its own copy internally).
function depsForRegister(): AuthDeps {
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
