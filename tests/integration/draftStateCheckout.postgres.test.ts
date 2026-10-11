import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import { repositoryMigrations, validateDisposableDatabaseUrl } from './support/disposableDatabase.js';

/**
 * The Pay & Send order active on a draft, as getDraftState reads it for get_draft_status (#676): the letter card asks
 * the server what became of its draft, since ChatGPT did not give a reopened card its kept state.
 *
 *   an unexpired checkout, or one paid, being sent, refunded, disputed or held, is active, with its link (the database holds at
 *   most one active Pay & Send order per draft, idx_orders_active_jit_draft_unique)
 *   an expired checkout, a cancelled one, another person's, and a pack's are not
 *
 * Against real PostgreSQL because the subquery's join, its status list and its expiry test are the change's whole
 * substance, and a mocked query() honours none of them.
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

const RECIPIENT = {
  name: 'Sam Rivera',
  addressLine1: '350 5th Ave',
  city: 'New York',
  state: 'NY',
  postalCode: '10118',
  country: 'US'
};
const SENDER = {
  name: 'Test Sender',
  addressLine1: '1 Main St',
  city: 'Springfield',
  state: 'IL',
  postalCode: '62701',
  country: 'US'
};
const PAGE = '<!DOCTYPE html><html><body data-renderer="pdf-1"><svg></svg></body></html>';

describePostgres('the Pay & Send order active on a draft (#676)', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let schema: string;
  let drafts: typeof import('../../src/services/draftService.js');
  let closeServicePool: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const baseUrl = validateDisposableDatabaseUrl(process.env.LIRL_TEST_DATABASE_URL);
    adminPool = new Pool({ connectionString: baseUrl });
    schema = schemaName('lirl_draft_checkout');
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const scoped = databaseUrlForSchema(baseUrl, schema);
    await migrate({ connectionString: scoped, migrationsDirectory: repositoryMigrations });
    pool = new Pool({ connectionString: scoped, max: 4 });

    process.env.DATABASE_URL = scoped;
    drafts = await import('../../src/services/draftService.js');
    closeServicePool = (await import('../../src/db/index.js')).closePool;
  }, 180_000);

  afterAll(async () => {
    await closeServicePool?.();
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  }, 60_000);

  async function seedUser(): Promise<string> {
    const userId = `auth0|draft-checkout-${randomUUID()}`;
    await pool.query(`INSERT INTO users (user_id, email, credits, credits_purchased) VALUES ($1, $2, 0, 0)`, [
      userId,
      `${randomUUID()}@test.invalid`
    ]);
    return userId;
  }

  async function previewed(userId: string): Promise<string> {
    const { draftId } = await drafts.createDraft({
      userId,
      sender: SENDER,
      recipient: RECIPIENT,
      bodyText: `Hello ${randomUUID()}`,
      signOff: 'Warmly,\nTest',
      requiredCredits: 2,
      previewHtml: PAGE,
      layoutType: 'text_only',
      rendererVersion: 'pdf-1'
    });
    return draftId;
  }

  /** A Pay & Send (or other) order on the draft, with its status, link, expiry and age. */
  async function order(
    userId: string,
    draftId: string | null,
    fields: {
      status: string;
      type?: string;
      url?: string | null;
      expiresInMinutes?: number | null;
      ageMinutes?: number;
    }
  ): Promise<string> {
    const orderId = randomUUID();
    const expires = fields.expiresInMinutes == null ? null : new Date(Date.now() + fields.expiresInMinutes * 60_000);
    await pool.query(
      `INSERT INTO orders (
         order_id, user_id, order_type, draft_id, product_code, credits, amount_cents, currency,
         idempotency_key, status, checkout_url, checkout_expires_at, created_at
       ) VALUES ($1, $2, $3, $4, 'jit-letter', $10::int, 499, 'usd', $5, $6, $7, $8, NOW() - make_interval(mins => $9::int))`,
      [
        orderId,
        userId,
        fields.type ?? 'jit_mail',
        draftId,
        `jit-checkout:${orderId}`,
        fields.status,
        fields.url === undefined ? 'https://checkout.stripe.com/c/pay/cs_test_x' : fields.url,
        expires,
        fields.ageMinutes ?? 0,
        (fields.type ?? 'jit_mail') === 'letter_pack' ? 2 : null
      ]
    );
    return orderId;
  }

  it('reads an unexpired checkout as active, with its link', async () => {
    const userId = await seedUser();
    const draftId = await previewed(userId);
    expect((await drafts.getDraftState(draftId))?.active_checkout).toBeNull();
    const orderId = await order(userId, draftId, { status: 'checkout_pending', expiresInMinutes: 30 });
    expect((await drafts.getDraftState(draftId))?.active_checkout).toEqual({
      order_id: orderId,
      status: 'checkout_pending',
      checkout_url: 'https://checkout.stripe.com/c/pay/cs_test_x'
    });
  });

  it('reads one with no expiry, and one paid, being sent, refunded, disputed or held, as active', async () => {
    for (const [status, expiresInMinutes] of [
      ['checkout_pending', null],
      ['paid', -60],
      ['fulfillment_pending', -60],
      ['refund_pending', -60],
      ['disputed', -60],
      ['held', -60]
    ] as const) {
      const userId = await seedUser();
      const draftId = await previewed(userId);
      const orderId = await order(userId, draftId, { status, expiresInMinutes, url: null });
      expect((await drafts.getDraftState(draftId))?.active_checkout, status).toEqual({
        order_id: orderId,
        status,
        checkout_url: null
      });
    }
  });

  it('reads no expired checkout, no cancelled one, no pack, and none of another person', async () => {
    const cases: Array<[string, (userId: string, draftId: string) => Promise<unknown>]> = [
      ['expired', (userId, draftId) => order(userId, draftId, { status: 'checkout_pending', expiresInMinutes: -1 })],
      ['cancelled', (userId, draftId) => order(userId, draftId, { status: 'cancelled', expiresInMinutes: 30 })],
      [
        'a pack',
        (userId, draftId) =>
          order(userId, draftId, { status: 'checkout_pending', expiresInMinutes: 30, type: 'letter_pack' })
      ],
      [
        'another person',
        async (_userId, draftId) =>
          order(await seedUser(), draftId, { status: 'checkout_pending', expiresInMinutes: 30 })
      ]
    ];
    for (const [label, make] of cases) {
      const userId = await seedUser();
      const draftId = await previewed(userId);
      await make(userId, draftId);
      expect((await drafts.getDraftState(draftId))?.active_checkout, label).toBeNull();
    }
  });
});
