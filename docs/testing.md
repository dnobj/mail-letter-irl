# Testing Guide

**Last Updated:** September 16, 2026
**Purpose:** Test suites, commands, CI jobs, and conventions for Letter IRL

Changes to financial, balance, order, draft, fulfillment, refund, or administrative mutations must also satisfy the commit, rollback, replay, crash/recovery, and concurrency coverage in the [ACID Transaction Standard](acid-transaction-standard.md). Mock-based unit tests alone do not prove database locking, constraints, isolation, or rollback behavior.

---

## Overview

| Suite | Location | Needs | Proves |
| --- | --- | --- | --- |
| **Unit** | `tests/unit/**` | nothing external; the database is mocked | business logic, tool contracts, widgets, config validation |
| **Submission** | a subset of unit tests (`npm run test:submission`) | nothing external | manifest, tool registration, widget resources, OAuth metadata |
| **PostgreSQL integration** | `tests/integration/**` (`*.postgres.test.ts`, `admin/`) | a disposable local PostgreSQL | locking, constraints, isolation, rollback, migrations, least-privilege grants |
| **Manual** | [manual-tests.md](manual-tests.md) | the deployed development (or production) environment | ChatGPT flows, widgets, OAuth, payments, operator panel |

There are no automated end-to-end tests against live Stripe or PostGrid.

---

## Test Stack

