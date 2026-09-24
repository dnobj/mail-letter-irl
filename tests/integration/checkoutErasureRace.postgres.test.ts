import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import { repositoryMigrations, validateDisposableDatabaseUrl } from './support/disposableDatabase.js';

/**
 * A checkout that meets an account erasure (#449), against real PostgreSQL.
 *
 * The erasure holds the account row FOR UPDATE while it scrubs and tombstones
 * the account. A checkout that got past every earlier check reaches its order
 * INSERT, whose foreign key needs a KEY SHARE lock on that row, so it waits.
 * Before #449 the insert then went through on the tombstone and the checkout
 * returned a live Stripe session; a paid pack granted letters to an account
 * nobody can sign in to. Now the account is read again after the insert, in
 * the same transaction, and the rollback leaves no order and no session.
 *
 * Only a real database can show this: the wait on the row lock, and READ
 * COMMITTED handing the statement after it a snapshot that includes the
 * erasure. The first case drives the erasure worker itself, so a change to the
 * worker's lock that stopped it conflicting with the insert fails here. Stripe
 * and the price catalog are the doubles.
 */

const stripeDouble = vi.hoisted(() => ({ sessions: [] as string[] }));

vi.mock('../../src/services/priceCatalog.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/services/priceCatalog.js')>()),
  ensurePriceCatalog: async () => undefined
}));

vi.mock('../../src/services/stripeService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/services/stripeService.js')>()),
  isJitPurchaseEnabled: () => true,
  getPackProductConfig: () => ({
    productCode: 'credit-pack-4',
    priceId: 'price_test_pack',
    amountCents: 500,
    currency: 'usd',
    credits: 4,
    name: 'Starter Pack',
    description: 'Test pack'
  }),
  getJitProductConfig: (mailType: 'letter' | 'postcard') => ({
    productCode: mailType === 'postcard' ? 'jit-postcard' : 'jit-letter',
    mailType,
    priceId: `price_test_${mailType}`,
    amountCents: 499,
    currency: 'usd',
    name: 'Pay & Send',
    description: 'Test product'
  }),
  createPackCheckoutSession: async (params: { orderId: string }) => {
    stripeDouble.sessions.push(params.orderId);
    return {
      success: true,
      sessionId: `cs_test_${params.orderId}`,
      sessionUrl: `https://checkout.stripe.test/${params.orderId}`
    };
  },
  createJitCheckoutSession: async (params: { orderId: string; expiresAt?: Date }) => {
    stripeDouble.sessions.push(params.orderId);
    return {
      success: true,
      sessionId: `cs_test_${params.orderId}`,
      sessionUrl: `https://checkout.stripe.test/${params.orderId}`,
      expiresAt: params.expiresAt
    };
  }
}));

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

async function settleAll(steps: Array<() => Promise<unknown>>): Promise<void> {
  for (const step of steps) {
    try {
      await step();
    } catch {
      // Deliberately swallowed: one failed teardown must not skip the rest.
    }
  }
}

