import { describe, expect, it } from "vitest";
import { parseCookies, SESSION_COOKIE, serializeSessionCookie } from "./cookies.js";

describe("cookies", () => {
  it("parses a cookie header into a map", () => {
    expect(parseCookies("a=1; b=two; c=")).toEqual({ a: "1", b: "two", c: "" });
  });

  it("returns an empty map for a missing/blank header", () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies("")).toEqual({});
  });

  it("does not throw on malformed percent-encoding — keeps the raw value (garbage cookie must not 500 a request)", () => {
    expect(parseCookies("bad=%zz; good=ok")).toEqual({ bad: "%zz", good: "ok" });
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
