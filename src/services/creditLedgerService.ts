/**
 * Credit Ledger Service
 *
 * Handles serialized credit operations with expiration support:
 * - Add credits with source type and expiration
 * - Deduct credits using FIFO with expiration priority
 * - Query detailed balance with expiration breakdown
 * - Mark expired entries
 *
 * This service works alongside creditService.ts, which maintains
 * backward compatibility with the existing API.
 */

import { transaction, query } from '../db/index.js';
import type pg from 'pg';
import { writeDiagnostic } from '../utils/diagnosticLog.js';
import { lockAccountForBalanceChange } from './accountLock.js';
import {
  User,
  CreditTransaction,
  CreditLedgerEntry,
  CreditConsumption,
  AddCreditsToLedgerParams,
  DeductCreditsFromLedgerParams,
  RefundCreditsToLedgerParams,
  GetLedgerEntriesParams,
  CreditBalanceDetailed,
  CreditLedgerOperationResult,
  LedgerEntriesResult,
  ExpiringBucket,
  SourceBreakdown,
  CreditSourceType,
} from './types.js';

// Default expiration days by source type
const DEFAULT_EXPIRATION_DAYS: Record<CreditSourceType, number | null> = {
  purchase: 730,      // 2 years
  signup_bonus: 30,   // 1 month
  promo: 90,          // 3 months (overridden by campaign settings)
  adjustment: null,   // Never expires
  refund: null,       // Never expires (or inherit from original)
  legacy: null,       // Never expires
};

/**
 * Add credits to user's ledger
 *
 * Creates a new ledger entry with the specified source type and expiration.
 * Also updates the users.credits cache and records a transaction.
 *
 * @throws Error if credits <= 0
 */
export async function addCreditsToLedger(
  params: AddCreditsToLedgerParams
): Promise<CreditLedgerOperationResult> {
  const {
    userId,
    email,
    credits,
    sourceType,
    sourceReferenceId,
    sourceOrderId,
    sourceMetadata,
    expirationPolicy,
    expiresAt,
    expirationDays,
    description,
  } = params;

  if (credits <= 0) {
    throw new Error('Credits must be positive');
  }

  // Determine expiration
  let finalExpiresAt: Date | null = null;
  let finalExpirationPolicy = expirationPolicy || 'days_from_activation';
  let finalExpirationDays = expirationDays;

  if (expiresAt) {
    // Fixed date provided
    finalExpiresAt = expiresAt;
    finalExpirationPolicy = 'fixed_date';
  } else if (expirationDays !== undefined) {
    // Days from activation provided
    finalExpiresAt = new Date();
    finalExpiresAt.setDate(finalExpiresAt.getDate() + expirationDays);
    finalExpirationPolicy = 'days_from_activation';
    finalExpirationDays = expirationDays;
  } else {
    // Use default for source type
    const defaultDays = DEFAULT_EXPIRATION_DAYS[sourceType];
    if (defaultDays !== null) {
      finalExpiresAt = new Date();
      finalExpiresAt.setDate(finalExpiresAt.getDate() + defaultDays);
      finalExpirationPolicy = 'days_from_activation';
      finalExpirationDays = defaultDays;
    } else {
      finalExpirationPolicy = 'never';
    }
  }

  return await transaction(async (client) => {
    // Upsert user (create if doesn't exist)
    const userResult = await client.query<User>(
      `INSERT INTO users (user_id, email, credits, credits_purchased, credits_used)
       VALUES ($1, $2, $3, $3, 0)
       ON CONFLICT (user_id) DO UPDATE
       SET credits = users.credits + $3,
           credits_purchased = users.credits_purchased + $3,
           updated_at = NOW()
       RETURNING *`,
      [userId, email || `${userId}@unknown.com`, credits]
    );
    const user = userResult.rows[0];

    // Create ledger entry
    const ledgerResult = await client.query<CreditLedgerEntry>(
      `INSERT INTO credit_ledger (
        user_id, initial_amount, remaining_amount, source_type,
        source_reference_id, source_order_id, source_metadata, activated_at,
        expires_at, expiration_policy, expiration_days, status, description
      ) VALUES ($1, $2, $2, $3, $4, $10, $5, NOW(), $6, $7, $8, 'active', $9)
      RETURNING *`,
      [
        userId,
        credits,
        sourceType,
        sourceReferenceId || null,
        sourceMetadata ? JSON.stringify(sourceMetadata) : null,
        finalExpiresAt,
        finalExpirationPolicy,
        finalExpirationDays || null,
        description || `Added ${credits} credits (${sourceType})`,
        sourceOrderId || null,
      ]
    );
    const ledgerEntry = ledgerResult.rows[0];

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
        sourceType === 'purchase' ? 'purchase' : 'adjustment',
        sourceType === 'purchase' ? 'order' : 'manual',
        sourceReferenceId || ledgerEntry.ledger_id,
        description || `Added ${credits} credits (${sourceType})`,
      ]
    );
    const txn = txResult.rows[0];

    writeDiagnostic('info', 'credits.ledger_added', {
      credits,
      sourceType,
      expires: finalExpiresAt ? 'scheduled' : 'never',
      newBalance: user.credits
    });

    return { user, transaction: txn, ledgerEntry };
  });
}