describePostgres('a checkout that meets an account erasure (#449)', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let schema: string;
  let commerce: typeof import('../../src/services/commerceService.js');
  let erasure: typeof import('../../src/services/accountErasureService.js');
  let closeServicePool: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const baseUrl = validateDisposableDatabaseUrl(process.env.LIRL_TEST_DATABASE_URL);
    adminPool = new Pool({ connectionString: baseUrl });
    schema = schemaName('lirl_erasure_race');
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const scoped = databaseUrlForSchema(baseUrl, schema);
    await migrate({ connectionString: scoped, migrationsDirectory: repositoryMigrations });
    pool = new Pool({ connectionString: scoped, max: 4 });

    process.env.DATABASE_URL = scoped;
    commerce = await import('../../src/services/commerceService.js');
    erasure = await import('../../src/services/accountErasureService.js');
    closeServicePool = (await import('../../src/db/index.js')).closePool;
  }, 180_000);

  afterAll(async () => {
    await settleAll([
      async () => closeServicePool?.(),
      async () => pool?.end(),
      async () => adminPool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`),
      async () => adminPool?.end()
    ]);
  });

  async function seedUser(): Promise<string> {
    const userId = `auth0|erasure-race-${randomUUID()}`;
    await pool.query(`INSERT INTO users (user_id, email) VALUES ($1, $2)`, [userId, `${randomUUID()}@test.invalid`]);
    return userId;
  }

  async function seedDraft(userId: string): Promise<string> {
    const draftId = randomUUID();
    await pool.query(
      `INSERT INTO letter_drafts (
         draft_id, user_id, sender, recipient, body_text, sign_off, required_credits,
         expires_at, status, mail_type, layout_type
       ) VALUES ($1, $2, $3, $4, 'Hi Sam, see you soon.', 'Love, Dee', 2,
                 NOW() + INTERVAL '1 day', 'pending', 'letter', 'text_only')`,
      [
        draftId,
        userId,
        JSON.stringify({ name: 'Dee', addressLine1: '1 Main St', city: 'Springfield', state: 'IL', postalCode: '62701', country: 'US' }),
        JSON.stringify({ name: 'Sam', addressLine1: '2 Road', city: 'Leeds', state: 'NY', postalCode: '10001', country: 'US' })
      ]
    );
    return draftId;
  }

  /** An erasure's transaction, begun and left open while the checkout runs. */
  async function openErasure(): Promise<{ holder: pg.PoolClient; pid: number }> {
    const holder = await pool.connect();
    await holder.query('BEGIN');
    const pid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    return { holder, pid };
  }

  /**
   * The account row as a hand-written erasure leaves it: held FOR UPDATE, with
   * the tombstone the 035 CHECK requires. For the Pay & Send case, where the
   * real worker would deadlock with the checkout over the draft instead.
   */
  async function tombstoneByHand(holder: pg.PoolClient, userId: string): Promise<void> {
    await holder.query('SELECT user_id FROM users WHERE user_id = $1 FOR UPDATE', [userId]);
    await holder.query(
      `UPDATE users
          SET erased_at = NOW(),
              email = $2,
              return_address = NULL,
              return_address_validated_at = NULL,
              sends_blocked_at = NOW(),
              sends_blocked_reason = 'account_erased'
        WHERE user_id = $1`,
      [userId, `erased-${randomUUID()}@erased.invalid`]
    );
  }

  /** Resolves once some backend waits on the erasure's lock: the checkout is at its insert. */
  async function waitUntilBlockedBy(pid: number): Promise<'blocked'> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const blocked = await adminPool.query<{ n: number }>(
        'SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))',
        [pid]
      );
      if (blocked.rows[0].n > 0) return 'blocked';
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('the checkout never waited on the account row');
  }

  /**
   * Start the checkout, wait until it is blocked on the erasure, commit the
   * erasure, and return how the checkout ended. A checkout that ends before it
   * reaches the lock is reported with its own outcome, not as a timeout, and
   * the erasure is always rolled back unless it committed, so no failure leaves
   * the account row locked for the rest of the suite.
   */
  async function checkoutAcrossCommit(
    erasureTx: { holder: pg.PoolClient; pid: number },
    start: () => Promise<unknown>
  ): Promise<unknown> {
    let committed = false;
    try {
      const checkout = start().then(() => 'opened' as const, (error: unknown) => error);
      const blocked = waitUntilBlockedBy(erasureTx.pid);
      // When the checkout ends first, the abandoned wait still times out later;
      // that rejection is expected and must not surface as an unhandled one.
      blocked.catch(() => undefined);
      const first = await Promise.race([blocked, checkout.then(outcome => ({ endedEarly: outcome }))]);
      if (first !== 'blocked') {
        throw new Error(`the checkout ended before it reached its insert: ${String((first.endedEarly as Error)?.message ?? first.endedEarly)}`);
      }
      await erasureTx.holder.query('COMMIT');
      committed = true;
      return await checkout;
    } finally {
      if (!committed) await erasureTx.holder.query('ROLLBACK').catch(() => undefined);
      erasureTx.holder.release(!committed);
    }
  }

  async function ordersFor(userId: string): Promise<number> {
    const result = await pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM orders WHERE user_id = $1', [userId]);
    return result.rows[0].n;
  }

  it('refuses a pack checkout that waited out the erasure worker, leaving no order and no session', async () => {
    const userId = await seedUser();
    const sessionsBefore = stripeDouble.sessions.length;
    const erasureTx = await openErasure();
    // The worker itself, in the transaction: its lock on the account row is
    // what the checkout's insert has to wait for.
    await expect(erasure.eraseAccountWithClient(erasureTx.holder, userId)).resolves.toMatchObject({ outcome: 'erased' });

    const outcome = await checkoutAcrossCommit(erasureTx, () =>
      commerce.createPackCheckout({ userId, userEmail: 'person@test.invalid', productId: 'credit-pack-4' })
    );

    expect(outcome).toMatchObject({ code: 'ACCOUNT_SENDS_BLOCKED' });
    expect(await ordersFor(userId)).toBe(0);
    expect(stripeDouble.sessions.length).toBe(sessionsBefore);
  }, 60_000);

  it('refuses a pack checkout that waited out a hand-written tombstone', async () => {
    const userId = await seedUser();
    const sessionsBefore = stripeDouble.sessions.length;
    const erasureTx = await openErasure();
    await tombstoneByHand(erasureTx.holder, userId);

    const outcome = await checkoutAcrossCommit(erasureTx, () =>
      commerce.createPackCheckout({ userId, userEmail: 'person@test.invalid', productId: 'credit-pack-4' })
    );

    expect(outcome).toMatchObject({ code: 'ACCOUNT_SENDS_BLOCKED' });
    expect(await ordersFor(userId)).toBe(0);
    expect(stripeDouble.sessions.length).toBe(sessionsBefore);
  }, 60_000);

  it('makes a Pay & Send checkout read the account after its insert, whatever its first check saw', async () => {
    // The first block check reads the account before the tombstone commits and
    // passes. The real worker would delete this draft and deadlock with the
    // checkout, which PostgreSQL resolves safely; this proves the read after
    // the insert, which is the only refusal when a checkout waits across the
    // commit somewhere of its own.
    const userId = await seedUser();
    const draftId = await seedDraft(userId);
    const sessionsBefore = stripeDouble.sessions.length;
    const erasureTx = await openErasure();
    await tombstoneByHand(erasureTx.holder, userId);

    const outcome = await checkoutAcrossCommit(erasureTx, () => commerce.createJitCheckout({ userId, draftId }));

    expect(outcome).toMatchObject({ code: 'ACCOUNT_SENDS_BLOCKED' });
    expect(await ordersFor(userId)).toBe(0);
    expect(stripeDouble.sessions.length).toBe(sessionsBefore);
    // The rollback released the draft untouched.
    const draft = await pool.query<{ status: string }>('SELECT status FROM letter_drafts WHERE draft_id = $1', [draftId]);
    expect(draft.rows[0].status).toBe('pending');
  }, 60_000);

  it('still opens a pack checkout for an account nobody is erasing', async () => {
    const userId = await seedUser();

    const result = await commerce.createPackCheckout({
      userId,
      userEmail: 'person@test.invalid',
      productId: 'credit-pack-4'
    });

    expect(result).toMatchObject({ success: true, status: 'checkout_pending' });
    expect(await ordersFor(userId)).toBe(1);
  }, 60_000);
});
