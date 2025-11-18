/**
 * Credit API Routes
 *
 * Express routes for credit management:
 * - GET /api/credits/balance - Get current credit balance
 * - GET /api/credits/transactions - Get transaction history
 * - GET /api/users/me - Get current user info
 */

import { Router } from 'express';
import { getBalance, getTransactions } from '../services/creditService.js';
import { getUser } from '../services/userService.js';
import { authMiddleware } from './middleware/auth.js';
import type { Request, Response } from 'express';

export const creditRouter = Router();

// Apply auth middleware to all routes
creditRouter.use(authMiddleware);

/**
 * GET /api/credits/balance
 * Get current credit balance for authenticated user
 *
 * Response:
 * {
 *   "userId": "auth0|123456",
 *   "credits": 25,
 *   "credits_purchased": 40,
 *   "credits_used": 15
 * }
 */
creditRouter.get('/balance', async (req: Request, res: Response) => {
  try {
    const userId = req.authInfo!.userId;

    const balance = await getBalance(userId);

    res.json({
      userId,
      credits: balance.credits,
      creditsPurchased: balance.credits_purchased,
      creditsUsed: balance.credits_used
    });
  } catch (error) {
    console.error('Get balance error:', error);

    if (error.message.includes('User not found')) {
      res.status(404).json({
        error: 'User not found',
        message: 'No account found for this user. Credits will be created on first purchase.'
      });
      return;
    }

    res.status(500).json({
      error: 'Failed to get balance',
      message: error.message
    });
  }
});

/**
 * GET /api/credits/transactions
 * Get transaction history for authenticated user
 *
 * Query params:
 * - limit: number (default: 50, max: 100)
 * - offset: number (default: 0)
 * - type: 'purchase' | 'deduction' | 'refund' | 'adjustment' (optional)
 *
 * Response:
 * {
 *   "transactions": [...],
 *   "total": 15,
 *   "limit": 50,
 *   "offset": 0
 * }
 */
creditRouter.get('/transactions', async (req: Request, res: Response) => {
  try {
    const userId = req.authInfo!.userId;

    // Parse query params
    let limit = parseInt(req.query.limit as string) || 50;
    let offset = parseInt(req.query.offset as string) || 0;
    const type = req.query.type as any;

    // Validate limits
    if (limit < 1) limit = 1;
    if (limit > 100) limit = 100;
    if (offset < 0) offset = 0;

    // Validate type
    const validTypes = ['purchase', 'deduction', 'refund', 'adjustment'];
    if (type && !validTypes.includes(type)) {
      res.status(400).json({
        error: 'Invalid transaction type',
        message: `Type must be one of: ${validTypes.join(', ')}`
      });
      return;
    }

    const result = await getTransactions({ userId, limit, offset, type });

    res.json({
      transactions: result.transactions,
      total: result.total,
      limit,
      offset
    });
  } catch (error) {
    console.error('Get transactions error:', error);
    res.status(500).json({
      error: 'Failed to get transactions',
      message: error.message
    });
  }
});

/**
 * GET /api/users/me
 * Get current user info including credit balance
 *
 * Response:
 * {
 *   "userId": "auth0|123456",
 *   "email": "user@example.com",
 *   "credits": 25,
 *   "creditsPurchased": 40,
 *   "creditsUsed": 15,
 *   "createdAt": "2025-01-14T12:00:00Z"
 * }
 */
creditRouter.get('/users/me', async (req: Request, res: Response) => {
  try {
    const userId = req.authInfo!.userId;

    const user = await getUser(userId);

    res.json({
      userId: user.user_id,
      email: user.email,
      credits: user.credits,
      creditsPurchased: user.credits_purchased,
      creditsUsed: user.credits_used,
      createdAt: user.created_at
    });
  } catch (error) {
    console.error('Get user error:', error);

    if (error.message.includes('User not found')) {
      res.status(404).json({
        error: 'User not found',
        message: 'No account found. Account will be created on first purchase.'
      });
      return;
    }

    res.status(500).json({
      error: 'Failed to get user info',
      message: error.message
    });
  }
});
