import type pg from "pg";

/**
 * The last accepted TOTP counter, by key (#730): an operator's login while
 * each operator has a secret of their own, or one shared key under the legacy
 * shared secret. A code is accepted only for a counter above the stored one,
 * so a code cannot be used twice within its window.
 *
 * It used to live in the process's memory, so a restart, or a second process,
 * forgot which codes had been used. The database keeps it: admin_totp_counters
 * (migration 063), written by the operator role.
 */
export interface TotpCounterStore {
  /** The last counter accepted for this key, or null if none. */
  lastCounter(key: string): Promise<number | null>;
  /**
   * Records `counter` as accepted for this key, only if it is above the one
   * stored, in one statement. False when a counter at or above it is already
   * recorded: the code was used, here or by another process, in the meantime.
   */
  claim(key: string, counter: number): Promise<boolean>;
}

/** For tests, and a process with no database: the old in-memory behaviour. */
export class MemoryTotpCounterStore implements TotpCounterStore {
  private readonly counters = new Map<string, number>();

  async lastCounter(key: string): Promise<number | null> {
    return this.counters.get(key) ?? null;
  }

  async claim(key: string, counter: number): Promise<boolean> {
    const last = this.counters.get(key);
    if (last !== undefined && last >= counter) return false;
    this.counters.set(key, counter);
    return true;
  }
}

/** The database store, on the operator role's pool. */
export function databaseTotpCounterStore(pool: Pick<pg.Pool, "query">): TotpCounterStore {
  return {
    async lastCounter(key) {
      const result = await pool.query<{ last_counter: string }>(
        "SELECT last_counter FROM admin_totp_counters WHERE counter_key = $1",
        [key],
      );
      const row = result.rows[0];
      return row ? Number(row.last_counter) : null;
    },
    async claim(key, counter) {
      // One statement: two processes accepting the same code race on the
      // row, and only the first raises it.
      const result = await pool.query(
        `INSERT INTO admin_totp_counters (counter_key, last_counter, updated_at)
         VALUES ($1, $2::bigint, NOW())
         ON CONFLICT (counter_key) DO UPDATE
           SET last_counter = EXCLUDED.last_counter, updated_at = NOW()
           WHERE admin_totp_counters.last_counter < EXCLUDED.last_counter
         RETURNING counter_key`,
        [key, counter],
      );
      return (result.rowCount ?? 0) > 0;
    },
  };
}
