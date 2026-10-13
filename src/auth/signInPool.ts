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
 * The set holds a digest of each token, never the token, until the token
 * expires or ten minutes pass. It exempts a request from the shared backstop
 * only. Every request is still authenticated in full.
 */

import { createHash } from 'node:crypto';

export const VERIFIED_TOKEN_CONFIG = {
  /** How long a verified token stays exempt, at most. */
  verifiedForMs: 10 * 60 * 1000,
  /** Digests held at most; the oldest go first. */
  maxVerified: 20_000
} as const;

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
  const until = Math.min(now + VERIFIED_TOKEN_CONFIG.verifiedForMs, expiresAtMs ?? Number.POSITIVE_INFINITY);
  if (until <= now) return;
  const key = digest(token);
  verified.delete(key);
  verified.set(key, until);
  while (verified.size > VERIFIED_TOKEN_CONFIG.maxVerified) {
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

/** Tests and clearRateLimitState only. */
export function resetVerifiedTokens(): void {
  verified.clear();
}