/** Add credits inside a caller-owned transaction (used by payment webhooks). */
export async function addCreditsToLedgerWithClient(
  client: Pick<pg.PoolClient, 'query'>,
  params: AddCreditsToLedgerParams
): Promise<CreditLedgerOperationResult> {
  const {
    userId,
    email,
    credits,
    sourceType,
    sourceReferenceId,
    sourceOrderId,
    sourceMetadata,
    expirationPolicy,
    expiresAt,
    expirationDays,
    description
  } = params;

  if (credits <= 0) throw new Error('Credits must be positive');

  let finalExpiresAt: Date | null = null;
  let finalExpirationPolicy = expirationPolicy || 'days_from_activation';
  let finalExpirationDays = expirationDays;
  if (expiresAt) {
    finalExpiresAt = expiresAt;
    finalExpirationPolicy = 'fixed_date';
  } else if (expirationDays !== undefined) {
    finalExpiresAt = new Date();
    finalExpiresAt.setDate(finalExpiresAt.getDate() + expirationDays);
    finalExpirationPolicy = 'days_from_activation';
  } else {
    const defaultDays = DEFAULT_EXPIRATION_DAYS[sourceType];
    if (defaultDays === null) {
      finalExpirationPolicy = 'never';
    } else {
      finalExpiresAt = new Date();
      finalExpiresAt.setDate(finalExpiresAt.getDate() + defaultDays);
      finalExpirationPolicy = 'days_from_activation';
      finalExpirationDays = defaultDays;
    }
  }

  const userResult = await client.query<User>(
    `INSERT INTO users (user_id, email, credits, credits_purchased, credits_used)
     VALUES ($1, $2, $3, $3, 0)
     ON CONFLICT (user_id) DO UPDATE
     SET credits = users.credits + $3,
         credits_purchased = users.credits_purchased + $3,
         updated_at = NOW()
     RETURNING *`,
    [userId, email || `${userId}@unknown.com`, credits]
  );
  const user = userResult.rows[0];

  const ledgerResult = await client.query<CreditLedgerEntry>(
    `INSERT INTO credit_ledger (
       user_id, initial_amount, remaining_amount, source_type,
       source_reference_id, source_order_id, source_metadata, activated_at,
       expires_at, expiration_policy, expiration_days, status, description
     ) VALUES ($1, $2, $2, $3, $4, $10, $5, NOW(), $6, $7, $8, 'active', $9)
     RETURNING *`,
    [
      userId,
      credits,
      sourceType,
      sourceReferenceId || null,
      sourceMetadata ? JSON.stringify(sourceMetadata) : null,
      finalExpiresAt,
      finalExpirationPolicy,
      finalExpirationDays || null,
      description || `Added ${credits} credits (${sourceType})`,
      sourceOrderId || null
    ]
  );
  const ledgerEntry = ledgerResult.rows[0];

  const txResult = await client.query<CreditTransaction>(
    `INSERT INTO credit_transactions (
       user_id, amount, balance_after, type, reference_type, reference_id, description
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      userId,
      credits,
      user.credits,
      sourceType === 'purchase' ? 'purchase' : 'adjustment',
      sourceType === 'purchase' ? 'order' : 'manual',
      sourceReferenceId || ledgerEntry.ledger_id,
      description || `Added ${credits} credits (${sourceType})`
    ]
  );

  return { user, transaction: txResult.rows[0], ledgerEntry };
}

/**
 * Deduct credits from user's ledger using FIFO with expiration priority
 *
 * Consumption order:
 * 1. Credits expiring soonest first
 * 2. Within same expiration, oldest first (FIFO)
 * 3. Never-expiring credits last
 *
 * @throws Error if insufficient credits
 * @throws Error if user not found
 * @throws Error if credits <= 0
 */
export async function deductCreditsFromLedger(
  params: DeductCreditsFromLedgerParams
): Promise<CreditLedgerOperationResult> {
  return transaction((client) => deductCreditsFromLedgerWithClient(client, params));
}

/**
 * Deduct credits as part of a caller-owned transaction.
 *
 * The send flow uses this so draft consumption, credit deduction, letter
 * creation, and outbox insertion either all commit or all roll back.
 */
export async function deductCreditsFromLedgerWithClient(
  client: pg.PoolClient,
  params: DeductCreditsFromLedgerParams
): Promise<CreditLedgerOperationResult> {
    const { userId, credits, letterId, description } = params;

    if (credits <= 0) {
      throw new Error('Credits must be positive');
    }

    // Lock user row
    const userResult = await client.query<User>(
      'SELECT * FROM users WHERE user_id = $1 FOR UPDATE',
      [userId]
    );

    if (userResult.rows.length === 0) {
      throw new Error('User not found');
    }

    const user = userResult.rows[0];

    // Get available ledger entries in consumption order
    // FIFO with expiration priority: expire soonest first, then oldest
    const ledgerResult = await client.query<CreditLedgerEntry>(
      `SELECT * FROM credit_ledger
       WHERE user_id = $1
         AND status = 'active'
         AND remaining_amount > 0
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY expires_at NULLS LAST, created_at ASC
       FOR UPDATE`,
      [userId]
    );

    // Calculate total available
    const totalAvailable = ledgerResult.rows.reduce(
      (sum, entry) => sum + entry.remaining_amount,
      0
    );

    if (totalAvailable < credits) {
      throw new Error(
        `Insufficient credits. Required: ${credits}, Available: ${totalAvailable}`
      );
    }

    // Consume from entries
    let remainingToDeduct = credits;
    const consumptions: CreditConsumption[] = [];

    // First, deduct from users.credits and record transaction
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
        -credits,
        updatedUser.credits,
        'deduction',
        'letter',
        letterId,
        description || `Sent letter (${credits} credits)`,
      ]
    );
    const txn = txResult.rows[0];

    // Now consume from ledger entries
    for (const entry of ledgerResult.rows) {
      if (remainingToDeduct <= 0) break;

      const amountToTake = Math.min(remainingToDeduct, entry.remaining_amount);
      const newRemaining = entry.remaining_amount - amountToTake;

      // Update ledger entry
      await client.query(
        `UPDATE credit_ledger
         SET remaining_amount = $1,
             status = CASE WHEN $1 = 0 THEN 'depleted'::credit_ledger_status ELSE status END,
             updated_at = NOW()
         WHERE ledger_id = $2`,
        [newRemaining, entry.ledger_id]
      );

      // Record consumption
      const consumptionResult = await client.query<CreditConsumption>(
        `INSERT INTO credit_consumption (
          transaction_id, ledger_id, amount, ledger_remaining_after
        ) VALUES ($1, $2, $3, $4)
        RETURNING *`,
        [txn.transaction_id, entry.ledger_id, amountToTake, newRemaining]
      );
      consumptions.push(consumptionResult.rows[0]);

      remainingToDeduct -= amountToTake;
    }

    writeDiagnostic('info', 'credits.ledger_deducted', {
      credits,
      ledgerEntries: consumptions.length,
      newBalance: updatedUser.credits
    });

    return {
      user: updatedUser,
      transaction: txn,
      consumedFrom: consumptions,
    };
}

/**
 * Refund credits to user's ledger
 *
 * Creates a new ledger entry linked to the original (if provided).
 * Can inherit expiration from original or set new expiration.
 *
 * @throws Error if credits <= 0
 * @throws Error if user not found
 */
export async function refundCreditsToLedger(
  params: RefundCreditsToLedgerParams
): Promise<CreditLedgerOperationResult> {
  const {
    userId,
    originalLedgerId,
    credits,
    orderId,
    reason,
    inheritExpiration,
    newExpirationDays,
  } = params;

  if (credits <= 0) {
    throw new Error('Credits must be positive');
  }

  return await transaction(async (client) => {
    // Get original ledger entry if provided
    let expiresAt: Date | null = null;
    let expirationPolicy: string = 'never';
    let expirationDays: number | null = null;

    if (originalLedgerId && inheritExpiration) {
      const originalResult = await client.query<CreditLedgerEntry>(
        'SELECT * FROM credit_ledger WHERE ledger_id = $1',
        [originalLedgerId]
      );
      if (originalResult.rows.length > 0) {
        const original = originalResult.rows[0];
        expiresAt = original.expires_at || null;
        expirationPolicy = original.expiration_policy || 'never';
        expirationDays = original.expiration_days || null;
      }
    } else if (newExpirationDays) {
      expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + newExpirationDays);
      expirationPolicy = 'days_from_activation';
      expirationDays = newExpirationDays;
    }

    // Update user balance
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
      throw new Error('User not found');
    }

    const user = userResult.rows[0];

    // Create ledger entry for refund
    const ledgerResult = await client.query<CreditLedgerEntry>(
      `INSERT INTO credit_ledger (
        user_id, initial_amount, remaining_amount, source_type,
        source_reference_id, activated_at, expires_at,
        expiration_policy, expiration_days, status, description, related_ledger_id
      ) VALUES ($1, $2, $2, 'refund', $3, NOW(), $4, $5, $6, 'active', $7, $8)
      RETURNING *`,
      [
        userId,
        credits,
        orderId || null,
        expiresAt,
        expirationPolicy,
        expirationDays,
        reason || `Refunded ${credits} credits`,
        originalLedgerId || null,
      ]
    );
    const ledgerEntry = ledgerResult.rows[0];

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
        'refund',
        'order',
        orderId || ledgerEntry.ledger_id,
        reason || `Refunded ${credits} credits`,
      ]
    );
    const txn = txResult.rows[0];

    writeDiagnostic('info', 'credits.ledger_refunded', {
      credits,
      newBalance: user.credits
    });

    return { user, transaction: txn, ledgerEntry };
  });
}

/**
 * Get detailed credit balance with expiration breakdown
 */
export async function getDetailedBalance(
  userId: string
): Promise<CreditBalanceDetailed> {
  // Get all active, non-expired ledger entries
  const result = await query<CreditLedgerEntry>(
    `SELECT * FROM credit_ledger
     WHERE user_id = $1
       AND status = 'active'
       AND remaining_amount > 0
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY expires_at NULLS LAST, created_at ASC`,
    [userId]
  );

  const entries = result.rows;
  const now = new Date();
  const thirtyDaysFromNow = new Date();
  thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

  // Calculate totals
  let totalAvailable = 0;
  let expiringSoon = 0;
  let neverExpiring = 0;

  const expiringBuckets = new Map<string, ExpiringBucket>();
  const sourceBreakdown = new Map<CreditSourceType, SourceBreakdown>();

  for (const entry of entries) {
    totalAvailable += entry.remaining_amount;

    // Track by expiration date
    const bucketKey = entry.expires_at?.toISOString() || 'never';
    const bucket = expiringBuckets.get(bucketKey) || {
      expiresAt: entry.expires_at || null,
      credits: 0,
      ledgerIds: [],
    };
    bucket.credits += entry.remaining_amount;
    bucket.ledgerIds.push(entry.ledger_id);
    expiringBuckets.set(bucketKey, bucket);

    // Check if expiring soon
    if (entry.expires_at) {
      if (entry.expires_at <= thirtyDaysFromNow) {
        expiringSoon += entry.remaining_amount;
      }
    } else {
      neverExpiring += entry.remaining_amount;
    }

    // Track by source type
    const sourceEntry = sourceBreakdown.get(entry.source_type) || {
      sourceType: entry.source_type,
      available: 0,
      total: 0,
    };
    sourceEntry.available += entry.remaining_amount;
    sourceEntry.total += entry.initial_amount;
    sourceBreakdown.set(entry.source_type, sourceEntry);
  }

  return {
    totalAvailable,
    expiringSoon,
    neverExpiring,
    expiringDates: Array.from(expiringBuckets.values()).sort((a, b) => {
      if (!a.expiresAt) return 1;
      if (!b.expiresAt) return -1;
      return a.expiresAt.getTime() - b.expiresAt.getTime();
    }),
    bySource: Array.from(sourceBreakdown.values()),
  };
}

/**
 * Get available credits (simple count from ledger)
 * Used for balance checks
 */
export async function getAvailableCredits(userId: string): Promise<number> {
  const result = await query<{ total: string }>(
    `SELECT COALESCE(SUM(remaining_amount), 0) as total
     FROM credit_ledger
     WHERE user_id = $1
       AND status = 'active'
       AND remaining_amount > 0
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [userId]
  );

  return parseInt(result.rows[0].total, 10);
}

