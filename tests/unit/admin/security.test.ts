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
    const refusal = (headers: Record<string, string>, method = "POST") =>
      checkStateChangingRequest(request(headers, method), ORIGINS);
    expect(refusal(good)).toBeNull();
    expect(refusal({ ...good, "sec-fetch-site": "none" })).toBeNull();
    expect(refusal({ ...good, "sec-fetch-site": "cross-site" })).toMatchObject({
      code: "ADMIN_CSRF_REJECTED",
      detail: "sec_fetch_site_missing_or_cross_site",
    });
    expect(refusal({ ...good, "sec-fetch-site": "same-site" })).toMatchObject({
      code: "ADMIN_CSRF_REJECTED",
    });
    const { "sec-fetch-site": _omitted, ...withoutSite } = good;
    expect(refusal(withoutSite)).toMatchObject({
      detail: "sec_fetch_site_missing_or_cross_site",
    });
    expect(refusal({ ...good, origin: "https://evil.example" })).toMatchObject({
      code: "ADMIN_CSRF_REJECTED",
      detail: "origin_mismatch",
    });
    const { origin: _origin, ...withoutOrigin } = good;
    expect(refusal(withoutOrigin)).toMatchObject({ detail: "origin_missing_or_null" });
    // Chrome sends a literal "null" Origin on a form post when the response
    // that carried the form set Referrer-Policy: no-referrer. It is reported
    // apart from a mismatch because the cause is our own headers, not the
    // caller.
    expect(refusal({ ...good, origin: "null" })).toMatchObject({
      code: "ADMIN_CSRF_REJECTED",
      detail: "origin_missing_or_null",
    });
    expect(refusal({ ...good, "content-type": "application/json" })).toMatchObject({
      code: "ADMIN_INVALID_REQUEST",
      detail: "content_type_not_form",
    });
    expect(refusal(good, "PUT")).toMatchObject({ code: "ADMIN_METHOD_NOT_ALLOWED" });
  });

  it("sets a referrer policy that leaves the Origin header intact on our own form posts", () => {
    // Per Fetch, a non-CORS request whose method is not GET or HEAD has its
    // Origin serialised as `null` under "no-referrer". The panel used to send
    // that header, so every form post arrived with Origin: null and was
    // refused by the boundary check above: two correct controls that were
    // mutually exclusive, and no automated test caught it because the request
    // fixtures set Origin themselves rather than letting a browser compute it.
    const policy = buildSecurityHeaders(createNonce())["Referrer-Policy"];
    expect(policy).not.toBe("no-referrer");
    expect(["same-origin", "strict-origin", "strict-origin-when-cross-origin"]).toContain(policy);
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
    expect(headers["Referrer-Policy"]).toBe("same-origin");
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
