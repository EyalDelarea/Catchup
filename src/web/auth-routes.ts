import type http from "node:http";
import { parseCookies, SESSION_COOKIE, serializeSessionCookie } from "../auth/cookies.js";
import {
  type AuthDeps,
  ConsentRequiredError,
  currentUser,
  login,
  logout,
  register,
  requestPasswordReset,
  resetPassword,
  resolveSession,
  verifyEmail,
} from "../auth/service.js";
import { EmailTakenError } from "../db/repositories/users.js";

/**
 * The /api/auth/* HTTP surface — a thin adapter over src/auth/service.ts. Pure
 * request/response handling lives here; all auth logic (pools, RLS, tokens) stays in
 * the service. Wired into createServer() ahead of the session gate, since these are
 * exactly the endpoints that must work without a session.
 */

export type AuthRoutesOptions = {
  deps: AuthDeps;
  /** Secure attribute on the session cookie (config.auth.cookieSecure). */
  cookieSecure: boolean;
};

export type ResolvedSession = { sessionId: string; tenantId: string; userId: string };

const MAX_BODY_BYTES = 32 * 1024;
// Deliberately loose — real validation is the verification email. This only blocks
// obvious garbage from reaching the unique index.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LEN = 8;

export function makeAuthRoutes(opts: AuthRoutesOptions) {
  const { deps, cookieSecure } = opts;

  const setSession = (res: http.ServerResponse, rawToken: string): void => {
    res.setHeader(
      "set-cookie",
      serializeSessionCookie(rawToken, {
        secure: cookieSecure,
        maxAgeSeconds: deps.sessionTtlSeconds,
      }),
    );
  };
  const clearSession = (res: http.ServerResponse): void => {
    res.setHeader(
      "set-cookie",
      serializeSessionCookie("", { secure: cookieSecure, maxAgeSeconds: 0 }),
    );
  };

  /** Cookie → live session, or null. Shared with the server's session gate. */
  const session = async (req: http.IncomingMessage): Promise<ResolvedSession | null> => {
    const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!raw) return null;
    return resolveSession(deps, raw);
  };

  /** Returns true when the request was an auth route and has been fully handled. */
  const handle = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    if (!url.pathname.startsWith("/api/auth/")) return false;
    try {
      await dispatch(req, res, url);
    } catch (err) {
      process.stderr.write(
        `Error handling ${url.pathname}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
      json(res, 500, { error: "Internal server error." });
    }
    return true;
  };

  const dispatch = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> => {
    const route = `${req.method} ${url.pathname}`;

    if (route === "GET /api/auth/me") {
      const s = await session(req);
      const user = s && (await currentUser(deps, s));
      if (!user) {
        json(res, 401, { error: "Not authenticated." });
        return;
      }
      json(res, 200, {
        email: user.email,
        tenantId: user.tenantId,
        emailVerified: user.emailVerified,
      });
      return;
    }

    if (req.method !== "POST") {
      json(res, 404, { error: "Not found." });
      return;
    }
    const body = await readJsonBody(req);
    if (body === null) {
      json(res, 400, { error: "Invalid JSON body." });
      return;
    }

    switch (url.pathname) {
      case "/api/auth/register": {
        const { email, password, consent } = body as Record<string, unknown>;
        if (typeof email !== "string" || !EMAIL_RE.test(email)) {
          json(res, 400, { error: "A valid email is required." });
          return;
        }
        if (typeof password !== "string" || password.length < MIN_PASSWORD_LEN) {
          json(res, 400, { error: `Password must be at least ${MIN_PASSWORD_LEN} characters.` });
          return;
        }
        try {
          await register(deps, { email, password, consent: consent === true });
        } catch (err) {
          if (err instanceof ConsentRequiredError) {
            json(res, 400, { error: "You must accept the terms of service." });
            return;
          }
          if (err instanceof EmailTakenError) {
            json(res, 409, { error: "This email is already registered." });
            return;
          }
          throw err;
        }
        // Auto-login: a fresh registrant should land in their workspace, not a login form.
        const opened = await login(deps, { email, password });
        if (opened) setSession(res, opened.rawToken);
        json(res, 201, { email: email.toLowerCase(), emailVerified: false });
        return;
      }

      case "/api/auth/login": {
        const { email, password } = body as Record<string, unknown>;
        const result =
          typeof email === "string" && typeof password === "string"
            ? await login(deps, { email, password })
            : null;
        if (!result) {
          // Identical body for wrong-password and unknown-email: no account enumeration.
          json(res, 401, { error: "Invalid email or password." });
          return;
        }
        setSession(res, result.rawToken);
        json(res, 200, {
          email: result.user.email,
          tenantId: result.user.tenantId,
          emailVerified: result.user.emailVerified,
        });
        return;
      }

      case "/api/auth/logout": {
        const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
        if (raw) await logout(deps, raw);
        clearSession(res);
        res.writeHead(204);
        res.end();
        return;
      }

      case "/api/auth/verify": {
        const token = (body as Record<string, unknown>)["token"];
        const ok =
          typeof token === "string" && token.length > 0 && (await verifyEmail(deps, token));
        if (!ok) {
          json(res, 400, { error: "Invalid or expired verification link." });
          return;
        }
        json(res, 200, { verified: true });
        return;
      }

      case "/api/auth/request-reset": {
        const email = (body as Record<string, unknown>)["email"];
        if (typeof email === "string" && email.length > 0) {
          await requestPasswordReset(deps, email);
        }
        // Always 202 whether or not the account exists: no enumeration.
        json(res, 202, { ok: true });
        return;
      }

      case "/api/auth/reset": {
        const { token, password } = body as Record<string, unknown>;
        if (typeof password !== "string" || password.length < MIN_PASSWORD_LEN) {
          json(res, 400, { error: `Password must be at least ${MIN_PASSWORD_LEN} characters.` });
          return;
        }
        const ok =
          typeof token === "string" &&
          token.length > 0 &&
          (await resetPassword(deps, token, password));
        if (!ok) {
          json(res, 400, { error: "Invalid or expired reset link." });
          return;
        }
        json(res, 200, { ok: true });
        return;
      }

      default:
        json(res, 404, { error: "Not found." });
    }
  };

  return { handle, session };
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** Read and parse a JSON body, capped at MAX_BODY_BYTES. Returns null on any malformation. */
async function readJsonBody(req: http.IncomingMessage): Promise<unknown | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) return null;
      chunks.push(chunk as Buffer);
    }
  } catch {
    return null;
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}
