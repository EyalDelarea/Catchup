import type pg from "pg";
import type { AuditEntry } from "../db/repositories/audit.js";
import {
  consumeTokenByHash,
  createEmailToken,
  findActiveTokenByHash,
} from "../db/repositories/email-tokens.js";
import {
  createSession,
  deleteSessionByTokenHash,
  deleteSessionsForUser,
  findSessionByTokenHash,
} from "../db/repositories/sessions.js";
import { createTenant } from "../db/repositories/tenants.js";
import {
  createUser,
  EmailTakenError,
  findUserForLogin,
  getUserById,
  markEmailVerified,
  setPasswordHash,
} from "../db/repositories/users.js";
import { withTenant } from "../db/tenant-context.js";
import { hashPassword, verifyPassword } from "./password.js";
import { generateToken, hashToken } from "./tokens.js";

/**
 * Auth orchestration. This is the brain of T2; the HTTP layer is a thin adapter over it.
 *
 * The defining constraint (see repos): the three reads that PRECEDE tenant context —
 * login lookup, cookie→session resolution, email-token redemption — use the BYPASSRLS
 * operator pool; everything else runs in withTenant() on the RLS-enforced app pool.
 *
 * Open self-registration: each new signup provisions its OWN tenant (isolated workspace).
 */

export type Mailer = {
  send(to: string, subject: string, body: string): Promise<void>;
};

export type AuthDeps = {
  /** catchup_app pool — RLS enforced; all in-tenant work. */
  appPool: pg.Pool;
  /** catchup_operator pool — BYPASSRLS; pre-tenant lookups + tenant provisioning. */
  operatorPool: pg.Pool;
  mailer: Mailer;
  /** Injectable clock for deterministic TTL tests. */
  now: () => Date;
  sessionTtlSeconds: number;
  emailTokenTtlSeconds: number;
  tosVersion: string;
  /** Base URL used to build verify/reset links in emails. */
  publicBaseUrl: string;
  /**
   * Optional audit sink (T6). When present, security-relevant auth events are recorded.
   * A sink failure must never break the auth operation (audited best-effort).
   */
  recordAudit?: (entry: AuditEntry) => Promise<void>;
};

/** Best-effort audit: never let an audit-sink failure break the auth operation. */
async function audit(deps: AuthDeps, entry: AuditEntry): Promise<void> {
  if (!deps.recordAudit) return;
  try {
    await deps.recordAudit(entry);
  } catch {
    // Swallow — auditing is observability, not a precondition for auth.
  }
}

export type AuthedUser = { id: string; tenantId: string; email: string; emailVerified: boolean };

function expiry(now: Date, seconds: number): Date {
  return new Date(now.getTime() + seconds * 1000);
}

/**
 * Register a new tenant + its owner user, then email a verification link. Throws
 * EmailTakenError if the email is already registered anywhere on the instance.
 */
export async function register(
  deps: AuthDeps,
  input: { email: string; password: string; consent: boolean },
): Promise<{ tenantId: string; userId: string }> {
  if (!input.consent) throw new ConsentRequiredError();
  const passwordHash = await hashPassword(input.password);

  // Provision the tenant on the operator connection (tenants is not RLS-scoped).
  const tenant = await createTenant(deps.operatorPool, { name: input.email });

  let userId: string;
  try {
    const user = await withTenant(deps.appPool, tenant.id, (c) =>
      createUser(c, { email: input.email, passwordHash, consentTosVersion: deps.tosVersion }),
    );
    userId = user.id;
  } catch (err) {
    // Roll the just-created tenant back so a taken email leaves no orphan tenant.
    if (err instanceof EmailTakenError) {
      await deps.operatorPool.query(`DELETE FROM tenants WHERE id = $1`, [tenant.id]);
    }
    throw err;
  }

  await issueEmailToken(deps, tenant.id, userId, "verify", "Verify your Catchup email", "verify");
  await audit(deps, {
    tenantId: tenant.id,
    actorUserId: userId,
    actorEmail: input.email.toLowerCase(),
    action: "auth.register",
  });
  return { tenantId: tenant.id, userId };
}

/** Authenticate; on success create a session and return its RAW token (for the cookie). */
export async function login(
  deps: AuthDeps,
  input: { email: string; password: string },
): Promise<{ rawToken: string; user: AuthedUser } | null> {
  const user = await findUserForLogin(deps.operatorPool, input.email);
  // Verify even when the user is missing? We still hit argon2 only when we have a hash; a
  // missing user returns null. (Timing-uniformity hardening can come in T6.)
  if (!user || !(await verifyPassword(user.passwordHash, input.password))) {
    await audit(deps, {
      tenantId: user?.tenantId ?? null,
      actorEmail: input.email.toLowerCase(),
      action: "auth.login_failed",
    });
    return null;
  }

  const rawToken = generateToken();
  await withTenant(deps.appPool, user.tenantId, (c) =>
    createSession(c, {
      userId: user.id,
      tokenHash: hashToken(rawToken),
      expiresAt: expiry(deps.now(), deps.sessionTtlSeconds),
    }),
  );
  await audit(deps, {
    tenantId: user.tenantId,
    actorUserId: user.id,
    actorEmail: user.email,
    action: "auth.login",
  });
  return {
    rawToken,
    user: {
      id: user.id,
      tenantId: user.tenantId,
      email: user.email,
      emailVerified: user.emailVerifiedAt !== null,
    },
  };
}

