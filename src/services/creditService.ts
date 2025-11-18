/**
 * Credit Service
 *
 * Handles all credit-related operations:
 * - Add credits (from purchases)
 * - Deduct credits (for letter sending)
 * - Check balance
 * - Transaction history
 * - Refunds
 *
 * All operations use database transactions for atomicity
 */

import { transaction, query } from '../db/index.js';
import {
  User,
  CreditTransaction,
  AddCreditsParams,
  DeductCreditsParams,
  RefundCreditsParams,
  GetTransactionsParams,
  CreditBalance,
  CreditOperationResult,
  TransactionHistoryResult
} from './types.js';

/**
 * Add credits to user account (from purchase)
 *
 * - Creates user if doesn't exist
 * - Adds credits to balance
 * - Increments lifetime credits_purchased
 * - Records transaction in audit trail
 * - All operations are atomic (uses transaction)
 *
 * @throws Error if credits <= 0
 */
export async function addCredits(params: AddCreditsParams): Promise<CreditOperationResult> {
  const { userId, email, credits, orderId, description } = params;

  if (credits <= 0) {
    throw new Error('Credits must be positive');
  }

  return await transaction(async (client) => {
    // Insert or update user (UPSERT)
    const userResult = await client.query<User>(
      `INSERT INTO users (user_id, email, credits, credits_purchased, credits_used)
       VALUES ($1, $2, $3, $3, 0)
       ON CONFLICT (user_id) DO UPDATE
       SET credits = users.credits + $3,
           credits_purchased = users.credits_purchased + $3,
           updated_at = NOW()
       RETURNING *`,
      [userId, email, credits]
    );

    const user = userResult.rows[0];

    // Record transaction
    const txResult = await client.query<CreditTransaction>(
      `INSERT INTO credit_transactions (
        user_id, amount, balance_after, type, reference_type, reference_id, description
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *`,
      [
        userId,
        credits,
        user.credits,
        'purchase',
        'order',
        orderId,
        description || `Purchased ${credits} credits`
      ]
    );

    const txn = txResult.rows[0];

    console.log(`💳 Added ${credits} credits to ${userId} (order: ${orderId}), new balance: ${user.credits}`);

    return { user, transaction: txn };
  });
}

/**
 * Deduct credits from user account (for sending letter)
 *
 * - Checks balance is sufficient (throws if not)
 * - Locks user row to prevent race conditions
 * - Deducts credits from balance
 * - Increments lifetime credits_used
 * - Records transaction in audit trail
 * - All operations are atomic (uses transaction)
 *
 * @throws Error if insufficient credits
 * @throws Error if user not found
 * @throws Error if credits <= 0
 */
export async function deductCredits(params: DeductCreditsParams): Promise<CreditOperationResult> {
  const { userId, credits, letterId, description } = params;

  if (credits <= 0) {
    throw new Error('Credits must be positive');
  }

  return await transaction(async (client) => {
    // Lock user row and get current balance
    const userResult = await client.query<User>(
      'SELECT * FROM users WHERE user_id = $1 FOR UPDATE',
      [userId]
    );

    if (userResult.rows.length === 0) {
      throw new Error(`User not found: ${userId}`);
    }

    const user = userResult.rows[0];

    // Check sufficient balance
    if (user.credits < credits) {
      throw new Error(
        `Insufficient credits. Required: ${credits}, Available: ${user.credits}`
      );
    }

    // Deduct credits
    const updateResult = await client.query<User>(
      `UPDATE users
       SET credits = credits - $1,
           credits_used = credits_used + $1,
           updated_at = NOW()
       WHERE user_id = $2
       RETURNING *`,
      [credits, userId]
    );

    const updatedUser = updateResult.rows[0];

    // Record transaction (negative amount for deduction)
    const txResult = await client.query<CreditTransaction>(
      `INSERT INTO credit_transactions (
        user_id, amount, balance_after, type, reference_type, reference_id, description
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *`,
      [
        userId,
        -credits, // Negative for deduction
        updatedUser.credits,
        'deduction',
        'letter',
        letterId,
        description || `Sent letter (${credits} credits)`
      ]
    );

    const txn = txResult.rows[0];

    console.log(`📤 Deducted ${credits} credits from ${userId} (letter: ${letterId}), new balance: ${updatedUser.credits}`);

    return { user: updatedUser, transaction: txn };
  });
}

/**
 * Refund credits to user (from cancelled order)
 *
 * - Adds credits back to balance
 * - Decrements lifetime credits_purchased
 * - Records refund transaction
 * - All operations are atomic (uses transaction)
 *
 * @throws Error if user not found
 * @throws Error if credits <= 0
 */
