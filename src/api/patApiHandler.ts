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
import { readRequestBody, JSON_API_BODY_LIMIT_BYTES } from '../utils/requestBody.js';
import { validateAuthorizationHeader, type AuthenticatedUser } from '../auth/tokenValidator.js';
import { BetaAccessDeniedError, BETA_ACCESS_MESSAGE } from '../auth/betaAccess.js';
import { createToken, listTokens, revokeToken } from '../services/patService.js';
import { classifyDiagnosticError, writeDiagnostic } from '../utils/diagnosticLog.js';

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
  // Bounded. This previously accumulated without a cap, which on a public
  // route is a memory-exhaustion denial of service (#157). readRequestBody
  // also decodes once at the end, so a multi-byte character split across two
  // chunks is no longer corrupted into replacement characters.
  const body = await readRequestBody(req, { limitBytes: JSON_API_BODY_LIMIT_BYTES });
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    // A RequestBodyTooLargeError from above propagates with its own 413 rather
    // than being flattened into this parse error.
    throw new Error('Invalid JSON body');
  }
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
    // A refused beta account authenticated correctly, so it gets 403 and no
    // invitation to retry.
    if (error instanceof BetaAccessDeniedError) {
      sendJson(res, 403, {
        error: 'Forbidden',
        message: BETA_ACCESS_MESSAGE,
      });
      return true;
    }
    sendJson(res, 401, {
      error: 'Unauthorized',
      message: 'Authentication failed',
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
    writeDiagnostic('error', 'auth.pat_api_failed', {
      errorClass: classifyDiagnosticError(error, 'database_error')
    });
    sendJson(res, 500, {
      error: 'Internal Server Error',
      message: 'Unable to complete token request',
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
