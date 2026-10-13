/**
 * The shared backstop on the MCP and REST routes counts failed sign-ins only
 * (#730).
 *
 * The routes check a per-address limit and then, before authentication, a
 * limit shared by everyone. That shared limit used to count every request, so
 * two addresses sending junk bearer tokens could use it up and every ChatGPT
 * and Claude call was refused. It exists to bound the cost of checking tokens
 * that turn out to be bad, so now it counts only those. When it is full, a
 * request is refused only if it does not carry a token this process verified
 * recently: the people already signed in keep working while it is full.
 *
 * The verified set holds a digest of each token, never the token, until the
 * token expires or ten minutes pass. It exempts a request from this backstop
 * only. Every request is still authenticated in full.
 */

import { createHash } from 'node:crypto';

export const SIGN_IN_POOL_CONFIG = {
  windowMs: 60 * 1000,
  /** Failed sign-ins a minute, from everyone, before unverified requests wait. */
  maxFailures: 600,
  /** How long a verified token stays exempt, at most. */
  verifiedForMs: 10 * 60 * 1000,
  /** Digests held at most; the oldest go first. */
  maxVerified: 20_000
} as const;

let failures = { count: 0, windowStart: 0 };
const verified = new Map<string, number>();

function digest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

function bearerOf(authorization: string | string[] | undefined): string | null {
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  const match = header ? /^Bearer\s+(.+)$/i.exec(header) : null;
  return match ? match[1] : null;
}

/** A token that passed authentication, until `expiresAtMs` or ten minutes. */
export function rememberVerifiedToken(token: string, expiresAtMs?: number, now = Date.now()): void {
  const until = Math.min(now + SIGN_IN_POOL_CONFIG.verifiedForMs, expiresAtMs ?? Number.POSITIVE_INFINITY);
  if (until <= now) return;
  const key = digest(token);
  verified.delete(key);
  verified.set(key, until);
  while (verified.size > SIGN_IN_POOL_CONFIG.maxVerified) {
    const oldest = verified.keys().next().value;
    if (oldest === undefined) break;
    verified.delete(oldest);
  }
}

/** Whether the request's bearer token passed authentication here recently. */
export function carriesVerifiedToken(authorization: string | string[] | undefined, now = Date.now()): boolean {
  const token = bearerOf(authorization);
  if (!token) return false;
  const key = digest(token);
  const until = verified.get(key);
  if (until === undefined) return false;
  if (until <= now) {
    verified.delete(key);
    return false;
  }
  return true;
}

/** One token that failed to authenticate: a bad signature, claims or PAT. */
export function recordFailedSignIn(now = Date.now()): void {
  if (now - failures.windowStart >= SIGN_IN_POOL_CONFIG.windowMs) {
    failures = { count: 0, windowStart: now };
  }
  failures.count += 1;
}

/** Whether this minute's failed sign-ins have reached the limit, and when it resets. */
export function failedSignInPool(now = Date.now()): { full: boolean; limit: number; resetMs: number } {
  const fresh = now - failures.windowStart >= SIGN_IN_POOL_CONFIG.windowMs;
  return {
    full: !fresh && failures.count >= SIGN_IN_POOL_CONFIG.maxFailures,
    limit: SIGN_IN_POOL_CONFIG.maxFailures,
    resetMs: fresh ? 0 : SIGN_IN_POOL_CONFIG.windowMs - (now - failures.windowStart)
  };
}

/** Tests and clearRateLimitState only. */
export function resetSignInPool(): void {
  failures = { count: 0, windowStart: 0 };
  verified.clear();
}
