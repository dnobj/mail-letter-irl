import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import { normalizeGiftCode } from '../../src/services/giftCodes.js';
import { repositoryMigrations, validateDisposableDatabaseUrl } from './support/disposableDatabase.js';
import {
  definiteRejection,
  installStubProvider,
  resetStubProvider,
  stubProvider,
  STUB_PROVIDER_NAME
} from './support/stubProvider.js';

/**
 * Gift letters against real PostgreSQL (docs/gift-letters.md).
 *
 * The unit suites pin the decisions against a scripted client. What only a
 * real database settles: migration 033's constraints; one gift per send and
 * one redemption per code under concurrency, which is the cost bound; a seed
 * campaign's cap under concurrency; the send transaction rolling a consumed
 * gift back when a cap or the #412 guard refuses; and the outbox handing a
 * gift back exactly once when the provider refuses the piece.
 *
 * Every test uses its own accounts, so nothing needs cleaning between them.
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
  name: 'Grandma Rivera',
  addressLine1: '350 5th Ave',
  city: 'New York',
  state: 'NY',
  postalCode: '10118',
  country: 'US'
};
const SENDER = {
  name: 'Sarah Johnson',
  addressLine1: '1 Main St',
  city: 'Springfield',
  state: 'IL',
  postalCode: '62701',
  country: 'US'
};

describePostgres('gift letters (033)', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let schema: string;
  let gifts: typeof import('../../src/services/giftLetterService.js');
  let mailSend: typeof import('../../src/services/mailSendService.js');
  let redemption: typeof import('../../src/services/codeRedemptionService.js');
  let promos: typeof import('../../src/services/promoService.js');
  let commerce: typeof import('../../src/services/commerceService.js');
  let ledger: typeof import('../../src/services/creditLedgerService.js');
  let db: typeof import('../../src/db/index.js');

  const saved: Record<string, string | undefined> = {};
  const ENV = {
    LETTER_IRL_GIFT_LETTERS_ENABLED: 'true',
    LETTER_IRL_GIFT_DAILY_SEND_CAP: '100000',
    LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP: '1000',
    LETTER_IRL_BETA_GLOBAL_DAILY_MAIL_CEILING: '100000',
    LETTER_IRL_GIFT_LANDING_BASE_URL: 'https://letterirl.test'
  };

  beforeAll(async () => {
    for (const [name, value] of Object.entries(ENV)) {
      saved[name] = process.env[name];
      process.env[name] = value;
    }
    const baseUrl = validateDisposableDatabaseUrl(process.env.LIRL_TEST_DATABASE_URL);
    adminPool = new Pool({ connectionString: baseUrl });
    schema = schemaName('lirl_gifts');
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const scoped = databaseUrlForSchema(baseUrl, schema);
    await migrate({ connectionString: scoped, migrationsDirectory: repositoryMigrations });
    pool = new Pool({ connectionString: scoped, max: 8 });

    process.env.DATABASE_URL = scoped;
    await installStubProvider();
    // Migration 015 routes every mail type to postgrid; send them to the stub.
    await pool.query(`UPDATE provider_routing SET provider = $1, enabled = true`, [STUB_PROVIDER_NAME]);
    gifts = await import('../../src/services/giftLetterService.js');
    mailSend = await import('../../src/services/mailSendService.js');
    redemption = await import('../../src/services/codeRedemptionService.js');
    promos = await import('../../src/services/promoService.js');
    commerce = await import('../../src/services/commerceService.js');
    ledger = await import('../../src/services/creditLedgerService.js');
    db = await import('../../src/db/index.js');
  }, 180_000);

  afterAll(async () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await db?.closePool();
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }, 60_000);

  beforeEach(() => {
    process.env.LETTER_IRL_GIFT_DAILY_SEND_CAP = ENV.LETTER_IRL_GIFT_DAILY_SEND_CAP;
    resetStubProvider();
  });

  async function seedUser(email = `${randomUUID()}@test.invalid`): Promise<string> {
    const userId = `auth0|gifts-${randomUUID()}`;
    await pool.query(`INSERT INTO users (user_id, email, credits, credits_purchased) VALUES ($1, $2, 0, 0)`, [userId, email]);
    return userId;
  }

  async function grant(userId: string, generationsRemaining: number, extra: Record<string, unknown> = {}) {
    return db.transaction(client =>
      gifts.grantGiftLettersWithClient(client, {
        userId,
        quantity: 1,
        generationsRemaining,
        source: 'operator',
        sourceReferenceId: `test:${randomUUID()}`,
        ...extra
      })
    );
  }

  async function giftDraft(userId: string, body = `Hello ${randomUUID()}`): Promise<string> {
    const draftId = randomUUID();
    await pool.query(
      `INSERT INTO letter_drafts (
         draft_id, user_id, sender, recipient, body_text, sign_off, required_credits,
         expires_at, status, mail_type, layout_type, is_gift_send
       ) VALUES ($1, $2, $3, $4, $5, 'Love, Sarah', 2, NOW() + INTERVAL '1 day', 'pending',
                 'letter', 'text_only', true)`,
      [draftId, userId, JSON.stringify(SENDER), JSON.stringify(RECIPIENT), body]
    );
    return draftId;
  }

  async function sendGift(userId: string, body?: string) {
    return mailSend.createMailOrderFromDraft({ draftId: await giftDraft(userId, body), userId, mailType: 'letter' });
  }

  async function available(userId: string): Promise<number> {
    return (await gifts.getGiftBalance(userId)).available;
  }

  async function codeFor(letterId: string) {
    const result = await pool.query('SELECT * FROM gift_codes WHERE letter_id = $1', [letterId]);
    return result.rows[0];
  }

  describe('migration 033', () => {
    it('lets a letter be funded by a gift letter, but never with an order', async () => {
      const userId = await seedUser();
      await pool.query(
        `INSERT INTO letters (letter_id, user_id, content, recipient, credits_cost, status, mail_type, funding_type)
         VALUES ($1, $2, '{}', '{}', 2, 'draft', 'letter', 'gift_letter')`,
        [randomUUID(), userId]
      );
      const order = `gift-order-${randomUUID()}`;
      await pool.query(
        `INSERT INTO orders (order_id, user_id, order_type, product_code, product_snapshot, credits, amount_cents, currency, idempotency_key, status)
         VALUES ($1, $2, 'letter_pack', 'credit-pack-4', '{}', 4, 500, 'usd', $3, 'fulfilled')`,
        [order, userId, `pack:${order}`]
      );
      await expect(
        pool.query(
          `INSERT INTO letters (letter_id, user_id, content, recipient, credits_cost, status, mail_type, funding_type, funding_order_id)
           VALUES ($1, $2, '{}', '{}', 2, 'draft', 'letter', 'gift_letter', $3)`,
          [randomUUID(), userId, order]
        )
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('refuses a code outside Crockford base32, and a redemption that grants nothing', async () => {
      const userId = await seedUser();
      const [gift] = await grant(userId, 1);
      const letterId = randomUUID();
      await pool.query(
        `INSERT INTO letters (letter_id, user_id, content, recipient, credits_cost, status, mail_type, funding_type)
         VALUES ($1, $2, '{}', '{}', 2, 'draft', 'letter', 'gift_letter')`,
        [letterId, userId]
      );
      for (const bad of ['K7M2QX9I', 'K7M2QX9', 'k7m2qx9a', 'K7M2-QX9']) {
        await expect(
          pool.query(
            `INSERT INTO gift_codes (code, gift_id, letter_id, issued_to_user_id, grants_generations_remaining, expires_at)
             VALUES ($1, $2, $3, $4, 0, NOW() + INTERVAL '1 day')`,
            [bad, gift.gift_id, letterId, userId]
          )
        ).rejects.toMatchObject({ code: '23514' });
      }
      const campaign = await pool.query<{ campaign_id: string }>(
        `INSERT INTO promo_campaigns (code, name, credits_amount, status) VALUES ($1, 'x', 0, 'active') RETURNING campaign_id`,
        [`EMPTY-${randomUUID().slice(0, 8)}`]
      );
      await expect(
        pool.query(`INSERT INTO promo_redemptions (campaign_id, user_id) VALUES ($1, $2)`, [campaign.rows[0].campaign_id, userId])
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('normalises a campaign code in SQL exactly as normalizeGiftCode does in TypeScript', async () => {
      // The mint guard compares minted codes to campaign codes through this
      // translate(); if the two disagree, a chain code can shadow a campaign.
      for (const code of ['WELCOME5', 'welcome5', 'K7M2-QX9A', 'O1IL 0000', 'BOOKCLUB']) {
        const sql = await pool.query<{ normalised: string }>(
          `SELECT translate(UPPER($1::text), 'OIL- ', '011') AS normalised`,
          [code]
        );
        const typescript = normalizeGiftCode(code);
        if (typescript) expect(sql.rows[0].normalised).toBe(typescript);
      }
    });
  });

  describe('sending', () => {
    it('spends one gift letter, never the balance, and mints a code worth one less', async () => {
      const userId = await seedUser();
      await grant(userId, 2);
      const sent = await sendGift(userId);

      expect(sent.fundingType).toBe('gift_letter');
      const letter = await pool.query('SELECT funding_type, funding_order_id, content FROM letters WHERE letter_id = $1', [sent.letter.letter_id]);
      expect(letter.rows[0].funding_type).toBe('gift_letter');
      expect(letter.rows[0].funding_order_id).toBeNull();
      const code = await codeFor(sent.letter.letter_id);
      expect(code.grants_generations_remaining).toBe(1);
      expect(code.issued_to_user_id).toBe(userId);
      expect(code.status).toBe('issued');
      expect(letter.rows[0].content.giftCard).toMatchObject({
        state: 'funded',
        code: code.code,
        url: `https://letterirl.test/g/${code.code}`
      });
      const used = await pool.query('SELECT status, consumed_by_letter_id FROM gift_letters WHERE user_id = $1', [userId]);
      expect(used.rows).toEqual([{ status: 'consumed', consumed_by_letter_id: sent.letter.letter_id }]);
      const credits = await pool.query('SELECT credits FROM users WHERE user_id = $1', [userId]);
      expect(credits.rows[0].credits).toBe(0);
    });

    it('prints the plain card and mints nothing once the budget is spent', async () => {
      const userId = await seedUser();
      await grant(userId, 0);
      const sent = await sendGift(userId);
      expect(sent.giftCard).toEqual({ state: 'unfunded', url: 'https://letterirl.test', displayUrl: 'letterirl.test' });
      expect(await codeFor(sent.letter.letter_id)).toBeUndefined();
    });

    it('lets exactly one of two concurrent sends use a single gift letter', async () => {
      const userId = await seedUser();
      await grant(userId, 1);
      const results = await Promise.allSettled([sendGift(userId, 'first'), sendGift(userId, 'second')]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      const refused = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
      expect(refused.reason).toMatchObject({ code: 'GIFT_LETTER_UNAVAILABLE' });
      const letters = await pool.query(`SELECT COUNT(*)::int AS n FROM letters WHERE user_id = $1`, [userId]);
      expect(letters.rows[0].n).toBe(1);
    });

    it('rolls the gift back when the #412 guard refuses a second identical send', async () => {
      const userId = await seedUser();
      await grant(userId, 1);
      await grant(userId, 1);
      await sendGift(userId, 'the same words');
      await expect(sendGift(userId, 'the same words')).rejects.toMatchObject({ code: 'DUPLICATE_RECENT_MAIL' });
      expect(await available(userId)).toBe(1);
    });

    it('refuses past the daily gift budget and rolls the gift back', async () => {
      const userId = await seedUser();
      await grant(userId, 1);
      const sentToday = await pool.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM letters WHERE funding_type = 'gift_letter'
           AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')`
      );
      process.env.LETTER_IRL_GIFT_DAILY_SEND_CAP = String(sentToday.rows[0].n);
      await expect(sendGift(userId)).rejects.toMatchObject({ code: 'GIFT_DAILY_SEND_CAP' });
      expect(await available(userId)).toBe(1);
    });
  });

  describe('redeeming', () => {
    it('grants exactly one gift letter when two people race for one code', async () => {
      const sender = await seedUser();
      await grant(sender, 2);
      const sent = await sendGift(sender);
      const { code } = await codeFor(sent.letter.letter_id);
      const [a, b] = [await seedUser(), await seedUser()];

      const results = await Promise.all([
        redemption.redeemCode({ userId: a, email: `${a}@x.test`, code: code.toLowerCase() }),
        redemption.redeemCode({ userId: b, email: `${b}@x.test`, code: `${code.slice(0, 4)}-${code.slice(4)}` })
      ]);
      expect(results.filter(r => r.success)).toHaveLength(1);
      expect(results.find(r => !r.success)).toMatchObject({ reason: 'redeemed' });

      const granted = await pool.query(
        `SELECT user_id, generations_remaining, parent_code, source FROM gift_letters WHERE parent_code = $1`,
        [code]
      );
      expect(granted.rows).toHaveLength(1);
      expect(granted.rows[0]).toMatchObject({ generations_remaining: 1, source: 'chain_redemption' });
    });

    it('ends the chain at the budget: the last gift prints the plain card', async () => {
      const first = await seedUser();
      await grant(first, 1);
      const hop1 = await sendGift(first);
      const code1 = (await codeFor(hop1.letter.letter_id)).code;
      expect((await codeFor(hop1.letter.letter_id)).grants_generations_remaining).toBe(0);

      const second = await seedUser();
      expect(await redemption.redeemCode({ userId: second, email: `${second}@x.test`, code: code1 })).toMatchObject({ success: true, giftLetters: 1 });
      const hop2 = await sendGift(second);
      expect(hop2.giftCard?.state).toBe('unfunded');
      expect(await codeFor(hop2.letter.letter_id)).toBeUndefined();
    });

    it("refuses the sender's own code, from the same account or the same mailbox", async () => {
      const sender = await seedUser('sarah.johnson@gmail.com');
      await grant(sender, 1);
      const { code } = await codeFor((await sendGift(sender)).letter.letter_id);
      expect(await redemption.redeemCode({ userId: sender, email: 'sarah.johnson@gmail.com', code })).toMatchObject({ reason: 'own_code' });
      const alt = await seedUser('sarahjohnson+alt@gmail.com');
      expect(await redemption.redeemCode({ userId: alt, email: 'sarahjohnson+alt@gmail.com', code })).toMatchObject({ reason: 'own_code' });
      const still = await pool.query('SELECT status FROM gift_codes WHERE code = $1', [code]);
      expect(still.rows[0].status).toBe('issued');
    });

    it('holds a seed campaign to its cap under concurrency and to one claim per person', async () => {
      const code = `SEED-${randomUUID().slice(0, 8).toUpperCase()}`;
      await db.transaction(client =>
        promos.createCampaignWithClient(client, {
          code,
          name: 'Readers',
          creditsAmount: 0,
          maxTotalRedemptions: 2,
          giftGenerationsRemaining: 1
        })
      );
      await pool.query(`UPDATE promo_campaigns SET status = 'active' WHERE code = $1`, [code]);

      const users = await Promise.all([seedUser(), seedUser(), seedUser()]);
      const results = await Promise.all(users.map(u => redemption.redeemCode({ userId: u, email: `${u}@x.test`, code })));
      expect(results.filter(r => r.success)).toHaveLength(2);
      const rows = await pool.query(
        `SELECT r.ledger_id, g.generations_remaining, g.source
           FROM promo_redemptions r JOIN gift_letters g ON g.gift_id = r.gift_id
           JOIN promo_campaigns c ON c.campaign_id = r.campaign_id WHERE c.code = $1`,
        [code]
      );
      expect(rows.rows).toEqual([
        { ledger_id: null, generations_remaining: 1, source: 'seed_redemption' },
        { ledger_id: null, generations_remaining: 1, source: 'seed_redemption' }
      ]);
    });

    it('refuses a second claim of a seed through another spelling of the same Gmail address', async () => {
      const code = `SEED-${randomUUID().slice(0, 8).toUpperCase()}`;
      await db.transaction(client =>
        promos.createCampaignWithClient(client, { code, name: 'Readers', creditsAmount: 0, giftGenerationsRemaining: 0 })
      );
      await pool.query(`UPDATE promo_campaigns SET status = 'active' WHERE code = $1`, [code]);
      const one = await seedUser();
      const two = await seedUser();
      expect(await redemption.redeemCode({ userId: one, email: 'Reader.One@gmail.com', code })).toMatchObject({ success: true });
      expect(await redemption.redeemCode({ userId: two, email: 'readerone+2@gmail.com', code })).toMatchObject({
        success: false,
        error: 'This code has already been redeemed with this email address.'
      });
    });
  });

  describe('when the provider refuses the piece', () => {
    async function processSent(sent: Awaited<ReturnType<typeof sendGift>>) {
      const jobs = await import('../../src/services/letterJobService.js');
      stubProvider.nextResult = definiteRejection('stub refused');
      await jobs.processLetterJob(sent.job!.job_id);
      return jobs;
    }

    it('voids the unmailed code and hands the gift back exactly once', async () => {
      const userId = await seedUser();
      await grant(userId, 3);
      const sent = await sendGift(userId);
      const jobs = await processSent(sent);

      // Premise: the stub was reached and the job ended, or every assertion
      // below would pass for a job that never ran.
      expect(stubProvider.calls).toHaveLength(1);
      expect((stubProvider.calls[0].params as { giftCard?: unknown }).giftCard).toMatchObject({ state: 'funded' });
      const job = await pool.query('SELECT status FROM letter_jobs WHERE job_id = $1', [sent.job!.job_id]);
      expect(job.rows[0].status).toBe('failed');

      expect(await codeFor(sent.letter.letter_id)).toMatchObject({ status: 'void', void_reason: 'send_failed' });
      const returned = await pool.query(
        `SELECT generations_remaining, status FROM gift_letters WHERE source = 'send_failed' AND source_reference_id = $1`,
        [sent.letter.letter_id]
      );
      expect(returned.rows).toEqual([{ generations_remaining: 3, status: 'available' }]);

      // A replay hands nothing more back, and an operator retry is refused.
      await db.transaction(client =>
        gifts.returnGiftLetterForFailedSendWithClient(client, { letterId: sent.letter.letter_id, userId, failureCode: 'X' })
      );
      expect(await available(userId)).toBe(1);
      await expect(
        db.transaction(client => ledger.isLetterAlreadyCompensated(client, { letterId: sent.letter.letter_id, userId }))
      ).resolves.toBe(true);
      void jobs;
    }, 60_000);

    it('hands nothing back once the code has been redeemed: the letter evidently arrived', async () => {
      const userId = await seedUser();
      await grant(userId, 1);
      const sent = await sendGift(userId);
      const { code } = await codeFor(sent.letter.letter_id);
      const recipient = await seedUser();
      expect(await redemption.redeemCode({ userId: recipient, email: `${recipient}@x.test`, code })).toMatchObject({ success: true });

      await processSent(sent);

      expect(stubProvider.calls).toHaveLength(1);
      expect(await codeFor(sent.letter.letter_id)).toMatchObject({ status: 'redeemed' });
      expect(await available(userId)).toBe(0);
    }, 60_000);
  });

  describe('when the purchase is reversed', () => {
    async function packWithGifts(userId: string) {
      const orderId = `gift-pack-${randomUUID()}`;
      await pool.query(
        `INSERT INTO orders (order_id, user_id, order_type, product_code, product_snapshot, credits, amount_cents, currency, idempotency_key, status)
         VALUES ($1, $2, 'letter_pack', 'credit-pack-4', '{}', 4, 500, 'usd', $3, 'fulfilled')`,
        [orderId, userId, `pack:${orderId}`]
      );
      await db.transaction(client =>
        gifts.grantGiftLettersWithClient(client, {
          userId,
          quantity: 2,
          generationsRemaining: 1,
          source: 'pack_purchase',
          sourceReferenceId: orderId,
          sourceOrderId: orderId
        })
      );
      const sent = await sendGift(userId);
      const order = (await pool.query('SELECT * FROM orders WHERE order_id = $1', [orderId])).rows[0];
      return { order, sent };
    }

    it('revokes unsent gifts on a refund, marks the sent one, and leaves its printed code alone', async () => {
      const userId = await seedUser();
      const { order, sent } = await packWithGifts(userId);
      await db.transaction(client => commerce.revokePackLots(client, order, { credits: 'all' }));

      const rows = await pool.query(
        `SELECT status, source_reversed_at IS NOT NULL AS reversed FROM gift_letters WHERE source_order_id = $1 ORDER BY status`,
        [order.order_id]
      );
      expect(rows.rows).toEqual([
        { status: 'consumed', reversed: true },
        { status: 'revoked', reversed: false }
      ]);
      expect(await codeFor(sent.letter.letter_id)).toMatchObject({ status: 'issued' });
    });

    it('also voids the unredeemed code on a dispute', async () => {
      const userId = await seedUser();
      const { order, sent } = await packWithGifts(userId);
      await db.transaction(client =>
        commerce.revokePackLots(client, order, { credits: 'all', cause: 'payment_disputed', disputeId: 'dp_test' })
      );
      expect(await codeFor(sent.letter.letter_id)).toMatchObject({ status: 'void', void_reason: 'purchase_reversed' });
    });
  });
});
