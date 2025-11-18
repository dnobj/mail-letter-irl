/**
 * Admin Authorization Middleware
 *
 * Checks if the authenticated user has admin privileges
 * Uses whitelist approach - admin user IDs configured in environment
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { jwtVerify, createRemoteJWKSet } from 'jose';

// Create JWKS client for Auth0
const JWKS = createRemoteJWKSet(
  new URL(process.env.LETTER_IRL_OAUTH_JWKS_URI!)
);

// Admin user IDs (comma-separated in .env)
// Example: LETTER_IRL_ADMIN_USER_IDS=auth0|123,auth0|456
const ADMIN_USER_IDS = (process.env.LETTER_IRL_ADMIN_USER_IDS || '')
  .split(',')
  .map(id => id.trim())
  .filter(id => id.length > 0);

interface AdminAuthInfo {
  userId: string;
  email?: string;
  isAdmin: boolean;
}

/**
 * Send JSON response
 */
function sendJson(res: ServerResponse, statusCode: number, data: any) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

/**
 * Authenticate request and verify admin status
 * Returns admin info if authenticated and authorized, null otherwise
 */
export async function authenticateAdmin(
  req: IncomingMessage,
  res: ServerResponse
): Promise<AdminAuthInfo | null> {
  // Check for Authorization header
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    sendJson(res, 401, {
      error: 'Unauthorized',
      message: 'Missing or invalid Authorization header'
    });
    return null;
  }

  const token = authHeader.substring(7);

  // Verify JWT
  let userId: string;
  let email: string | undefined;

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: process.env.LETTER_IRL_OAUTH_ISSUER,
      audience: process.env.LETTER_IRL_OAUTH_AUDIENCE
    });

    userId = payload.sub!;
    email = payload.email as string | undefined;
  } catch (error) {
    console.error('Admin auth - JWT validation failed:', error);
    sendJson(res, 401, {
      error: 'Unauthorized',
      message: 'Invalid or expired token'
    });
    return null;
  }

  // Check if user is admin
  const isAdmin = ADMIN_USER_IDS.includes(userId);

  if (!isAdmin) {
    console.warn(`Admin access denied for user: ${userId}`);
    sendJson(res, 403, {
      error: 'Forbidden',
      message: 'Admin access required. Contact administrator for access.'
    });
    return null;
  }

  console.log(`✅ Admin authenticated: ${userId} (${email})`);

  return {
    userId,
    email,
    isAdmin: true
  };
}

/**
 * Check if a user ID is an admin (without HTTP request/response)
 * Useful for internal checks
 */
export function isAdmin(userId: string): boolean {
  return ADMIN_USER_IDS.includes(userId);
}

/**
 * Get list of admin user IDs (for debugging)
 */
export function getAdminUserIds(): string[] {
  return [...ADMIN_USER_IDS];
}
