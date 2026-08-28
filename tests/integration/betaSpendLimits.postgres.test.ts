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

  async function seedOrder(userId: string, amountCents: number, createdAtUtc: string): Promise<void> {
    await pool.query(
      `INSERT INTO orders (order_id, user_id, credits, amount_cents, status, created_at)
       VALUES ($1, $2, 1, $3, 'pending', $4::timestamp)`,
      [randomUUID(), userId, amountCents, createdAtUtc]
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
    await seedOrder(USER, 4000, utcDayOffset(0));
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
});
