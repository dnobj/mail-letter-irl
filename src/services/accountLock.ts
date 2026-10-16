import type pg from 'pg';

/**
 * Canonical lock order for every transaction that mutates account balances,
 * grants, or entitlements:
 *
 *   letter_drafts -> orders -> letters -> letter_jobs
 *          -> image_generation_reservations -> users -> credit_ledger
 *          -> image_entitlements
 *
 * The order is for rows that already exist. Inserting a new row (a letter, its
 * job, a ledger lot) may follow the account lock: no other transaction can
 * hold the new row, and its foreign-key share lock on the account is then
 * already covered by the account lock held. A send takes the account before
 * inserting its letter for that reason (#730): inserted first, the letter's
 * share lock on the account would make two sends from one account each wait
 * for the other's to take it FOR UPDATE.
 *
 * A draft comes before its orders (#730): a prepaid send and a checkout's
 * preparation lock the draft and then the draft's orders, and the paid
 * fulfilment finds its order unlocked, locks the draft, then the order
 * (commerceService lockDraftThenOrder).
 *
 * A draft is locked FOR NO KEY UPDATE, not FOR UPDATE (#730 review): the
 * draft's holders still take turns, but the share lock a foreign-key check
 * takes on it is not blocked. PostgreSQL re-checks an order's key to its
 * draft when a transaction updates the same order row twice (a refund, then
 * clearing its hold), and that check comes after the order and the account;
 * against a draft held FOR UPDATE by a path waiting for the order (a payment's
 * fulfilment, an erasure) or the account (a draft edit), the two would
 * deadlock.
 * The same holds for every implicit lock: an UPDATE's foreign-key re-check
 * counts as taking the referenced row after the row it updates. The stronger
 * lock is left to a statement that deletes drafts, when it runs, and to the
 * retention sweeps, which skip a locked draft and wait on nothing while they
 * hold one.
 *
 * One path runs against it: restoring quarantined content (retentionService)
 * locks the saved copy in redacted_content_quarantine before its draft or
 * letter. It runs only in the maintenance run, before that run's erasures,
 * so it meets an erasure only if two runs overlap, and both retry a lock
 * conflict.
 *
 * `users` is the account aggregate root. Locking it first is what makes the
 * rest of the order safe: `credit_ledger` and `image_entitlements` rows are
 * only ever reached while the owning account row is already held, so two
 * transactions touching the same account can never acquire the same pair of
 * rows in opposite directions.
 *
 * Historically some paths locked `credit_ledger` or `image_entitlements`
 * first - directly via `FOR UPDATE`, or implicitly via a bare `UPDATE` - which
 * inverted against the deduction and grant paths and could deadlock a refund
 * against a concurrent send or image reservation. Call this helper before the
 * first ledger or entitlement statement in any such transaction.
 *
 * The lock is deliberately taken with a `SELECT ... FOR UPDATE` rather than a
 * no-op `UPDATE` so it never touches `updated_at` and never fails when the
 * account row does not exist.
 *
 * This makes two transactions touching the *same* account safe. A transaction
 * that spans several accounts must additionally visit them in a deterministic
 * account order, or two such transactions can still invert against each other;
 * `reconcileGenerationReservations` is the only such path and orders by
 * `user_id` for exactly that reason.
 */
export async function lockAccountForBalanceChange(
  client: Pick<pg.PoolClient, 'query'>,
  userId: string
): Promise<void> {
  await client.query('SELECT user_id FROM users WHERE user_id = $1 FOR UPDATE', [userId]);
}
