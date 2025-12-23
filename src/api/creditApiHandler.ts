/**
 * Credit API Request Handler
 *
 * Handles Credit API routes for the raw Node.js HTTP server
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { jwtVerify, createRemoteJWKSet } from 'jose';
import { getBalance, getTransactions, getDetailedBalance } from '../services/creditService.js';
import { getUser } from '../services/userService.js';
import { validatePromoCode, redeemPromoCode, getUserRedemptions } from '../services/promoService.js';
import { getLedgerEntries } from '../services/creditLedgerService.js';

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
  if (!pathname.startsWith('/api/credits') && !pathname.startsWith('/api/users/me') && !pathname.startsWith('/api/promo')) {
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

    // GET /api/credits/balance/detailed
    if (pathname === '/api/credits/balance/detailed' && req.method === 'GET') {
      await handleGetDetailedBalance(res, authInfo);
      return true;
    }

    // GET /api/credits/ledger
    if (pathname === '/api/credits/ledger' && req.method === 'GET') {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      await handleGetLedgerEntries(res, authInfo, url.searchParams);
      return true;
    }

    // POST /api/promo/redeem
    if (pathname === '/api/promo/redeem' && req.method === 'POST') {
      await handleRedeemPromo(req, res, authInfo);
      return true;
    }

    // GET /api/promo/validate/:code
    if (pathname.startsWith('/api/promo/validate/') && req.method === 'GET') {
      const code = pathname.split('/').pop();
      if (code) {
        await handleValidatePromo(res, authInfo, decodeURIComponent(code));
        return true;
      }
    }

    // GET /api/promo/redemptions
    if (pathname === '/api/promo/redemptions' && req.method === 'GET') {
      await handleGetUserRedemptions(res, authInfo);
      return true;
    }

    // Route not found
    sendJson(res, 404, {
      error: 'Not found',
      message: `Route not found: ${req.method} ${pathname}`
    });
    return true;

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    console.error('Credit API error:', errorMessage);
    if (errorStack) {
      console.error('Stack trace:', errorStack);
    }
    sendJson(res, 500, {
      error: 'Internal server error',
      message: errorMessage
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
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('User not found')) {
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
  let limit = parseInt(queryParams.get('limit') || '50', 10);
  let offset = parseInt(queryParams.get('offset') || '0', 10);
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
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('User not found')) {
      sendJson(res, 404, {
        error: 'User not found',
        message: 'No account found. Account will be created on first purchase.'
      });
    } else {
      throw error;
    }
  }
}

/**
 * GET /api/credits/balance/detailed
 */
async function handleGetDetailedBalance(res: ServerResponse, authInfo: AuthInfo) {
  try {
    const balance = await getDetailedBalance(authInfo.userId);

    sendJson(res, 200, {
      userId: authInfo.userId,
      totalAvailable: balance.totalAvailable,
      expiringSoon: balance.expiringSoon,
      neverExpiring: balance.neverExpiring,
      expiringDates: balance.expiringDates.map(b => ({
        expiresAt: b.expiresAt,
        credits: b.credits
      })),
      bySource: balance.bySource
    });
  } catch (error: unknown) {
    // Return empty balance for new users
    sendJson(res, 200, {
      userId: authInfo.userId,
      totalAvailable: 0,
      expiringSoon: 0,
      neverExpiring: 0,
      expiringDates: [],
      bySource: []
    });
  }
}

/**
 * GET /api/credits/ledger
 */
async function handleGetLedgerEntries(
  res: ServerResponse,
  authInfo: AuthInfo,
  queryParams: URLSearchParams
) {
  const limit = Math.min(parseInt(queryParams.get('limit') || '50', 10), 100);
  const offset = Math.max(parseInt(queryParams.get('offset') || '0', 10), 0);
  const includeExpired = queryParams.get('includeExpired') === 'true';

  const result = await getLedgerEntries({
    userId: authInfo.userId,
    includeExpired,
    limit,
    offset
  });

  sendJson(res, 200, {
    entries: result.entries.map(e => ({
      ledgerId: e.ledger_id,
      initialAmount: e.initial_amount,
      remainingAmount: e.remaining_amount,
      sourceType: e.source_type,
      sourceReferenceId: e.source_reference_id,
      activatedAt: e.activated_at,
      expiresAt: e.expires_at,
      status: e.status,
      description: e.description,
      createdAt: e.created_at
    })),
    total: result.total,
    limit,
    offset
  });
}

/**
 * Parse JSON body from request
 */
async function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * POST /api/promo/redeem
 */
async function handleRedeemPromo(
  req: IncomingMessage,
  res: ServerResponse,
  authInfo: AuthInfo
) {
  const body = await parseBody(req);

  if (!body.code) {
    sendJson(res, 400, {
      error: 'Missing required field: code'
    });
    return;
  }

  const result = await redeemPromoCode({
    userId: authInfo.userId,
    email: authInfo.email,
    promoCode: body.code
  });

  if (result.success) {
    sendJson(res, 200, {
      success: true,
      credits: result.credits,
      expiresAt: result.expiresAt,
      message: `Successfully redeemed ${result.credits} credits!`
    });
  } else {
    sendJson(res, 400, {
      success: false,
      error: result.error
    });
  }
}

/**
 * GET /api/promo/validate/:code
 */
async function handleValidatePromo(
  res: ServerResponse,
  authInfo: AuthInfo,
  code: string
) {
  const result = await validatePromoCode(code, authInfo.userId);

  if (result.valid && result.campaign) {
    sendJson(res, 200, {
      valid: true,
      code: result.campaign.code,
      name: result.campaign.name,
      credits: result.campaign.credits_amount,
      expirationDays: result.campaign.expiration_days,
      message: `This code gives you ${result.campaign.credits_amount} credits!`
    });
  } else {
    sendJson(res, 200, {
      valid: false,
      reason: result.reason
    });
  }
}

/**
 * GET /api/promo/redemptions
 */
async function handleGetUserRedemptions(res: ServerResponse, authInfo: AuthInfo) {
  const redemptions = await getUserRedemptions(authInfo.userId);

  sendJson(res, 200, {
    redemptions: redemptions.map(r => ({
      redemptionId: r.redemption.redemption_id,
      campaignCode: r.campaign.code,
      campaignName: r.campaign.name,
      credits: r.campaign.credits_amount,
      redeemedAt: r.redemption.redeemed_at
    }))
  });
}
