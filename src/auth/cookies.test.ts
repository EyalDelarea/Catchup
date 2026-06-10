import { describe, expect, it } from "vitest";
import { parseCookies, SESSION_COOKIE, serializeSessionCookie } from "./cookies.js";

describe("cookies", () => {
  it("parses a cookie header into a Map", () => {
    expect(parseCookies("a=1; b=two; c=")).toEqual(
      new Map([
        ["a", "1"],
        ["b", "two"],
        ["c", ""],
      ]),
    );
  });

  it("returns an empty Map for a missing/blank header", () => {
    expect(parseCookies(undefined).size).toBe(0);
    expect(parseCookies("").size).toBe(0);
  });

  it("does not throw on malformed percent-encoding — keeps the raw value (garbage cookie must not 500 a request)", () => {
    const out = parseCookies("bad=%zz; good=ok");
    expect(out.get("bad")).toBe("%zz");
    expect(out.get("good")).toBe("ok");
  });

  it("is immune to prototype pollution via hostile cookie names (Map, not object)", () => {
    const out = parseCookies("__proto__=evil; constructor=evil; a=1");
    expect(out.get("a")).toBe("1");
    expect(out.get("__proto__")).toBe("evil"); // inert data, not Object machinery
    expect({} as Record<string, unknown>).not.toHaveProperty("polluted");
    expect(Object.prototype.toString).toBeTypeOf("function"); // untouched
  });

  it("serializes a secure, httpOnly session cookie", () => {
    const c = serializeSessionCookie("tok123", { secure: true, maxAgeSeconds: 3600 });
    expect(c).toContain(`${SESSION_COOKIE}=tok123`);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Secure");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Path=/");
    expect(c).toContain("Max-Age=3600");
  });

  it("omits Secure when secure=false (local http dev) and clears with maxAge 0", () => {
    expect(serializeSessionCookie("t", { secure: false, maxAgeSeconds: 3600 })).not.toContain(
      "Secure",
    );
    const cleared = serializeSessionCookie("", { secure: true, maxAgeSeconds: 0 });
    expect(cleared).toContain("Max-Age=0");
  });
});
