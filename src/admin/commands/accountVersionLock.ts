import type pg from "pg";

/**
 * An account command's version, read inside the operator transaction with the
 * account row held until the transaction ends (CommandDefinition.lockVersion,
 * #730). It is the same updated_at the account previews read, through a JS
 * Date as theirs is, so the two compare at the same precision.
 *
 * In the canonical lock order (src/services/accountLock.ts) only draft, order,
 * letter, job and reservation rows come before `users`, and no account command
 * locks any of those: each one takes this row first anyway, or touches the
 * ledger, entitlements or gift letters after it.
 */
export async function lockAccountVersion(client: Pick<pg.PoolClient, "query">, userId: string): Promise<string | null> {
  const result = await client.query<{ updated_at: Date }>("SELECT updated_at FROM users WHERE user_id = $1 FOR UPDATE", [
    userId,
  ]);
  const row = result.rows[0];
  return row ? row.updated_at.toISOString() : null;
}
