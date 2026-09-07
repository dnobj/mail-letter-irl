import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { AdminErrorCode } from "../errors.js";

/**
 * Browser-boundary hardening for the panel: response headers with a per-
 * response CSP nonce, the state-changing request checks, the CSRF token bound
 * to the session, a per-login rate limiter, and bounded form parsing.
 *
 * CSRF matters more here than on an ordinary site. Serve's identity comes
 * from the node, not from the browser tab, so any page open in any browser on
 * the operator's device could make an authenticated request. State changes
 * therefore need Sec-Fetch-Site, Origin and a synchronizer token, all three.
 */

export interface RequestView {
  method: string;
  header(name: string): string | undefined;
}

export const FORM_BODY_LIMIT_BYTES = 64 * 1024;

export function createNonce(): string {
  return randomBytes(16).toString("base64");
}

export function buildSecurityHeaders(nonce: string): Record<string, string> {
  return {
    "Content-Security-Policy": [
      "default-src 'none'",
      `script-src 'nonce-${nonce}' 'strict-dynamic'`,
      `style-src 'nonce-${nonce}'`,
      "img-src 'self'",
      "connect-src 'self'",
      "form-action 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ].join("; "),
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Permissions-Policy":
      "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}

/**
 * A POST is accepted only when the browser itself says it came from this
 * origin. Absent metadata is a refusal, not a pass: every supported browser
 * sends Sec-Fetch-Site and Origin on a form submission.
 */
export function checkStateChangingRequest(
  request: RequestView,
  expectedOrigins: readonly string[],
): AdminErrorCode | null {
  if (request.method !== "POST") return "ADMIN_METHOD_NOT_ALLOWED";
  const site = request.header("sec-fetch-site");
  if (site !== "same-origin" && site !== "none") return "ADMIN_CSRF_REJECTED";
  const origin = request.header("origin");
  if (!origin || !expectedOrigins.includes(origin.toLowerCase())) {
    return "ADMIN_CSRF_REJECTED";
  }
  const contentType = (request.header("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith("application/x-www-form-urlencoded")) {
    return "ADMIN_INVALID_REQUEST";
  }
  return null;
}

export function createCsrfToken(secret: string, sessionId: string): string {
  return createHmac("sha256", secret).update(`csrf:${sessionId}`).digest("hex");
}

export function verifyCsrfToken(
  secret: string,
  sessionId: string,
  presented: string | undefined,
): boolean {
  if (!presented || presented.length !== 64) return false;
  const expected = Buffer.from(createCsrfToken(secret, sessionId), "hex");
  const actual = Buffer.from(presented, "hex");
  return actual.length === expected.length && timingSafeEqual(expected, actual);
}

/** Fixed-window counter per key; process-local, which is all there is. */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  allow(key: string): boolean {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter(
      (at) => now - at < this.windowMs,
    );
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 1000) {
      for (const [otherKey, stamps] of this.hits) {
        if (stamps.every((at) => now - at >= this.windowMs)) {
          this.hits.delete(otherKey);
        }
      }
    }
    return true;
  }
}

/** Parse a form body into single-valued fields; repeats keep the first. */
export function parseFormBody(
  text: string,
  maxFields = 50,
): Map<string, string> {
  const fields = new Map<string, string>();
  const params = new URLSearchParams(text);
  for (const [key, value] of params) {
    if (fields.size >= maxFields) break;
    if (!fields.has(key)) fields.set(key, value);
  }
  return fields;
}