/**
 * Get user's ledger entries
 */
export async function getLedgerEntries(
  params: GetLedgerEntriesParams
): Promise<LedgerEntriesResult> {
  const { userId, status, includeExpired, limit = 50, offset = 0 } = params;

  // Build WHERE clause
  const conditions: string[] = ['user_id = $1'];
  const queryParams: (string | number | string[])[] = [userId];
  let paramIndex = 2;

  if (status && status.length > 0) {
    conditions.push(`status = ANY($${paramIndex})`);
    queryParams.push(status);
    paramIndex++;
  }

  if (!includeExpired) {
    conditions.push(`(expires_at IS NULL OR expires_at > NOW())`);
  }

  const whereClause = conditions.join(' AND ');

  // Get entries
  const result = await query<CreditLedgerEntry>(
    `SELECT * FROM credit_ledger
     WHERE ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...queryParams, limit, offset]
  );

  // Get total count
  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM credit_ledger WHERE ${whereClause}`,
    queryParams
  );

  return {
    entries: result.rows,
    total: parseInt(countResult.rows[0].count, 10),
  };
}

/**
 * Get credits expiring within specified days
 */
export async function getExpiringCredits(
  userId: string,
  withinDays: number
): Promise<{ total: number; entries: CreditLedgerEntry[] }> {
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + withinDays);

  const result = await query<CreditLedgerEntry>(
    `SELECT * FROM credit_ledger
     WHERE user_id = $1
       AND status = 'active'
       AND remaining_amount > 0
       AND expires_at IS NOT NULL
       AND expires_at > NOW()
       AND expires_at <= $2
     ORDER BY expires_at ASC`,
    [userId, futureDate]
  );

  const total = result.rows.reduce((sum, entry) => sum + entry.remaining_amount, 0);

  return { total, entries: result.rows };
}

