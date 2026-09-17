import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import { repositoryMigrations, validateDisposableDatabaseUrl } from './support/disposableDatabase.js';

/**
 * The duplicate-mail check (#412), against real PostgreSQL.
 *
 * The unit suites drive the comparison through a database double, which says
 * nothing about whether the SQL plans and returns what the service parses.
 * That gap is where this repository's defects come from (see
 * betaSpendLimits.postgres.test.ts). What only a real database settles here:
 *
 *   - the 24-hour window, written against TIMESTAMP columns with
 *     `NOW() AT TIME ZONE 'UTC'`;
 *   - the uuid and varchar parameters, each bound once with one type;
 *   - md5() over JSON text and draft columns agreeing, so an image letter
 *     matches the mail it became;
 *   - the whole prepaid send refusing a second copy inside its transaction
 *     and rolling the deduction back;
 *   - a Pay & Send checkout checked only where a new order is created: an
 *     open checkout is handed back unchecked, a refused replacement leaves the
 *     row it would replace as it was, and a sent draft is refused as sent.
 *
 * Stripe is the one thing stubbed: a priced product and a session that opens.
 * Every test uses its own account, so no cleanup is needed between them.
 */

const stripeDouble = vi.hoisted(() => ({ sessions: [] as string[] }));

vi.mock('../../src/services/priceCatalog.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/services/priceCatalog.js')>()),
  ensurePriceCatalog: async () => undefined
}));

vi.mock('../../src/services/stripeService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/services/stripeService.js')>()),
  isJitPurchaseEnabled: () => true,
  getJitProductConfig: (mailType: 'letter' | 'postcard') => ({
    productCode: mailType === 'postcard' ? 'jit-postcard' : 'jit-letter',
    mailType,
    priceId: `price_test_${mailType}`,
    amountCents: 499,
    currency: 'usd',
    name: 'Pay & Send',
    description: 'Test product'
  }),
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

const RECIPIENT = {
  name: 'Sam Rivera',
  addressLine1: '350 5th Ave',
  addressLine2: 'Suite 8701',
  city: 'New York',
  state: 'NY',
  postalCode: '10118',
  country: 'US'
};
const SENDER = {
  name: 'Dee Nicholl',
  addressLine1: '1 Main St',
  city: 'Springfield',
  state: 'IL',
  postalCode: '62701',
  country: 'US'
};
const IMAGE_A = 'data:image/jpeg;base64,' + 'A'.repeat(64);
const IMAGE_B = 'data:image/jpeg;base64,' + 'B'.repeat(64);

interface DraftSeed {
  mailType?: 'letter' | 'postcard';
  layoutType?: 'text_only' | 'header_image' | 'inline_image';
  body?: string;
  signOff?: string | null;
  recipient?: Record<string, unknown>;
  sender?: Record<string, unknown>;
  headerImage?: string | null;
  inlineImage?: string | null;
  frontImage?: string | null;
  postcardSize?: string | null;
}

