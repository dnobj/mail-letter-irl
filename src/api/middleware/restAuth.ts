/**
 * Bearer authentication for the REST API (letters, credits, return address).
 *
 * One implementation, delegating to the same validator the MCP layer trusts.
 * Issue #209: three copies of this check lived in three handlers, each reading
 * LETTER_IRL_OAUTH_AUDIENCE straight from the environment as a single value.
 * The MCP layer reads the audience through getOAuthConfig(), which parses a
 * list and merges LETTER_IRL_OAUTH_LEGACY_AUDIENCES under the static-DCR
 * compatibility flag. The two layers therefore disagreed about which audiences
 * were valid, and only the MCP one won: the website's token, minted for the
 * legacy audience, was rejected by every dashboard call.
 *
 * Going through validateJWTToken closes that permanently. Whatever the config
 * layer accepts, REST accepts; there is no second source of truth to drift.
 *
 * It also fixes the message. The old check answered "Missing or invalid
 * Authorization header" for a header that was present and well-formed but
 * carried a token failing issuer or audience validation. That sent the #209
 * investigation to the website's proxy first. The outcomes are now distinct.
 *
 * Issue #179 added `status`, and made it REQUIRED. All three handlers used to
 * answer 401 for every failure, including "the server cannot validate
 * anything" - which this file's own docblock says it exists to distinguish,
 * and which the sibling middleware already answered 503. A beta refusal must
 * be 403, because 401 tells a client to authenticate again and it would
 * succeed and be refused again. Making the field required means the compiler
 * finds every caller rather than trusting three handlers to be updated
 * together.
 */

import type { IncomingMessage } from 'http';
import { validateJWTToken } from '../../auth/tokenValidator.js';
import { BetaAccessDeniedError, BETA_ACCESS_MESSAGE } from '../../auth/betaAccess.js';

export interface RestAuthInfo {
  userId: string;
  email?: string;
}

export type RestAuthFailureReason =
  | 'no_credentials'
  | 'not_configured'
  | 'rejected'
  | 'forbidden';

export type RestAuthOutcome =
  | { ok: true; user: RestAuthInfo }
  | { ok: false; reason: RestAuthFailureReason; status: number; message: string };

const MESSAGES: Record<RestAuthFailureReason, string> = {
  no_credentials: 'Missing or invalid Authorization header',
  not_configured: 'Authentication is not configured on this server',
  rejected: 'The bearer token was rejected',
  forbidden: BETA_ACCESS_MESSAGE
};

/**
 * The status each outcome deserves, in one table rather than at three call
 * sites. 403 for `forbidden` is the load-bearing one: the caller authenticated
 * correctly and is simply not admitted, so telling them to authenticate again
 * would send them round a loop that cannot terminate.
 */
const STATUS: Record<RestAuthFailureReason, number> = {
  no_credentials: 401,
  not_configured: 503,
  rejected: 401,
  forbidden: 403
};

/**
 * The JSON `error` label for a status. Exported so the handlers do not each
 * carry their own mapping - three copies of a small thing is exactly how the
 * audience check drifted in #209.
 */
export function restAuthErrorLabel(status: number): string {
  if (status === 403) return 'Forbidden';
  if (status === 503) return 'Service Unavailable';
  return 'Unauthorized';
}

function fail(reason: RestAuthFailureReason): RestAuthOutcome {
  return { ok: false, reason, status: STATUS[reason], message: MESSAGES[reason] };
}

function extractToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    const token = header.substring(7).trim();
    if (token) return token;
  }
  // The letter and return-address handlers also accepted an access_token cookie.
  // Kept for parity; the website's proxy sends a header, so this is a fallback.
  const cookies = req.headers.cookie;
  if (cookies) {
    const found = cookies
      .split(';')
      .map(c => c.trim())
      .find(c => c.startsWith('access_token='));
    if (found) {
      const token = found.substring('access_token='.length).trim();
      if (token) return token;
    }
  }
  return null;
}

export async function authenticateRestRequest(req: IncomingMessage): Promise<RestAuthOutcome> {
  const token = extractToken(req);
  if (!token) {
    return fail('no_credentials');
  }
  try {
    const user = await validateJWTToken(token);
    const email = typeof user.claims.email === 'string' ? user.claims.email : undefined;
    return { ok: true, user: { userId: user.userId, email } };
  } catch (error) {
    // Checked before the message comparisons below: a beta refusal is not an
    // authentication failure, and must not be reported as one.
    if (error instanceof BetaAccessDeniedError) {
      return fail('forbidden');
    }
    // validateJWTToken already emitted the structured diagnostic. Distinguish
    // "the server cannot validate anything" from "this token failed" so an
    // operator reading the response knows which side to look at.
    const message = error instanceof Error ? error.message : '';
    if (message === 'OAuth validation not configured') {
      return fail('not_configured');
    }
    return fail('rejected');
  }
}