/** Resolve a raw session token (from the cookie) → tenant + user, or null if invalid/expired. */
export async function resolveSession(
  deps: AuthDeps,
  rawToken: string,
): Promise<{ sessionId: string; tenantId: string; userId: string } | null> {
  const s = await findSessionByTokenHash(deps.operatorPool, hashToken(rawToken));
  if (!s) return null;
  return { sessionId: s.id, tenantId: s.tenantId, userId: s.userId };
}

/** Load the authenticated user record for a resolved session. */
export async function currentUser(
  deps: AuthDeps,
  resolved: { tenantId: string; userId: string },
): Promise<AuthedUser | null> {
  const user = await withTenant(deps.appPool, resolved.tenantId, (c) =>
    getUserById(c, resolved.userId),
  );
  if (!user) return null;
  return {
    id: user.id,
    tenantId: user.tenantId,
    email: user.email,
    emailVerified: user.emailVerifiedAt !== null,
  };
}

export async function logout(deps: AuthDeps, rawToken: string): Promise<void> {
  // Resolve first (for the audit actor) then delete by hash — both tenant-agnostic.
  const s = await findSessionByTokenHash(deps.operatorPool, hashToken(rawToken));
  await deleteSessionByTokenHash(deps.operatorPool, hashToken(rawToken));
  if (s) {
    await audit(deps, {
      tenantId: s.tenantId,
      actorUserId: s.userId,
      action: "auth.logout",
    });
  }
}

/** Redeem a verification token → mark the user's email verified. Returns true on success. */
export async function verifyEmail(deps: AuthDeps, rawToken: string): Promise<boolean> {
  const tok = await findActiveTokenByHash(deps.operatorPool, hashToken(rawToken));
  if (!tok || tok.kind !== "verify") return false;
  const ok = await withTenant(deps.appPool, tok.tenantId, async (c) => {
    const consumed = await consumeTokenByHash(c, hashToken(rawToken));
    if (!consumed) return false;
    await markEmailVerified(c, tok.userId);
    return true;
  });
  if (ok) {
    await audit(deps, {
      tenantId: tok.tenantId,
      actorUserId: tok.userId,
      action: "auth.verify",
    });
  }
  return ok;
}

/**
 * Begin a password reset. ALWAYS resolves (no error) whether or not the email exists, so
 * the endpoint cannot be used to enumerate accounts.
 */
export async function requestPasswordReset(deps: AuthDeps, email: string): Promise<void> {
  const user = await findUserForLogin(deps.operatorPool, email);
  if (!user) return;
  await issueEmailToken(
    deps,
    user.tenantId,
    user.id,
    "reset",
    "Reset your Catchup password",
    "reset",
  );
}

/** Complete a password reset using a valid reset token. Returns true on success. */
export async function resetPassword(
  deps: AuthDeps,
  rawToken: string,
  newPassword: string,
): Promise<boolean> {
  const tok = await findActiveTokenByHash(deps.operatorPool, hashToken(rawToken));
  if (!tok || tok.kind !== "reset") return false;
  const newHash = await hashPassword(newPassword);
  const ok = await withTenant(deps.appPool, tok.tenantId, async (c) => {
    const consumed = await consumeTokenByHash(c, hashToken(rawToken));
    if (!consumed) return false;
    await setPasswordHash(c, tok.userId, newHash);
    // A reset often happens BECAUSE the account is compromised: kill every live session.
    await deleteSessionsForUser(c, tok.userId);
    return true;
  });
  if (ok) {
    await audit(deps, {
      tenantId: tok.tenantId,
      actorUserId: tok.userId,
      action: "auth.reset",
    });
  }
  return ok;
}

/** Thrown when registration is attempted without accepting the consent/ToS gate. */
export class ConsentRequiredError extends Error {
  constructor() {
    super("consent to the terms of service is required");
    this.name = "ConsentRequiredError";
  }
}

async function issueEmailToken(
  deps: AuthDeps,
  tenantId: string,
  userId: string,
  kind: "verify" | "reset",
  subject: string,
  path: string,
): Promise<void> {
  const rawToken = generateToken();
  await withTenant(deps.appPool, tenantId, (c) =>
    createEmailToken(c, {
      userId,
      kind,
      tokenHash: hashToken(rawToken),
      expiresAt: expiry(deps.now(), deps.emailTokenTtlSeconds),
    }),
  );
  const link = `${deps.publicBaseUrl}/${path}?token=${rawToken}`;
  // Look the user's email up on the operator pool (pre/non-tenant-bound send).
  const user = await getUserEmail(deps, tenantId, userId);
  await deps.mailer.send(user, subject, `${subject}\n\n${link}\n`);
}

async function getUserEmail(deps: AuthDeps, tenantId: string, userId: string): Promise<string> {
  const u = await withTenant(deps.appPool, tenantId, (c) => getUserById(c, userId));
  return u?.email ?? "";
}