export async function refundCredits(params: RefundCreditsParams): Promise<CreditOperationResult> {
  const { userId, credits, orderId, reason } = params;

  if (credits <= 0) {
    throw new Error('Credits must be positive');
  }

  return await transaction(async (client) => {
    // Add credits back
    const userResult = await client.query<User>(
      `UPDATE users
       SET credits = credits + $1,
           credits_purchased = credits_purchased - $1,
           updated_at = NOW()
       WHERE user_id = $2
       RETURNING *`,
      [credits, userId]
    );

    if (userResult.rows.length === 0) {
      throw new Error(`User not found: ${userId}`);
    }

    const user = userResult.rows[0];

    // Record refund transaction
    const txResult = await client.query<CreditTransaction>(
      `INSERT INTO credit_transactions (
        user_id, amount, balance_after, type, reference_type, reference_id, description
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *`,
      [
        userId,
        credits,
        user.credits,
        'refund',
        'order',
        orderId,
        reason || `Refunded ${credits} credits`
      ]
    );

    const txn = txResult.rows[0];

    console.log(`💸 Refunded ${credits} credits to ${userId} (order: ${orderId}), new balance: ${user.credits}`);

    return { user, transaction: txn };
  });
}

/**
 * Get current credit balance for user
 *
 * @throws Error if user not found
 */
export async function getBalance(userId: string): Promise<CreditBalance> {
  const result = await query<User>(
    'SELECT credits, credits_purchased, credits_used FROM users WHERE user_id = $1',
    [userId]
  );

  if (result.rows.length === 0) {
    throw new Error(`User not found: ${userId}`);
  }

  const user = result.rows[0];

  return {
    credits: user.credits,
    credits_purchased: user.credits_purchased,
    credits_used: user.credits_used
  };
}

/**
 * Get transaction history for user
 *
 * - Returns paginated results
 * - Can filter by transaction type
 * - Ordered by newest first
 */
export async function getTransactions(params: GetTransactionsParams): Promise<TransactionHistoryResult> {
  const { userId, limit = 50, offset = 0, type } = params;

  // Build WHERE clause
  let whereClause = 'WHERE user_id = $1';
  const queryParams: any[] = [userId];

  if (type) {
    whereClause += ' AND type = $2';
    queryParams.push(type);
  }

  // Get transactions
  const result = await query<CreditTransaction>(
    `SELECT * FROM credit_transactions
     ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${queryParams.length + 1}
     OFFSET $${queryParams.length + 2}`,
    [...queryParams, limit, offset]
  );

  // Get total count
  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM credit_transactions ${whereClause}`,
    queryParams
  );

  return {
    transactions: result.rows,
    total: parseInt(countResult.rows[0].count)
  };
}

/**
 * Check if user has sufficient credits
 *
 * Returns true if user exists and has enough credits, false otherwise
 */
export async function hasSufficientCredits(userId: string, creditsRequired: number): Promise<boolean> {
  try {
    const balance = await getBalance(userId);
    return balance.credits >= creditsRequired;
  } catch (error) {
    // User not found
    return false;
  }
}

/**
 * Manual credit adjustment (admin only)
 *
 * - Can add or remove credits
 * - Records as 'adjustment' type transaction
 * - Use positive amount to add, negative to remove
 *
 * @throws Error if user not found
 */
export async function adjustCredits(
  userId: string,
  amount: number,
  reason: string
): Promise<CreditOperationResult> {
  if (amount === 0) {
    throw new Error('Adjustment amount cannot be zero');
  }

  return await transaction(async (client) => {
    // Update balance
    const userResult = await client.query<User>(
      `UPDATE users
       SET credits = credits + $1,
           updated_at = NOW()
       WHERE user_id = $2
       RETURNING *`,
      [amount, userId]
    );

    if (userResult.rows.length === 0) {
      throw new Error(`User not found: ${userId}`);
    }

    const user = userResult.rows[0];

    // Ensure balance doesn't go negative
    if (user.credits < 0) {
      throw new Error(`Cannot adjust credits: would result in negative balance`);
    }

    // Record transaction
    const txResult = await client.query<CreditTransaction>(
      `INSERT INTO credit_transactions (
        user_id, amount, balance_after, type, reference_type, reference_id, description
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *`,
      [
        userId,
        amount,
        user.credits,
        'adjustment',
        'manual',
        null,
        reason
      ]
    );

    const txn = txResult.rows[0];

    console.log(`🔧 Adjusted ${amount} credits for ${userId}: ${reason}, new balance: ${user.credits}`);

    return { user, transaction: txn };
  });
}
