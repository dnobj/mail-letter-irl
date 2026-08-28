# Credit API Implementation Guide

> **SUPERSEDED — do not implement from this document.**
>
> This guide describes the pre-ledger credit design, in which a grant wrote
> `users.credits` and a `credit_transactions` row and nothing else. That design
> was replaced by the credit ledger in migration `003_credit_ledger.sql`, and
> the worked implementations below have not been updated.
>
> **Why it matters rather than merely being stale.** The `addCredits` shown here
> never writes `credit_ledger`. A grant built from this document is invisible to
> `idx_credit_ledger_purchase_order_unique` (migration 023) and to the
> attribution trigger (migration 027), which is precisely the double-grant
> shape issue #152 exists to eliminate. `creditService.addCredits` itself no
> longer exists.
>
> **For the current behaviour, read the code, not this file:**
>
> | What | Where |
> |---|---|
> | The grant itself | `src/services/creditLedgerService.ts` — `addCreditsToLedger`, `addCreditsToLedgerWithClient` |
> | The purchase path | `src/services/commerceService.ts` — `transitionPaidCheckout` |
> | Consumption (FIFO by expiry) | `src/services/creditLedgerService.ts` — `deductCreditsFromLedger` |
> | What a purchase grant must satisfy | `db/migrations/023_jit_recovery_state_machines.sql`, `db/migrations/027_purchase_grant_attribution.sql` |
> | Executable specification | `tests/integration/purchaseIdempotency.postgres.test.ts` |
>
> Retained for the design rationale and the API-shape discussion below, which
> are still broadly accurate. Every code block is not.

## Overview

The Credit API manages user credit balances, transactions, and audit trails. This is the foundation for both ACP credit purchases and letter sending.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Credit API Flow                          │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ACP Checkout           MCP Tools          Admin Panel       │
│       │                     │                    │           │
│       ├─────────────────────┼────────────────────┤           │
│       │                     │                    │           │
│       v                     v                    v           │
│  ┌────────────────────────────────────────────────────┐     │
│  │            Credit Service (Business Logic)          │     │
│  │  - addCredits()                                     │     │
│  │  - deductCredits()                                  │     │
│  │  - getBalance()                                     │     │
│  │  - getTransactions()                                │     │
│  └──────────────────────┬─────────────────────────────┘     │
│                         │                                    │
│                         v                                    │
│  ┌────────────────────────────────────────────────────┐     │
│  │         PostgreSQL Database (Neon)                  │     │
│  │  - users table (balances)                           │     │
│  │  - credit_transactions table (audit trail)          │     │
│  │  - orders table (purchase records)                  │     │
│  └────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────┘
```

## Database Schema Recap

### users table
```sql
user_id VARCHAR(255) PRIMARY KEY  -- Auth0 ID like "auth0|123456"
email VARCHAR(255) NOT NULL UNIQUE
credits INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0)
credits_purchased INTEGER NOT NULL DEFAULT 0
credits_used INTEGER NOT NULL DEFAULT 0
created_at TIMESTAMP NOT NULL DEFAULT NOW()
updated_at TIMESTAMP NOT NULL DEFAULT NOW()
```

### credit_transactions table
```sql
transaction_id SERIAL PRIMARY KEY
user_id VARCHAR(255) NOT NULL REFERENCES users(user_id)
amount INTEGER NOT NULL  -- Positive for add, negative for deduct
balance_after INTEGER NOT NULL  -- Snapshot after transaction
type VARCHAR(50) NOT NULL  -- 'purchase', 'deduction', 'refund', 'adjustment'
reference_type VARCHAR(50)  -- 'order', 'letter', 'manual'
reference_id VARCHAR(255)  -- order_id or letter_id
description TEXT
created_at TIMESTAMP NOT NULL DEFAULT NOW()
```

## Credit Service Implementation

### File Structure

```
src/services/
├── creditService.ts       # Core credit management logic
├── userService.ts         # User account CRUD
└── types.ts              # Shared TypeScript types

src/api/
├── creditApiHandler.ts   # Credit API request handler (Node.js HTTP)
└── middleware/
    └── auth.ts           # JWT authentication helper
```

## Core Functions

### 1. Get or Create User

```typescript
// src/services/userService.ts

import { query, transaction } from '../db/index.js';

export interface User {
  user_id: string;
  email: string;
  credits: number;
  credits_purchased: number;
  credits_used: number;
  created_at: Date;
  updated_at: Date;
}

/**
 * Get user by ID, create if doesn't exist
 */
