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
 * All operations use database transactions for atomicity.
 *
 * This service now uses the credit ledger for tracking individual credit
 * batches with expiration. The users.credits field is maintained as a
 * cache for quick balance checks.
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
  TransactionHistoryResult,
  CreditBalanceDetailed,
  CreditLedgerOperationResult,
  AddCreditsToLedgerParams,
} from './types.js';
import {
  addCreditsToLedger,
  deductCreditsFromLedger,
  refundCreditsToLedger,
  getDetailedBalance as getLedgerDetailedBalance,
  getAvailableCredits,
  hasSufficientCredits as ledgerHasSufficientCredits,
} from './creditLedgerService.js';

// Default expiration for purchased credits (2 years)
const DEFAULT_PURCHASE_EXPIRATION_DAYS = 730;

/**
 * Add credits to user account (from purchase)
 *
 * - Creates user if doesn't exist
 * - Adds credits to balance
 * - Creates ledger entry with expiration
 * - Increments lifetime credits_purchased
 * - Records transaction in audit trail
 * - All operations are atomic (uses transaction)
 *
 * @throws Error if credits <= 0
 */
export async function addCredits(params: AddCreditsParams): Promise<CreditOperationResult> {
  const { userId, email, credits, orderId, description } = params;

  // Use ledger service with purchase defaults
  const result = await addCreditsToLedger({
    userId,
    email,
    credits,
    sourceType: 'purchase',
    sourceReferenceId: orderId,
    expirationDays: DEFAULT_PURCHASE_EXPIRATION_DAYS,
    description: description || `Purchased ${credits} credits`,
  });

  return {
    user: result.user,
    transaction: result.transaction,
  };
}

/**
 * Add credits with full ledger options
 *
 * Use this when you need control over expiration policy, source type, etc.
 */
export async function addCreditsWithOptions(
  params: AddCreditsToLedgerParams
): Promise<CreditLedgerOperationResult> {
  return await addCreditsToLedger(params);
}

/**
 * Deduct credits from user account (for sending letter)
 *
 * Uses FIFO with expiration priority:
 * 1. Credits expiring soonest first
 * 2. Within same expiration, oldest first
 * 3. Never-expiring credits last
 *
 * - Checks balance is sufficient (throws if not)
 * - Locks user row to prevent race conditions
 * - Deducts credits from balance and ledger
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

  // Use ledger service for FIFO consumption
  const result = await deductCreditsFromLedger({
    userId,
    credits,
    letterId,
    description,
  });

  return {
    user: result.user,
    transaction: result.transaction,
  };
}

/**
 * Deduct credits with consumption details
 *
 * Returns information about which ledger entries were consumed.
 */
export async function deductCreditsWithDetails(
  params: DeductCreditsParams
): Promise<CreditLedgerOperationResult> {
  return await deductCreditsFromLedger({
    userId: params.userId,
    credits: params.credits,
    letterId: params.letterId,
    description: params.description,
  });
}

/**
 * Refund credits to user (from cancelled order)
 *
 * - Creates new ledger entry for refunded credits
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

  // Use ledger service for refund
  const result = await refundCreditsToLedger({
    userId,
    credits,
    orderId,
    reason,
    // Refunded credits don't expire by default
    newExpirationDays: undefined,
  });

  return {
    user: result.user,
    transaction: result.transaction,
  };
}

/**
 * Get current credit balance for user
 *
 * Returns the cached balance from users table.
 * For detailed breakdown with expiration info, use getDetailedBalance().
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
 * Get detailed credit balance with expiration breakdown
 *
 * Includes:
 * - Total available credits
 * - Credits expiring in next 30 days
 * - Breakdown by expiration date
 * - Breakdown by source type
 */
export async function getDetailedBalance(userId: string): Promise<CreditBalanceDetailed> {
  return await getLedgerDetailedBalance(userId);
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
  const queryParams: (string | number)[] = [userId];

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
 * Checks the ledger for non-expired credits.
 * Returns true if user exists and has enough credits, false otherwise.
 */
export async function hasSufficientCredits(userId: string, creditsRequired: number): Promise<boolean> {
  return await ledgerHasSufficientCredits(userId, creditsRequired);
}

/**
 * Manual credit adjustment (admin only)
 *
 * - Can add or remove credits
 * - Records as 'adjustment' type transaction
 * - Use positive amount to add, negative to remove
 * - For positive adjustments, creates a ledger entry (never expires by default)
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

  if (amount > 0) {
    // Positive adjustment: add credits via ledger
    const result = await addCreditsToLedger({
      userId,
      credits: amount,
      sourceType: 'adjustment',
      description: reason,
      // Adjustments don't expire by default
      expirationPolicy: 'never',
    });

    return {
      user: result.user,
      transaction: result.transaction,
    };
  } else {
    // Negative adjustment: deduct credits
    // Note: This uses the legacy method since we're removing credits
    // and don't have a specific letter to reference
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

      // For negative adjustments, we need to update the ledger entries too
      // Consume from ledger in FIFO order
      let remainingToDeduct = Math.abs(amount);

      const ledgerResult = await client.query<{ ledger_id: string; remaining_amount: number }>(
        `SELECT ledger_id, remaining_amount FROM credit_ledger
         WHERE user_id = $1
           AND status = 'active'
           AND remaining_amount > 0
           AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY expires_at NULLS LAST, created_at ASC
         FOR UPDATE`,
        [userId]
      );

      for (const entry of ledgerResult.rows) {
        if (remainingToDeduct <= 0) break;

        const amountToTake = Math.min(remainingToDeduct, entry.remaining_amount);
        const newRemaining = entry.remaining_amount - amountToTake;

        await client.query(
          `UPDATE credit_ledger
           SET remaining_amount = $1,
               status = CASE WHEN $1 = 0 THEN 'depleted'::credit_ledger_status ELSE status END,
               updated_at = NOW()
           WHERE ledger_id = $2`,
          [newRemaining, entry.ledger_id]
        );

        remainingToDeduct -= amountToTake;
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
}

// Re-export ledger functions for direct access when needed
export {
  getAvailableCredits,
  getDetailedBalance as getBalanceFromLedger,
} from './creditLedgerService.js';
