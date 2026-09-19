import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import { repositoryMigrations, validateDisposableDatabaseUrl } from './support/disposableDatabase.js';
import { VerifiedEmailRequiredError } from '../../src/auth/verifiedEmail.js';

/**
 * One account per address, against real PostgreSQL.
 *
 * Two of the three things here cannot be proven against a database double at
 * all, and the third was wrong in production for a month:
 *
 *   - **The constraint name.** `EmailAlreadyLinkedError` is raised by matching
 *     `users_email_key` on a 23505. A mocked client agrees with whatever name
 *     the code writes; only PostgreSQL knows what it actually called the
 *     inline UNIQUE in 001_initial_schema.sql. If a future migration renames
 *     or replaces it, this is what goes red instead of a customer getting
 *     "database error" and no account.
 *   - **The rollback.** A grant refused for want of an address must leave
 *     nothing behind - no account, no ledger lot, no transaction row. That is
 *     a property of the enclosing transaction, which a double does not have.
 *   - **No ghost accounts.** `${userId}@unknown.com` used to be written here.
 *     The test that would have caught it is the one that asks the database
 *     whether any such row exists.
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

describePostgres('one account per address', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let schema: string;
  let users: typeof import('../../src/services/userService.js');
  let ledger: typeof import('../../src/services/creditLedgerService.js');
  let db: typeof import('../../src/db/index.js');

  beforeAll(async () => {
    const baseUrl = validateDisposableDatabaseUrl(process.env.LIRL_TEST_DATABASE_URL);
    adminPool = new Pool({ connectionString: baseUrl });
    schema = schemaName('lirl_identity');
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const scoped = databaseUrlForSchema(baseUrl, schema);
    await migrate({ connectionString: scoped, migrationsDirectory: repositoryMigrations });
    pool = new Pool({ connectionString: scoped, max: 4 });

    process.env.DATABASE_URL = scoped;
    users = await import('../../src/services/userService.js');
    ledger = await import('../../src/services/creditLedgerService.js');
    db = await import('../../src/db/index.js');
  }, 180_000);

  afterAll(async () => {
    await db?.closePool();
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }, 60_000);

  function subject(label: string): string {
    return `auth0|${label}-${randomUUID()}`;
  }

  function address(): string {
    return `${randomUUID()}@test.invalid`;
  }

  async function seedAccount(email: string, credits = 0): Promise<string> {
    const userId = subject('identity');
    await pool.query(
      `INSERT INTO users (user_id, email, credits, credits_purchased, credits_used)
       VALUES ($1, $2, $3, $3, 0)`,
      [userId, email, credits]
    );
    return userId;
  }

  async function countUsers(userId: string): Promise<number> {
    const result = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE user_id = $1', [
      userId
    ]);
    return result.rows[0].n;
  }

  describe('an address that already belongs to another subject', () => {
    it('is named, rather than raised as a database error', async () => {
      // Auth0 mints a subject per sign-in method, so this is one person
      // arriving by Google having first arrived by password. Until it was
      // named, the INSERT raised a bare 23505 which the caller swallowed, and
      // the customer was left with no account row at all.
      const email = address();
      await seedAccount(email);
      const second = subject('second-method');

      await expect(users.createUser({ userId: second, email })).rejects.toBeInstanceOf(
        users.EmailAlreadyLinkedError
      );
      await expect(users.getOrCreateUser(second, email)).rejects.toBeInstanceOf(
        users.EmailAlreadyLinkedError
      );
      expect(await countUsers(second)).toBe(0);
    });

    it('is named when an existing account is moved onto it', async () => {
      const held = address();
      await seedAccount(held);
      const mover = await seedAccount(address());

      await expect(users.updateUserEmail(mover, held)).rejects.toBeInstanceOf(
        users.EmailAlreadyLinkedError
      );
    });

    it('does not fire when the same subject presents the same address again', async () => {
      // getOrCreateUser runs on every authenticated call. The common case -
      // an account that exists, with the address it already has - must not be
      // mistaken for a collision.
      const email = address();
      const userId = await seedAccount(email);

      const again = await users.getOrCreateUser(userId, email);
      expect(again.user_id).toBe(userId);
      expect(again.email).toBe(email);

      const moved = address();
      expect((await users.getOrCreateUser(userId, moved)).email).toBe(moved);
    });
  });

  describe('an account that cannot be opened', () => {
    it('is refused, and leaves no row behind', async () => {
      const stranger = subject('stranger');

      await expect(
        db.transaction(client => users.ensureAccountRowWithClient(client, { userId: stranger }))
      ).rejects.toBeInstanceOf(VerifiedEmailRequiredError);

      expect(await countUsers(stranger)).toBe(0);
    });

    it('takes the whole grant down with it, ledger row included', async () => {
      // The refusal has to be inside the transaction that writes the lot. If
      // it were not, a grant could leave a ledger row pointing at an account
      // that was never opened - which the foreign key would refuse anyway,
      // reported as whatever the database calls it.
      const stranger = subject('stranger');

      await expect(
        ledger.addCreditsToLedger({ userId: stranger, credits: 2, sourceType: 'promo' })
      ).rejects.toBeInstanceOf(VerifiedEmailRequiredError);

      expect(await countUsers(stranger)).toBe(0);
      const lots = await pool.query('SELECT COUNT(*)::int AS n FROM credit_ledger WHERE user_id = $1', [
        stranger
      ]);
      expect(lots.rows[0].n).toBe(0);
    });

    it('never invents an address for one', async () => {
      // The specific shape that used to be written, asked of the database
      // rather than of a mock: `${userId}@unknown.com`.
      const ghosts = await pool.query(
        "SELECT COUNT(*)::int AS n FROM users WHERE email LIKE '%@unknown.com'"
      );
      expect(ghosts.rows[0].n).toBe(0);
    });
  });

  describe('a write that adds no credits', () => {
    it('leaves updated_at where it was, so an operator preview does not go stale', async () => {
      // A gift redemption adds nothing to the balance; it only needs the row
      // to exist. users.updated_at is the admin panel's optimistic version, so
      // writing the row anyway would stale an operator's open preview on every
      // redemption. This is the statement origin/dev ran, preserved.
      const email = address();
      const userId = await seedAccount(email);
      const before = await pool.query('SELECT updated_at FROM users WHERE user_id = $1', [userId]);

      const row = await db.transaction(client =>
        users.ensureAccountRowWithClient(client, { userId, email })
      );

      const after = await pool.query('SELECT updated_at FROM users WHERE user_id = $1', [userId]);
      expect(row.user_id).toBe(userId);
      expect(after.rows[0].updated_at).toEqual(before.rows[0].updated_at);
    });

    it('still opens the account when it carries an address and there is no row', async () => {
      const userId = subject('gift-first');
      const email = address();

      const row = await db.transaction(client =>
        users.ensureAccountRowWithClient(client, { userId, email })
      );

      expect(row.email).toBe(email);
      expect(row.credits).toBe(0);
    });
  });

  describe('an account that does exist', () => {
    it('is credited by a grant that carries no address, and keeps the address it has', async () => {
      // A Stripe webhook and an operator adjustment both land here with no
      // address, on an account somebody already opened. Neither may be
      // refused, and neither may rewrite the address.
      const email = address();
      const userId = await seedAccount(email, 4);

      const result = await ledger.addCreditsToLedger({
        userId,
        credits: 6,
        sourceType: 'purchase'
      });

      expect(result.user.credits).toBe(10);
      expect(result.user.credits_purchased).toBe(10);
      expect(result.user.email).toBe(email);
    });

    it('is opened by a grant that does carry one', async () => {
      const userId = subject('first-arrival');
      const email = address();

      const result = await ledger.addCreditsToLedger({
        userId,
        email,
        credits: 4,
        sourceType: 'purchase'
      });

      expect(result.user.email).toBe(email);
      expect(result.user.credits).toBe(4);
      expect(result.user.credits_purchased).toBe(4);
    });

    it('moves the lifetime purchased total only for a purchase', async () => {
      // The promo path credits the balance and leaves credits_purchased where
      // it is; the credit grants move both. One helper serves all three call
      // sites now, so the distinction has to be proven rather than assumed -
      // and only a real database shows what each statement actually wrote.
      const email = address();
      const userId = await seedAccount(email, 3);

      await db.transaction(client =>
        users.ensureAccountRowWithClient(client, { userId, credits: 5 })
      );

      const promoOnly = await pool.query(
        'SELECT credits, credits_purchased FROM users WHERE user_id = $1',
        [userId]
      );
      expect(promoOnly.rows[0]).toEqual({ credits: 8, credits_purchased: 3 });

      await db.transaction(client =>
        users.ensureAccountRowWithClient(client, { userId, credits: 2, countAsPurchased: true })
      );

      const afterPurchase = await pool.query(
        'SELECT credits, credits_purchased FROM users WHERE user_id = $1',
        [userId]
      );
      expect(afterPurchase.rows[0]).toEqual({ credits: 10, credits_purchased: 5 });
    });

    it('refuses a grant carrying an address another subject holds', async () => {
      const email = address();
      await seedAccount(email);

      await expect(
        ledger.addCreditsToLedger({
          userId: subject('collider'),
          email,
          credits: 2,
          sourceType: 'purchase'
        })
      ).rejects.toBeInstanceOf(users.EmailAlreadyLinkedError);
    });
  });
});