export async function getOrCreateUser(userId: string, email: string): Promise<User> {
  // Try to find existing user
  const result = await query<User>(
    'SELECT * FROM users WHERE user_id = $1',
    [userId]
  );

  if (result.rows.length > 0) {
    return result.rows[0];
  }

  // Create new user
  const insertResult = await query<User>(
    `INSERT INTO users (user_id, email, credits, credits_purchased, credits_used)
     VALUES ($1, $2, 0, 0, 0)
     RETURNING *`,
    [userId, email]
  );

  console.log(`📝 Created new user: ${userId} (${email})`);
  return insertResult.rows[0];
}

/**
 * Get user by ID (throws if not found)
 */
export async function getUser(userId: string): Promise<User> {
  const result = await query<User>(
    'SELECT * FROM users WHERE user_id = $1',
    [userId]
  );

  if (result.rows.length === 0) {
    throw new Error(`User not found: ${userId}`);
  }

  return result.rows[0];
}
```

### 2. Add Credits (Purchase)

```typescript
// src/services/creditService.ts

import { transaction } from '../db/index.js';
import { getOrCreateUser } from './userService.js';

export interface CreditTransaction {
  transaction_id: number;
  user_id: string;
  amount: number;
  balance_after: number;
  type: 'purchase' | 'deduction' | 'refund' | 'adjustment';
  reference_type?: 'order' | 'letter' | 'manual';
  reference_id?: string;
  description?: string;
  created_at: Date;
}

export interface AddCreditsParams {
  userId: string;
  email: string;
  credits: number;
  orderId: string;
  description?: string;
}

/**
 * Add credits to user account (from purchase)
 * Uses transaction to ensure atomicity
 */