/**
 * Check if user has sufficient non-expired credits
 */
export async function hasSufficientCredits(
  userId: string,
  creditsRequired: number
): Promise<boolean> {
  const available = await getAvailableCredits(userId);
  return available >= creditsRequired;
}

// ============================================================================
// Background Job Functions
// ============================================================================

/**
 * Mark expired ledger entries as 'expired'
 * Called by daily background job
 */
export async function markExpiredEntries(): Promise<{ count: number }> {
  const result = await query(
    `UPDATE credit_ledger
     SET status = 'expired', updated_at = NOW()
     WHERE status = 'active'
       AND expires_at IS NOT NULL
       AND expires_at <= NOW()
       AND remaining_amount > 0`
  );

  const count = result.rowCount || 0;

  if (count > 0) {
    console.log(`🕐 Marked ${count} ledger entries as expired`);
  }

  return { count };
}

/**
 * Reconcile users.credits cache with ledger
 * Returns users with mismatched balances
 */
export async function reconcileBalances(): Promise<{
  checked: number;
  fixed: number;
  mismatches: Array<{ userId: string; cached: number; actual: number }>;
}> {
  // Find mismatches between cache and ledger
  const mismatchResult = await query<{
    user_id: string;
    cached_credits: number;
    actual_credits: string;
  }>(
    `SELECT u.user_id, u.credits as cached_credits,
            COALESCE(SUM(l.remaining_amount), 0) as actual_credits
     FROM users u
     LEFT JOIN credit_ledger l ON u.user_id = l.user_id
       AND l.status = 'active'
       AND l.remaining_amount > 0
       AND (l.expires_at IS NULL OR l.expires_at > NOW())
     GROUP BY u.user_id, u.credits
     HAVING u.credits != COALESCE(SUM(l.remaining_amount), 0)`
  );

  const mismatches = mismatchResult.rows.map((row) => ({
    userId: row.user_id,
    cached: row.cached_credits,
    actual: parseInt(row.actual_credits, 10),
  }));

  // Fix mismatches
  let fixed = 0;
  for (const mismatch of mismatches) {
    await query(
      `UPDATE users SET credits = $1, updated_at = NOW() WHERE user_id = $2`,
      [mismatch.actual, mismatch.userId]
    );
    fixed++;
    console.log(
      `🔧 Fixed balance mismatch: ${mismatch.cached} -> ${mismatch.actual}`
    );
  }

  // Get total users checked
  const countResult = await query<{ count: string }>('SELECT COUNT(*) as count FROM users');
  const checked = parseInt(countResult.rows[0].count, 10);

  return { checked, fixed, mismatches };
}

