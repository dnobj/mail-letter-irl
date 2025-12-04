/**
 * Admin Authorization Middleware
 *
 * Checks if the authenticated user has admin privileges
 * Uses whitelist approach - admin user IDs configured in environment
 *
 * Security:
 * - ADMIN_ENABLED must be explicitly set to 'true' (disabled by default)
 * - ADMIN_LOCAL_ONLY restricts to localhost connections only
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { jwtVerify, createRemoteJWKSet } from 'jose';

// Admin feature flags
// ADMIN_ENABLED: Must be 'true' to enable admin routes (disabled by default)
// ADMIN_LOCAL_ONLY: If 'true', only localhost can access admin routes
const ADMIN_ENABLED = process.env.ADMIN_ENABLED === 'true';
const ADMIN_LOCAL_ONLY = process.env.ADMIN_LOCAL_ONLY === 'true';

// Create JWKS client for Auth0 (only if admin is enabled)
const JWKS = ADMIN_ENABLED && process.env.LETTER_IRL_OAUTH_JWKS_URI
  ? createRemoteJWKSet(new URL(process.env.LETTER_IRL_OAUTH_JWKS_URI))
  : null;

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
  // Check if admin is enabled (disabled by default)
  if (!ADMIN_ENABLED) {
    // Return stealth 404 - don't reveal admin routes exist
    sendJson(res, 404, { error: 'Not found' });
    return null;
  }

  // Check remote address
  const remoteAddress = req.socket.remoteAddress;
  const isLocalhost = remoteAddress === '127.0.0.1' ||
                      remoteAddress === '::1' ||
                      remoteAddress === '::ffff:127.0.0.1';

  // Block if coming through proxy (ngrok, etc.)
  const isProxied = req.headers['x-forwarded-for'] ||
                    req.headers['x-real-ip'] ||
                    req.headers['ngrok-agent-ips'];

  // If ADMIN_LOCAL_ONLY is set, only allow localhost non-proxied requests
  if (ADMIN_LOCAL_ONLY && (!isLocalhost || isProxied)) {
    // Return stealth 404
    sendJson(res, 404, { error: 'Not found' });
    return null;
  }

  // Allow localhost requests without authentication
  if (isLocalhost && !isProxied) {
    console.log('✅ Admin API: Localhost access (no auth required)');
    return {
      userId: 'localhost-admin',
      email: 'localhost@admin',
      isAdmin: true
    };
  }

  // For remote access, require Authorization header
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
    if (!JWKS) {
      throw new Error('JWKS not configured');
    }
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

/**
 * Check if admin features are enabled
 * Returns false by default - must be explicitly enabled via ADMIN_ENABLED=true
 */
export function isAdminEnabled(): boolean {
  return ADMIN_ENABLED;
}

/**
 * Check if admin is restricted to localhost only
 */
export function isAdminLocalOnly(): boolean {
  return ADMIN_LOCAL_ONLY;
}