export async function addCredits(params: AddCreditsParams): Promise<{
  user: User;
  transaction: CreditTransaction;
}> {
  const { userId, email, credits, orderId, description } = params;

  if (credits <= 0) {
    throw new Error('Credits must be positive');
  }

  return await transaction(async (client) => {
    // Get or create user
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
```

### 3. Deduct Credits (Send Letter)

```typescript
export interface DeductCreditsParams {
  userId: string;
  credits: number;
  letterId: string;
  description?: string;
}

/**
 * Deduct credits from user account (for sending letter)
 * Throws error if insufficient credits
 */
export async function deductCredits(params: DeductCreditsParams): Promise<{
  user: User;
  transaction: CreditTransaction;
}> {
  const { userId, credits, letterId, description } = params;

  if (credits <= 0) {
    throw new Error('Credits must be positive');
  }

  return await transaction(async (client) => {
    // Lock user row and check balance
    const userResult = await client.query<User>(
      'SELECT * FROM users WHERE user_id = $1 FOR UPDATE',
      [userId]
    );

    if (userResult.rows.length === 0) {
      throw new Error(`User not found: ${userId}`);
    }

    const user = userResult.rows[0];

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

    // Record transaction
    const txResult = await client.query<CreditTransaction>(
      `INSERT INTO credit_transactions (
        user_id, amount, balance_after, type, reference_type, reference_id, description
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *`,
      [
        userId,
        -credits, // Negative amount for deduction
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
```

### 4. Get Balance

```typescript
/**
 * Get current credit balance for user
 */
export async function getBalance(userId: string): Promise<{
  credits: number;
  credits_purchased: number;
  credits_used: number;
}> {
  const user = await getUser(userId);

  return {
    credits: user.credits,
    credits_purchased: user.credits_purchased,
    credits_used: user.credits_used
  };
}
```

### 5. Get Transaction History

```typescript
export interface GetTransactionsParams {
  userId: string;
  limit?: number;
  offset?: number;
  type?: 'purchase' | 'deduction' | 'refund' | 'adjustment';
}

/**
 * Get transaction history for user
 */
export async function getTransactions(params: GetTransactionsParams): Promise<{
  transactions: CreditTransaction[];
  total: number;
}> {
  const { userId, limit = 50, offset = 0, type } = params;

  // Build query
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
```

### 6. Refund Credits

```typescript
export interface RefundCreditsParams {
  userId: string;
  credits: number;
  orderId: string;
  reason?: string;
}

/**
 * Refund credits to user (from cancelled order)
 */
export async function refundCredits(params: RefundCreditsParams): Promise<{
  user: User;
  transaction: CreditTransaction;
}> {
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
        orderId,
        reason || `Refunded ${credits} credits`
      ]
    );

    const txn = txResult.rows[0];

    console.log(`💸 Refunded ${credits} credits to ${userId} (order: ${orderId}), new balance: ${user.credits}`);

    return { user, transaction: txn };
  });
}
```

## HTTP API Handlers

The Credit API is implemented using Node.js HTTP handlers (not Express) in `src/api/creditApiHandler.ts`.

### Available Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/credits/balance` | Get current credit balance |
| GET | `/api/credits/transactions` | Get transaction history |
| GET | `/api/users/me` | Get current user info |

See `src/api/creditApiHandler.ts` for the full implementation.

## Integration Points

### 1. ACP Checkout Complete

When user completes purchase via ACP:

```typescript
// In src/acp/checkoutService.ts

import { addCredits } from '../services/creditService.js';

async function completeCheckout(...) {
  // ... charge Stripe payment ...

  // Add credits to user account
  const { user, transaction } = await addCredits({
    userId: authInfo.userId,
    email: authInfo.email,
    credits: creditsPurchased,
    orderId: order_id,
    description: `Purchased ${creditsPurchased} credits for $${amount.toFixed(2)}`
  });

  return {
    order_id,
    credits_added: creditsPurchased,
    new_balance: user.credits
  };
}
```

### 2. MCP Send Letter Tool

When user sends letter via ChatGPT:

```typescript
// In src/mcp/registerTools.ts or letter service

import { deductCredits } from '../services/creditService.js';
import { getBalance } from '../services/creditService.js';

async function sendLetter(userId: string, letterData: any) {
  const creditsRequired = calculateCredits(letterData.pageCount);

  // Check balance first
  const balance = await getBalance(userId);
  if (balance.credits < creditsRequired) {
    throw new Error(
      `Insufficient credits. Required: ${creditsRequired}, Available: ${balance.credits}`
    );
  }

  // Deduct credits
  const { user, transaction } = await deductCredits({
    userId,
    credits: creditsRequired,
    letterId: letter_id,
    description: `Sent letter to ${letterData.recipient.name}`
  });

  // ... queue letter for processing ...

  return {
    letter_id,
    credits_used: creditsRequired,
    credits_remaining: user.credits
  };
}
```

## Testing

### Manual Testing

```bash
# Start server
npm run mcp:http

# Test endpoints with curl

# 1. Get balance
curl http://localhost:8090/api/credits/balance \
  -H "Authorization: Bearer <jwt_token>"

# 2. Get transactions
curl http://localhost:8090/api/credits/transactions?limit=10 \
  -H "Authorization: Bearer <jwt_token>"

# 3. Get user info
curl http://localhost:8090/api/credits/users/me \
  -H "Authorization: Bearer <jwt_token>"
```

### Database Testing

```typescript
// Create test script: scripts/test-credits.ts

import 'dotenv/config';
import { addCredits, deductCredits, getBalance } from '../src/services/creditService.js';
import { closePool } from '../src/db/index.js';

async function testCreditFlow() {
  const userId = 'test-user-123';
  const email = 'test@example.com';

  console.log('1. Add 20 credits...');
  const add1 = await addCredits({
    userId,
    email,
    credits: 20,
    orderId: 'order_test_1'
  });
  console.log('   Balance:', add1.user.credits);

  console.log('\n2. Deduct 2 credits...');
  const deduct1 = await deductCredits({
    userId,
    credits: 2,
    letterId: 'letter_test_1'
  });
  console.log('   Balance:', deduct1.user.credits);

  console.log('\n3. Check final balance...');
  const balance = await getBalance(userId);
  console.log('   Balance:', balance.credits);
  console.log('   Purchased:', balance.credits_purchased);
  console.log('   Used:', balance.credits_used);

  await closePool();
}

testCreditFlow().catch(console.error);
```

## Error Handling

Common errors to handle:

```typescript
try {
  await deductCredits({ ... });
} catch (error) {
  if (error.message.includes('Insufficient credits')) {
    // Show user they need to purchase more credits
    return { error: 'insufficient_credits', ... };
  } else if (error.message.includes('User not found')) {
    // Create user or return auth error
    return { error: 'user_not_found', ... };
  } else {
    // Generic error
    return { error: 'internal_error', ... };
  }
}
```

## Security Considerations

1. **Always use transactions** for credit operations to prevent race conditions
2. **Use FOR UPDATE** when checking balances to lock the row
3. **Validate JWT tokens** before any credit operation
4. **Log all transactions** for audit trail
5. **Never trust client-side credit amounts** - always calculate server-side

## Next Steps

After implementing Credit API:

1. ✅ Credit Service functions implemented
2. ✅ Express routes configured
3. ✅ Integrated with ACP checkout
4. ✅ Integrated with MCP send letter tool
5. 📝 Job Queue implementation (pg-boss)
6. 📝 Admin API for monitoring

See `docs/job-queue-implementation.md` for next phase.