/**
 * Get users with credits expiring soon (for notifications)
 */
export async function getUsersWithExpiringCredits(
  withinDays: number
): Promise<
  Array<{ userId: string; email: string; expiringCredits: number; expiresAt: Date }>
> {
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + withinDays);

  const result = await query<{
    user_id: string;
    email: string;
    expiring_credits: string;
    earliest_expiry: Date;
  }>(
    `SELECT u.user_id, u.email,
            SUM(l.remaining_amount) as expiring_credits,
            MIN(l.expires_at) as earliest_expiry
     FROM users u
     JOIN credit_ledger l ON u.user_id = l.user_id
     WHERE l.status = 'active'
       AND l.remaining_amount > 0
       AND l.expires_at IS NOT NULL
       AND l.expires_at > NOW()
       AND l.expires_at <= $1
     GROUP BY u.user_id, u.email
     ORDER BY earliest_expiry ASC`,
    [futureDate]
  );

  return result.rows.map((row) => ({
    userId: row.user_id,
    email: row.email,
    expiringCredits: parseInt(row.expiring_credits, 10),
    expiresAt: row.earliest_expiry,
  }));
}

/**
 * Return the credits a failed send consumed, exactly once.
 *
 * Issue #151. A confirmed send deducts the pack before the provider is called.
 * When the job terminally fails, a pay-per-send order transitions to
 * refund_pending, but a prepaid send previously returned nothing at all - the
 * customer paid and received no letter.
 *
 * Posts NEW compensating lots rather than putting the consumed amounts back
 * into the originals, matching the approach settled in issue #150: the
 * consumption stays in history as a record of what happened, and the return is
 * a separate linked entry. `related_ledger_id` on the consumed lot answers
 * "was this taken, and was it given back?" in one indexed lookup.
 *
 * Each returned lot inherits the expiry of the lot it came from. Credits live
 * in lots consumed FIFO by expires_at, so returning them into a fresh lot with
 * no expiry would quietly extend the customer's window. It inherits that lot's
 * source reference too, which is what keeps a later refund able to claw the
 * returned credit back - see the note at the insert.
 *
 * A lot the customer has already been refunded for in cash is skipped: issue
 * #150's revocation zeroes and revokes those lots, and returning against one
 * would pay for the same pack twice.
 *
 * Exactly-once is enforced by refusing to act when a return already exists for
 * this letter. Callers must already hold the canonical locks down to the letter
 * row; this takes the account lock itself, which is the next step in that order.
 *
 * Returns the number of credits returned - zero when there is nothing to return
 * or a return has already happened.
 */
