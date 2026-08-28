# ACID Transaction Standard

ACID—**Atomicity, Consistency, Isolation, and Durability**—is the guiding principle for every Letter IRL operation that changes durable business state. This standard applies to financial balances and ledger entries, purchases and orders, drafts, letters and postcards, fulfillment jobs, refunds, promotions, image quota reservations, and administrative mutations.

The goal is not merely to use a database transaction. After failures, retries, concurrent requests, and process restarts, the database must still describe one valid business outcome.

## Required properties

### Atomicity

All PostgreSQL changes needed to establish one business outcome commit together or roll back together. A transaction must include every dependent local write, such as:

- a balance change and its immutable ledger/audit entry;
- draft consumption, letter creation, credit deduction, and outbox insertion;
- a refund record, its ledger effect, and the resulting order state;
- an administrative mutation and its audit record.

Never expose success before the transaction commits. Do not split required writes across helper functions that silently open independent transactions. Helpers used inside a transaction should accept and use the caller's database client.

### Consistency

Every commit must preserve domain invariants. Enforce invariants in PostgreSQL whenever possible with `NOT NULL`, `CHECK`, foreign-key, and unique constraints; application validation supplements these constraints but does not replace them.

Examples include no negative spendable balance, one consumed outcome per draft, one outbox row per letter, one application per provider event or idempotency key, valid state transitions, and ledger totals that reconcile with cached balances. A constraint violation is a rejected operation, not a partially successful one.

### Isolation

Concurrent requests must behave as though conflicting mutations occurred in a safe serial order. Lock the aggregate that owns the invariant before reading and writing it—for example, the user or relevant ledger rows for a balance mutation, and the draft for a confirmed send. Use conditional writes, unique constraints, or an appropriate PostgreSQL isolation level where they express the invariant more directly.

Acquire multiple locks in a stable order. Avoid check-then-write logic outside the transaction. Treat serialization failures and deadlocks as retryable only with a bounded retry policy; the retry must reuse the same business idempotency key.

### Durability

Once Letter IRL reports a committed mutation, the authoritative PostgreSQL state and any durable follow-up work must survive a process crash or restart. In-memory flags, queues, and caches are not authoritative. Required asynchronous work must be represented durably, normally by an outbox row written in the same transaction as the state change that requires it.

## Transaction boundary

Define the invariant and transaction boundary before implementing a mutation. Keep the transaction focused on PostgreSQL reads and writes:

1. Validate request shape and authentication before opening the transaction when that validation does not depend on mutable state.
2. Begin one transaction and lock or conditionally select the rows that own the invariant.
3. Revalidate mutable preconditions inside the transaction.
4. Write all state, ledger/audit records, and required outbox work through the same database client.
5. Commit, then report the durable local result.
6. Perform external work from the committed outbox or another resumable workflow.

Do not hold database locks while waiting on network calls, image processing, or other slow work. If information from an external system is required, obtain it before the transaction, then revalidate any affected local assumptions while committing.

## External systems: Stripe and PostGrid

An external vendor call **cannot be part of a single PostgreSQL ACID transaction**. A database rollback cannot undo a Stripe charge or a PostGrid submission, and a database commit cannot prove that a timed-out vendor request did not succeed. Therefore Letter IRL does not claim exactly-once execution across systems.

Use a resumable state machine instead:

- Commit the local intent and a transactional outbox record together.
- Give each logical operation a stable, persisted idempotency key and reuse it for every retry. Never generate the key inside a retry loop.
- Call the vendor only after the local transaction commits.
- Record vendor identifiers and state transitions with uniqueness and transition guards.
- Make Stripe webhook processing idempotent by provider event and business object identifiers.
- Submit PostGrid work from the durable outbox using the stable letter identifier as the provider idempotency key.
- On timeout or ambiguous response, query or reconcile vendor state before creating a replacement operation.

When local and vendor state cannot be made identical immediately, use an explicit compensating action, such as recording a refund obligation, releasing a reservation, restoring credits, or scheduling operator review. Compensation is itself an idempotent, audited state transition; it is not deletion of history. Scheduled reconciliation must detect stuck, missing, duplicate, and contradictory states and either repair them safely or surface them for review.

## Mutation-specific expectations

- **Balances and financial records:** Lock the owning account and affected ledger rows, preserve an append-only audit trail, and update any cached balance in the same transaction. Monetary values use integer minor units or another exact representation.
- **Orders, drafts, and sends:** Lock and revalidate the draft. One transaction consumes it, records funding, creates the letter or postcard, and inserts one outbox row. A replay returns the original outcome rather than spending or mailing again.
- **Fulfillment:** Claim outbox rows atomically with guarded transitions such as `FOR UPDATE SKIP LOCKED`. Retries preserve the same row, attempt history, backoff, and provider idempotency key.
- **Refunds and reversals:** Deduplicate vendor events and operator requests. Link reversal entries to the original financial record and keep order, ledger, and audit state consistent.
- **Administrative mutations:** Use the same domain service and invariants as user-facing paths. Authorization, confirmation, guarded state changes, and the audit entry are required; direct table edits must not bypass them.

