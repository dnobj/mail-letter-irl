# Testing Guide

**Last Updated:** December 4, 2025

This document describes the testing strategy and infrastructure for Letter IRL.

---

## Overview

Letter IRL uses a **hybrid testing approach**:

| Test Type | External Services | Speed | Purpose |
|-----------|------------------|-------|---------|
| **Unit Tests** | Mocked | ~100ms | Business logic in isolation |
| **Integration Tests** | Test Mode APIs | ~1-3s | Real API contracts |
| **E2E Tests** | Test Mode APIs | ~5-10s | Full system verification |

---

## Test Stack

- **Test Runner:** [Vitest](https://vitest.dev/) - Fast, TypeScript-native, Jest-compatible
- **Mocking:** Vitest built-in `vi.mock()` and `vi.fn()`
- **Coverage:** `@vitest/coverage-v8`

---

## Running Tests

```bash
# Run all tests in watch mode
npm test

# Run all tests once (CI mode)
npm run test:run

# Run only unit tests
npm run test:unit

# Run only integration tests
npm run test:integration

# Run with coverage report
npm run test:coverage
```

---

## Test Directory Structure

```
tests/
├── setup.ts                    # Global test setup
├── mocks/
│   └── database.ts             # Database mocking utilities
├── fixtures/
│   ├── users.ts                # Test user data (personas)
│   ├── credits.ts              # Credit ledger entries
│   └── letters.ts              # Letters, drafts, addresses
├── unit/
│   └── services/
│       ├── creditLedgerService.test.ts
│       └── draftService.test.ts
└── integration/
    ├── api/                    # API endpoint tests
    └── flows/                  # End-to-end flow tests
```

---

## Test Fixtures

### Users (based on Personas)

```typescript
import { testUsers } from '../../fixtures/users';

testUsers.sarah    // Occasional sender (4 credits)
testUsers.marcus   // Regular correspondent (10 credits)
testUsers.eleanor  // Legacy connector (2 credits)
testUsers.david    // Business user (50 credits)
testUsers.alex     // Promo hunter (promo credits only)
testUsers.newUser  // New user (0 credits)
```

### Credit Ledger Entries

```typescript
import { createLedgerEntry, createFIFOTestEntries } from '../../fixtures/credits';

// Single entry
const entry = createLedgerEntry(userId, 10, {
  sourceType: 'purchase',
  expiresInDays: 730,
});

// FIFO test set (ordered by expiration)
const entries = createFIFOTestEntries(userId);
```

### Letters and Drafts

```typescript
import { testDrafts, testAddresses, testLetterContent } from '../../fixtures/letters';

// Pre-built draft scenarios
testDrafts.pending()      // Valid pending draft
testDrafts.consumed()     // Already used (idempotency test)
testDrafts.expired()      // Past expiration
testDrafts.cancelled()    // Cancelled by user
testDrafts.differentUser() // Belongs to another user
```

---

## Mocking Database

For unit tests, mock the database layer:

```typescript
import { vi, beforeEach } from 'vitest';

// Mock before importing the service
vi.mock('../../../src/db/index.js', () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

import * as db from '../../../src/db/index.js';
import { someFunction } from '../../../src/services/myService.js';

describe('myService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should do something', async () => {
    // Setup mock response
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 1, name: 'test' }],
      rowCount: 1,
    });

    // Call the function
    const result = await someFunction();

    // Verify
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT'),
      expect.any(Array)
    );
  });
});
```

---

## External Service Testing Strategy

### Stripe (Test Mode)

For integration tests, use Stripe test mode:

```bash
# .env.test
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

Test cards:
- `4242424242424242` - Success
- `4000000000000002` - Declined
- `4000000000009995` - Insufficient funds

Forward webhooks locally:
```bash
stripe listen --forward-to localhost:8788/api/stripe/webhook
```

### PostGrid (Test Mode)

```bash
# .env.test
POSTGRID_API_KEY=test_sk_...
```

Test mode returns realistic responses without actually mailing letters.

### Auth0

For unit tests, mock JWT validation. For integration tests, you can use test tokens or mock the JWKS endpoint.

---

## User Story Coverage

Tests are mapped to user stories from [user-stories.md](user-stories.md):

| Test File | User Stories |
|-----------|--------------|
| `creditLedgerService.test.ts` | US-2.1, US-2.3, US-2.7 |
| `draftService.test.ts` | US-1.1, US-1.3, US-6.1, US-6.7 |

---

## Writing New Tests

### Unit Test Template

```typescript
/**
 * Unit tests for [serviceName]
 *
 * User Stories Covered:
 * - US-X.X: Story title
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testUsers } from '../../fixtures/users.js';

// Mock database before import
vi.mock('../../../src/db/index.js', () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

import * as db from '../../../src/db/index.js';
import { functionToTest } from '../../../src/services/myService.js';

describe('myService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('functionToTest', () => {
    it('should handle happy path', async () => {
      // Arrange
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [...], rowCount: 1 });

      // Act
      const result = await functionToTest(testUsers.sarah.user_id);

      // Assert
      expect(result).toBeDefined();
      expect(db.query).toHaveBeenCalled();
    });

    it('should handle error case', async () => {
      // Arrange
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [], rowCount: 0 });

      // Act & Assert
      await expect(functionToTest('bad-input')).rejects.toThrow('Expected error');
    });
  });
});
```

---

## CI/CD Integration

Tests run automatically on push/PR:

```yaml
# .github/workflows/test.yml
name: Tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npm run test:run
```

Integration tests with real APIs require secrets:

```yaml
  integration-tests:
    if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository
    env:
      STRIPE_SECRET_KEY: ${{ secrets.STRIPE_TEST_KEY }}
      POSTGRID_API_KEY: ${{ secrets.POSTGRID_TEST_KEY }}
```

---

## Current Coverage

| Service | Unit Tests | Integration Tests |
|---------|------------|-------------------|
| creditLedgerService | 19 tests | - |
| draftService | 17 tests | - |
| creditService | - | - |
| letterJobService | - | - |
| stripeService | - | - |
| promoService | - | - |

**Total: 36 tests**

---

## See Also

- [user-stories.md](user-stories.md) - User stories with acceptance criteria
- [personas.md](personas.md) - Test personas
- [engineering-plan.md](engineering-plan.md) - Testing strategy recommendations