/**
 * Whether this letter's pack has already been returned.
 *
 * The marker is the compensating lot itself, which makes the check and the
 * thing it guards impossible to get out of step. It answers exactly-once for
 * the return below; operator actions ask isLetterAlreadyCompensated instead,
 * which also covers the pack that was refunded in cash rather than returned.
 */
export async function hasReturnedCreditsForLetter(
  client: Pick<pg.PoolClient, 'query'>,
  params: { letterId: string; userId: string }
): Promise<boolean> {
  const existing = await client.query(
    `SELECT 1 FROM credit_ledger
      WHERE user_id = $1
        AND source_type = 'adjustment'
        AND source_metadata->>'letter_id' = $2
        AND source_metadata->>'reason' = 'send_failed'
      LIMIT 1`,
    [params.userId, params.letterId]
  );
  return Boolean(existing.rowCount);
}

/**
 * Whether this letter has already been paid for in the customer's favour.
 *
 * Two routes lead there and an operator action must refuse on either. The pack
 * came back as a compensating lot (issue #151), or the pack itself was refunded
 * in cash and its lots revoked (issue #150) - in which case the return below
 * correctly declines and leaves no marker of its own. Nothing re-deducts on the
 * way back through the outbox, so a retry from either state posts mail nobody
 * is paying for.
 *
 * bool_and over no rows is NULL, so a letter that consumed no credits - every
 * pay-per-send letter - answers false and keeps its own JIT guards.
 */
