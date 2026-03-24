/**
 * Personal Access Token (PAT) API Request Handler
 *
 * Handles PAT management routes:
 * - POST /api/tokens   - Create new token (JWT only)
 * - GET /api/tokens    - List user's tokens
 * - DELETE /api/tokens/:id - Revoke token (JWT only)
 *
 * User Stories:
 * - US-MCP-01: Generate Personal Access Token
 * - US-MCP-02: Revoke Personal Access Token
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { validateAuthorizationHeader, type AuthenticatedUser } from '../auth/tokenValidator.js';
import { createToken, listTokens, revokeToken } from '../services/patService.js';

/**
 * Send JSON response
 */
function sendJson(res: ServerResponse, statusCode: number, data: unknown) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

/**
 * Read request body as JSON
 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Handle PAT API requests
 * Returns true if request was handled, false if should continue to next handler
 */
export async function handlePATApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
): Promise<boolean> {
  // Check if this is a PAT API route
  if (!pathname.startsWith('/api/tokens')) {
    return false;
  }

  // Authenticate request (supports both JWT and PAT)
  let authInfo: AuthenticatedUser;
  try {
    authInfo = await validateAuthorizationHeader(req.headers.authorization);
  } catch (error) {
    sendJson(res, 401, {
      error: 'Unauthorized',
      message: error instanceof Error ? error.message : 'Authentication failed',
    });
    return true;
  }

  // Route handlers
  try {
    // POST /api/tokens - Create new token (JWT only)
    if (pathname === '/api/tokens' && req.method === 'POST') {
      // Security: Only allow token creation via JWT auth (not PAT)
      if (authInfo.authType === 'pat') {
        sendJson(res, 403, {
          error: 'Forbidden',
          message: 'Cannot create tokens using PAT authentication. Use OAuth/JWT to create new tokens.',
        });
        return true;
      }

      await handleCreateToken(req, res, authInfo);
      return true;
    }

    // GET /api/tokens - List tokens
    if (pathname === '/api/tokens' && req.method === 'GET') {
      await handleListTokens(res, authInfo);
      return true;
    }

    // DELETE /api/tokens/:id - Revoke token (JWT only)
    const deleteMatch = pathname.match(/^\/api\/tokens\/(\d+)$/);
    if (deleteMatch && req.method === 'DELETE') {
      // Security: Only allow token revocation via JWT auth (not PAT)
      if (authInfo.authType === 'pat') {
        sendJson(res, 403, {
          error: 'Forbidden',
          message: 'Cannot revoke tokens using PAT authentication. Use OAuth/JWT to revoke tokens.',
        });
        return true;
      }

      const tokenId = parseInt(deleteMatch[1], 10);
      await handleRevokeToken(res, authInfo, tokenId);
      return true;
    }

    // Unknown route under /api/tokens
    sendJson(res, 404, { error: 'Not found' });
    return true;
  } catch (error) {
    console.error('🔑 PAT API error:', error);
    sendJson(res, 500, {
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
    return true;
  }
}

/**
 * POST /api/tokens - Create new Personal Access Token
 */
async function handleCreateToken(
  req: IncomingMessage,
  res: ServerResponse,
  authInfo: AuthenticatedUser
): Promise<void> {
  const body = await readJsonBody(req);

  // Validate name
  const name = body.name;
  if (typeof name !== 'string' || name.length < 1 || name.length > 100) {
    sendJson(res, 400, {
      error: 'Bad Request',
      message: 'Token name is required and must be 1-100 characters',
    });
    return;
  }

  // Optional expiration
  let expiresAt: Date | undefined;
  if (body.expiresAt) {
    expiresAt = new Date(body.expiresAt as string);
    if (isNaN(expiresAt.getTime())) {
      sendJson(res, 400, {
        error: 'Bad Request',
        message: 'Invalid expiresAt date format',
      });
      return;
    }
  }

  const result = await createToken(authInfo.userId, name, { expiresAt });

  sendJson(res, 201, {
    token: result.token,  // Raw token - shown once!
    tokenId: result.tokenId,
    name: result.name,
    expiresAt: result.expiresAt,
    message: 'Token created successfully. Save this token now - you will not be able to see it again.',
  });
}

/**
 * GET /api/tokens - List user's tokens
 */
async function handleListTokens(
  res: ServerResponse,
  authInfo: AuthenticatedUser
): Promise<void> {
  const tokens = await listTokens(authInfo.userId, { includeRevoked: true });

  sendJson(res, 200, {
    tokens,
    total: tokens.length,
  });
}

/**
 * DELETE /api/tokens/:id - Revoke a token
 */
async function handleRevokeToken(
  res: ServerResponse,
  authInfo: AuthenticatedUser,
  tokenId: number
): Promise<void> {
  try {
    const result = await revokeToken(authInfo.userId, tokenId);

    sendJson(res, 200, {
      success: true,
      message: result.alreadyRevoked ? 'Token was already revoked' : 'Token revoked successfully',
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('not found')) {
      sendJson(res, 404, {
        error: 'Not Found',
        message: 'Token not found or does not belong to you',
      });
      return;
    }
    throw error;
  }
}
