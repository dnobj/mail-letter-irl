import type pg from 'pg';

/**
 * Canonical lock order for every transaction that mutates account balances,
 * grants, or entitlements:
 *
 *   orders -> letters -> letter_jobs -> image_generation_reservations
 *          -> users -> credit_ledger -> image_entitlements
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
 */
export async function lockAccountForBalanceChange(
  client: Pick<pg.PoolClient, 'query'>,
  userId: string
): Promise<void> {
  await client.query('SELECT user_id FROM users WHERE user_id = $1 FOR UPDATE', [userId]);
}
