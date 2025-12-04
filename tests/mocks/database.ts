/**
 * Database mocking utilities for unit tests
 *
 * For unit tests, we mock the database layer to test business logic in isolation.
 * For integration tests, we use a real test database with Stripe/PostGrid test mode.
 */

import { vi } from 'vitest';
import type { PoolClient, QueryResult } from 'pg';

// Type for our mock query function
export type MockQueryFn = <T>(
  sql: string,
  params?: unknown[]
) => Promise<QueryResult<T>>;

// Type for our mock transaction function
export type MockTransactionFn = <T>(
  callback: (client: MockClient) => Promise<T>
) => Promise<T>;

// Mock client for transaction callbacks
export interface MockClient {
  query: MockQueryFn;
}

/**
 * Create a mock query result
 */
export function createQueryResult<T>(rows: T[], rowCount?: number): QueryResult<T> {
  return {
    rows,
    rowCount: rowCount ?? rows.length,
    command: 'SELECT',
    oid: 0,
    fields: [],
  };
}

/**
 * Create a mock database module
 *
 * Returns mocked `query` and `transaction` functions that can be configured
 * per-test to return specific results.
 */
export function createMockDatabase() {
  // Store query results by SQL pattern
  const queryResults = new Map<string | RegExp, unknown[]>();

  // The mock query function
  const mockQuery = vi.fn(async <T>(sql: string, _params?: unknown[]): Promise<QueryResult<T>> => {
    // Find matching result
    for (const [pattern, rows] of queryResults.entries()) {
      if (pattern instanceof RegExp) {
        if (pattern.test(sql)) {
          return createQueryResult(rows as T[]);
        }
      } else if (sql.includes(pattern)) {
        return createQueryResult(rows as T[]);
      }
    }
    // Default: return empty result
    return createQueryResult<T>([]);
  });

  // The mock transaction function
  const mockTransaction = vi.fn(async <T>(
    callback: (client: MockClient) => Promise<T>
  ): Promise<T> => {
    // Create a mock client that uses our mockQuery
    const mockClient: MockClient = {
      query: mockQuery,
    };
    return callback(mockClient);
  });

  return {
    query: mockQuery,
    transaction: mockTransaction,
    queryResults,

    // Helper to set up expected results
    setQueryResult: (sqlPattern: string | RegExp, rows: unknown[]) => {
      queryResults.set(sqlPattern, rows);
    },

    // Helper to clear all results
    clearResults: () => {
      queryResults.clear();
      mockQuery.mockClear();
      mockTransaction.mockClear();
    },
  };
}

/**
 * Mock the database module for a test file
 *
 * Usage:
 * ```ts
 * import { mockDatabaseModule } from '../mocks/database';
 *
 * const db = mockDatabaseModule();
 *
 * beforeEach(() => {
 *   db.clearResults();
 * });
 *
 * test('my test', async () => {
 *   db.setQueryResult('SELECT * FROM users', [{ user_id: 'test-user' }]);
 *   // ... test code
 * });
 * ```
 */
export function mockDatabaseModule() {
  const mockDb = createMockDatabase();

  // Mock the db module
  vi.mock('../../src/db/index.js', () => ({
    query: mockDb.query,
    transaction: mockDb.transaction,
  }));

  return mockDb;
}

// ============================================================================
// In-Memory Database for More Complex Tests
// ============================================================================

interface InMemoryUser {
  user_id: string;
  email: string;
  credits: number;
  credits_purchased: number;
  credits_used: number;
  tier: string;
  created_at: Date;
  updated_at: Date;
}

interface InMemoryLedgerEntry {
  ledger_id: number;
  user_id: string;
  initial_amount: number;
  remaining_amount: number;
  source_type: string;
  source_reference_id: string | null;
  source_metadata: string | null;
  activated_at: Date;
  expires_at: Date | null;
  expiration_policy: string;
  expiration_days: number | null;
  status: string;
  description: string;
  related_ledger_id: number | null;
  created_at: Date;
  updated_at: Date;
}

interface InMemoryTransaction {
  transaction_id: number;
  user_id: string;
  amount: number;
  balance_after: number;
  type: string;
  reference_type: string;
  reference_id: string;
  description: string;
  created_at: Date;
}

/**
 * In-memory database for more complex unit tests
 *
 * Simulates basic database operations without a real database.
 * Useful for testing business logic that spans multiple queries.
 */
export class InMemoryDatabase {
  users = new Map<string, InMemoryUser>();
  ledgerEntries: InMemoryLedgerEntry[] = [];
  transactions: InMemoryTransaction[] = [];
  private ledgerIdCounter = 1;
  private transactionIdCounter = 1;

  // Create or update user
  upsertUser(userId: string, email: string, creditsToAdd: number): InMemoryUser {
    const existing = this.users.get(userId);
    if (existing) {
      existing.credits += creditsToAdd;
      existing.credits_purchased += creditsToAdd;
      existing.updated_at = new Date();
      return existing;
    }

    const user: InMemoryUser = {
      user_id: userId,
      email,
      credits: creditsToAdd,
      credits_purchased: creditsToAdd,
      credits_used: 0,
      tier: 'standard',
      created_at: new Date(),
      updated_at: new Date(),
    };
    this.users.set(userId, user);
    return user;
  }

  // Add a ledger entry
  addLedgerEntry(
    userId: string,
    amount: number,
    sourceType: string,
    expiresAt: Date | null
  ): InMemoryLedgerEntry {
    const entry: InMemoryLedgerEntry = {
      ledger_id: this.ledgerIdCounter++,
      user_id: userId,
      initial_amount: amount,
      remaining_amount: amount,
      source_type: sourceType,
      source_reference_id: null,
      source_metadata: null,
      activated_at: new Date(),
      expires_at: expiresAt,
      expiration_policy: expiresAt ? 'days_from_activation' : 'never',
      expiration_days: null,
      status: 'active',
      description: `Added ${amount} credits`,
      related_ledger_id: null,
      created_at: new Date(),
      updated_at: new Date(),
    };
    this.ledgerEntries.push(entry);
    return entry;
  }

  // Get available ledger entries in FIFO order
  getAvailableEntries(userId: string): InMemoryLedgerEntry[] {
    const now = new Date();
    return this.ledgerEntries
      .filter(
        (e) =>
          e.user_id === userId &&
          e.status === 'active' &&
          e.remaining_amount > 0 &&
          (e.expires_at === null || e.expires_at > now)
      )
      .sort((a, b) => {
        // Expiring soonest first, then by creation date
        if (a.expires_at === null && b.expires_at === null) {
          return a.created_at.getTime() - b.created_at.getTime();
        }
        if (a.expires_at === null) return 1;
        if (b.expires_at === null) return -1;
        return a.expires_at.getTime() - b.expires_at.getTime();
      });
  }

  // Get total available credits
  getAvailableCredits(userId: string): number {
    return this.getAvailableEntries(userId).reduce(
      (sum, e) => sum + e.remaining_amount,
      0
    );
  }

  // Reset the database
  reset(): void {
    this.users.clear();
    this.ledgerEntries = [];
    this.transactions = [];
    this.ledgerIdCounter = 1;
    this.transactionIdCounter = 1;
  }
}
