import type http from "node:http";
import type { AddressInfo } from "node:net";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Mailer } from "../auth/service.js";
import { DEFAULT_TENANT_ID, withTenant } from "../db/tenant-context.js";
import type { StreamingSummarizer, SummaryPrompt } from "../summarization/summarizer.js";
import { appPool, createTestDatabase, operatorPool } from "../test/db.js";
import { createServer } from "./server.js";

/**
 * T2 acceptance: the LIVE request path enforces tenant isolation. The server runs on the
 * RLS-enforced catchup_app pool; requests authenticate via session cookie; each request's
 * data access is scoped to the session's tenant. Also proves the backward-compat default:
 * with auth absent, everything runs as the default tenant with no login.
 */

class FakeSummarizer implements StreamingSummarizer {
  // biome-ignore lint/correctness/useYield: minimal stub
  async *summarizeStream(_p: SummaryPrompt): AsyncGenerator<string> {
    return;
  }
}

const silentMailer: Mailer = { send: async () => {} };

let app: pg.Pool;
let op: pg.Pool;

beforeAll(async () => {
  const uri = await createTestDatabase();
  app = appPool(uri);
  op = operatorPool(uri);
});

afterAll(async () => {
  await app?.end();
  await op?.end();
});

const onboardingStarts: string[] = [];
const fakeRegistry = {
  start: async (tenantId: string): Promise<void> => {
    onboardingStarts.push(tenantId);
  },
  snapshot: () => [],
  on: () => {},
  off: () => {},
};

function startServer(authRequired: boolean): Promise<{ base: string; server: http.Server }> {
  const server = createServer({
    pool: app,
    summarizer: new FakeSummarizer(),
    tokenBudget: 24000,
    model: "fake",
    onboarding: fakeRegistry,
    auth: {
      deps: {
        appPool: app,
        operatorPool: op,
        mailer: silentMailer,
        now: () => new Date(),
        sessionTtlSeconds: 3600,
        emailTokenTtlSeconds: 3600,
        tosVersion: "t",
        publicBaseUrl: "http://localhost",
      },
      cookieSecure: false,
      required: authRequired,
    },
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      resolve({ base: `http://localhost:${(server.address() as AddressInfo).port}`, server });
    });
  });
}

async function registerAndGetCookie(base: string, email: string): Promise<string> {
  const r = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "pw-12345678", consent: true }),
  });
  expect(r.status).toBe(201);
  const cookie = r.headers.getSetCookie().find((c) => c.startsWith("catchup_session="));
  expect(cookie).toBeTruthy();
  return cookie!.split(";")[0]!;
}

describe("multi-tenant mode (auth required)", () => {
  let base: string;
  let server: http.Server;

  beforeAll(async () => {
    ({ base, server } = await startServer(true));
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("gates /api/* behind a session (401 without one) but leaves auth + SPA pages open", async () => {
    expect((await fetch(`${base}/api/groups`)).status).toBe(401);
    expect((await fetch(`${base}/api/status`)).status).toBe(401);
    expect((await fetch(`${base}/api/onboarding/status`)).status).toBe(401); // T4 gated too
    const me = await fetch(`${base}/api/auth/me`);
    expect(me.status).toBe(401); // auth route answers itself, not the gate
    const home = await fetch(`${base}/`);
    expect(home.status).toBe(200);
    expect((await fetch(`${base}/verify`)).status).toBe(200); // emailed-link landing page = SPA
    expect((await fetch(`${base}/reset`)).status).toBe(200);
  });

  it("onboarding link starts the session for the AUTHENTICATED tenant only (T4)", async () => {
    onboardingStarts.length = 0;
    const cookie = await registerAndGetCookie(base, "onboard@live.test");
    const me = (await (await fetch(`${base}/api/auth/me`, { headers: { cookie } })).json()) as {
      tenantId: string;
    };

    const r = await fetch(`${base}/api/onboarding/link`, {
      method: "POST",
      headers: { cookie },
    });
    expect(r.status).toBe(202);
    expect(onboardingStarts).toEqual([me.tenantId]);
  });

  it("isolates tenants end-to-end through the live request path", async () => {
    const cookieA = await registerAndGetCookie(base, "tenant-a@live.test");
    const cookieB = await registerAndGetCookie(base, "tenant-b@live.test");

    // Find tenant A's id from /me, then seed a group into A's workspace.
    const meA = (await (
      await fetch(`${base}/api/auth/me`, { headers: { cookie: cookieA } })
    ).json()) as {
      tenantId: string;
    };
    await withTenant(app, meA.tenantId, async (c) => {
      await c.query(`INSERT INTO groups (name, source) VALUES ('a-secret-group', 'import')`);
    });

    const listA = (await (
      await fetch(`${base}/api/groups`, { headers: { cookie: cookieA } })
    ).json()) as Array<{ name: string }>;
    const listB = (await (
      await fetch(`${base}/api/groups`, { headers: { cookie: cookieB } })
    ).json()) as Array<{ name: string }>;

    expect(listA.map((g) => g.name)).toContain("a-secret-group");
    expect(listB.map((g) => g.name)).not.toContain("a-secret-group");
  });
});

describe("single-user mode (no auth block — backward compat)", () => {
  it("serves /api/* without any session, scoped to the default tenant", async () => {
    await withTenant(app, DEFAULT_TENANT_ID, async (c) => {
      await c.query(
        `INSERT INTO groups (name, source) VALUES ('local-default-group', 'import')
         ON CONFLICT DO NOTHING`,
      );
    });
    const { base, server } = await startServer(false);
    try {
      const r = await fetch(`${base}/api/groups`);
      expect(r.status).toBe(200);
      const groups = (await r.json()) as Array<{ name: string }>;
      expect(groups.map((g) => g.name)).toContain("local-default-group");
      // A session is still optional in this mode — /me just reports single-user.
      expect((await fetch(`${base}/api/auth/me`)).status).toBe(401);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
