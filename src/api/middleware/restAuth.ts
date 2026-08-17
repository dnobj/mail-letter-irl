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
 */

import type { IncomingMessage } from 'http';
import { validateJWTToken } from '../../auth/tokenValidator.js';

export interface RestAuthInfo {
  userId: string;
  email?: string;
}

export type RestAuthOutcome =
  | { ok: true; user: RestAuthInfo }
  | { ok: false; reason: 'no_credentials' | 'not_configured' | 'rejected'; message: string };

const MESSAGES: Record<Exclude<RestAuthOutcome, { ok: true }>['reason'], string> = {
  no_credentials: 'Missing or invalid Authorization header',
  not_configured: 'Authentication is not configured on this server',
  rejected: 'The bearer token was rejected'
};

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
    return { ok: false, reason: 'no_credentials', message: MESSAGES.no_credentials };
  }
  try {
    const user = await validateJWTToken(token);
    const email = typeof user.claims.email === 'string' ? user.claims.email : undefined;
    return { ok: true, user: { userId: user.userId, email } };
  } catch (error) {
    // validateJWTToken already emitted the structured diagnostic. Distinguish
    // "the server cannot validate anything" from "this token failed" so an
    // operator reading the response knows which side to look at.
    const message = error instanceof Error ? error.message : '';
    if (message === 'OAuth validation not configured') {
      return { ok: false, reason: 'not_configured', message: MESSAGES.not_configured };
    }
    return { ok: false, reason: 'rejected', message: MESSAGES.rejected };
  }
}
