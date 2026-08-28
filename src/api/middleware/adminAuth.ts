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

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { validateJWTToken } from '../../auth/tokenValidator.js';
import { classifyDiagnosticError, writeDiagnostic } from '../../utils/diagnosticLog.js';

// Admin feature flags
// ADMIN_ENABLED: Must be 'true' to enable admin routes (disabled by default)
// ADMIN_LOCAL_ONLY: If 'true', only localhost can access admin routes
const ADMIN_ENABLED = process.env.ADMIN_ENABLED === 'true';
const ADMIN_LOCAL_ONLY = process.env.ADMIN_LOCAL_ONLY === 'true';

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

  // Localhost is a network boundary, not an identity. Authentication and
  // allow-list attribution remain mandatory below.
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
    // Issue #209: validate through the shared validator so the accepted
    // audience set has one source of truth. This was the fifth copy of a raw
    // single-value audience check; the operator interface (#162) would have
    // rejected every website-audience token the moment it authenticated one.
    const user = await validateJWTToken(token);
    userId = user.userId;
    email = typeof user.claims.email === 'string' ? user.claims.email : undefined;
  } catch (error) {
    writeDiagnostic('error', 'auth.admin_validation_failed', {
      errorClass: classifyDiagnosticError(error, 'authorization_error')
    });
    sendJson(res, 401, {
      error: 'Unauthorized',
      message: 'Invalid or expired token'
    });
    return null;
  }

  // Check if user is admin
  const isAdmin = ADMIN_USER_IDS.includes(userId);

  if (!isAdmin) {
    writeDiagnostic('warn', 'auth.admin_access_denied');
    sendJson(res, 403, {
      error: 'Forbidden',
      message: 'Admin access required. Contact administrator for access.'
    });
    return null;
  }

  writeDiagnostic('info', 'auth.admin_authenticated');

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

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Fail-closed browser/readback and CSRF boundary for the temporary local API. */
export function validateAdminRequestBoundary(req: IncomingMessage, res: ServerResponse): boolean {
  const allowedOrigin = process.env.ADMIN_ALLOWED_ORIGIN;
  const csrfSecret = process.env.ADMIN_CSRF_TOKEN;
  if (process.env.ADMIN_LOCAL_ONLY !== 'true' || !allowedOrigin || !csrfSecret) {
    sendJson(res, 404, { error: 'Not found' });
    return false;
  }
  let expected: URL;
  try {
    expected = new URL(allowedOrigin);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
    return false;
  }
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '');
  const forwarded = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['ngrok-agent-ips'];
  const origin = req.headers.origin;
  const fetchSite = req.headers['sec-fetch-site'];
  if (!local || forwarded || req.headers.host !== expected.host ||
      (origin !== undefined && origin !== allowedOrigin) ||
      (fetchSite !== undefined && !['same-origin', 'none'].includes(String(fetchSite)))) {
    sendJson(res, 404, { error: 'Not found' });
    return false;
  }
  if (req.method === 'OPTIONS' || req.headers['x-letter-irl-admin'] !== 'local-operator') {
    sendJson(res, 403, { error: 'Forbidden' });
    return false;
  }
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method || '')) {
    const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim();
    const supplied = String(req.headers['x-csrf-token'] || '');
    if (contentType !== 'application/json' || !supplied || !equalSecret(supplied, csrfSecret)) {
      sendJson(res, 403, { error: 'Forbidden' });
      return false;
    }
  }
  return true;
}
