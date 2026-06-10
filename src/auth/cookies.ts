/**
 * Minimal cookie parse/serialize for the session cookie. Kept dependency-free on purpose:
 * the auth path should have as little third-party surface as practical, and this is all the
 * cookie handling the app needs.
 */

export const SESSION_COOKIE = "catchup_session";

/** Parse a `Cookie:` header value into a name→value map. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    const raw = part.slice(eq + 1).trim();
    // A malformed %-sequence from a buggy/hostile client must not throw (and 500 the
    // request) — fall back to the raw value; token lookups on garbage simply miss.
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

export type CookieOptions = {
  /** Set the Secure attribute (true in production behind HTTPS; false for local http dev). */
  secure: boolean;
  /** Max-Age in seconds. Use 0 to expire/clear the cookie immediately. */
  maxAgeSeconds: number;
};

/** Serialize the session cookie. httpOnly + SameSite=Lax always; Secure per options. */
export function serializeSessionCookie(token: string, opts: CookieOptions): string {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(opts.maxAgeSeconds))}`,
  ];
  if (opts.secure) attrs.push("Secure");
  return attrs.join("; ");
}
