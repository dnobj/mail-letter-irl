import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import type { LetterParams } from '../../src/services/providers/types.js';
import { repositoryMigrations, validateDisposableDatabaseUrl } from './support/disposableDatabase.js';
import {
  installStubProvider,
  providerSuccess,
  resetStubProvider,
  stubProvider,
  STUB_PROVIDER_NAME
} from './support/stubProvider.js';

/**
 * Certified mail past the draft (#625, migration 053).
 *
 *   a letter records how it travelled (standard, or one of the two certified
 *   services) and, for a certified one, the carrier's number; the CHECKs hold
 *   a postcard, a gift letter and every other value out
 *   the outbox hands the provider the service of a paid letter, and turns away
 *   a letter whose service the provider cannot send BEFORE asking it, so the
 *   order that paid for it goes to refund
 *   the status sync stores the carrier's number on its own, keeps asking for it
 *   after a delivery that came first, and never writes one to a standard letter
 *
 * Against real PostgreSQL because the constraints, the parameter types and the
 * widened status-sync query are the substance, and a mocked query() honours
 * none of them.
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

const NUMBER = '9407 1000 0000 0000 0000 00';

describePostgres('certified mail at the letter, the dispatch and the status sync (migration 053, #625)', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let schema: string;
  let jobs: typeof import('../../src/services/letterJobService.js');
  let sync: typeof import('../../src/services/statusSyncService.js');
  let closeServicePool: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const baseUrl = validateDisposableDatabaseUrl(process.env.LIRL_TEST_DATABASE_URL);
    adminPool = new Pool({ connectionString: baseUrl });
    schema = schemaName('lirl_certified');
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const scoped = databaseUrlForSchema(baseUrl, schema);
    await migrate({ connectionString: scoped, migrationsDirectory: repositoryMigrations });
    pool = new Pool({ connectionString: scoped, max: 4 });

    process.env.DATABASE_URL = scoped;
    await installStubProvider();
    // Routing consults provider_routing before LETTER_PROVIDER, and migration
    // 015 seeds it with postgrid (failedSendRefund.postgres.test.ts says why).
    await pool.query('UPDATE provider_routing SET provider = $1, enabled = true', [STUB_PROVIDER_NAME]);
    jobs = await import('../../src/services/letterJobService.js');
    sync = await import('../../src/services/statusSyncService.js');
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

  beforeEach(() => {
    resetStubProvider();
  });

  async function seedUser(): Promise<string> {
    const userId = `user_${randomUUID()}`;
    await pool.query('INSERT INTO users (user_id, email, credits) VALUES ($1, $2, 0)', [userId, `${userId}@test.invalid`]);
    return userId;
  }

  /**
   * A letter the outbox can dispatch, paid for by a Pay & Send order that awaits
   * fulfilment. The order names a draft (021's valid_order_draft).
   */
  async function seedPaidLetter(service: string): Promise<{ userId: string; letterId: string; orderId: string }> {
    const userId = await seedUser();
    const draft = await pool.query<{ draft_id: string }>(
      `INSERT INTO letter_drafts (user_id, sender, recipient, body_text, sign_off, required_credits, expires_at)
       VALUES ($1, '{}', '{}', 'Dear Sam', 'Regards', 2, NOW() + INTERVAL '1 day') RETURNING draft_id`,
      [userId]
    );
    const orderId = `order_${randomUUID()}`;
    await pool.query(
      `INSERT INTO orders (order_id, user_id, credits, amount_cents, currency, status, order_type, product_code,
         idempotency_key, draft_id, paid_at)
       VALUES ($1, $2, NULL, 1199, 'usd', 'fulfillment_pending', 'jit_mail', 'jit-letter-certified', $3, $4, NOW())`,
      [orderId, userId, `idem_${orderId}`, draft.rows[0].draft_id]
    );
    const letterId = randomUUID();
    await pool.query(
      `INSERT INTO letters (letter_id, user_id, content, recipient, credits_cost, status, mail_type,
         funding_type, funding_order_id, mail_service)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, 2, 'queued', 'letter', 'jit_order', $5, $6::text)`,
      [
        letterId,
        userId,
        JSON.stringify({ bodyText: 'Dear Sam', signOff: 'Regards', layoutType: 'text_only' }),
        JSON.stringify({
          name: 'Sam Rivera', addressLine1: '350 5th Ave', city: 'New York', state: 'NY', postalCode: '10118', country: 'US'
        }),
        orderId,
        service
      ]
    );
    return { userId, letterId, orderId };
  }

  async function queueJob(letterId: string): Promise<string> {
    const jobId = randomUUID();
    await pool.query(
      `INSERT INTO letter_jobs (job_id, letter_id, status, attempts, max_attempts, scheduled_at,
         idempotency_key, next_attempt_at)
       VALUES ($1, $2, 'pending', 0, 3, NOW(), $2, NOW())`,
      [jobId, letterId]
    );
    return jobId;
  }

  /** A letter with a provider id, as the status sync reads one. */
  async function seedSentLetter(options: { service: string; status: string; number?: string | null }): Promise<string> {
    const userId = await seedUser();
    const letterId = randomUUID();
    await pool.query(
      `INSERT INTO letters (letter_id, user_id, content, recipient, credits_cost, status, mail_type,
         funding_type, mail_service, carrier_tracking_number, tracking_id, provider, sent_at)
       VALUES ($1, $2, '{}'::jsonb, '{}'::jsonb, 2, $3, 'letter', 'prepaid_balance', $4::text, $5::text, $6,
         $7, NOW())`,
      [letterId, userId, options.status, options.service, options.number ?? null, `pg_${letterId}`, STUB_PROVIDER_NAME]
    );
    return letterId;
  }

  async function letterNow(letterId: string) {
    return (
      await pool.query<{
        status: string;
        mail_service: string;
        carrier_tracking_number: string | null;
        updated_at: Date;
      }>('SELECT status, mail_service, carrier_tracking_number, updated_at FROM letters WHERE letter_id = $1', [letterId])
    ).rows[0];
  }

  describe('migration 053: how a letter travelled', () => {
    it('records standard by default, and admits only the three services', async () => {
      const userId = await seedUser();
      const letterId = randomUUID();
      await pool.query(
        `INSERT INTO letters (letter_id, user_id, content, recipient, credits_cost, status)
         VALUES ($1, $2, '{}'::jsonb, '{}'::jsonb, 2, 'draft')`,
        [letterId, userId]
      );
      const now = await letterNow(letterId);
      expect(now.mail_service).toBe('standard');
      expect(now.carrier_tracking_number).toBeNull();

      for (const service of ['certified', 'certified_return_receipt', 'standard']) {
        await pool.query('UPDATE letters SET mail_service = $2::text WHERE letter_id = $1', [letterId, service]);
        expect((await letterNow(letterId)).mail_service).toBe(service);
      }
      for (const service of ['registered', 'express', '', 'Certified']) {
        await expect(
          pool.query('UPDATE letters SET mail_service = $2::text WHERE letter_id = $1', [letterId, service]),
          service
        ).rejects.toMatchObject({ code: '23514', constraint: 'letters_mail_service_known' });
      }
      expect((await letterNow(letterId)).mail_service).toBe('standard');
    }, 60_000);

    it('admits a service other than standard only on a letter that is neither a postcard nor a gift letter', async () => {
      const refused = { code: '23514', constraint: 'letters_mail_service_letters_paid_per_send' };
      const postcard = await seedSentLetter({ service: 'standard', status: 'processing' });
      await pool.query("UPDATE letters SET mail_type = 'postcard' WHERE letter_id = $1", [postcard]);
      await expect(
        pool.query("UPDATE letters SET mail_service = 'certified' WHERE letter_id = $1", [postcard])
      ).rejects.toMatchObject(refused);

      const gift = await seedSentLetter({ service: 'standard', status: 'processing' });
      await pool.query("UPDATE letters SET funding_type = 'gift_letter' WHERE letter_id = $1", [gift]);
      await expect(
        pool.query("UPDATE letters SET mail_service = 'certified_return_receipt' WHERE letter_id = $1", [gift])
      ).rejects.toMatchObject(refused);

      // Nor does a certified letter become a postcard or a gift letter.
      const certified = await seedSentLetter({ service: 'certified', status: 'processing' });
      for (const change of ["mail_type = 'postcard'", "funding_type = 'gift_letter'"]) {
        await expect(pool.query(`UPDATE letters SET ${change} WHERE letter_id = $1`, [certified]), change)
          .rejects.toMatchObject(refused);
      }
      expect((await letterNow(certified)).mail_service).toBe('certified');
    }, 60_000);

    it("keeps the carrier's number to a letter that travelled certified, within 64 characters", async () => {
      const standard = await seedSentLetter({ service: 'standard', status: 'processing' });
      await expect(
        pool.query('UPDATE letters SET carrier_tracking_number = $2::text WHERE letter_id = $1', [standard, NUMBER])
      ).rejects.toMatchObject({ code: '23514', constraint: 'letters_carrier_tracking_certified_only' });

      const certified = await seedSentLetter({ service: 'certified', status: 'processing' });
      await pool.query('UPDATE letters SET carrier_tracking_number = $2::text WHERE letter_id = $1', [certified, NUMBER]);
      expect((await letterNow(certified)).carrier_tracking_number).toBe(NUMBER);
      for (const tooLong of ['', 'A'.repeat(65)]) {
        await expect(
          pool.query('UPDATE letters SET carrier_tracking_number = $2::text WHERE letter_id = $1', [certified, tooLong])
        ).rejects.toMatchObject({ code: '23514', constraint: 'letters_carrier_tracking_length' });
      }
      await pool.query('UPDATE letters SET carrier_tracking_number = $2::text WHERE letter_id = $1', [certified, 'A'.repeat(64)]);

      // A letter cannot go back to standard while it holds a number.
      await expect(
        pool.query("UPDATE letters SET mail_service = 'standard' WHERE letter_id = $1", [certified])
      ).rejects.toMatchObject({ code: '23514', constraint: 'letters_carrier_tracking_certified_only' });
    }, 60_000);
  });

  describe('the dispatch', () => {
    async function jobAndLetter(jobId: string, letterId: string) {
      const job = await pool.query<{ status: string; provider_outcome: string }>(
        'SELECT status, provider_outcome FROM letter_jobs WHERE job_id = $1',
        [jobId]
      );
      return { job: job.rows[0], letter: await letterNow(letterId) };
    }

    it.each(['certified', 'certified_return_receipt'])(
      'hands the provider the service of a paid %s letter, and the letter is accepted',
      async service => {
        stubProvider.supportsExtraServices = true;
        stubProvider.nextResult = providerSuccess(`stub-${service}`);
        const { letterId, orderId } = await seedPaidLetter(service);
        const jobId = await queueJob(letterId);

        await jobs.processLetterJob(jobId);

        expect(stubProvider.calls).toHaveLength(1);
        expect((stubProvider.calls[0].params as LetterParams).extraService).toBe(service);
        const { job, letter } = await jobAndLetter(jobId, letterId);
        expect(job).toMatchObject({ status: 'completed', provider_outcome: 'accepted' });
        expect(letter).toMatchObject({ status: 'accepted', mail_service: service });
        const order = await pool.query('SELECT status FROM orders WHERE order_id = $1', [orderId]);
        expect(order.rows[0].status).toBe('fulfilled');
      },
      60_000
    );

    it('hands the provider no service for a standard letter', async () => {
      stubProvider.supportsExtraServices = true;
      stubProvider.nextResult = providerSuccess('stub-standard');
      const { letterId } = await seedPaidLetter('standard');

      await jobs.processLetterJob(await queueJob(letterId));

      expect(stubProvider.calls).toHaveLength(1);
      expect((stubProvider.calls[0].params as LetterParams).extraService).toBeUndefined();
    }, 60_000);

    it('turns away a certified letter the provider cannot send before asking it, and the order that paid goes to refund', async () => {
      // supportsExtraServices is left unset: the provider does not say it can.
      stubProvider.nextResult = providerSuccess('would-be-sent');
      const { letterId, orderId } = await seedPaidLetter('certified');
      const jobId = await queueJob(letterId);

      await jobs.processLetterJob(jobId);

      // The premise of the test: the provider was never reached.
      expect(stubProvider.calls).toHaveLength(0);
      const { job, letter } = await jobAndLetter(jobId, letterId);
      expect(job).toMatchObject({ status: 'failed', provider_outcome: 'definite_failure' });
      expect(letter.status).toBe('failed');
      const order = await pool.query<{ status: string; last_error_code: string; last_error: string }>(
        'SELECT status, last_error_code, last_error FROM orders WHERE order_id = $1',
        [orderId]
      );
      expect(order.rows[0]).toEqual({
        status: 'refund_pending',
        last_error_code: 'PROVIDER_SUBMISSION_FAILED',
        last_error: 'provider_rejected'
      });
      const events = await pool.query(
        "SELECT 1 FROM commerce_order_events WHERE order_id = $1 AND event_type = 'provider.terminal_failure'",
        [orderId]
      );
      expect(events.rowCount).toBe(1);
    }, 60_000);
  });

  describe('the status sync', () => {
    beforeEach(async () => {
      // Other tests leave letters the sync would poll; this one follows only its own.
      await pool.query("UPDATE letters SET status = 'cancelled' WHERE status <> 'cancelled'");
    });

    const answering = (number: string | undefined, status: 'processing' | 'in_transit' | 'delivered' = 'processing') => {
      stubProvider.statusFor = trackingId => ({
        trackingId,
        status,
        statusMessage: 'Stub status',
        lastUpdated: new Date(),
        carrierTrackingNumber: number
      });
    };

    it("stores the carrier's number once the provider has it, though the status has not moved, and only once", async () => {
      const letterId = await seedSentLetter({ service: 'certified', status: 'processing' });
      answering(NUMBER);

      const first = await sync.syncLetterStatuses(false, 30);
      const stored = await letterNow(letterId);

      expect(first).toMatchObject({ checked: 1, updated: 0, errors: 0 });
      expect(stored).toMatchObject({ status: 'processing', carrier_tracking_number: NUMBER });

      const second = await sync.syncLetterStatuses(false, 30);
      const again = await letterNow(letterId);
      expect(second).toMatchObject({ checked: 1, updated: 0, errors: 0 });
      // Nothing was written the second time: the number is the same.
      expect(again.updated_at.getTime()).toBe(stored.updated_at.getTime());
    }, 60_000);

    it('replaces a number the provider now reports differently', async () => {
      const letterId = await seedSentLetter({ service: 'certified', status: 'processing', number: 'OLD-NUMBER-0001' });
      answering(NUMBER);

      await sync.syncLetterStatuses(false, 30);

      expect((await letterNow(letterId)).carrier_tracking_number).toBe(NUMBER);
    }, 60_000);

    it('never writes a number to a standard letter, and the sync still finishes it', async () => {
      const letterId = await seedSentLetter({ service: 'standard', status: 'processing' });
      answering(NUMBER, 'in_transit');

      const result = await sync.syncLetterStatuses(false, 30);

      expect(result).toMatchObject({ checked: 1, updated: 1, errors: 0 });
      expect(await letterNow(letterId)).toMatchObject({ status: 'in_transit', carrier_tracking_number: null });
    }, 60_000);

    it('writes nothing in a dry run', async () => {
      const letterId = await seedSentLetter({ service: 'certified', status: 'processing' });
      answering(NUMBER);

      await sync.syncLetterStatuses(true, 30);

      expect((await letterNow(letterId)).carrier_tracking_number).toBeNull();
    }, 60_000);

    it('keeps asking about a certified letter that was delivered without a number, and stops once it has one', async () => {
      const without = await seedSentLetter({ service: 'certified', status: 'delivered' });
      const withNumber = await seedSentLetter({ service: 'certified', status: 'delivered', number: NUMBER });
      const standard = await seedSentLetter({ service: 'standard', status: 'delivered' });
      answering(NUMBER, 'delivered');

      const result = await sync.syncLetterStatuses(false, 30);

      // Only the delivered certified letter without a number is asked about.
      expect(result).toMatchObject({ checked: 1, updated: 0, errors: 0 });
      expect(stubProvider.statusCalls).toEqual([`pg_${without}`]);
      expect((await letterNow(without)).carrier_tracking_number).toBe(NUMBER);
      expect((await letterNow(withNumber)).carrier_tracking_number).toBe(NUMBER);
      expect((await letterNow(standard)).carrier_tracking_number).toBeNull();

      stubProvider.statusCalls = [];
      await sync.syncLetterStatuses(false, 30);
      expect(stubProvider.statusCalls).toEqual([]);
    }, 60_000);
  });
});
