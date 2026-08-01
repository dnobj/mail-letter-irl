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

Each new or changed mutation needs tests proportional to its risk. At minimum, cover:

- successful commit and rollback at each meaningful failure point;
- two concurrent requests contending for the same draft, balance, order, refund, or job;
- replay of the same client request, webhook event, and outbox job;
- process failure after local commit but before the vendor call;
- timeout or crash after the vendor may have accepted the request but before Letter IRL records the response;
- stale outbox claim recovery and bounded retry exhaustion;
- constraint and invalid-transition rejection;
- reconciliation of deliberately inconsistent local/vendor fixtures.

Prefer integration tests against PostgreSQL for locking, constraint, isolation, and rollback behavior. Unit tests with mocked queries cannot prove those properties.

## Pull request review checklist

For every PR that changes durable business state, the author and reviewer must confirm:

- [ ] The business invariant and owner row/aggregate are identified.
- [ ] All required local writes share one explicit transaction and database client.
- [ ] Mutable preconditions are checked under a lock, conditional write, or justified isolation level.
- [ ] Database constraints enforce invariants that must survive application bugs or concurrency.
- [ ] Lock ordering is deterministic, and serialization/deadlock retries are bounded and idempotent.
- [ ] Success is returned only after commit; failure cannot leave partial local state.
- [ ] External calls occur outside the PostgreSQL transaction through a durable, resumable workflow.
- [ ] Stable idempotency keys, guarded state transitions, compensation, and reconciliation are defined for external effects.
- [ ] Financial, fulfillment, refund, and admin audit history is retained without logging unnecessary personal or secret data.
- [ ] Commit, rollback, replay, crash/recovery, and concurrency tests cover the changed invariant.
- [ ] Migration and rollback/forward-fix behavior preserve existing data and in-flight work.

If any item does not apply, the PR must state why. A reviewer should block a mutation that cannot explain its failure and concurrency behavior.
