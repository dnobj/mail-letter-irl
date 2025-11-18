/**
 * Credit API Request Handler
 *
 * Handles Credit API routes for the raw Node.js HTTP server
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { jwtVerify, createRemoteJWKSet } from 'jose';
import { getBalance, getTransactions } from '../services/creditService.js';
import { getUser } from '../services/userService.js';

// Create JWKS client for Auth0
const JWKS = createRemoteJWKSet(
  new URL(process.env.LETTER_IRL_OAUTH_JWKS_URI!)
);

interface AuthInfo {
  userId: string;
  email?: string;
}

/**
 * Authenticate request and extract user info from JWT
 */
async function authenticateRequest(req: IncomingMessage): Promise<AuthInfo | null> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.substring(7);

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: process.env.LETTER_IRL_OAUTH_ISSUER,
      audience: process.env.LETTER_IRL_OAUTH_AUDIENCE
    });

    return {
      userId: payload.sub!,
      email: payload.email as string | undefined
    };
  } catch (error) {
    console.error('JWT validation failed:', error);
    return null;
  }
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
 * Handle Credit API requests
 * Returns true if request was handled, false if should continue to next handler
 */
export async function handleCreditApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
): Promise<boolean> {
  // Check if this is a credit API route
  if (!pathname.startsWith('/api/credits') && !pathname.startsWith('/api/users/me')) {
    return false; // Not a credit API route, continue to next handler
  }

  // Authenticate request
  const authInfo = await authenticateRequest(req);
  if (!authInfo) {
    sendJson(res, 401, {
      error: 'Unauthorized',
      message: 'Missing or invalid Authorization header'
    });
    return true;
  }

  // Route handlers
  try {
    // GET /api/credits/balance
    if (pathname === '/api/credits/balance' && req.method === 'GET') {
      await handleGetBalance(res, authInfo);
      return true;
    }

    // GET /api/credits/transactions
    if (pathname === '/api/credits/transactions' && req.method === 'GET') {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      await handleGetTransactions(res, authInfo, url.searchParams);
      return true;
    }

    // GET /api/users/me
    if (pathname === '/api/users/me' && req.method === 'GET') {
      await handleGetUser(res, authInfo);
      return true;
    }

    // Route not found
    sendJson(res, 404, {
      error: 'Not found',
      message: `Route not found: ${req.method} ${pathname}`
    });
    return true;

  } catch (error) {
    console.error('Credit API error:', error);
    sendJson(res, 500, {
      error: 'Internal server error',
      message: error.message
    });
    return true;
  }
}

/**
 * GET /api/credits/balance
 */
async function handleGetBalance(res: ServerResponse, authInfo: AuthInfo) {
  try {
    const balance = await getBalance(authInfo.userId);

    sendJson(res, 200, {
      userId: authInfo.userId,
      credits: balance.credits,
      creditsPurchased: balance.credits_purchased,
      creditsUsed: balance.credits_used
    });
  } catch (error) {
    if (error.message.includes('User not found')) {
      sendJson(res, 404, {
        error: 'User not found',
        message: 'No account found for this user. Credits will be created on first purchase.'
      });
    } else {
      throw error;
    }
  }
}

/**
 * GET /api/credits/transactions
 */
async function handleGetTransactions(
  res: ServerResponse,
  authInfo: AuthInfo,
  queryParams: URLSearchParams
) {
  let limit = parseInt(queryParams.get('limit') || '50');
  let offset = parseInt(queryParams.get('offset') || '0');
  const type = queryParams.get('type') as any;

  // Validate limits
  if (limit < 1) limit = 1;
  if (limit > 100) limit = 100;
  if (offset < 0) offset = 0;

  // Validate type
  const validTypes = ['purchase', 'deduction', 'refund', 'adjustment'];
  if (type && !validTypes.includes(type)) {
    sendJson(res, 400, {
      error: 'Invalid transaction type',
      message: `Type must be one of: ${validTypes.join(', ')}`
    });
    return;
  }

  const result = await getTransactions({
    userId: authInfo.userId,
    limit,
    offset,
    type
  });

  sendJson(res, 200, {
    transactions: result.transactions,
    total: result.total,
    limit,
    offset
  });
}

/**
 * GET /api/users/me
 */
async function handleGetUser(res: ServerResponse, authInfo: AuthInfo) {
  try {
    const user = await getUser(authInfo.userId);

    sendJson(res, 200, {
      userId: user.user_id,
      email: user.email,
      credits: user.credits,
      creditsPurchased: user.credits_purchased,
      creditsUsed: user.credits_used,
      createdAt: user.created_at
    });
  } catch (error) {
    if (error.message.includes('User not found')) {
      sendJson(res, 404, {
        error: 'User not found',
        message: 'No account found. Account will be created on first purchase.'
      });
    } else {
      throw error;
    }
  }
}
