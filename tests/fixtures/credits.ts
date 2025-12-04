/**
 * Test fixtures for credit ledger entries
 */

import type { CreditSourceType } from '../../src/services/types.js';

export interface TestLedgerEntry {
  ledger_id: number;
  user_id: string;
  initial_amount: number;
  remaining_amount: number;
  source_type: CreditSourceType;
  source_reference_id: string | null;
  source_metadata: string | null;
  activated_at: Date;
  expires_at: Date | null;
  expiration_policy: string;
  expiration_days: number | null;
  status: 'active' | 'depleted' | 'expired' | 'revoked';
  description: string;
  related_ledger_id: number | null;
  created_at: Date;
  updated_at: Date;
}

// Helper to create dates relative to now
export function daysFromNow(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date;
}

export function daysAgo(days: number): Date {
  return daysFromNow(-days);
}

let ledgerIdCounter = 1000;

/**
 * Create a test ledger entry
 */
export function createLedgerEntry(
  userId: string,
  amount: number,
  options: {
    sourceType?: CreditSourceType;
    expiresAt?: Date | null;
    expiresInDays?: number;
    status?: 'active' | 'depleted' | 'expired' | 'revoked';
    remaining?: number;
    createdDaysAgo?: number;
  } = {}
): TestLedgerEntry {
  const {
    sourceType = 'purchase',
    expiresAt,
    expiresInDays,
    status = 'active',
    remaining = amount,
    createdDaysAgo = 0,
  } = options;

  let finalExpiresAt: Date | null = null;
  if (expiresAt !== undefined) {
    finalExpiresAt = expiresAt;
  } else if (expiresInDays !== undefined) {
    finalExpiresAt = daysFromNow(expiresInDays);
  }

  const createdAt = daysAgo(createdDaysAgo);

  return {
    ledger_id: ledgerIdCounter++,
    user_id: userId,
    initial_amount: amount,
    remaining_amount: remaining,
    source_type: sourceType,
    source_reference_id: null,
    source_metadata: null,
    activated_at: createdAt,
    expires_at: finalExpiresAt,
    expiration_policy: finalExpiresAt ? 'days_from_activation' : 'never',
    expiration_days: expiresInDays ?? null,
    status,
    description: `Added ${amount} credits (${sourceType})`,
    related_ledger_id: null,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

/**
 * Create a set of ledger entries for FIFO testing
 *
 * Returns entries in the order they should be consumed:
 * 1. Expiring soonest first
 * 2. Never-expiring last
 */
export function createFIFOTestEntries(userId: string): TestLedgerEntry[] {
  return [
    // Entry 1: Expires in 7 days (should be consumed first)
    createLedgerEntry(userId, 3, {
      sourceType: 'promo',
      expiresInDays: 7,
      createdDaysAgo: 10,
    }),

    // Entry 2: Expires in 30 days (should be consumed second)
    createLedgerEntry(userId, 5, {
      sourceType: 'purchase',
      expiresInDays: 30,
      createdDaysAgo: 5,
    }),

    // Entry 3: Expires in 365 days (should be consumed third)
    createLedgerEntry(userId, 10, {
      sourceType: 'purchase',
      expiresInDays: 365,
      createdDaysAgo: 1,
    }),

    // Entry 4: Never expires (should be consumed last)
    createLedgerEntry(userId, 8, {
      sourceType: 'adjustment',
      expiresAt: null,
      createdDaysAgo: 20,
    }),
  ];
}

/**
 * Create entries with some already expired (for testing expired filtering)
 */
export function createMixedStatusEntries(userId: string): TestLedgerEntry[] {
  return [
    // Active entry
    createLedgerEntry(userId, 5, {
      sourceType: 'purchase',
      expiresInDays: 30,
      status: 'active',
    }),

    // Depleted entry (fully used)
    createLedgerEntry(userId, 10, {
      sourceType: 'purchase',
      expiresInDays: 60,
      status: 'depleted',
      remaining: 0,
    }),

    // Expired entry
    createLedgerEntry(userId, 3, {
      sourceType: 'promo',
      expiresAt: daysAgo(5), // Expired 5 days ago
      status: 'expired',
    }),

    // Revoked entry (from refund)
    createLedgerEntry(userId, 4, {
      sourceType: 'purchase',
      status: 'revoked',
      remaining: 0,
    }),
  ];
}

/**
 * Test transaction fixtures
 */
export interface TestTransaction {
  transaction_id: number;
  user_id: string;
  amount: number;
  balance_after: number;
  type: 'purchase' | 'deduction' | 'refund' | 'adjustment' | 'promo';
  reference_type: string;
  reference_id: string;
  description: string;
  created_at: Date;
}

let transactionIdCounter = 2000;

export function createTransaction(
  userId: string,
  amount: number,
  balanceAfter: number,
  type: TestTransaction['type'],
  referenceId: string = 'test-ref'
): TestTransaction {
  return {
    transaction_id: transactionIdCounter++,
    user_id: userId,
    amount,
    balance_after: balanceAfter,
    type,
    reference_type: type === 'deduction' ? 'letter' : 'order',
    reference_id: referenceId,
    description: `${type} of ${Math.abs(amount)} credits`,
    created_at: new Date(),
  };
}
