/**
 * Tokens this process verified recently (#730), so the MCP and REST routes'
 * shared backstop can leave the people already signed in alone.
 *
 * The routes check a per-address limit and then, before authentication, a
 * limit shared by everyone. It bounds the cost of checking tokens (a database
 * query and a bcrypt compare for a personal access token), so it counts every
 * request as it arrives. But a few addresses sending junk tokens could fill it,
 * and then every ChatGPT and Claude call was refused. Now a request whose
 * bearer token passed authentication here recently is neither counted nor
 * refused by it. What a flood can still delay: a first sign-in, the first
 * request with a refreshed token, the first after ten idle minutes, and every
 * request just after a restart, as the set is held in memory.
 *
 * The set holds a digest of each token, never the token, and the account it
 * signed in, until the token expires or ten minutes pass. It exempts a request
 * from the shared backstop only, and at most `exemptPerAccountPerMinute` a
 * minute per account: every request is still authenticated in full, which
 * costs a query and a bcrypt compare for a personal access token, so one
 * credential sent from many addresses must not escape the bound. Past it, the
 * account's requests are counted like anyone's.
 */

import { createHash } from 'node:crypto';

export const VERIFIED_TOKEN_CONFIG = {
  /** How long a verified token stays exempt, at most. */
  verifiedForMs: 10 * 60 * 1000,
  /** Digests held at most; the oldest go first. */
  maxVerified: 20_000,
  /** Requests an account may make a minute without being counted: twice mcp_account. */
  exemptPerAccountPerMinute: 120,
  windowMs: 60 * 1000
} as const;

const verified = new Map<string, { until: number; userId: string }>();
const exemptions = new Map<string, { count: number; windowStart: number }>();

function digest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

function bearerOf(authorization: string | string[] | undefined): string | null {
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  const match = header ? /^Bearer\s+(.+)$/i.exec(header) : null;
  const token = match ? match[1].trim() : '';
  return token || null;
}

/** A token that passed authentication for `userId`, until `expiresAtMs` or ten minutes. */
export function rememberVerifiedToken(token: string, userId: string, expiresAtMs?: number, now = Date.now()): void {
  const until = Math.min(now + VERIFIED_TOKEN_CONFIG.verifiedForMs, expiresAtMs ?? Number.POSITIVE_INFINITY);
  if (until <= now) return;
  const key = digest(token.trim());
  verified.delete(key);
  verified.set(key, { until, userId });
  while (verified.size > VERIFIED_TOKEN_CONFIG.maxVerified) {
    const oldest = verified.keys().next().value;
    if (oldest === undefined) break;
    verified.delete(oldest);
  }
}

/** The account whose recently verified token the request carries, or null. */
export function verifiedAccount(authorization: string | string[] | undefined, now = Date.now()): string | null {
  const token = bearerOf(authorization);
  if (!token) return null;
  const key = digest(token);
  const entry = verified.get(key);
  if (entry === undefined) return null;
  if (entry.until <= now) {
    verified.delete(key);
    return null;
  }
  return entry.userId;
}

/** Whether the request's bearer token passed authentication here recently. */
export function carriesVerifiedToken(authorization: string | string[] | undefined, now = Date.now()): boolean {
  return verifiedAccount(authorization, now) !== null;
}

/**
 * Whether a request carrying a verified token may skip the shared backstop:
 * true for the account's first `exemptPerAccountPerMinute` a minute.
 */
export function takeExemption(authorization: string | string[] | undefined, now = Date.now()): boolean {
  const userId = verifiedAccount(authorization, now);
  if (userId === null) return false;
  let entry = exemptions.get(userId);
  if (!entry || now - entry.windowStart >= VERIFIED_TOKEN_CONFIG.windowMs) {
    if (exemptions.size >= VERIFIED_TOKEN_CONFIG.maxVerified) {
      for (const [id, old] of exemptions) {
        if (now - old.windowStart >= VERIFIED_TOKEN_CONFIG.windowMs) exemptions.delete(id);
      }
    }
    entry = { count: 0, windowStart: now };
    exemptions.set(userId, entry);
  }
  if (entry.count >= VERIFIED_TOKEN_CONFIG.exemptPerAccountPerMinute) return false;
  entry.count += 1;
  return true;
}

/** Tests and clearRateLimitState only. */
export function resetVerifiedTokens(): void {
  verified.clear();
  exemptions.clear();
}