export async function isLetterAlreadyCompensated(
  client: Pick<pg.PoolClient, 'query'>,
  params: { letterId: string; userId: string }
): Promise<boolean> {
  if (await hasReturnedCreditsForLetter(client, params)) return true;
  const consumed = await client.query<{ all_revoked: boolean | null }>(
    `SELECT bool_and(lot.status = 'revoked') AS all_revoked
       FROM credit_consumption consumption
       JOIN credit_transactions txn ON txn.transaction_id = consumption.transaction_id
       JOIN credit_ledger lot ON lot.ledger_id = consumption.ledger_id
      WHERE txn.reference_type = 'letter'
        AND txn.reference_id = $1
        AND txn.type = 'deduction'
        AND txn.user_id = $2`,
    [params.letterId, params.userId]
  );
  return consumed.rows[0]?.all_revoked === true;
}

export async function returnConsumedCreditsForLetter(
  client: Pick<pg.PoolClient, 'query'>,
  params: { letterId: string; userId: string; failureCode: string }
): Promise<number> {
  const { letterId, userId, failureCode } = params;
  await lockAccountForBalanceChange(client, userId);

  if (await hasReturnedCreditsForLetter(client, { letterId, userId })) return 0;

  // credit_consumption records exactly which lots the deduction drew from and
  // how much came from each, so the return mirrors the original split rather
  // than guessing from letters.credits_cost.
  const consumed = await client.query<{
    ledger_id: string;
    amount: number;
    expires_at: Date | null;
    expiration_policy: string | null;
    status: string;
    source_reference_id: string | null;
    stripe_session_id: string | null;
  }>(
    `SELECT consumption.ledger_id, consumption.amount,
            lot.expires_at, lot.expiration_policy, lot.status,
            lot.source_reference_id,
            lot.source_metadata->>'stripe_session_id' AS stripe_session_id
       FROM credit_consumption consumption
       JOIN credit_transactions txn ON txn.transaction_id = consumption.transaction_id
       JOIN credit_ledger lot ON lot.ledger_id = consumption.ledger_id
      WHERE txn.reference_type = 'letter'
        AND txn.reference_id = $1
        AND txn.type = 'deduction'
        AND txn.user_id = $2`,
    [letterId, userId]
  );
  if (consumed.rows.length === 0) return 0;

  let returned = 0;
  for (const lot of consumed.rows) {
    if (lot.amount <= 0) continue;
    // A revoked lot was already paid back in cash. Refunding a pack zeroes its
    // lots and claws the balance down (issue #150); minting a fresh credit from
    // one of those lots would hand the customer the money and the credit for
    // the same pack. The send failing after the refund does not owe them
    // anything - the refund already covered the letter that never went.
    if (lot.status === 'revoked') continue;
    await client.query(
      `INSERT INTO credit_ledger (
         user_id, initial_amount, remaining_amount, source_type,
         source_reference_id, source_metadata, activated_at,
         expires_at, expiration_policy, status, description, related_ledger_id
       ) VALUES ($1, $2, $2, 'adjustment', $3, $4, NOW(), $5, $6, 'active', $7, $8)`,
      [
        userId,
        lot.amount,
        // The returned credit belongs to whatever bought the lot it came from,
        // so it carries that lot's reference rather than the letter's. A later
        // refund or chargeback claws back by order id or checkout session
        // (commerceService.revokePackCredits); a letter-referenced lot is
        // invisible to that query, which would leave a refunded customer
        // holding both the cash and the returned credit. The letter is still
        // recorded in the metadata below, where the exactly-once marker reads
        // it.
        lot.source_reference_id,
        // failure_code is a stable classification, never the provider's own
        // error text. This row is durable and operator-visible, and this repo
        // bars provider internals and customer content from persisted
        // diagnostics.
        JSON.stringify({
          reason: 'send_failed',
          letter_id: letterId,
          failure_code: failureCode,
          restores_ledger_id: lot.ledger_id,
          // Carried for the same reason as the reference above: the claw-back's
          // other arm matches on the checkout session.
          ...(lot.stripe_session_id ? { stripe_session_id: lot.stripe_session_id } : {})
        }),
        lot.expires_at,
        lot.expiration_policy,
        `Returned after failed send ${letterId}`,
        lot.ledger_id
      ]
    );
    returned += lot.amount;
  }
  if (returned === 0) return 0;

  await client.query(
    `UPDATE users SET credits = credits + $1, updated_at = NOW() WHERE user_id = $2`,
    [returned, userId]
  );

  // balance_after is read after the update above, so the snapshot matches the
  // balance this transaction produced.
  await client.query(
    `INSERT INTO credit_transactions (
       user_id, amount, balance_after, type, reference_type, reference_id, description
     ) SELECT $1::varchar, $2::int, credits, 'refund', 'letter', $3::varchar, $4::text
         FROM users WHERE user_id = $1::varchar`,
    [userId, returned, letterId, `Returned after failed send ${letterId}`]
  );

  writeDiagnostic('info', 'credits.returned_after_failed_send', {
    creditsReturned: returned,
    lotsRestored: consumed.rows.length
  });

  return returned;
}
