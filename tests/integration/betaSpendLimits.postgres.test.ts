import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import { repositoryMigrations, validateDisposableDatabaseUrl } from './support/disposableDatabase.js';

/**
 * The daily spend ceilings, against real PostgreSQL (#179).
 *
 * The unit tests drive the arithmetic through a fake client, so they prove the
 * comparisons and the fail-closed direction but say nothing about whether the
 * SQL runs. That gap is exactly where this repository's defects come from:
 * migration 027 shipped two bugs across three revisions that three rounds of
 * careful reading missed, and both surfaced only when CI ran a real database.
 *
 * What only a real database can settle here:
 *
 *   - `created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')` against a
 *     TIMESTAMP column. The obvious spelling, copied from
 *     countGenerationsToday, compares a TIMESTAMP against a timestamptz and
 *     converts through the session time zone - silently moving the day
 *     boundary. Whether the version written here plans at all, and whether it
 *     puts the boundary where it claims, is not something reading establishes.
 *     A near-identical mistake - one parameter bound to both a varchar column
 *     and a bare literal - is what made every refund throw in #188.
 *
 *   - That the aggregate returns the row shape the caller parses. `countOf`
 *     fails CLOSED on anything it cannot read, so a column-name mismatch would
 *     refuse every send in production while every unit test stayed green.
 *
 * Deliberately NOT covered here: the transaction rollback after a refused
 * send. That needs the whole draft-and-funding fixture, and the unit suite
 * already asserts the deduction happened and the draft returned to `pending`.
 */

const { Pool } = pg;
const enabled = process.env.LIRL_RUN_POSTGRES_INTEGRATION === 'true';
const describePostgres = enabled ? describe : describe.skip;

