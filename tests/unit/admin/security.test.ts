import { describe, expect, it } from "vitest";

import {
  SlidingWindowLimiter,
  buildSecurityHeaders,
  checkStateChangingRequest,
  createCsrfToken,
  createNonce,
  parseFormBody,
  verifyCsrfToken,
} from "../../../src/admin/http/security.js";

function request(headers: Record<string, string>, method = "POST") {
  return { method, header: (name: string) => headers[name.toLowerCase()] };
}

const ORIGINS = ["https://letter-irl-admin-dev.tail1234.ts.net"];

describe("admin browser-boundary checks", () => {
  it("accepts a same-origin form post and nothing looser", () => {
    const good = {
      "sec-fetch-site": "same-origin",
      origin: "https://letter-irl-admin-dev.tail1234.ts.net",
      "content-type": "application/x-www-form-urlencoded",
    };
    expect(checkStateChangingRequest(request(good), ORIGINS)).toBeNull();
    expect(checkStateChangingRequest(request({ ...good, "sec-fetch-site": "none" }), ORIGINS)).toBeNull();
    expect(
      checkStateChangingRequest(request({ ...good, "sec-fetch-site": "cross-site" }), ORIGINS),
    ).toBe("ADMIN_CSRF_REJECTED");
    expect(
      checkStateChangingRequest(request({ ...good, "sec-fetch-site": "same-site" }), ORIGINS),
    ).toBe("ADMIN_CSRF_REJECTED");
    const { "sec-fetch-site": _omitted, ...withoutSite } = good;
    expect(checkStateChangingRequest(request(withoutSite), ORIGINS)).toBe("ADMIN_CSRF_REJECTED");
    expect(
      checkStateChangingRequest(request({ ...good, origin: "https://evil.example" }), ORIGINS),
    ).toBe("ADMIN_CSRF_REJECTED");
    const { origin: _origin, ...withoutOrigin } = good;
    expect(checkStateChangingRequest(request(withoutOrigin), ORIGINS)).toBe("ADMIN_CSRF_REJECTED");
    expect(
      checkStateChangingRequest(request({ ...good, "content-type": "application/json" }), ORIGINS),
    ).toBe("ADMIN_INVALID_REQUEST");
    expect(checkStateChangingRequest(request(good, "PUT"), ORIGINS)).toBe("ADMIN_METHOD_NOT_ALLOWED");
  });

  it("binds the CSRF token to the session and the secret", () => {
    const token = createCsrfToken("s".repeat(32), "session-1");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyCsrfToken("s".repeat(32), "session-1", token)).toBe(true);
    expect(verifyCsrfToken("s".repeat(32), "session-2", token)).toBe(false);
    expect(verifyCsrfToken("t".repeat(32), "session-1", token)).toBe(false);
    expect(verifyCsrfToken("s".repeat(32), "session-1", undefined)).toBe(false);
    expect(verifyCsrfToken("s".repeat(32), "session-1", token.slice(1))).toBe(false);
  });

  it("emits the strict CSP with a fresh nonce and no-store on every response", () => {
    const nonce = createNonce();
    expect(nonce).not.toBe(createNonce());
    const headers = buildSecurityHeaders(nonce);
    expect(headers["Content-Security-Policy"]).toContain(`script-src 'nonce-${nonce}' 'strict-dynamic'`);
    expect(headers["Content-Security-Policy"]).toContain("default-src 'none'");
    expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(headers["Content-Security-Policy"]).not.toContain("unsafe-inline");
    expect(headers["Cache-Control"]).toBe("no-store");
    expect(headers["Referrer-Policy"]).toBe("no-referrer");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("rate-limits per key over a sliding window", () => {
    let now = 0;
    const limiter = new SlidingWindowLimiter(3, 1_000, () => now);
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("a")).toBe(false);
    expect(limiter.allow("b")).toBe(true);
    now = 1_001;
    expect(limiter.allow("a")).toBe(true);
  });

  it("parses forms into single-valued bounded fields", () => {
    const fields = parseFormBody("a=1&a=2&b=x%20y&_csrf=abc", 2);
    expect(fields.get("a")).toBe("1");
    expect(fields.get("b")).toBe("x y");
    expect(fields.has("_csrf")).toBe(false);
  });
});