- **Test Runner:** [Vitest](https://vitest.dev/)
- **Mocking:** Vitest built-in `vi.mock()` and `vi.fn()`; `tests/mocks/database.ts`
- **Coverage:** `@vitest/coverage-v8`
- **Global setup:** `tests/setup.ts` loads `.env.test`, sets `NODE_ENV=test`, and turns the beta gate off unless a test turns it on

Test files are **not type-checked**: `tsconfig.json` includes only `src/`, and Vitest strips types.
A test that hand-builds an object whose type gained a field still compiles and fails only when it
runs. After changing a shared type, update every hand-built instance under `tests/` in the same commit.

---

## Running Tests

```bash
# Lint, build, unit and submission tests - the CI `checks` job
npm run verify

# Unit tests only
npm run test:unit

# Submission-facing tests (`npm run check:submission` adds lint)
npm run test:submission

# All suites once; the PostgreSQL suites skip without their environment variables
npm run test:run

# Watch mode
npm test

# PostgreSQL suites against a local database - the CI `postgres-integration` job
npm run test:integration:local

# Coverage report
npm run test:coverage
```

### PostgreSQL integration suites

The suites skip silently unless `LIRL_RUN_POSTGRES_INTEGRATION=true`. They refuse to run unless the
database is on a local host, its name contains `test` or `acid`, `NODE_ENV` is not production, and
the URL differs from the application `DATABASE_URL`. Never point them at Neon.

`npm run test:integration:local` (`scripts/run-integration-local.ts`) sets the flag, creates the
databases, and runs the suites. It reads connection details from the environment or from an ignored
`.env.integration.local`:

```bash
LIRL_TEST_DATABASE_URL=postgres://postgres:PASSWORD@127.0.0.1:5432/letterirl_test
LETTER_IRL_ADMIN_TEST_DATABASE_URL=postgres://postgres:PASSWORD@127.0.0.1:5432/letterirl_admin_test
```

Use PostgreSQL 17 to match production. See [tests/integration/README.md](../tests/integration/README.md)
for what the suites cover.

The admin foundation specs under `tests/integration/admin/` read migrations 021, 022 and 023 only from
this repository's `db/migrations`; there is no path override, so a synthetic
`021_jit_commerce_foundation.sql` cannot be substituted. `adminFoundationDatabase.test.ts` proves the
`001-020 -> 021 -> 022` sequence and the constraint, immutability, and least-privilege behavior of
migration 022. `adminMigrationOrder.test.ts` proves that `001-020 -> 021 -> 023 -> 022` and
`001-020 -> 021 -> 022 -> 023` converge on identical columns, constraints, defaults, indexes,
triggers, functions, and table privileges, and that 022 fails closed when 021 is absent. See the
[migration 021/022/023 integration gate](deployment.md#migration-021022023-integration-gate).

---

## Test Directory Structure

```
tests/
├── setup.ts            # Global test setup
├── mocks/
│   └── database.ts     # Database mocking utilities
├── fixtures/           # admin, credits, layouts, letters, postcards, promos, tokens, users
├── unit/
│   ├── admin/          # Operator panel: auth, sessions, pages, commands
│   ├── api/            # REST handlers
│   ├── auth/           # Token validation, scopes, OAuth metadata, beta access
│   ├── cli/            # Maintenance and migrator entry points
│   ├── config/         # Deployment validation, products
│   ├── db/             # Pool and wake-up retry
│   ├── mcp/            # Registration, manifest, widget resources, submission readiness
│   ├── middleware/     # Rate limiting
│   ├── repo/           # Repository invariants (Vitest config, CI integration gate)
│   ├── scripts/        # Operational scripts
│   ├── services/       # Domain services
│   ├── tools/          # MCP tool handlers
│   ├── utils/          # Diagnostics, env parsing
│   ├── widgets/        # Widget HTML behavior (jsdom)
│   └── workers/        # Daily maintenance
└── integration/
    ├── admin/          # Admin migration and grant proofs
    ├── support/        # Shared disposable-database helpers
    └── *.postgres.test.ts
```

Tests mirror the source tree: `src/services/creditLedgerService.ts` is tested in
`tests/unit/services/creditLedgerService.test.ts`.

---

## Test Fixtures

### Users (based on Personas)

```typescript
import { testUsers } from "../../fixtures/users";

testUsers.sarah; // Occasional sender (4 credits)
testUsers.marcus; // Regular correspondent (10 credits)
testUsers.eleanor; // Legacy connector (2 credits)
testUsers.david; // Business user (50 credits)
testUsers.alex; // Promo hunter (promo credits only)
testUsers.newUser; // New user (0 credits)
```

### Credit Ledger Entries

```typescript
import {
  createLedgerEntry,
  createFIFOTestEntries,
} from "../../fixtures/credits";

// Single entry
const entry = createLedgerEntry(userId, 10, {
  sourceType: "purchase",
  expiresInDays: 730,
});

// FIFO test set (ordered by expiration)
const entries = createFIFOTestEntries(userId);
```

### Letters and Drafts

```typescript
import {
  testDrafts,
  testAddresses,
  testLetterContent,
} from "../../fixtures/letters";

// Pre-built draft scenarios
testDrafts.pending(); // Valid pending draft
testDrafts.consumed(); // Already used (idempotency test)
testDrafts.expired(); // Past expiration
testDrafts.cancelled(); // Cancelled by user
testDrafts.differentUser(); // Belongs to another user
```

---

## Mocking Database

For unit tests, mock the database layer:

```typescript
import { vi, beforeEach } from "vitest";

// Mock before importing the service
vi.mock("../../../src/db/index.js", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

import * as db from "../../../src/db/index.js";
import { someFunction } from "../../../src/services/myService.js";

describe("myService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should do something", async () => {
    // Setup mock response
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: 1, name: "test" }],
      rowCount: 1,
    });

    // Call the function
    const result = await someFunction();

    // Verify
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("SELECT"),
      expect.any(Array),
    );
  });
});
```

---

## External Service Testing Strategy

### Stripe (Test Mode)

Automated tests mock Stripe and must not reach it. For manual testing against development, use
test-mode keys:

```bash
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

Test cards:

- `4242424242424242` - Success
- `4000000000000002` - Declined
- `4000000000009995` - Insufficient funds

Forward webhooks to a local server:

```bash
stripe listen --forward-to localhost:8090/webhooks/stripe
```

### PostGrid (Test Mode)

```bash
LETTER_PROVIDER=postgrid
LETTER_PROVIDER_API_KEY=test_sk_...
LETTER_PROVIDER_CONFIG={"mode":"test"}
```

Use `LETTER_PROVIDER_API_KEY`. The provider factory also reads `POSTGRID_API_KEY`, and **prefers it when
both are set**, but the boot validator checks only `LETTER_PROVIDER_API_KEY`, so a production service
with only `POSTGRID_API_KEY` is refused (`provider.api_key_required`). Do not set both. Test mode returns realistic responses without mailing anything. For local work with no
provider at all, use the [dummy provider](testing-dummy-provider.md). See also
[testing-postgrid.md](testing-postgrid.md).

### Auth0

For unit tests, mock JWT validation. The integration suites do not need tokens. End-to-end OAuth is
tested manually against the deployed development environment ([manual-tests.md](manual-tests.md)).

---

## User Story Coverage

Unit test files name the user stories they cover in their header comment (see the template below).
[user-stories.md](user-stories.md) holds the stories and their acceptance criteria.

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

A change to a financial or state-changing mutation also needs a PostgreSQL suite case; follow the
existing `*.postgres.test.ts` files and their `tests/integration/support/` helpers.

---

## CI

`.github/workflows/ci.yml` runs on every pull request to `dev` or `master`, on every push to `dev`,
and on manual dispatch. It uses no secrets.

| Job | Steps |
| --- | --- |
| `checks` | `npm ci`, `npm run lint`, `npm run build`, `npm run test:unit`, `npm run test:submission` |
| `postgres-integration` | a `postgres:17` service; creates `letterirl_test` and `letterirl_admin_test`; runs `npm run test:integration` with `LIRL_RUN_POSTGRES_INTEGRATION=true`; then `.github/scripts/assert-integration-ran.mjs` fails the job if the PostgreSQL suites skipped |

Both jobs use Node 22, matching Railway. The integration report is uploaded as an artifact for 14 days.

---

## Coverage

Run `npm run test:coverage` for current figures. Hand-maintained counts go stale, so this document
does not keep one.

---

## See Also

- [ACID Transaction Standard](acid-transaction-standard.md) - required coverage for mutations
- [manual-tests.md](manual-tests.md) - manual acceptance cases and their run records
- [user-stories.md](user-stories.md) - user stories with acceptance criteria
- [personas.md](personas.md) - test personas