function schemaName(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function databaseUrlForSchema(baseUrl: string, schema: string): string {
  const parsed = new URL(baseUrl);
  parsed.searchParams.set('options', `-c search_path=${schema},public`);
  return parsed.toString();
}

describePostgres('beta spend limits', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let schema: string;
  let limits: typeof import('../../src/services/betaSpendLimits.js');
  let closeServicePool: (() => Promise<void>) | undefined;

  const USER = 'auth0|spend-limits-user';
  const OTHER = 'auth0|spend-limits-other';

  beforeAll(async () => {
    const baseUrl = validateDisposableDatabaseUrl(process.env.LIRL_TEST_DATABASE_URL);
    adminPool = new Pool({ connectionString: baseUrl });
    schema = schemaName('lirl_spendlimits');
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const scoped = databaseUrlForSchema(baseUrl, schema);
    await migrate({ connectionString: scoped, migrationsDirectory: repositoryMigrations });
    pool = new Pool({ connectionString: scoped, max: 4 });

    process.env.DATABASE_URL = scoped;
    limits = await import('../../src/services/betaSpendLimits.js');
    closeServicePool = (await import('../../src/db/index.js')).closePool;

    for (const userId of [USER, OTHER]) {
      await pool.query(
        `INSERT INTO users (user_id, email, credits, credits_purchased)
         VALUES ($1, $2, 100, 100)`,
        [userId, `${userId.replace(/[^a-z0-9]/gi, '')}@test.invalid`]
      );
    }
  }, 180_000);

  afterEach(async () => {
    await pool.query('DELETE FROM letters');
    await pool.query('DELETE FROM orders');
    delete process.env.LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP;
    delete process.env.LETTER_IRL_BETA_GLOBAL_DAILY_MAIL_CEILING;
    delete process.env.LETTER_IRL_BETA_ACCOUNT_DAILY_CHARGE_CENTS;
    delete process.env.LETTER_IRL_MAIL_SENDING_ENABLED;
  });

  afterAll(async () => {
    await closeServicePool?.();
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }, 60_000);

  /** A letter at an explicit UTC instant, so the day boundary is testable. */
  async function seedLetter(userId: string, createdAtUtc: string): Promise<void> {
    await pool.query(
      `INSERT INTO letters (letter_id, user_id, content, recipient, credits_cost, status, created_at)
       VALUES ($1, $2, '{}'::jsonb, '{}'::jsonb, 1, 'sent', $3::timestamp)`,
      [randomUUID(), userId, createdAtUtc]
    );
  }

  /**
   * Migration 021 made product_code and idempotency_key NOT NULL with no
   * default, and 023's constraint dropped the original 'pending' status. The
   * first version of this fixture predated both and failed in CI - which is
   * the reason this suite exists rather than a mocked one.
   */
  async function seedOrder(
    userId: string,
    amountCents: number,
    createdAtUtc: string,
    status = 'checkout_pending'
  ): Promise<void> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO orders
         (order_id, user_id, credits, amount_cents, status, created_at,
          product_code, idempotency_key)
       VALUES ($1, $2, 1, $3, $4, $5::timestamp, 'credit-pack-4', $6)`,
      [id, userId, amountCents, status, createdAtUtc, 'seed:' + id]
    );
  }

  /** Today and yesterday as UTC wall-clock timestamps, matching the column. */
  function utcDayOffset(days: number, hour = 12): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + days);
    d.setUTCHours(hour, 0, 0, 0);
    return d.toISOString().replace('T', ' ').replace('Z', '');
  }

  it('runs at all, and reads the aggregate it expects', async () => {
    // The whole point. A SQL or column-name fault here would fail CLOSED in
    // production - refusing every send - while the unit suite stayed green.
    const client = await pool.connect();
    try {
      await expect(limits.assertMailWithinDailyCaps(client, USER, 1)).resolves.toBeUndefined();
    } finally {
      client.release();
    }
  });

  it('counts today and ignores yesterday', async () => {
    process.env.LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP = '2';
    // Three yesterday, which must not count, and two today, which fill the cap.
    for (let i = 0; i < 3; i += 1) await seedLetter(USER, utcDayOffset(-1));
    await seedLetter(USER, utcDayOffset(0));
    await seedLetter(USER, utcDayOffset(0));

    const client = await pool.connect();
    try {
      // Two today with inFlight 0 is exactly at the cap.
      await expect(limits.assertMailWithinDailyCaps(client, USER, 0)).resolves.toBeUndefined();
      // The same state with one more in flight is over it - and it is over it
      // because of TODAY's two, not yesterday's three.
      await expect(limits.assertMailWithinDailyCaps(client, USER, 1)).rejects.toMatchObject({
        code: 'ACCOUNT_DAILY_MAIL_CAP'
      });
    } finally {
      client.release();
    }
  });

  it('includes the first minute of the UTC day and excludes the last of the previous', async () => {
    // The boundary itself. A session-time-zone conversion would move this.
    process.env.LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP = '1';
    await seedLetter(USER, utcDayOffset(-1, 23));
    await seedLetter(USER, utcDayOffset(0, 0));

    const client = await pool.connect();
    try {
      // Exactly one row falls inside the window, so a cap of 1 with nothing in
      // flight is satisfied and one more is not.
      await expect(limits.assertMailWithinDailyCaps(client, USER, 0)).resolves.toBeUndefined();
      await expect(limits.assertMailWithinDailyCaps(client, USER, 1)).rejects.toMatchObject({
        code: 'ACCOUNT_DAILY_MAIL_CAP'
      });
    } finally {
      client.release();
    }
  });

  it('scopes the per-account count to the account, and the global one to everybody', async () => {
    process.env.LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP = '5';
    process.env.LETTER_IRL_BETA_GLOBAL_DAILY_MAIL_CEILING = '2';
    await seedLetter(OTHER, utcDayOffset(0));
    await seedLetter(OTHER, utcDayOffset(0));

    const client = await pool.connect();
    try {
      // USER has sent nothing and is far under their own cap, but the day is
      // spent - so the refusal must be the GLOBAL one.
      await expect(limits.assertMailWithinDailyCaps(client, USER, 1)).rejects.toMatchObject({
        code: 'GLOBAL_DAILY_MAIL_CEILING'
      });
    } finally {
      client.release();
    }
  });

  it('counts a cancelled letter like any other', async () => {
    // No status filter, deliberately: a cap that forgives failures is one an
    // error loop walks straight through.
    process.env.LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP = '1';
    await pool.query(
      `INSERT INTO letters (letter_id, user_id, content, recipient, credits_cost, status, created_at)
       VALUES ($1, $2, '{}'::jsonb, '{}'::jsonb, 1, 'cancelled', $3::timestamp)`,
      [randomUUID(), USER, utcDayOffset(0)]
    );

    const client = await pool.connect();
    try {
      await expect(limits.assertMailWithinDailyCaps(client, USER, 1)).rejects.toMatchObject({
        code: 'ACCOUNT_DAILY_MAIL_CAP'
      });
    } finally {
      client.release();
    }
  });

  it('sums today\'s charges and refuses the one that would exceed the cap', async () => {
    process.env.LETTER_IRL_BETA_ACCOUNT_DAILY_CHARGE_CENTS = '6000';
    // Deliberately mixed statuses, totalling 4000 today. An abandoned checkout
    // is still an intent to charge, and a cap that forgave them would let a
    // retry loop walk straight past it.
    await seedOrder(USER, 1500, utcDayOffset(0), 'checkout_pending');
    await seedOrder(USER, 1500, utcDayOffset(0), 'paid');
    await seedOrder(USER, 1000, utcDayOffset(0), 'payment_failed');
    await seedOrder(USER, 5000, utcDayOffset(-1)); // yesterday: must not count
    await seedOrder(OTHER, 5000, utcDayOffset(0)); // another account: must not count

    await expect(limits.assertChargeWithinDailyCap(USER, 2000)).resolves.toBeUndefined();
    await expect(limits.assertChargeWithinDailyCap(USER, 2001)).rejects.toMatchObject({
      code: 'ACCOUNT_DAILY_CHARGE_CAP'
    });
  });

  it('reads zero spend as zero, not as unverifiable', async () => {
    // COALESCE(SUM(...), 0) over no rows returns one row containing 0. If that
    // ever came back empty instead, the fail-closed branch would refuse every
    // purchase by a first-time customer.
    process.env.LETTER_IRL_BETA_ACCOUNT_DAILY_CHARGE_CENTS = '100';
    await expect(limits.assertChargeWithinDailyCap(USER, 100)).resolves.toBeUndefined();
  });

  it('honours the kill switch', async () => {
    process.env.LETTER_IRL_MAIL_SENDING_ENABLED = 'false';
    const client = await pool.connect();
    try {
      await expect(limits.assertMailWithinDailyCaps(client, USER, 1)).rejects.toMatchObject({
        code: 'MAIL_SENDING_DISABLED'
      });
    } finally {
      client.release();
    }
  });

  /**
   * The operator values and the refusal record (migration 038), against real
   * rows: the expiry and clearing filters, the table's own rules, and the
   * counter row that lets many simultaneous refusals open one alert.
   */
  describe('operator values and refusal records', () => {
    afterEach(async () => {
      await (await import('../../src/services/dailyLimits.js')).settleDailyLimitReports();
      await pool.query('DELETE FROM daily_limit_overrides');
      await pool.query('DELETE FROM daily_limit_refusals');
      await pool.query(`DELETE FROM commerce_operational_alerts WHERE alert_type = 'daily_limit_reached'`);
      await pool.query('DELETE FROM daily_limit_defaults');
    });

    async function override(
      limitKey: string,
      value: number,
      options: { userId?: string | null; expiresSql?: string; cleared?: boolean } = {}
    ): Promise<void> {
      await pool.query(
        `INSERT INTO daily_limit_overrides (limit_key, user_id, value, expires_at, cleared_at, cleared_by_command_id)
         VALUES ($1, $2, $3, ${options.expiresSql ?? 'NULL'},
                 ${options.cleared ? 'NOW()' : 'NULL'}, ${options.cleared ? "'run-1'" : 'NULL'})`,
        [limitKey, options.userId ?? null, value]
      );
    }

    /**
     * A refusal in an earlier test records itself without being awaited
     * (reportDailyLimitReached). Wait for every such record to land, then
     * clear it, so a test that counts refusals or alerts sees only its own.
     */
    async function settle(): Promise<void> {
      await (await import('../../src/services/dailyLimits.js')).settleDailyLimitReports();
      await pool.query('DELETE FROM daily_limit_refusals');
      await pool.query(`DELETE FROM commerce_operational_alerts WHERE alert_type = 'daily_limit_reached'`);
    }

    async function withClient<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        return await run(client);
      } finally {
        client.release();
      }
    }

    it("raises a limit for everyone, and lets one account's own value win", async () => {
      process.env.LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP = '3';
      await override('account_daily_mail', 5);
      await override('account_daily_mail', 10, { userId: USER });
      for (let i = 0; i < 9; i += 1) await seedLetter(USER, utcDayOffset(0));
      for (let i = 0; i < 5; i += 1) await seedLetter(OTHER, utcDayOffset(0));

      await withClient(async (client) => {
        await expect(limits.assertMailWithinDailyCaps(client, USER, 1)).resolves.toBeUndefined();
        await expect(limits.assertMailWithinDailyCaps(client, OTHER, 1)).rejects.toMatchObject({
          code: 'ACCOUNT_DAILY_MAIL_CAP',
          message: 'This account has reached its daily limit of 5 letters and postcards. Please try again tomorrow.'
        });
      });
    });

    it('ignores an expired value and a cleared one', async () => {
      process.env.LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP = '3';
      await override('account_daily_mail', 50, { expiresSql: "NOW() - INTERVAL '1 minute'" });
      await override('account_daily_mail', 60, { userId: USER, cleared: true });
      for (let i = 0; i < 3; i += 1) await seedLetter(USER, utcDayOffset(0));
      await withClient(async (client) => {
        await expect(limits.assertMailWithinDailyCaps(client, USER, 1)).rejects.toMatchObject({
          code: 'ACCOUNT_DAILY_MAIL_CAP'
        });
      });
      // A value that has not yet expired is in force.
      await pool.query('DELETE FROM daily_limit_overrides');
      await override('account_daily_mail', 50, { expiresSql: "NOW() + INTERVAL '1 hour'" });
      await withClient(async (client) => {
        await expect(limits.assertMailWithinDailyCaps(client, USER, 1)).resolves.toBeUndefined();
      });
    });

    it('raises the money limit for one account through the pool path', async () => {
      process.env.LETTER_IRL_BETA_ACCOUNT_DAILY_CHARGE_CENTS = '6000';
      await override('account_daily_charge_cents', 20000, { userId: USER });
      await expect(limits.assertChargeWithinDailyCap(USER, 9000)).resolves.toBeUndefined();
      await expect(limits.assertChargeWithinDailyCap(OTHER, 9000)).rejects.toMatchObject({
        code: 'CHARGE_ABOVE_DAILY_CAP'
      });
    });

    it('keeps its own rules: no account on a limit for everyone, no negative value, one uncleared value each', async () => {
      await expect(override('global_daily_mail', 5, { userId: USER })).rejects.toMatchObject({ code: '23514' });
      await expect(override('account_daily_mail', -1)).rejects.toMatchObject({ code: '23514' });
      await expect(override('unknown_limit', 5)).rejects.toMatchObject({ code: '23514' });
      await override('account_daily_mail', 5);
      await expect(override('account_daily_mail', 6)).rejects.toMatchObject({ code: '23505' });
      await override('account_daily_mail', 7, { userId: USER });
      await expect(override('account_daily_mail', 8, { userId: USER })).rejects.toMatchObject({ code: '23505' });
      // Cleared rows are history, and do not count.
      await override('account_daily_mail', 9, { cleared: true });
    });

    it('opens one alert for a burst of refusals, counts every one, and tells the operator once', async () => {
      const { recordDailyLimitRefusal } = await import('../../src/services/dailyLimits.js');
      const { transaction } = await import('../../src/db/index.js');
      await settle();
      let notices = 0;
      const deps = {
        transaction,
        notify: async () => {
          notices += 1;
          return 'sent' as const;
        }
      };

      const outcomes = await Promise.all(
        Array.from({ length: 6 }, () => recordDailyLimitRefusal('global_daily_mail', USER, 100, deps))
      );

      expect(outcomes.filter((outcome) => outcome.opened)).toHaveLength(1);
      expect(notices).toBe(1);
      const counter = await pool.query<{ refusals: number; today: boolean }>(
        `SELECT refusals, utc_day = (NOW() AT TIME ZONE 'UTC')::date AS today FROM daily_limit_refusals WHERE limit_key = 'global_daily_mail'`
      );
      expect(counter.rows).toEqual([{ refusals: 6, today: true }]);
      const alerts = await pool.query<{ severity: string; status: string; details: Record<string, unknown> }>(
        `SELECT severity, status, details FROM commerce_operational_alerts WHERE alert_type = 'daily_limit_reached'`
      );
      expect(alerts.rows).toHaveLength(1);
      expect(alerts.rows[0].severity).toBe('warning');
      expect(alerts.rows[0].status).toBe('open');
      // A limit for everyone names no account.
      expect(alerts.rows[0].details).toEqual({
        limitKey: 'global_daily_mail',
        utcDay: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        value: 100
      });
    });

    it('names the first account on a per-account limit, and opens a separate alert per limit', async () => {
      const { recordDailyLimitRefusal } = await import('../../src/services/dailyLimits.js');
      const { transaction } = await import('../../src/db/index.js');
      const deps = { transaction, notify: async () => 'sent' as const };
      await settle();
      await recordDailyLimitRefusal('account_daily_mail', USER, 25, deps);
      await recordDailyLimitRefusal('account_daily_mail', OTHER, 25, deps);
      await recordDailyLimitRefusal('account_daily_charge_cents', OTHER, 20000, deps);
      const alerts = await pool.query<{ key: string; user_id: string }>(
        `SELECT details->>'limitKey' AS key, details->>'userId' AS user_id FROM commerce_operational_alerts
          WHERE alert_type = 'daily_limit_reached' ORDER BY created_at`
      );
      expect(alerts.rows).toEqual([
        { key: 'account_daily_mail', user_id: USER },
        { key: 'account_daily_charge_cents', user_id: OTHER }
      ]);
    });

    it('writes the configured values, and rewrites them on the next start', async () => {
      const { reportDailyLimitDefaults } = await import('../../src/services/dailyLimits.js');
      expect(await reportDailyLimitDefaults({ LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP: '25' })).toBe(true);
      expect(await reportDailyLimitDefaults({ LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP: '30' })).toBe(true);
      const rows = await pool.query<{ limit_key: string; value: number }>(
        `SELECT limit_key, value FROM daily_limit_defaults ORDER BY limit_key`
      );
      expect(rows.rows).toEqual([
        { limit_key: 'account_daily_charge_cents', value: 6000 },
        { limit_key: 'account_daily_mail', value: 30 },
        { limit_key: 'gift_daily_send', value: 20 },
        { limit_key: 'global_daily_mail', value: 25 }
      ]);
    });
  });

  /**
   * #730: each cap is counted under its own lock, held to the commit, and an
   * open Pay & Send checkout counts as the letter it will become.
   */
  describe('counting under a lock, with open checkouts', () => {
    afterEach(async () => {
      await pool.query('DELETE FROM letters');
      await pool.query('DELETE FROM orders');
      await pool.query('DELETE FROM letter_drafts');
    });

    async function seedDraft(userId: string): Promise<string> {
      const draftId = randomUUID();
      await pool.query(
        `INSERT INTO letter_drafts (draft_id, user_id, sender, recipient, body_text, sign_off, required_credits, status, expires_at)
         VALUES ($1, $2, '{}'::jsonb, '{}'::jsonb, 'Hi', 'Yours', 2, 'pending', NOW() + INTERVAL '1 day')`,
        [draftId, userId]
      );
      return draftId;
    }

    /** A Pay & Send order today, open unless a status says otherwise. */
    async function seedJitOrder(userId: string, status: string, checkoutExpiresIn = '30 minutes'): Promise<string> {
      const orderId = randomUUID();
      await pool.query(
        `INSERT INTO orders (order_id, user_id, order_type, draft_id, credits, amount_cents, status, created_at,
                             product_code, idempotency_key, checkout_expires_at)
         VALUES ($1, $2, 'jit_mail', $3, NULL, 499, $4, NOW() AT TIME ZONE 'UTC', 'jit-letter', $5,
                 NOW() + $6::interval)`,
        [orderId, userId, await seedDraft(userId), status, 'seed:' + orderId, checkoutExpiresIn]
      );
      return orderId;
    }

    async function seedLetterFor(userId: string, orderId: string | null = null, client: pg.PoolClient | pg.Pool = pool): Promise<void> {
      await client.query(
        `INSERT INTO letters (letter_id, user_id, content, recipient, credits_cost, status, funding_type, funding_order_id)
         VALUES ($1, $2, '{}'::jsonb, '{}'::jsonb, 1, 'sent', $3, $4)`,
        [randomUUID(), userId, orderId ? 'jit_order' : 'prepaid_balance', orderId]
      );
    }

    async function check(userId: string, inFlight = 0): Promise<unknown> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await limits.assertMailWithinDailyCaps(client, userId, inFlight);
        await client.query('COMMIT');
        return undefined;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }

    it('counts an open checkout, once its letter exists counts the letter alone, and lets go of the rest', async () => {
      process.env.LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP = '2';
      // Open, paid and being fulfilled hold room; so does a letter.
      await seedJitOrder(USER, 'checkout_pending');
      await seedJitOrder(USER, 'paid');
      await expect(check(USER, 1)).rejects.toMatchObject({ code: 'ACCOUNT_DAILY_MAIL_CAP' });

      // A fulfilled order with its letter counts once.
      await pool.query('DELETE FROM orders');
      const fulfilled = await seedJitOrder(USER, 'fulfillment_pending');
      await seedLetterFor(USER, fulfilled);
      await expect(check(USER, 1)).resolves.toBeUndefined();

      // Cancelled, refunded and failed orders, and a checkout past its expiry, hold none.
      await pool.query('DELETE FROM letters');
      await pool.query('DELETE FROM orders');
      for (const status of ['cancelled', 'refund_pending', 'payment_failed']) await seedJitOrder(USER, status);
      await seedJitOrder(USER, 'checkout_pending', '-1 minute');
      await expect(check(USER, 2)).resolves.toBeUndefined();
    });

    it.each([
      ['the account cap', 'LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP', [USER, USER], 'ACCOUNT_DAILY_MAIL_CAP'],
      ['the global ceiling', 'LETTER_IRL_BETA_GLOBAL_DAILY_MAIL_CEILING', [USER, OTHER], 'GLOBAL_DAILY_MAIL_CEILING']
    ] as const)('lets only one of two sends at once take the last place under %s', async (_label, variable, [first, second], code) => {
      process.env[variable] = '2';
      // One letter already today, so the cap of 2 has one place left.
      await seedLetterFor(first);

      const a = await pool.connect();
      const b = await pool.connect();
      const bPid = (await b.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      try {
        await a.query('BEGIN');
        await b.query('BEGIN');
        // Each send has written its letter, as the send path has when it checks.
        await seedLetterFor(first, null, a);
        await seedLetterFor(second, null, b);
        await expect(limits.assertMailWithinDailyCaps(a, first, 0)).resolves.toBeUndefined();

        // The second waits on the first's lock, so it counts after the first commits.
        let settled = false;
        const waiting = limits.assertMailWithinDailyCaps(b, second, 0).finally(() => { settled = true; });
        waiting.catch(() => undefined);
        // Seen waiting on a lock by the server itself, not guessed from a delay.
        let waitingOnLock = false;
        for (let tries = 0; tries < 100 && !waitingOnLock && !settled; tries += 1) {
          const seen = await pool.query<{ wait_event_type: string | null; wait_event: string | null }>(
            'SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE pid = $1',
            [bPid]
          );
          // The cap's own lock, not some row the fixtures happen to share.
          waitingOnLock = seen.rows[0]?.wait_event_type === 'Lock' && seen.rows[0]?.wait_event === 'advisory';
          if (!waitingOnLock) await new Promise(resolve => setTimeout(resolve, 50));
        }
        expect(settled).toBe(false);
        expect(waitingOnLock).toBe(true);

        await a.query('COMMIT');
        await expect(waiting).rejects.toMatchObject({ code });
      } finally {
        // Whatever failed, neither connection goes back holding a lock or a letter.
        await a.query('ROLLBACK').catch(() => undefined);
        await b.query('ROLLBACK').catch(() => undefined);
        a.release();
        b.release();
      }
    }, 30_000);
  });

});