describePostgres('duplicate mail check (#412)', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let schema: string;
  let duplicates: typeof import('../../src/services/duplicateMailService.js');
  let mailSend: typeof import('../../src/services/mailSendService.js');
  let commerce: typeof import('../../src/services/commerceService.js');
  let closeServicePool: (() => Promise<void>) | undefined;

  const savedCaps = {
    account: process.env.LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP,
    global: process.env.LETTER_IRL_BETA_GLOBAL_DAILY_MAIL_CEILING
  };

  beforeAll(async () => {
    // The daily caps count every letter created today, seeded ones included,
    // and their defaults (3 per account, 25 in all) are not what this file tests.
    process.env.LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP = '1000';
    process.env.LETTER_IRL_BETA_GLOBAL_DAILY_MAIL_CEILING = '100000';
    const baseUrl = validateDisposableDatabaseUrl(process.env.LIRL_TEST_DATABASE_URL);
    adminPool = new Pool({ connectionString: baseUrl });
    schema = schemaName('lirl_duplicates');
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const scoped = databaseUrlForSchema(baseUrl, schema);
    await migrate({ connectionString: scoped, migrationsDirectory: repositoryMigrations });
    pool = new Pool({ connectionString: scoped, max: 4 });

    process.env.DATABASE_URL = scoped;
    duplicates = await import('../../src/services/duplicateMailService.js');
    mailSend = await import('../../src/services/mailSendService.js');
    commerce = await import('../../src/services/commerceService.js');
    closeServicePool = (await import('../../src/db/index.js')).closePool;
  }, 180_000);

  afterAll(async () => {
    for (const [name, value] of [
      ['LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP', savedCaps.account],
      ['LETTER_IRL_BETA_GLOBAL_DAILY_MAIL_CEILING', savedCaps.global]
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await closeServicePool?.();
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }, 60_000);

  /**
   * An account with ten credits (five letters) by default. Pay & Send needs
   * one that cannot pay from balance, so it passes 0.
   */
  async function seedUser(credits = 10): Promise<string> {
    const userId = `auth0|duplicates-${randomUUID()}`;
    await pool.query(
      `INSERT INTO users (user_id, email, credits, credits_purchased)
       VALUES ($1, $2, $3, $4)`,
      [userId, `${randomUUID()}@test.invalid`, credits, credits]
    );
    if (credits > 0) {
      await pool.query(
        `INSERT INTO credit_ledger (user_id, initial_amount, remaining_amount, source_type)
         VALUES ($1, $2, $3, 'adjustment')`,
        [userId, credits, credits]
      );
    }
    return userId;
  }

  async function seedDraft(userId: string, seed: DraftSeed = {}): Promise<string> {
    const draftId = randomUUID();
    const postcard = seed.mailType === 'postcard';
    await pool.query(
      `INSERT INTO letter_drafts (
         draft_id, user_id, sender, recipient, body_text, sign_off, required_credits,
         expires_at, status, mail_type, layout_type, header_image_data, inline_image_data,
         front_image_data, postcard_size
       ) VALUES ($1, $2, $3, $4, $5, $6, 2, NOW() + INTERVAL '1 day', 'pending',
                 $7, $8, $9, $10, $11, $12)`,
      [
        draftId,
        userId,
        JSON.stringify(seed.sender ?? SENDER),
        JSON.stringify(seed.recipient ?? RECIPIENT),
        seed.body ?? 'Hi Sam, see you soon.',
        seed.signOff === undefined ? (postcard ? null : 'Love, Dee') : seed.signOff,
        seed.mailType ?? 'letter',
        seed.layoutType ?? 'text_only',
        seed.headerImage ?? null,
        seed.inlineImage ?? null,
        seed.frontImage ?? (postcard ? IMAGE_A : null),
        seed.postcardSize ?? (postcard ? '6x9' : null)
      ]
    );
    return draftId;
  }

  /** Mail as the send path writes it, created `hoursAgo` hours ago. */
  async function seedLetter(
    userId: string,
    options: { content?: Record<string, unknown>; status?: string; mailType?: string; hoursAgo?: number } = {}
  ): Promise<string> {
    const letterId = randomUUID();
    const content = options.content ?? {
      bodyText: 'Hi Sam, see you soon.',
      signOff: 'Love, Dee',
      sender: SENDER,
      layoutType: 'text_only',
      headerImageData: null,
      inlineImageData: null
    };
    await pool.query(
      `INSERT INTO letters (letter_id, user_id, content, recipient, credits_cost, status, mail_type, created_at)
       VALUES ($1, $2, $3, $4, 2, $5, $6,
               (NOW() AT TIME ZONE 'UTC') - make_interval(hours => $7))`,
      [
        letterId,
        userId,
        JSON.stringify(content),
        JSON.stringify(RECIPIENT),
        options.status ?? 'queued',
        options.mailType ?? 'letter',
        options.hoursAgo ?? 1
      ]
    );
    return letterId;
  }

  /** A Pay & Send order for `draftId`. */
  async function seedOrder(
    userId: string,
    draftId: string,
    options: { status: string; hoursAgo?: number; checkoutMinutesLeft?: number }
  ): Promise<string> {
    const orderId = `duplicates-order-${randomUUID()}`;
    await pool.query(
      `INSERT INTO orders (
         order_id, user_id, order_type, draft_id, product_code, product_snapshot,
         amount_cents, currency, idempotency_key, status, checkout_expires_at, created_at
       ) VALUES ($1, $2, 'jit_mail', $3, 'jit-letter', '{}', 499, 'usd', $4, $5,
                 NOW() + make_interval(mins => $6),
                 (NOW() AT TIME ZONE 'UTC') - make_interval(hours => $7))`,
      [
        orderId,
        userId,
        draftId,
        `jit-checkout:${orderId}`,
        options.status,
        options.checkoutMinutesLeft ?? 30,
        options.hoursAgo ?? 1
      ]
    );
    return orderId;
  }

  async function findFor(userId: string, draftId: string) {
    const db = { query: (text: string, params?: unknown[]) => pool.query(text, params) } as any;
    const mail = await duplicates.loadComparableDraft(db, draftId, userId);
    expect(mail).not.toBeNull();
    return duplicates.findRecentDuplicateMail(db, { userId, draftId, mail: mail! });
  }

  async function accountState(userId: string) {
    const result = await pool.query<{ credits: number; letters: string; jobs: string }>(
      `SELECT u.credits,
              (SELECT COUNT(*) FROM letters l WHERE l.user_id = u.user_id) AS letters,
              (SELECT COUNT(*) FROM letter_jobs j JOIN letters l ON l.letter_id = j.letter_id
                WHERE l.user_id = u.user_id) AS jobs
       FROM users u WHERE u.user_id = $1`,
      [userId]
    );
    return result.rows[0];
  }

  async function draftStatus(draftId: string): Promise<string> {
    const result = await pool.query<{ status: string }>(
      'SELECT status FROM letter_drafts WHERE draft_id = $1',
      [draftId]
    );
    return result.rows[0].status;
  }

  it('reads a draft only for its owner, and finds nothing on a new account', async () => {
    const userId = await seedUser();
    const other = await seedUser();
    const draftId = await seedDraft(userId);
    const db = { query: (text: string, params?: unknown[]) => pool.query(text, params) } as any;

    await expect(duplicates.loadComparableDraft(db, draftId, other)).resolves.toBeNull();
    await expect(findFor(userId, draftId)).resolves.toBeNull();
  });

  it('refuses a second identical letter from another draft, and rolls the send back', async () => {
    const userId = await seedUser();
    const first = await seedDraft(userId);
    const second = await seedDraft(userId, {
      recipient: { ...RECIPIENT, name: 'SAM  RIVERA' },
      body: 'hi sam,   see you SOON.'
    });

    await mailSend.createMailOrderFromDraft({ draftId: first, userId, mailType: 'letter' });
    expect(await accountState(userId)).toEqual({ credits: 8, letters: '1', jobs: '1' });

    await expect(
      mailSend.createMailOrderFromDraft({ draftId: second, userId, mailType: 'letter' })
    ).rejects.toMatchObject({
      code: 'DUPLICATE_RECENT_MAIL',
      duplicate: { kind: 'sent', mailType: 'letter', recipientName: 'Sam Rivera' }
    });

    expect(await accountState(userId)).toEqual({ credits: 8, letters: '1', jobs: '1' });
    expect(await draftStatus(second)).toBe('pending');
  });

  it('reports how long ago the first copy went out', async () => {
    const userId = await seedUser();
    await seedLetter(userId, { hoursAgo: 3 });
    const draftId = await seedDraft(userId);

    const found = await findFor(userId, draftId);

    expect(found?.kind).toBe('sent');
    expect(found!.ageSeconds).toBeGreaterThanOrEqual(3 * 3600 - 5);
    expect(found!.ageSeconds).toBeLessThan(3 * 3600 + 60);
  });

  it('sends another copy when the person asked for one', async () => {
    const userId = await seedUser();
    const first = await seedDraft(userId);
    const second = await seedDraft(userId);
    await mailSend.createMailOrderFromDraft({ draftId: first, userId, mailType: 'letter' });

    await expect(
      mailSend.createMailOrderFromDraft({ draftId: second, userId, mailType: 'letter', allowDuplicate: true })
    ).resolves.toMatchObject({ alreadyConsumed: false });

    expect(await accountState(userId)).toEqual({ credits: 6, letters: '2', jobs: '2' });
    expect(await draftStatus(second)).toBe('consumed');
  });

  it('still returns the existing order for the same draft', async () => {
    const userId = await seedUser();
    const draftId = await seedDraft(userId);
    const sent = await mailSend.createMailOrderFromDraft({ draftId, userId, mailType: 'letter' });

    await expect(
      mailSend.createMailOrderFromDraft({ draftId, userId, mailType: 'letter' })
    ).resolves.toMatchObject({ alreadyConsumed: true, letter: { letter_id: sent.letter.letter_id } });
    expect(await accountState(userId)).toEqual({ credits: 8, letters: '1', jobs: '1' });
  });

  it('lets a different letter through', async () => {
    const userId = await seedUser();
    const first = await seedDraft(userId);
    const second = await seedDraft(userId, { body: 'Hi Sam, see you later.' });
    await mailSend.createMailOrderFromDraft({ draftId: first, userId, mailType: 'letter' });

    await expect(
      mailSend.createMailOrderFromDraft({ draftId: second, userId, mailType: 'letter' })
    ).resolves.toMatchObject({ alreadyConsumed: false });
  });

  it('counts only the last 24 hours', async () => {
    const userId = await seedUser();
    await seedLetter(userId, { hoursAgo: 25 });
    const draftId = await seedDraft(userId);
    await expect(findFor(userId, draftId)).resolves.toBeNull();

    await seedLetter(userId, { hoursAgo: 23 });
    await expect(findFor(userId, draftId)).resolves.toMatchObject({ kind: 'sent' });
  });

  it('does not count failed or cancelled mail', async () => {
    const userId = await seedUser();
    await seedLetter(userId, { status: 'failed' });
    await seedLetter(userId, { status: 'cancelled' });
    const draftId = await seedDraft(userId);
    await expect(findFor(userId, draftId)).resolves.toBeNull();

    await seedLetter(userId, { status: 'delivered' });
    await expect(findFor(userId, draftId)).resolves.toMatchObject({ kind: 'sent' });
  });

  it('does not count another account, or another kind of mail', async () => {
    const userId = await seedUser();
    const other = await seedUser();
    await seedLetter(other);
    const draftId = await seedDraft(userId);
    await expect(findFor(userId, draftId)).resolves.toBeNull();

    const postcardId = await seedDraft(userId, { mailType: 'postcard', body: 'Hi Sam, see you soon.' });
    await seedLetter(userId);
    await expect(findFor(userId, postcardId)).resolves.toBeNull();
  });

  it('matches an image letter on the image the mail carries', async () => {
    const userId = await seedUser();
    const first = await seedDraft(userId, { layoutType: 'header_image', headerImage: IMAGE_A });
    const same = await seedDraft(userId, { layoutType: 'header_image', headerImage: IMAGE_A });
    const other = await seedDraft(userId, { layoutType: 'header_image', headerImage: IMAGE_B });
    const inline = await seedDraft(userId, { layoutType: 'inline_image', inlineImage: IMAGE_A });

    await mailSend.createMailOrderFromDraft({ draftId: first, userId, mailType: 'letter' });

    await expect(findFor(userId, same)).resolves.toMatchObject({ kind: 'sent' });
    await expect(findFor(userId, other)).resolves.toBeNull();
    await expect(findFor(userId, inline)).resolves.toBeNull();
  });

  it('matches a postcard on its message and front image', async () => {
    const userId = await seedUser();
    const first = await seedDraft(userId, { mailType: 'postcard', body: 'Wish you were here.' });
    const same = await seedDraft(userId, { mailType: 'postcard', body: 'WISH you were here. ' });
    const other = await seedDraft(userId, { mailType: 'postcard', body: 'Wish you were here.', frontImage: IMAGE_B });

    await mailSend.createMailOrderFromDraft({ draftId: first, userId, mailType: 'postcard' });

    await expect(
      mailSend.createMailOrderFromDraft({ draftId: same, userId, mailType: 'postcard' })
    ).rejects.toMatchObject({ code: 'DUPLICATE_RECENT_MAIL', duplicate: { mailType: 'postcard' } });
    await expect(findFor(userId, other)).resolves.toBeNull();
  });

  it('counts Pay & Send orders that are paid, or still open, and not expired or refunded ones', async () => {
    const userId = await seedUser();
    const draftId = await seedDraft(userId);

    const expired = await seedDraft(userId);
    await seedOrder(userId, expired, { status: 'checkout_pending', checkoutMinutesLeft: -5 });
    const refunded = await seedDraft(userId);
    await seedOrder(userId, refunded, { status: 'refund_pending' });
    const old = await seedDraft(userId);
    await seedOrder(userId, old, { status: 'paid', hoursAgo: 30 });
    await expect(findFor(userId, draftId)).resolves.toBeNull();

    const open = await seedDraft(userId);
    await seedOrder(userId, open, { status: 'checkout_pending' });
    await expect(findFor(userId, draftId)).resolves.toMatchObject({ kind: 'checkout_open' });

    const paid = await seedDraft(userId);
    await seedOrder(userId, paid, { status: 'fulfillment_pending' });
    await expect(findFor(userId, draftId)).resolves.toMatchObject({ kind: 'paid' });
  });

  it('never matches the draft against its own order', async () => {
    const userId = await seedUser();
    const draftId = await seedDraft(userId);
    await seedOrder(userId, draftId, { status: 'checkout_pending' });
    await expect(findFor(userId, draftId)).resolves.toBeNull();
  });

  it('refuses a prepaid send while a checkout for the same letter is open', async () => {
    const userId = await seedUser();
    const open = await seedDraft(userId);
    await seedOrder(userId, open, { status: 'checkout_pending' });
    const draftId = await seedDraft(userId);

    await expect(
      mailSend.createMailOrderFromDraft({ draftId, userId, mailType: 'letter' })
    ).rejects.toMatchObject({ code: 'DUPLICATE_RECENT_MAIL', duplicate: { kind: 'checkout_open' } });
    expect(await accountState(userId)).toEqual({ credits: 10, letters: '0', jobs: '0' });
  });

  describe('through Pay & Send', () => {
    async function ordersOf(userId: string) {
      const result = await pool.query<{
        order_id: string;
        draft_id: string;
        status: string;
        stripe_checkout_session_id: string | null;
      }>(
        `SELECT order_id, draft_id::text AS draft_id, status, stripe_checkout_session_id
         FROM orders WHERE user_id = $1 ORDER BY order_id`,
        [userId]
      );
      return result.rows;
    }

    it('refuses a new checkout for a letter already sent, before any order or session exists', async () => {
      const userId = await seedUser(0);
      await seedLetter(userId);
      const draftId = await seedDraft(userId);
      const sessions = stripeDouble.sessions.length;

      await expect(commerce.createJitCheckout({ userId, draftId })).rejects.toMatchObject({
        code: 'DUPLICATE_RECENT_MAIL',
        duplicate: { kind: 'sent', mailType: 'letter', recipientName: 'Sam Rivera' }
      });

      expect(await ordersOf(userId)).toEqual([]);
      expect(stripeDouble.sessions).toHaveLength(sessions);
    });

    it('opens the checkout when the person asked for another copy', async () => {
      const userId = await seedUser(0);
      await seedLetter(userId);
      const draftId = await seedDraft(userId);

      const copy = await commerce.createJitCheckout({ userId, draftId, allowDuplicate: true });

      expect(copy).toMatchObject({ success: true, reused: false, status: 'checkout_pending' });
      expect(copy.checkoutUrl).toBe(`https://checkout.stripe.test/${copy.orderId}`);
      expect(await ordersOf(userId)).toEqual([
        {
          order_id: copy.orderId,
          draft_id: draftId,
          status: 'checkout_pending',
          stripe_checkout_session_id: `cs_test_${copy.orderId}`
        }
      ]);
    });

    it('hands back the open checkout for the same draft without asking again', async () => {
      const userId = await seedUser(0);
      const draftId = await seedDraft(userId);
      const first = await commerce.createJitCheckout({ userId, draftId });
      await seedLetter(userId);

      const again = await commerce.createJitCheckout({ userId, draftId });

      expect(again).toMatchObject({ orderId: first.orderId, checkoutUrl: first.checkoutUrl, reused: true });
      expect(await ordersOf(userId)).toHaveLength(1);
    });

    it('checks the order that replaces one too near expiry, and leaves that one alone on a refusal', async () => {
      const userId = await seedUser(0);
      const draftId = await seedDraft(userId);
      // No session, and inside Stripe's 30-minute floor: prepareJitOrder
      // cancels this row and inserts a new order in its place.
      const stale = await seedOrder(userId, draftId, { status: 'checkout_pending', checkoutMinutesLeft: 10 });
      await seedLetter(userId);

      await expect(commerce.createJitCheckout({ userId, draftId })).rejects.toMatchObject({
        code: 'DUPLICATE_RECENT_MAIL',
        duplicate: { kind: 'sent' }
      });
      expect(await ordersOf(userId)).toEqual([
        { order_id: stale, draft_id: draftId, status: 'checkout_pending', stripe_checkout_session_id: null }
      ]);

      const copy = await commerce.createJitCheckout({ userId, draftId, allowDuplicate: true });

      expect(copy.reused).toBe(false);
      const orders = await ordersOf(userId);
      expect(orders).toHaveLength(2);
      expect(orders.find(order => order.order_id === stale)?.status).toBe('cancelled');
      expect(orders.find(order => order.order_id === copy.orderId)?.status).toBe('checkout_pending');
    });

    it('refuses a draft that was already sent as sent, not as a copy of itself', async () => {
      const userId = await seedUser();
      const draftId = await seedDraft(userId);
      await mailSend.createMailOrderFromDraft({ draftId, userId, mailType: 'letter' });

      await expect(commerce.createJitCheckout({ userId, draftId })).rejects.toMatchObject({
        code: 'DRAFT_INVALID_STATE'
      });
      expect(await ordersOf(userId)).toEqual([]);
    });
  });
});
