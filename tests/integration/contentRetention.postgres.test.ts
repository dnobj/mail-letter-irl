import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import { repositoryMigrations, validateDisposableDatabaseUrl } from './support/disposableDatabase.js';

/**
 * Issue #153 - enforce the published retention schedule.
 *
 *   sent letter content          -> anonymized at 90 days
 *   drafts on a PAID order       -> the same schedule
 *   drafts on an abandoned one   -> anonymized at 7 days (they cannot be deleted)
 *   unsent, no order at all      -> deleted at 7 days by cleanupOldDrafts
 *
 * These run against real PostgreSQL because every property that matters is a
 * property of the STATEMENT: the boundary, the allow-list holds, the
 * idempotency guard, and the fact that anonymization leaves the financial
 * audit trail standing. A mocked query() would accept a predicate matching
 * every row in the table - which is precisely how the first version of the
 * unit suite passed while missing three fatal mutations.
 *
 * Each test truncates first, so none depends on another's leftovers and any
 * one can be run in isolation.
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

const SECRET_BODY = 'Dear Sam, the thing we discussed is going ahead on Tuesday.';
const SECRET_STREET = '221B Baker Street';
const SECRET_IMAGE_URL = 'https://images.example.invalid/secret-photo.png';

describePostgres('content retention sweep', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let schema: string;
  let retention: typeof import('../../src/services/retentionService.js');
  let closeServicePool: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const baseUrl = validateDisposableDatabaseUrl(process.env.LIRL_TEST_DATABASE_URL);
    adminPool = new Pool({ connectionString: baseUrl });
    schema = schemaName('lirl_retention');
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const scoped = databaseUrlForSchema(baseUrl, schema);
    await migrate({ connectionString: scoped, migrationsDirectory: repositoryMigrations });
    pool = new Pool({ connectionString: scoped, max: 8 });

    process.env.DATABASE_URL = scoped;
    retention = await import('../../src/services/retentionService.js');
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

  beforeEach(async () => {
    // Order-independence: every exact-count assertion below would otherwise be
    // hostage to what an earlier test happened to leave due.
    await pool.query(
      `TRUNCATE credit_consumption, credit_transactions, credit_ledger,
                letter_jobs, orders, letter_drafts, letters, users
       RESTART IDENTITY CASCADE`
    );
  });

  async function seedUser(): Promise<string> {
    const userId = `user_${randomUUID()}`;
    await pool.query(`INSERT INTO users (user_id, email, credits) VALUES ($1, $2, 0)`, [
      userId,
      `${userId}@test.invalid`
    ]);
    return userId;
  }

  async function seedSentLetter(options: {
    daysAgo: number;
    status?: string;
    userId?: string;
  }): Promise<{ userId: string; letterId: string }> {
    const userId = options.userId ?? (await seedUser());
    const letterId = `letter_${randomUUID()}`;
    await pool.query(
      `INSERT INTO letters (
         letter_id, user_id, content, recipient, credits_cost, status, preview_html, sent_at
       ) VALUES ($1, $2, $3::jsonb, $4::jsonb, 2, $5, $6,
                 NOW() - make_interval(days => $7::int))`,
      [
        letterId,
        userId,
        JSON.stringify({ bodyText: SECRET_BODY, signOff: 'Yours, Alex' }),
        JSON.stringify({ name: 'Sam', addressLine1: SECRET_STREET, city: 'London' }),
        options.status ?? 'delivered',
        `<p>${SECRET_BODY}</p>`,
        options.daysAgo
      ]
    );
    return { userId, letterId };
  }

  /** jit_mail orders require credits IS NULL and a draft_id (migration 021). */
  async function seedDraft(userId: string, letterId?: string): Promise<string> {
    const draftId = randomUUID();
    await pool.query(
      `INSERT INTO letter_drafts (
         draft_id, user_id, sender, recipient, body_text, sign_off,
         required_credits, status, expires_at, consumed_letter_id
       ) VALUES ($1, $2, '{}'::jsonb, '{}'::jsonb, 'x', 'x', 2,
                 'consumed', NOW() - INTERVAL '1 day', $3)`,
      [draftId, userId, letterId ?? null]
    );
    return draftId;
  }

  async function seedJitOrder(options: {
    userId: string;
    status: string;
    letterId?: string;
    draftId?: string;
  }): Promise<string> {
    const orderId = `order_${randomUUID()}`;
    const draftId = options.draftId ?? (await seedDraft(options.userId, options.letterId));
    await pool.query(
      `INSERT INTO orders (
         order_id, user_id, credits, amount_cents, currency, status,
         order_type, product_code, idempotency_key, draft_id, letter_id
       ) VALUES ($1, $2, NULL, 499, 'USD', $3, 'jit_mail', 'jit-letter', $4, $5, $6)`,
      [orderId, options.userId, options.status, `idem_${orderId}`, draftId, options.letterId ?? null]
    );
    return orderId;
  }

  /**
   * A PREPAID letter and the pack order that funded it, linked only through
   * the ledger - which is the only link that exists for prepaid mail, because
   * orders.letter_id is written solely on the jit path.
   */
  async function seedPrepaidLetterFundedByPack(options: {
    daysAgo: number;
    orderStatus: string;
  }): Promise<{ letterId: string; orderId: string }> {
    const userId = await seedUser();
    const { letterId } = await seedSentLetter({ daysAgo: options.daysAgo, userId });
    const orderId = `order_${randomUUID()}`;
    await pool.query(
      `INSERT INTO orders (
         order_id, user_id, credits, amount_cents, currency, status,
         order_type, product_code, idempotency_key
       ) VALUES ($1, $2, 10, 1000, 'USD', $3, 'letter_pack', 'credit-pack-10', $4)`,
      [orderId, userId, options.orderStatus, `idem_${orderId}`]
    );
    const lot = await pool.query<{ ledger_id: string }>(
      `INSERT INTO credit_ledger (
         user_id, initial_amount, remaining_amount, source_type,
         source_reference_id, source_order_id, expiration_policy, status
       ) VALUES ($1, 10, 8, 'purchase', $2, $2, 'never', 'active')
       RETURNING ledger_id`,
      [userId, orderId]
    );
    const txn = await pool.query<{ transaction_id: number }>(
      `INSERT INTO credit_transactions (
         user_id, amount, balance_after, type, reference_type, reference_id
       ) VALUES ($1, -2, 8, 'deduction', 'letter', $2)
       RETURNING transaction_id`,
      [userId, letterId]
    );
    await pool.query(
      `INSERT INTO credit_consumption (transaction_id, ledger_id, amount, ledger_remaining_after)
       VALUES ($1, $2, 2, 8)`,
      [txn.rows[0].transaction_id, lot.rows[0].ledger_id]
    );
    return { letterId, orderId };
  }

  /**
   * letter_jobs couples status to provider_outcome, and 'held' additionally
   * requires held_at and hold_reason (valid_letter_job_outcome_state and
   * valid_letter_job_hold, migration 023). A fixture that ignores the state
   * machine is rejected outright, so derive the companion fields per status.
   */
  async function seedJob(letterId: string, status: string): Promise<void> {
    const outcome =
      status === 'completed'
        ? 'accepted'
        : status === 'held'
          ? 'ambiguous'
          : status === 'processing'
            ? 'dispatching'
            : 'not_dispatched';
    await pool.query(
      `INSERT INTO letter_jobs (
         job_id, letter_id, status, idempotency_key, next_attempt_at,
         provider_outcome, held_at, hold_reason
       ) VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7)`,
      [
        `job_${randomUUID()}`,
        letterId,
        status,
        `idem_${randomUUID()}`,
        outcome,
        status === 'held' ? new Date() : null,
        status === 'held' ? 'ambiguous_provider_outcome' : null
      ]
    );
  }

  async function readLetter(letterId: string) {
    const { rows } = await pool.query(
      `SELECT content, recipient, preview_html, status, credits_cost, sent_at, redacted_at
         FROM letters WHERE letter_id = $1`,
      [letterId]
    );
    return rows[0];
  }

  describe('letters', () => {
    it('anonymizes content once the window has passed, and stamps redacted_at', async () => {
      const { letterId } = await seedSentLetter({ daysAgo: 91 });

      expect(await retention.purgeExpiredLetterContent()).toBe(1);

      const row = await readLetter(letterId);
      expect(row.content).toEqual({});
      expect(row.recipient).toEqual({});
      expect(row.preview_html).toBeNull();
      expect(row.redacted_at).not.toBeNull();
      expect(JSON.stringify(row)).not.toContain(SECRET_BODY);
      expect(JSON.stringify(row)).not.toContain(SECRET_STREET);
    });

    it('leaves a letter INSIDE the window untouched', async () => {
      const { letterId } = await seedSentLetter({ daysAgo: 89 });

      expect(await retention.purgeExpiredLetterContent()).toBe(0);

      expect((await readLetter(letterId)).content.bodyText).toBe(SECRET_BODY);
    });

    it('preserves the non-content columns it must not touch', async () => {
      const { letterId } = await seedSentLetter({ daysAgo: 120 });

      await retention.purgeExpiredLetterContent();

      const row = await readLetter(letterId);
      expect(row.status).toBe('delivered');
      expect(row.credits_cost).toBe(2);
      expect(row.sent_at).not.toBeNull();
    });

    it('is idempotent - a second sweep redacts nothing', async () => {
      await seedSentLetter({ daysAgo: 200 });

      expect(await retention.purgeExpiredLetterContent()).toBe(1);
      expect(await retention.purgeExpiredLetterContent()).toBe(0);
    });

    it('can be re-swept after clearing redacted_at, which the sentinel could never do', async () => {
      // The point of the column: a sweep that shipped with a missed content
      // column can be fixed and re-run. The old '{"redacted":true}' sentinel
      // marked such rows done forever.
      const { letterId } = await seedSentLetter({ daysAgo: 200 });
      await retention.purgeExpiredLetterContent();

      await pool.query(`UPDATE letters SET redacted_at = NULL WHERE letter_id = $1`, [letterId]);

      expect(await retention.purgeExpiredLetterContent()).toBe(1);
    });

    it.each(['draft', 'queued', 'processing', 'held'])(
      'HOLDS a letter still in %s, however old',
      async status => {
        const { letterId } = await seedSentLetter({ daysAgo: 400, status });

        expect(await retention.purgeExpiredLetterContent()).toBe(0);

        expect((await readLetter(letterId)).content.bodyText).toBe(SECRET_BODY);
      }
    );

    it.each(['pending', 'processing', 'held', 'failed'])(
      'HOLDS a letter whose job is %s - a failed job can still be dispatched',
      async status => {
        const { letterId } = await seedSentLetter({ daysAgo: 400 });
        await seedJob(letterId, status);

        expect(await retention.purgeExpiredLetterContent()).toBe(0);
      }
    );

    it('redacts once every job is settled', async () => {
      const { letterId } = await seedSentLetter({ daysAgo: 400 });
      await seedJob(letterId, 'completed');

      expect(await retention.purgeExpiredLetterContent()).toBe(1);
    });

    it('HOLDS a letter whose JIT order is disputed', async () => {
      const { userId, letterId } = await seedSentLetter({ daysAgo: 400 });
      await seedJitOrder({ userId, status: 'disputed', letterId });

      expect(await retention.purgeExpiredLetterContent()).toBe(0);
    });

    it('HOLDS a PREPAID letter whose pack order is disputed', async () => {
      // The defect this whole rework exists for. orders.letter_id is jit-only,
      // so before the ledger arm this letter had NO hold at all and a pack
      // chargeback destroyed the evidence for every letter it funded.
      const { letterId } = await seedPrepaidLetterFundedByPack({
        daysAgo: 400,
        orderStatus: 'disputed'
      });

      expect(await retention.purgeExpiredLetterContent()).toBe(0);

      expect((await readLetter(letterId)).content.bodyText).toBe(SECRET_BODY);
    });

    it('redacts a PREPAID letter once its pack order is settled', async () => {
      const { letterId } = await seedPrepaidLetterFundedByPack({
        daysAgo: 400,
        orderStatus: 'fulfilled'
      });

      expect(await retention.purgeExpiredLetterContent()).toBe(1);

      expect((await readLetter(letterId)).content).toEqual({});
    });

    it('releases the hold once a dispute resolves', async () => {
      const { letterId, orderId } = await seedPrepaidLetterFundedByPack({
        daysAgo: 400,
        orderStatus: 'disputed'
      });
      expect(await retention.purgeExpiredLetterContent()).toBe(0);

      await pool.query(`UPDATE orders SET status = 'refunded' WHERE order_id = $1`, [orderId]);

      expect(await retention.purgeExpiredLetterContent()).toBe(1);
      expect((await readLetter(letterId)).content).toEqual({});
    });

    it('purges a FAILED letter that was never sent, clocking from created_at', async () => {
      // sent_at IS NULL for a letter that never reached the provider, so a
      // predicate keyed on sent_at alone retained its content forever.
      const userId = await seedUser();
      const letterId = `letter_${randomUUID()}`;
      await pool.query(
        `INSERT INTO letters (
           letter_id, user_id, content, recipient, credits_cost, status, created_at
         ) VALUES ($1, $2, $3::jsonb, $4::jsonb, 2, 'failed', NOW() - INTERVAL '200 days')`,
        [
          letterId,
          userId,
          JSON.stringify({ bodyText: SECRET_BODY }),
          JSON.stringify({ addressLine1: SECRET_STREET })
        ]
      );

      expect(await retention.purgeExpiredLetterContent()).toBe(1);
      expect((await readLetter(letterId)).content).toEqual({});
    });

    it('respects the batch limit', async () => {
      await seedSentLetter({ daysAgo: 400 });
      await seedSentLetter({ daysAgo: 400 });
      await seedSentLetter({ daysAgo: 400 });

      expect(await retention.purgeExpiredLetterContent(90, 2)).toBe(2);
    });
  });

  describe('drafts', () => {
    async function seedContentDraft(options: {
      daysAgo: number;
      userId: string;
      layout?: 'postcard' | 'header_image' | 'plain';
    }): Promise<string> {
      const draftId = randomUUID();
      const layout = options.layout ?? 'plain';
      const columns =
        layout === 'postcard'
          ? `, mail_type, front_image_data, front_image_url, postcard_size`
          : layout === 'header_image'
            ? `, layout_type, header_image_data, header_image_url`
            : '';
      const values =
        layout === 'postcard'
          ? `, 'postcard', 'data:image/jpeg;base64,SECRET', $6, '6x9'`
          : layout === 'header_image'
            ? `, 'header_image', 'data:image/jpeg;base64,SECRET', $6`
            : '';
      const params: unknown[] = [
        draftId,
        options.userId,
        JSON.stringify({ name: 'Alex', addressLine1: SECRET_STREET }),
        JSON.stringify({ name: 'Sam', addressLine1: SECRET_STREET }),
        SECRET_BODY
      ];
      if (layout !== 'plain') params.push(SECRET_IMAGE_URL);
      await pool.query(
        `INSERT INTO letter_drafts (
           draft_id, user_id, sender, recipient, body_text, sign_off,
           required_credits, status, expires_at, consumed_at, created_at${columns}
         ) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, 'Yours, Alex', 2,
                   'consumed',
                   NOW() - make_interval(days => ${options.daysAgo}),
                   NOW() - make_interval(days => ${options.daysAgo}),
                   NOW() - make_interval(days => ${options.daysAgo})${values})`,
        params
      );
      return draftId;
    }

    async function readDraft(draftId: string) {
      const { rows } = await pool.query(
        `SELECT sender, recipient, body_text, preview_html, required_credits,
                front_image_data, front_image_url, header_image_data, header_image_url,
                inline_image_data, redacted_at, mail_type
           FROM letter_drafts WHERE draft_id = $1`,
        [draftId]
      );
      return rows[0];
    }

    it('anonymizes a PAID draft at 90 days', async () => {
      const userId = await seedUser();
      const draftId = await seedContentDraft({ daysAgo: 120, userId });
      await seedJitOrder({ userId, status: 'fulfilled', draftId });

      expect(await retention.purgePaidDraftContent()).toBe(1);

      const row = await readDraft(draftId);
      expect(row.body_text).toBe('');
      expect(row.sender).toEqual({});
      expect(row.recipient).toEqual({});
      expect(row.redacted_at).not.toBeNull();
      expect(row.required_credits).toBe(2);
      expect(JSON.stringify(row)).not.toContain(SECRET_STREET);
    });

    it('HOLDS a paid draft whose order is still unsettled', async () => {
      const userId = await seedUser();
      const draftId = await seedContentDraft({ daysAgo: 120, userId });
      await seedJitOrder({ userId, status: 'fulfillment_pending', draftId });

      // Charged, but the draft is still the only copy of what was bought.
      expect(await retention.purgePaidDraftContent()).toBe(0);
      expect((await readDraft(draftId)).body_text).toBe(SECRET_BODY);
    });

    it('clears a POSTCARD image without tripping postcard_requires_image', async () => {
      const userId = await seedUser();
      const draftId = await seedContentDraft({ daysAgo: 120, userId, layout: 'postcard' });
      await seedJitOrder({ userId, status: 'fulfilled', draftId });

      await expect(retention.purgePaidDraftContent()).resolves.toBe(1);

      const row = await readDraft(draftId);
      expect(row.front_image_data).toBe('');
      expect(row.front_image_url).toBeNull();
      expect(row.mail_type).toBe('postcard');
    });

    it('clears a LAYOUT image without tripping header_layout_requires_image', async () => {
      const userId = await seedUser();
      const draftId = await seedContentDraft({ daysAgo: 120, userId, layout: 'header_image' });
      await seedJitOrder({ userId, status: 'fulfilled', draftId });

      await expect(retention.purgePaidDraftContent()).resolves.toBe(1);

      const row = await readDraft(draftId);
      expect(row.header_image_data).toBe('');
      expect(row.header_image_url).toBeNull();
      expect(JSON.stringify(row)).not.toContain(SECRET_IMAGE_URL);
    });

    it('leaves a null image null rather than changing the column shape', async () => {
      const userId = await seedUser();
      const draftId = await seedContentDraft({ daysAgo: 150, userId });
      await seedJitOrder({ userId, status: 'fulfilled', draftId });

      await retention.purgePaidDraftContent();

      const row = await readDraft(draftId);
      expect(row.front_image_data).toBeNull();
      expect(row.header_image_data).toBeNull();
      expect(row.inline_image_data).toBeNull();
    });

    it('does NOT treat an abandoned checkout as paid', async () => {
      const userId = await seedUser();
      const draftId = await seedContentDraft({ daysAgo: 120, userId });
      await seedJitOrder({ userId, status: 'cancelled', draftId });

      expect(await retention.purgePaidDraftContent()).toBe(0);
    });

    it('anonymizes an ABANDONED-checkout draft at 7 days, not 90', async () => {
      const userId = await seedUser();
      const draftId = await seedContentDraft({ daysAgo: 8, userId });
      await seedJitOrder({ userId, status: 'cancelled', draftId });

      expect(await retention.purgeAbandonedDraftContent()).toBe(1);

      const row = await readDraft(draftId);
      expect(row.body_text).toBe('');
      expect(JSON.stringify(row)).not.toContain(SECRET_STREET);
    });

    it('leaves an abandoned draft inside the 7-day window alone', async () => {
      const userId = await seedUser();
      const draftId = await seedContentDraft({ daysAgo: 3, userId });
      await seedJitOrder({ userId, status: 'checkout_pending', draftId });

      expect(await retention.purgeAbandonedDraftContent()).toBe(0);
      expect((await readDraft(draftId)).body_text).toBe(SECRET_BODY);
    });

    it('never touches a PAID draft on the unpaid schedule', async () => {
      const userId = await seedUser();
      const draftId = await seedContentDraft({ daysAgo: 30, userId });
      await seedJitOrder({ userId, status: 'fulfilled', draftId });

      expect(await retention.purgeAbandonedDraftContent()).toBe(0);
      expect((await readDraft(draftId)).body_text).toBe(SECRET_BODY);
    });

    it('leaves an order-less draft to cleanupOldDrafts', async () => {
      const userId = await seedUser();
      const draftId = await seedContentDraft({ daysAgo: 200, userId });

      expect(await retention.purgePaidDraftContent()).toBe(0);
      expect(await retention.purgeAbandonedDraftContent()).toBe(0);
      expect((await readDraft(draftId)).body_text).toBe(SECRET_BODY);
    });

    it('confirms an abandoned draft genuinely CANNOT be deleted', async () => {
      // The reason purgeAbandonedDraftContent exists at all: ON DELETE SET NULL
      // plus valid_order_draft makes the delete a constraint violation, so
      // cleanupOldDrafts can never reclaim these rows.
      const userId = await seedUser();
      const draftId = await seedContentDraft({ daysAgo: 30, userId });
      await seedJitOrder({ userId, status: 'cancelled', draftId });

      await expect(
        pool.query(`DELETE FROM letter_drafts WHERE draft_id = $1`, [draftId])
      ).rejects.toThrow(/valid_order_draft/);
    });
  });

  describe('runRetentionSweep', () => {
    it('reports counts only and no identifiers', async () => {
      await seedSentLetter({ daysAgo: 400 });

      const summary = await retention.runRetentionSweep();

      expect(summary.lettersRedacted).toBe(1);
      expect(summary.errors).toEqual([]);
      expect(Object.keys(summary).sort()).toEqual([
        'abandonedDraftsRedacted',
        'draftsRedacted',
        'errors',
        'lettersRedacted',
        'moreWaiting'
      ]);
      expect(JSON.stringify(summary)).not.toContain(SECRET_BODY);
      expect(JSON.stringify(summary)).not.toContain(SECRET_STREET);
    });

    it('refuses a window that would redact everything', async () => {
      await seedSentLetter({ daysAgo: 1 });

      const summary = await retention.runRetentionSweep(0);

      expect(summary.lettersRedacted).toBe(0);
      expect(summary.errors.join(' ')).toMatch(/positive integer/);
    });
  });
});
