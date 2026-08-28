/**
 * Auth Middleware
 *
 * JWT validation for HTTP requests
 * Validates Auth0 JWT tokens and returns user info
 *
 * Issue #209, second instance. This was the fourth copy of the bearer check
 * reading LETTER_IRL_OAUTH_AUDIENCE straight from the environment as a single
 * value, and it was missed when the other three were consolidated because it
 * answers with different wording ("Invalid or expired token" rather than
 * "Missing or invalid Authorization header"). Its one caller is the Stripe
 * checkout route, so the symptom was: the dashboard loads, and Buy Now does
 * nothing.
 *
 * It now delegates to validateJWTToken, the validator the MCP layer and the
 * REST handlers share, so the accepted audience set has one source of truth.
 * The response contract is unchanged: same status codes, same bodies, so the
 * website's proxy and its client see exactly what they saw before.
 */

import http from 'node:http';
import { AuthenticatedUser } from '../../services/types.js';
import { parseCookies } from '../../utils/cookies.js';
import { validateJWTToken } from '../../auth/tokenValidator.js';
import { BetaAccessDeniedError, BETA_ACCESS_MESSAGE } from '../../auth/betaAccess.js';

function respond(res: http.ServerResponse | undefined, statusCode: number, body: Record<string, unknown>): void {
  if (!res) return;
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

/**
 * Authenticate HTTP request - works with both Bearer tokens and cookies
 * For use with plain Node.js http.IncomingMessage
 *
 * @param req - HTTP incoming message
 * @param res - HTTP server response (optional, for error responses)
 * @returns AuthenticatedUser or null if authentication fails
 */
export async function authenticateHttpRequest(
  req: http.IncomingMessage,
  res?: http.ServerResponse
): Promise<AuthenticatedUser | null> {
  let token: string | null = null;

  // Try to get token from Authorization header first
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  }

  // If no bearer token, try to get from cookie
  if (!token) {
    const cookies = parseCookies(req.headers.cookie);
    token = cookies.access_token || null;
  }

  if (!token) {
    respond(res, 401, { error: 'Authentication required' });
    return null;
  }

  try {
    const user = await validateJWTToken(token);
    return {
      userId: user.userId,
      email: typeof user.claims.email === 'string' ? user.claims.email : undefined
    };
  } catch (error: unknown) {
    // Not an authentication failure: the token was good and the account is
    // simply not admitted. 401 here would send the caller back to Auth0 to
    // succeed and be refused again.
    if (error instanceof BetaAccessDeniedError) {
      respond(res, 403, { error: BETA_ACCESS_MESSAGE });
      return null;
    }
    // validateJWTToken already emitted the structured diagnostic.
    const message = error instanceof Error ? error.message : '';
    if (message === 'OAuth validation not configured') {
      respond(res, 503, { error: 'Authentication is not configured' });
      return null;
    }
    const code = (error as { code?: string })?.code;
    if (code === 'ERR_JWT_EXPIRED') {
      respond(res, 401, { error: 'Token expired' });
    } else if (code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED') {
      respond(res, 401, { error: 'Invalid token signature' });
    } else {
      respond(res, 401, { error: 'Invalid or expired token' });
    }
    return null;
  }
}
