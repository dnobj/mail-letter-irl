/**
 * Auth Middleware
 *
 * JWT validation for HTTP requests
 * Validates Auth0 JWT tokens and returns user info
 */

import http from 'node:http';
import { jwtVerify, createRemoteJWKSet } from 'jose';
import { AuthenticatedUser } from '../../services/types.js';
import { parseCookies } from '../../utils/cookies.js';

const jwksUri = process.env.LETTER_IRL_OAUTH_JWKS_URI;
const JWKS = jwksUri ? createRemoteJWKSet(new URL(jwksUri)) : null;

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
  try {
    if (!JWKS) {
      if (res) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Authentication is not configured' }));
      }
      return null;
    }
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
      if (res) {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Authentication required' }));
      }
      return null;
    }

    // Verify JWT with Auth0
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: process.env.LETTER_IRL_OAUTH_ISSUER,
      audience: process.env.LETTER_IRL_OAUTH_AUDIENCE
    });

    return {
      userId: payload.sub!,
      email: payload.email as string | undefined
    };
  } catch (error: any) {
    console.error('Authentication failed');

    if (res) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');

      if (error.code === 'ERR_JWT_EXPIRED') {
        res.end(JSON.stringify({ error: 'Token expired' }));
      } else if (error.code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED') {
        res.end(JSON.stringify({ error: 'Invalid token signature' }));
      } else {
        res.end(JSON.stringify({ error: 'Invalid or expired token' }));
      }
    }

    return null;
  }
}
