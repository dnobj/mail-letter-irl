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
 * erasure. Stripe and the price catalog are the doubles.
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

describePostgres('a checkout that meets an account erasure (#449)', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let schema: string;
  let commerce: typeof import('../../src/services/commerceService.js');
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
    closeServicePool = (await import('../../src/db/index.js')).closePool;
  }, 180_000);

  afterAll(async () => {
    await closeServicePool?.();
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
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

  /**
   * What the erasure worker does to the account row, left uncommitted: it
   * holds the row FOR UPDATE and writes the tombstone the 035 CHECK requires.
   */
  async function beginErasure(userId: string): Promise<{ holder: pg.PoolClient; pid: number }> {
    const holder = await pool.connect();
    await holder.query('BEGIN');
    const pid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
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
    return { holder, pid };
  }

  /** Until some backend waits on the erasure's lock: the checkout is at its insert. */
  async function waitUntilBlockedBy(pid: number): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const blocked = await adminPool.query<{ n: number }>(
        'SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))',
        [pid]
      );
      if (blocked.rows[0].n > 0) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('the checkout never waited on the account row');
  }

  async function ordersFor(userId: string): Promise<number> {
    const result = await pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM orders WHERE user_id = $1', [userId]);
    return result.rows[0].n;
  }

  it('refuses a pack checkout that waited out an erasure, leaving no order and no session', async () => {
    const userId = await seedUser();
    const sessionsBefore = stripeDouble.sessions.length;
    const { holder, pid } = await beginErasure(userId);
    let outcome: unknown;
    try {
      const checkout = commerce
        .createPackCheckout({ userId, userEmail: 'person@test.invalid', productId: 'credit-pack-4' })
        .then(() => 'opened', (error: unknown) => error);
      await waitUntilBlockedBy(pid);
      await holder.query('COMMIT');
      outcome = await checkout;
    } finally {
      holder.release();
    }

    expect(outcome).toMatchObject({ code: 'ACCOUNT_SENDS_BLOCKED' });
    expect(await ordersFor(userId)).toBe(0);
    expect(stripeDouble.sessions.length).toBe(sessionsBefore);
  }, 60_000);

  it('refuses a Pay & Send checkout that passed the first block check before the erasure committed', async () => {
    const userId = await seedUser();
    const draftId = await seedDraft(userId);
    const sessionsBefore = stripeDouble.sessions.length;
    const { holder, pid } = await beginErasure(userId);
    let outcome: unknown;
    try {
      // The first check reads the account before the erasure commits and
      // passes; only the read after the insert can see it.
      const checkout = commerce
        .createJitCheckout({ userId, draftId })
        .then(() => 'opened', (error: unknown) => error);
      await waitUntilBlockedBy(pid);
      await holder.query('COMMIT');
      outcome = await checkout;
    } finally {
      holder.release();
    }

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