## Required tests

Each new or changed mutation needs tests proportional to its risk and to the boundaries it changes. Every mutation must cover the following where applicable:

- successful commit and rollback at each meaningful failure point;
- the affected invariant, constraint, and invalid-transition rejection;
- concurrent requests contending for the same aggregate when conflicts are possible;
- client-request replay or recovery when the operation is retryable or asynchronous.

When a change affects a webhook, outbox, vendor call, compensation, or reconciliation boundary, it must also cover the applicable boundary scenarios:

- replay of the same webhook event or outbox job;
- process failure after local commit but before the vendor call;
- timeout or crash after the vendor may have accepted the request but before Letter IRL records the response;
- stale outbox claim recovery and bounded retry exhaustion;
- reconciliation of deliberately inconsistent local/vendor fixtures.

A PR may mark a scenario not applicable only when it gives a concrete reason. Risk-proportional coverage does not permit omitting a local or external-boundary failure mode introduced or changed by the PR.

Prefer integration tests against PostgreSQL for locking, constraint, isolation, and rollback behavior. Unit tests with mocked queries cannot prove those properties.

### The real-PostgreSQL suite is a required gate, not an optional extra

`npm run test:run` does **not** execute `tests/integration/commerceAcid.postgres.test.ts`. That
suite is opt-in and silently *skips* unless `LIRL_RUN_POSTGRES_INTEGRATION=true` is set, and this
repository has no CI. A green default test run is therefore **not** evidence of any locking,
constraint, isolation, migration, or rollback property.

Any PR that changes a financial, fulfillment, refund, entitlement, migration, or admin mutation
must run the suite against a disposable local PostgreSQL and record the real pass count in its
evidence. Reporting only `npm run test:run` for such a change is incomplete evidence.

```bash
docker run -d --name lirl-acid -e POSTGRES_PASSWORD=lirl_test_password \
  -e POSTGRES_DB=letterirl_acid_test -p 127.0.0.1:55432:5432 postgres:16-alpine
export LIRL_RUN_POSTGRES_INTEGRATION=true
export LIRL_TEST_DATABASE_URL='postgresql://postgres:lirl_test_password@127.0.0.1:55432/letterirl_acid_test'
npm run test:integration:postgres
docker rm -f lirl-acid
```

The suite refuses to run against a non-local host, a database whose name contains neither `test`
nor `acid`, `NODE_ENV=production`, or the application `DATABASE_URL`.

## Canonical lock order

Every transaction that mutates account balances, grants, or entitlements acquires locks in exactly
this order:

```
orders -> letters -> letter_jobs -> image_generation_reservations
       -> users -> credit_ledger -> image_entitlements
```

`users` is the account aggregate root: holding it first is what makes the ledger and entitlement
rows below it safe. Note that a bare `UPDATE` takes the same row lock as `SELECT ... FOR UPDATE`,
so an unguarded `UPDATE credit_ledger` or `UPDATE image_entitlements` counts as taking that lock
first and inverts the order. Call `lockAccountForBalanceChange` (`src/services/accountLock.ts`)
before the first ledger or entitlement statement.

Within the mail graph, take the funding order lock from `lockFundingGraph` and then address that
order by its `order_id`. Re-deriving the order from `letter_id` in a later `UPDATE ... WHERE
letter_id = $1` writes a row outside the lock you actually hold.

## Pull request review checklist

For every PR that changes durable business state, the author and reviewer must confirm:

- [ ] The business invariant and owner row/aggregate are identified.
- [ ] All required local writes share one explicit transaction and database client.
- [ ] Mutable preconditions are checked under a lock, conditional write, or justified isolation level.
- [ ] Database constraints enforce invariants that must survive application bugs or concurrency.
- [ ] Lock ordering follows the canonical order above, including locks taken implicitly by bare `UPDATE` statements, and serialization/deadlock retries are bounded and idempotent.
- [ ] The real-PostgreSQL suite was run for financial, fulfillment, refund, entitlement, migration, or admin changes, and its actual pass count is in the PR evidence.
- [ ] Success is returned only after commit; failure cannot leave partial local state.
- [ ] External calls occur outside the PostgreSQL transaction through a durable, resumable workflow.
- [ ] Stable idempotency keys, guarded state transitions, compensation, and reconciliation are defined for external effects.
- [ ] Financial, fulfillment, refund, and admin audit history is retained without logging unnecessary personal or secret data.
- [ ] Local commit, rollback, invariant, concurrency, and replay/recovery tests cover the changed behavior as applicable.
- [ ] Changes to webhook, outbox, vendor, compensation, or reconciliation boundaries test their applicable failure modes, or the PR records a concrete N/A reason.
- [ ] Migration and rollback/forward-fix behavior preserve existing data and in-flight work.

If any item does not apply, the PR must state why. A reviewer should block a mutation that cannot explain its failure and concurrency behavior.
