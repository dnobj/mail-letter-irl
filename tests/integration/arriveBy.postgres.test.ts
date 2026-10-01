import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import { repositoryMigrations, validateDisposableDatabaseUrl } from './support/disposableDatabase.js';

/**
 * Mail held to arrive by a date (migration 040, #535).
 *
 *   the dates are both set or both NULL, the mail date never after the
 *   arrival date, on drafts and letters alike
 *   they come back from whole-row reads as 'YYYY-MM-DD' strings
 *   a send copies them to the letter and holds the job until 09:00 New York
 *   time on the mail date: the claim, by id or not, leaves it alone
 *   a send whose mail date has passed is refused before anything is written
 *   set_arrival_date's update (setDraftSchedule) sets, moves and clears a
 *   pending draft's dates, leaves alone a draft that is not the caller's,
 *   sent, expired or held by a live Pay & Send order, and waits for a send
 *   that holds the draft's row
 *   a cancel (scheduledMailService) cancels held mail before it goes to the
 *   printer and returns its letters or gift letter exactly once, refuses
 *   what it must, answers 'busy' at once while the outbox holds the job, and
 *   frees the duplicate guard
 *   get_draft_status's read (getDraftState) gives a sent draft's letter as
 *   it stands, and only the draft owner's
 *
 * Against real PostgreSQL because the constraints, the DATE type, the job's
 * timestamps and the claim's predicate are the change's whole substance, and
 * a mocked query() honours none of them.
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

describePostgres('arrive-by (migration 040, #535)', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let schema: string;
  let mailSend: typeof import('../../src/services/mailSendService.js');
  let drafts: typeof import('../../src/services/draftService.js');
  let jobs: typeof import('../../src/services/letterJobService.js');
  let schedule: typeof import('../../src/services/deliverySchedule.js');
  let held: typeof import('../../src/services/scheduledMailService.js');
  let gifts: typeof import('../../src/services/giftLetterService.js');
  let inTransaction: typeof import('../../src/db/index.js')['transaction'];
  let closeServicePool: (() => Promise<void>) | undefined;

  const savedCaps = {
    account: process.env.LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP,
    global: process.env.LETTER_IRL_BETA_GLOBAL_DAILY_MAIL_CEILING
  };

  beforeAll(async () => {
    // The daily caps are not what this file tests.
    process.env.LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP = '1000';
    process.env.LETTER_IRL_BETA_GLOBAL_DAILY_MAIL_CEILING = '100000';
    const baseUrl = validateDisposableDatabaseUrl(process.env.LIRL_TEST_DATABASE_URL);
    adminPool = new Pool({ connectionString: baseUrl });
    schema = schemaName('lirl_arrive_by');
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const scoped = databaseUrlForSchema(baseUrl, schema);
    await migrate({ connectionString: scoped, migrationsDirectory: repositoryMigrations });

    process.env.DATABASE_URL = scoped;
    // Loading the services loads src/db/index.ts, which registers the DATE
    // parser for every pool in the process, this file's own included.
    mailSend = await import('../../src/services/mailSendService.js');
    drafts = await import('../../src/services/draftService.js');
    jobs = await import('../../src/services/letterJobService.js');
    schedule = await import('../../src/services/deliverySchedule.js');
    held = await import('../../src/services/scheduledMailService.js');
    gifts = await import('../../src/services/giftLetterService.js');
    inTransaction = (await import('../../src/db/index.js')).transaction;
    closeServicePool = (await import('../../src/db/index.js')).closePool;
    pool = new Pool({ connectionString: scoped, max: 4 });
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
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  }, 60_000);

  async function seedUser(credits = 10): Promise<string> {
    const userId = `auth0|arrive-by-${randomUUID()}`;
    await pool.query(
      `INSERT INTO users (user_id, email, credits, credits_purchased) VALUES ($1, $2, $3, $4)`,
      [userId, `${randomUUID()}@test.invalid`, credits, credits]
    );
    await pool.query(
      `INSERT INTO credit_ledger (user_id, initial_amount, remaining_amount, source_type)
       VALUES ($1, $2, $3, 'adjustment')`,
      [userId, credits, credits]
    );
    return userId;
  }

  /** A held letter's dates, two weeks out from today in New York, as a preview would choose them. */
  function upcoming(): { arriveBy: string; mailOn: string } {
    const now = new Date();
    const arriveBy = schedule.addCalendarDays(schedule.newYorkDate(now), 21);
    return { arriveBy, mailOn: schedule.mailOnFor(arriveBy, 7) };
  }

  /** A text-only letter draft through the service; each body differs so the duplicate check (#412) stays out of it. */
  async function seedDraft(
    userId: string,
    dates?: { arriveBy: string; mailOn: string },
    bodyText = `Hello ${randomUUID()}`,
    isGiftSend = false
  ): Promise<string> {
    const { draftId } = await drafts.createDraft({
      userId,
      sender: SENDER,
      recipient: RECIPIENT,
      bodyText,
      isGiftSend,
      signOff: 'Warmly, Test',
      requiredCredits: 2,
      ...(dates ? { schedule: dates } : {})
    });
    return draftId;
  }

  it('keeps the two dates together, and the mail date never after the arrival, on drafts and letters', async () => {
    const userId = await seedUser();
    const draftId = await seedDraft(userId);
    for (const [arriveBy, mailOn, constraint] of [
      ['2026-10-16', null, 'letter_drafts_schedule_pair'],
      [null, '2026-10-06', 'letter_drafts_schedule_pair'],
      ['2026-10-06', '2026-10-16', 'letter_drafts_schedule_order']
    ] as const) {
      await expect(
        pool.query('UPDATE letter_drafts SET arrive_by = $2::date, mail_on = $3::date WHERE draft_id = $1', [draftId, arriveBy, mailOn])
      ).rejects.toMatchObject({ code: '23514', constraint });
    }
    // The same day is allowed: lead time 0, as development may set.
    await pool.query("UPDATE letter_drafts SET arrive_by = '2026-10-06', mail_on = '2026-10-06' WHERE draft_id = $1", [draftId]);

    const letterId = randomUUID();
    await pool.query(
      `INSERT INTO letters (letter_id, user_id, content, recipient, credits_cost, status, mail_type, funding_type)
       VALUES ($1, $2, '{}', $3, 2, 'draft', 'letter', 'prepaid_balance')`,
      [letterId, userId, JSON.stringify(RECIPIENT)]
    );
    await expect(
      pool.query("UPDATE letters SET arrive_by = '2026-10-16' WHERE letter_id = $1", [letterId])
    ).rejects.toMatchObject({ code: '23514', constraint: 'letters_schedule_pair' });
    await expect(
      pool.query("UPDATE letters SET arrive_by = '2026-10-06', mail_on = '2026-10-07' WHERE letter_id = $1", [letterId])
    ).rejects.toMatchObject({ code: '23514', constraint: 'letters_schedule_order' });
  }, 60_000);

  it('reads the dates back from whole rows as YYYY-MM-DD strings', async () => {
    const userId = await seedUser();
    const draftId = await seedDraft(userId, { arriveBy: '2026-10-16', mailOn: '2026-10-06' });
    const row = (await pool.query('SELECT * FROM letter_drafts WHERE draft_id = $1', [draftId])).rows[0];
    expect([row.arrive_by, row.mail_on]).toEqual(['2026-10-16', '2026-10-06']);
    const asap = (await pool.query('SELECT * FROM letter_drafts WHERE draft_id = $1', [await seedDraft(userId)])).rows[0];
    expect([asap.arrive_by, asap.mail_on]).toEqual([null, null]);
  }, 60_000);

  it('holds a sent letter until 09:00 New York time on its mail date, and the claim leaves it alone', async () => {
    // The outbox's switch on, so "not claimed" is the hold, not a pause (#444);
    // put back in a finally, so a failure here cannot leak it.
    const savedSwitch = process.env.LETTER_IRL_OUTBOX_DISPATCH_ENABLED;
    process.env.LETTER_IRL_OUTBOX_DISPATCH_ENABLED = 'true';
    try {
      const userId = await seedUser();
      const dates = upcoming();
      const draftId = await seedDraft(userId, dates);

      const result = await mailSend.createMailOrderFromDraft({ draftId, userId, mailType: 'letter' });

      const letter = (await pool.query('SELECT * FROM letters WHERE letter_id = $1', [result.letter.letter_id])).rows[0];
      expect([letter.arrive_by, letter.mail_on, letter.status]).toEqual([dates.arriveBy, dates.mailOn, 'queued']);
      const release = schedule.dispatchAt(dates.mailOn);
      const job = (await pool.query('SELECT * FROM letter_jobs WHERE letter_id = $1', [letter.letter_id])).rows[0];
      expect(job.status).toBe('pending');
      expect(new Date(job.next_attempt_at).toISOString()).toBe(release.toISOString());
      // scheduled_at is a TIMESTAMP without a zone (001), written in the
      // session's zone, so it is compared in SQL rather than through the
      // process's own zone.
      const same = await pool.query<{ same: boolean }>(
        'SELECT scheduled_at = next_attempt_at::timestamp AS same FROM letter_jobs WHERE job_id = $1',
        [job.job_id]
      );
      expect(same.rows[0].same).toBe(true);
      expect(job.metadata).toMatchObject({ source: 'transactional-outbox', heldUntil: release.toISOString() });
      // The value moved at the send, as for any letter.
      const credits = (await pool.query('SELECT credits FROM users WHERE user_id = $1', [userId])).rows[0].credits;
      expect(credits).toBe(8);

      // The inline dispatch after a send claims by id: not before the release.
      await expect(jobs.processLetterJob(job.job_id)).resolves.toMatchObject({ claimed: false });
      const after = (await pool.query('SELECT status, attempts FROM letter_jobs WHERE job_id = $1', [job.job_id])).rows[0];
      expect(after).toEqual({ status: 'pending', attempts: 0 });
    } finally {
      if (savedSwitch === undefined) delete process.env.LETTER_IRL_OUTBOX_DISPATCH_ENABLED;
      else process.env.LETTER_IRL_OUTBOX_DISPATCH_ENABLED = savedSwitch;
    }
  }, 60_000);

  it('makes an ordinary send due at once, with no dates', async () => {
    const userId = await seedUser();
    const draftId = await seedDraft(userId);
    const before = Date.now();

    const result = await mailSend.createMailOrderFromDraft({ draftId, userId, mailType: 'letter' });

    const letter = (await pool.query('SELECT * FROM letters WHERE letter_id = $1', [result.letter.letter_id])).rows[0];
    expect([letter.arrive_by, letter.mail_on]).toEqual([null, null]);
    const job = (await pool.query('SELECT * FROM letter_jobs WHERE letter_id = $1', [letter.letter_id])).rows[0];
    expect(new Date(job.next_attempt_at).getTime()).toBeLessThanOrEqual(Date.now());
    expect(new Date(job.next_attempt_at).getTime()).toBeGreaterThanOrEqual(before - 60_000);
    expect(job.metadata).toEqual({ source: 'transactional-outbox' });
  }, 60_000);

  it('refuses a send whose mail date has passed, writing nothing', async () => {
    const userId = await seedUser();
    const draftId = await seedDraft(userId, { arriveBy: '2020-01-13', mailOn: '2020-01-02' });

    await expect(mailSend.createMailOrderFromDraft({ draftId, userId, mailType: 'letter' })).rejects.toMatchObject({
      code: 'SCHEDULE_PASSED'
    });

    const draft = (await pool.query('SELECT status FROM letter_drafts WHERE draft_id = $1', [draftId])).rows[0];
    expect(draft.status).toBe('pending');
    const letters = await pool.query('SELECT 1 FROM letters WHERE user_id = $1', [userId]);
    expect(letters.rowCount).toBe(0);
    const credits = (await pool.query('SELECT credits FROM users WHERE user_id = $1', [userId])).rows[0].credits;
    expect(credits).toBe(10);
  }, 60_000);

  async function datesOf(draftId: string): Promise<[string | null, string | null]> {
    const row = (await pool.query('SELECT arrive_by, mail_on FROM letter_drafts WHERE draft_id = $1', [draftId])).rows[0];
    return [row.arrive_by, row.mail_on];
  }

  async function seedPayAndSend(userId: string, draftId: string, status: string, expiresIn: string): Promise<string> {
    const orderId = `order-${randomUUID()}`;
    await pool.query(
      `INSERT INTO orders (order_id, user_id, credits, amount_cents, currency, status, order_type, product_code,
         idempotency_key, draft_id, checkout_expires_at)
       VALUES ($1, $2, NULL, 499, 'USD', $3, 'jit_mail', 'jit-letter', $4, $5, NOW() + $6::interval)`,
      [orderId, userId, status, `idem_${orderId}`, draftId, expiresIn]
    );
    return orderId;
  }

  it("sets, moves and clears a pending draft's dates, and a send then holds to them", async () => {
    const userId = await seedUser();
    const draftId = await seedDraft(userId);
    const dates = upcoming();
    const moved = { arriveBy: schedule.addCalendarDays(dates.arriveBy, 7), mailOn: schedule.mailOnFor(schedule.addCalendarDays(dates.arriveBy, 7), 7) };

    await expect(drafts.setDraftSchedule(draftId, userId, dates)).resolves.toBeNull();
    expect(await datesOf(draftId)).toEqual([dates.arriveBy, dates.mailOn]);
    await expect(drafts.setDraftSchedule(draftId, userId, moved)).resolves.toBeNull();
    expect(await datesOf(draftId)).toEqual([moved.arriveBy, moved.mailOn]);
    await expect(drafts.setDraftSchedule(draftId, userId, null)).resolves.toBeNull();
    expect(await datesOf(draftId)).toEqual([null, null]);

    // The send reads the dates the draft has when it is sent.
    await expect(drafts.setDraftSchedule(draftId, userId, dates)).resolves.toBeNull();
    const result = await mailSend.createMailOrderFromDraft({ draftId, userId, mailType: 'letter' });
    const letter = (await pool.query('SELECT arrive_by, mail_on FROM letters WHERE letter_id = $1', [result.letter.letter_id])).rows[0];
    expect([letter.arrive_by, letter.mail_on]).toEqual([dates.arriveBy, dates.mailOn]);
  }, 60_000);

  it("leaves alone a draft that is not the caller's, missing, sent or past its expiry", async () => {
    const userId = await seedUser();
    const stranger = await seedUser();
    const dates = upcoming();

    const draftId = await seedDraft(userId);
    await expect(drafts.setDraftSchedule(draftId, stranger, dates)).resolves.toBe('not_found');
    await expect(drafts.setDraftSchedule(randomUUID(), userId, dates)).resolves.toBe('not_found');
    await pool.query("UPDATE letter_drafts SET expires_at = NOW() - INTERVAL '1 minute' WHERE draft_id = $1", [draftId]);
    await expect(drafts.setDraftSchedule(draftId, userId, dates)).resolves.toBe('expired');
    expect(await datesOf(draftId)).toEqual([null, null]);

    const sent = await seedDraft(userId);
    await mailSend.createMailOrderFromDraft({ draftId: sent, userId, mailType: 'letter' });
    await expect(drafts.setDraftSchedule(sent, userId, dates)).resolves.toBe('sent');
    expect(await datesOf(sent)).toEqual([null, null]);
  }, 60_000);

  it('leaves alone a draft with a live Pay & Send order, but not one whose checkout can no longer be paid', async () => {
    const userId = await seedUser();
    const draftId = await seedDraft(userId);
    const dates = upcoming();

    const orderId = await seedPayAndSend(userId, draftId, 'checkout_pending', '20 minutes');
    await expect(drafts.setDraftSchedule(draftId, userId, dates)).resolves.toBe('checkout_pending');
    expect(await datesOf(draftId)).toEqual([null, null]);

    // The checkout's window has passed: nothing can pay it now.
    await pool.query("UPDATE orders SET checkout_expires_at = NOW() - INTERVAL '1 minute' WHERE order_id = $1", [orderId]);
    await expect(drafts.setDraftSchedule(draftId, userId, dates)).resolves.toBeNull();
    expect(await datesOf(draftId)).toEqual([dates.arriveBy, dates.mailOn]);

    // Paid, and every other live state, whatever the window.
    for (const status of ['paid', 'fulfillment_pending', 'refund_pending', 'disputed', 'held']) {
      await pool.query('UPDATE orders SET status = $2::varchar WHERE order_id = $1', [orderId, status]);
      await expect(drafts.setDraftSchedule(draftId, userId, null), status).resolves.toBe('checkout_pending');
    }
    // Over: a refunded order no longer fixes them.
    await pool.query("UPDATE orders SET status = 'refunded' WHERE order_id = $1", [orderId]);
    await expect(drafts.setDraftSchedule(draftId, userId, null)).resolves.toBeNull();
    expect(await datesOf(draftId)).toEqual([null, null]);
  }, 60_000);

  it("waits for a send that holds the draft's row, then finds it sent", async () => {
    const userId = await seedUser();
    const draftId = await seedDraft(userId);
    const holder = await pool.connect();
    let open = false;
    try {
      await holder.query('BEGIN');
      open = true;
      await holder.query('SELECT 1 FROM letter_drafts WHERE draft_id = $1 FOR UPDATE', [draftId]);
      const change = drafts.setDraftSchedule(draftId, userId, upcoming());

      // Proven waiting on the lock, not merely late, before the holder commits.
      let waiting = false;
      for (let attempt = 0; attempt < 50 && !waiting; attempt += 1) {
        const blocked = await pool.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE wait_event_type = 'Lock' AND query LIKE '%FROM letter_drafts WHERE draft_id = $1 AND user_id = $2 FOR UPDATE%'`
        );
        waiting = blocked.rows[0].n > 0;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 100));
      }
      expect(waiting).toBe(true);

      await holder.query("UPDATE letter_drafts SET status = 'consumed' WHERE draft_id = $1", [draftId]);
      await holder.query('COMMIT');
      open = false;
      await expect(change).resolves.toBe('sent');
      expect(await datesOf(draftId)).toEqual([null, null]);
    } finally {
      // A failure above leaves the row lock held: roll back, so the waiting
      // change ends and the pool gets its client back with no transaction.
      if (open) await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  }, 60_000);

  async function creditsOf(userId: string): Promise<number> {
    return (await pool.query('SELECT credits FROM users WHERE user_id = $1', [userId])).rows[0].credits;
  }

  /** A held prepaid letter, sent from a fresh draft; its id. */
  async function sendHeld(userId: string, bodyText?: string): Promise<string> {
    const draftId = await seedDraft(userId, upcoming(), bodyText);
    const sent = await mailSend.createMailOrderFromDraft({ draftId, userId, mailType: 'letter' });
    return sent.letter.letter_id;
  }

  it('cancels held prepaid mail: letter and job cancelled and never claimed, its credits back once on a lot that keeps its expiry', async () => {
    const savedSwitch = process.env.LETTER_IRL_OUTBOX_DISPATCH_ENABLED;
    process.env.LETTER_IRL_OUTBOX_DISPATCH_ENABLED = 'true';
    try {
      const userId = await seedUser();
      await pool.query(
        "UPDATE credit_ledger SET expires_at = NOW() + INTERVAL '90 days', expiration_policy = 'days_from_activation' WHERE user_id = $1",
        [userId]
      );
      const lotExpiry = (await pool.query('SELECT expires_at FROM credit_ledger WHERE user_id = $1', [userId])).rows[0].expires_at;
      const letterId = await sendHeld(userId);
      expect(await creditsOf(userId)).toBe(8);

      // Two credits back: one letter.
      await expect(held.cancelScheduledMail({ letterId, userId })).resolves.toMatchObject({
        ok: true,
        cancelled: { letterId, alreadyCancelled: false, returned: { kind: 'letters', count: 1 }, shortfall: 'none' }
      });

      const letter = (await pool.query('SELECT status FROM letters WHERE letter_id = $1', [letterId])).rows[0];
      expect(letter.status).toBe('cancelled');
      const job = (await pool.query(
        'SELECT job_id, status, provider_outcome, last_error FROM letter_jobs WHERE letter_id = $1',
        [letterId]
      )).rows[0];
      expect([job.status, job.provider_outcome, job.last_error]).toEqual(['cancelled', 'not_dispatched', 'cancelled_by_customer']);
      const history = await pool.query(
        "SELECT old_status, new_status FROM letter_status_history WHERE letter_id = $1 AND source = 'customer'",
        [letterId]
      );
      expect(history.rows).toEqual([{ old_status: 'queued', new_status: 'cancelled' }]);

      expect(await creditsOf(userId)).toBe(10);
      const returned = await pool.query(
        `SELECT initial_amount, expires_at, description, source_metadata FROM credit_ledger
          WHERE user_id = $1 AND source_metadata->>'letter_id' = $2`,
        [userId, letterId]
      );
      expect(returned.rows).toHaveLength(1);
      expect(returned.rows[0].initial_amount).toBe(2);
      expect(returned.rows[0].expires_at).toEqual(lotExpiry);
      expect(returned.rows[0].description).toBe(`Returned after cancelled send ${letterId}`);
      expect(returned.rows[0].source_metadata).toMatchObject({ reason: 'send_failed', failure_code: 'cancelled_by_customer' });

      // The outbox asking for it by id finds nothing to take.
      await expect(jobs.processLetterJob(job.job_id)).resolves.toMatchObject({ claimed: false });

      // Again: answered as cancelled, and nothing more goes back.
      await expect(held.cancelScheduledMail({ letterId, userId })).resolves.toMatchObject({
        ok: true,
        cancelled: { alreadyCancelled: true, returned: { count: 0 } }
      });
      expect(await creditsOf(userId)).toBe(10);
      const after = await pool.query(
        "SELECT 1 FROM credit_ledger WHERE user_id = $1 AND source_metadata->>'letter_id' = $2",
        [userId, letterId]
      );
      expect(after.rowCount).toBe(1);
    } finally {
      if (savedSwitch === undefined) delete process.env.LETTER_IRL_OUTBOX_DISPATCH_ENABLED;
      else process.env.LETTER_IRL_OUTBOX_DISPATCH_ENABLED = savedSwitch;
    }
  }, 60_000);

  it("says so when what paid for it expired while it was held: the credits come back on the lot's expiry, not counted", async () => {
    const userId = await seedUser();
    const letterId = await sendHeld(userId);
    // The lot it was paid from runs out while the mail waits.
    await pool.query(
      "UPDATE credit_ledger SET expires_at = NOW() - INTERVAL '1 minute', expiration_policy = 'days_from_activation' WHERE user_id = $1 AND source_metadata IS NULL",
      [userId]
    );

    await expect(held.cancelScheduledMail({ letterId, userId })).resolves.toMatchObject({
      ok: true,
      cancelled: { alreadyCancelled: false, returned: { kind: 'letters', count: 0 }, shortfall: 'expired' }
    });
    // On record, as expired, so it is never returned twice; never in the
    // cached balance or the account's history, which the ledger would not spend.
    const back = await pool.query(
      "SELECT initial_amount, status FROM credit_ledger WHERE user_id = $1 AND source_metadata->>'letter_id' = $2 AND expires_at <= NOW()",
      [userId, letterId]
    );
    expect(back.rows).toEqual([{ initial_amount: 2, status: 'expired' }]);
    expect(await creditsOf(userId)).toBe(8);
    const history = await pool.query(
      "SELECT 1 FROM credit_transactions WHERE user_id = $1 AND type = 'refund' AND reference_id = $2",
      [userId, letterId]
    );
    expect(history.rowCount).toBe(0);
  }, 60_000);

  it('cancels held gift mail: the gift letter comes back once and its printed code is voided as cancelled', async () => {
    const GIFT_ENV = {
      LETTER_IRL_GIFT_LETTERS_ENABLED: 'true',
      LETTER_IRL_GIFT_DAILY_SEND_CAP: '100000',
      LETTER_IRL_GIFT_LANDING_BASE_URL: 'https://letterirl.test'
    };
    const saved = Object.fromEntries(Object.keys(GIFT_ENV).map(name => [name, process.env[name]]));
    Object.assign(process.env, GIFT_ENV);
    try {
      const userId = await seedUser();
      await inTransaction(client =>
        gifts.grantGiftLettersWithClient(client, {
          userId,
          quantity: 1,
          generationsRemaining: 2,
          source: 'operator',
          sourceReferenceId: `test:${randomUUID()}`
        })
      );
      const draftId = await seedDraft(userId, upcoming(), undefined, true);
      const sent = await mailSend.createMailOrderFromDraft({ draftId, userId, mailType: 'letter' });
      const letterId = sent.letter.letter_id;
      const code = (await pool.query('SELECT code, status FROM gift_codes WHERE letter_id = $1', [letterId])).rows[0];
      expect(code.status).toBe('issued');

      await expect(held.cancelScheduledMail({ letterId, userId })).resolves.toMatchObject({
        ok: true,
        cancelled: { alreadyCancelled: false, returned: { kind: 'gift_letter', count: 1 } }
      });

      const voided = (await pool.query('SELECT status, void_reason FROM gift_codes WHERE code = $1', [code.code])).rows[0];
      expect(voided).toEqual({ status: 'void', void_reason: 'send_cancelled' });
      const back = await pool.query(
        "SELECT generations_remaining FROM gift_letters WHERE user_id = $1 AND source = 'send_failed' AND source_reference_id = $2",
        [userId, letterId]
      );
      expect(back.rows).toEqual([{ generations_remaining: 2 }]);

      await expect(held.cancelScheduledMail({ letterId, userId })).resolves.toMatchObject({
        ok: true,
        cancelled: { alreadyCancelled: true, returned: { kind: 'gift_letter', count: 0 } }
      });
      const once = await pool.query(
        "SELECT 1 FROM gift_letters WHERE source = 'send_failed' AND source_reference_id = $1",
        [letterId]
      );
      expect(once.rowCount).toBe(1);
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }, 60_000);

  it("refuses someone else's letter, mail with no date, mail the outbox has taken, and Pay & Send, changing nothing", async () => {
    const userId = await seedUser();
    const stranger = await seedUser();

    const letterId = await sendHeld(userId);
    await expect(held.cancelScheduledMail({ letterId, userId: stranger })).resolves.toEqual({ ok: false, refusal: 'not_found' });
    await expect(held.cancelScheduledMail({ letterId: randomUUID(), userId })).resolves.toEqual({ ok: false, refusal: 'not_found' });

    const asap = await mailSend.createMailOrderFromDraft({ draftId: await seedDraft(userId), userId, mailType: 'letter' });
    await expect(held.cancelScheduledMail({ letterId: asap.letter.letter_id, userId })).resolves.toEqual({
      ok: false,
      refusal: 'not_scheduled'
    });

    // As the claim leaves it: taken, attempted once, not yet dispatched.
    await pool.query(
      "UPDATE letter_jobs SET status = 'processing', attempts = 1, locked_at = NOW() WHERE letter_id = $1",
      [letterId]
    );
    await expect(held.cancelScheduledMail({ letterId, userId })).resolves.toEqual({ ok: false, refusal: 'too_late' });
    const still = (await pool.query('SELECT status FROM letters WHERE letter_id = $1', [letterId])).rows[0];
    expect(still.status).toBe('queued');
    expect(await creditsOf(userId)).toBe(6);

    const orderId = `order-${randomUUID()}`;
    await pool.query(
      `INSERT INTO orders (order_id, user_id, credits, amount_cents, currency, status, order_type, product_code,
         idempotency_key, draft_id)
       VALUES ($1, $2, NULL, 499, 'USD', 'fulfilled', 'jit_mail', 'jit-letter', $3, $4)`,
      [orderId, userId, `idem_${orderId}`, await seedDraft(userId)]
    );
    const paid = randomUUID();
    const dates = upcoming();
    await pool.query(
      `INSERT INTO letters (letter_id, user_id, content, recipient, credits_cost, status, mail_type,
         funding_type, funding_order_id, arrive_by, mail_on)
       VALUES ($1, $2, '{}', $3, 2, 'queued', 'letter', 'jit_order', $4, $5::date, $6::date)`,
      [paid, userId, JSON.stringify(RECIPIENT), orderId, dates.arriveBy, dates.mailOn]
    );
    await expect(held.cancelScheduledMail({ letterId: paid, userId })).resolves.toEqual({ ok: false, refusal: 'pay_and_send' });
    expect((await pool.query('SELECT status FROM letters WHERE letter_id = $1', [paid])).rows[0].status).toBe('queued');
  }, 60_000);

  it("answers 'busy' at once while the outbox holds the job, and cancels once it lets go", async () => {
    const userId = await seedUser();
    const letterId = await sendHeld(userId);
    const holder = await pool.connect();
    let open = false;
    try {
      await holder.query('BEGIN');
      open = true;
      await holder.query('SELECT 1 FROM letter_jobs WHERE letter_id = $1 FOR UPDATE', [letterId]);
      const started = Date.now();
      await expect(held.cancelScheduledMail({ letterId, userId })).resolves.toEqual({ ok: false, refusal: 'busy' });
      expect(Date.now() - started).toBeLessThan(5_000);
      await holder.query('ROLLBACK');
      open = false;
    } finally {
      if (open) await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
    expect(await creditsOf(userId)).toBe(8);
    await expect(held.cancelScheduledMail({ letterId, userId })).resolves.toMatchObject({
      ok: true,
      cancelled: { alreadyCancelled: false }
    });
    expect(await creditsOf(userId)).toBe(10);
  }, 60_000);

  it('answers two cancels at the same moment once each: one cancels, the other finds it cancelled', async () => {
    const userId = await seedUser();
    const letterId = await sendHeld(userId);

    const results = await Promise.all([
      held.cancelScheduledMail({ letterId, userId }),
      held.cancelScheduledMail({ letterId, userId })
    ]);

    expect(results.map(result => result.ok)).toEqual([true, true]);
    const already = results.map(result => (result.ok ? result.cancelled.alreadyCancelled : null)).sort();
    expect(already).toEqual([false, true]);
    expect(await creditsOf(userId)).toBe(10);
  }, 60_000);

  it("raises one alert for held mail not at the printer by 18:00 on its mail date, and none for mail that is", async () => {
    const userId = await seedUser();
    const late = randomUUID();
    const failed = randomUUID();
    const mailed = randomUUID();
    for (const [letterId, status] of [[late, 'queued'], [failed, 'failed'], [mailed, 'accepted']] as const) {
      await pool.query(
        `INSERT INTO letters (letter_id, user_id, content, recipient, credits_cost, status, mail_type,
           funding_type, arrive_by, mail_on)
         VALUES ($1, $2, '{}', $3, 2, $4, 'letter', 'prepaid_balance', '2020-01-13', '2020-01-02')`,
        [letterId, userId, JSON.stringify(RECIPIENT), status]
      );
    }

    // Every other letter in this file mails on a date still to come. A
    // failed one missed its day as surely as a queued one.
    await expect(held.raiseMissedMailDayAlerts()).resolves.toBe(2);
    const alerts = await pool.query(
      "SELECT order_id, severity, status, details FROM commerce_operational_alerts WHERE alert_type = 'schedule_missed_mail_day' ORDER BY details->>'letterId'"
    );
    expect(alerts.rows).toEqual(
      [late, failed].sort().map(letterId => ({
        order_id: null,
        severity: 'warning',
        status: 'open',
        details: { letterId, mailOn: '2020-01-02', userId }
      }))
    );

    // Once per letter, and the index refuses a second even past the check.
    await expect(held.raiseMissedMailDayAlerts()).resolves.toBe(0);
    await expect(
      pool.query(
        `INSERT INTO commerce_operational_alerts (alert_type, severity, details)
         VALUES ('schedule_missed_mail_day', 'warning', jsonb_build_object('letterId', $1::text))`,
        [late]
      )
    ).rejects.toMatchObject({ code: '23505' });
  }, 60_000);

  it("does not call a held letter's Pay & Send order stuck until 90 minutes after its job falls due, and only until first tried", async () => {
    const { STUCK_ORDER_CONDITION } = await import('../../src/services/stuckOrders.js');
    const stuck = async (orderId: string) =>
      Number((await pool.query(`SELECT COUNT(*)::int AS n FROM orders WHERE order_id = $1 AND ${STUCK_ORDER_CONDITION}`, [orderId])).rows[0].n);
    const userId = await seedUser();

    const seedOrder = async () => {
      const orderId = `order-${randomUUID()}`;
      // Two hours old from the start: orders' BEFORE UPDATE trigger (021) would
      // stamp any later UPDATE's updated_at back to NOW().
      await pool.query(
        `INSERT INTO orders (order_id, user_id, credits, amount_cents, currency, status, order_type, product_code,
           idempotency_key, draft_id, updated_at)
         VALUES ($1, $2, NULL, 499, 'USD', 'fulfillment_pending', 'jit_mail', 'jit-letter', $3, $4,
                 NOW() - INTERVAL '2 hours')`,
        [orderId, userId, `idem_${orderId}`, await seedDraft(userId)]
      );
      return orderId;
    };

    // An ordinary paid order still fulfilling after 2 hours is stuck.
    expect(await stuck(await seedOrder())).toBe(1);

    // One whose letter is held to a date to come is not.
    const orderId = await seedOrder();
    const letterId = randomUUID();
    const dates = upcoming();
    await pool.query(
      `INSERT INTO letters (letter_id, user_id, content, recipient, credits_cost, status, mail_type,
         funding_type, funding_order_id, arrive_by, mail_on)
       VALUES ($1, $2, '{}', $3, 2, 'draft', 'letter', 'jit_order', $4, $5::date, $6::date)`,
      [letterId, userId, JSON.stringify(RECIPIENT), orderId, dates.arriveBy, dates.mailOn]
    );
    await inTransaction(client =>
      jobs.createLetterJobWithClient(client, { letter_id: letterId } as never, { notBefore: schedule.dispatchAt(dates.mailOn) })
    );
    expect(await stuck(orderId)).toBe(0);

    // Sent now by an operator (job.dispatch_now), which moves only its next
    // attempt: not stuck while the hourly run gets to it, stuck 90 minutes on.
    await pool.query("UPDATE letter_jobs SET next_attempt_at = NOW() - INTERVAL '30 minutes' WHERE letter_id = $1", [letterId]);
    expect(await stuck(orderId)).toBe(0);
    await pool.query("UPDATE letter_jobs SET next_attempt_at = NOW() - INTERVAL '2 hours' WHERE letter_id = $1", [letterId]);
    expect(await stuck(orderId)).toBe(1);

    // Tried and waiting to try again, whatever its hold says: on its way like
    // any other, so stuck.
    await pool.query(
      "UPDATE letter_jobs SET attempts = 1, next_attempt_at = NOW() + INTERVAL '10 minutes' WHERE letter_id = $1",
      [letterId]
    );
    expect(await stuck(orderId)).toBe(1);

    // Its hold ended 3 hours ago and it has not gone: stuck.
    await pool.query(
      "UPDATE letter_jobs SET attempts = 0, metadata = jsonb_set(metadata, '{heldUntil}', to_jsonb((NOW() - INTERVAL '3 hours')::text)) WHERE letter_id = $1",
      [letterId]
    );
    expect(await stuck(orderId)).toBe(1);
  }, 60_000);

  it('counts nothing held behind a pause until it is due', async () => {
    const savedSwitch = process.env.LETTER_IRL_OUTBOX_DISPATCH_ENABLED;
    process.env.LETTER_IRL_OUTBOX_DISPATCH_ENABLED = 'false';
    try {
      const userId = await seedUser();
      const before = await jobs.lettersWaitingBehindPause();
      expect(typeof before).toBe('number');

      await sendHeld(userId);
      await expect(jobs.lettersWaitingBehindPause()).resolves.toBe(before);

      await mailSend.createMailOrderFromDraft({ draftId: await seedDraft(userId), userId, mailType: 'letter' });
      await expect(jobs.lettersWaitingBehindPause()).resolves.toBe((before as number) + 1);
    } finally {
      if (savedSwitch === undefined) delete process.env.LETTER_IRL_OUTBOX_DISPATCH_ENABLED;
      else process.env.LETTER_IRL_OUTBOX_DISPATCH_ENABLED = savedSwitch;
    }
  }, 60_000);

  it("reads a sent draft's letter as it stands, for get_draft_status, and never another account's", async () => {
    const userId = await seedUser();
    const dates = upcoming();
    const draftId = await seedDraft(userId, dates);
    const sent = await mailSend.createMailOrderFromDraft({ draftId, userId, mailType: 'letter' });
    const letterId = sent.letter.letter_id;

    await expect(drafts.getDraftState(draftId)).resolves.toMatchObject({
      draft_id: draftId,
      user_id: userId,
      status: 'consumed',
      consumed_letter_id: letterId,
      letter_status: 'queued',
      letter_funding_type: 'prepaid_balance',
      letter_arrive_by: dates.arriveBy,
      letter_mail_on: dates.mailOn
    });

    await expect(held.cancelScheduledMail({ letterId, userId })).resolves.toMatchObject({ ok: true });
    await expect(drafts.getDraftState(draftId)).resolves.toMatchObject({ letter_status: 'cancelled' });

    // A draft not sent has no letter.
    const pending = await seedDraft(userId, upcoming());
    await expect(drafts.getDraftState(pending)).resolves.toMatchObject({
      status: 'pending',
      consumed_letter_id: null,
      letter_status: null,
      letter_funding_type: null,
      letter_arrive_by: null,
      letter_mail_on: null
    });

    // A letter that is not the draft owner's is never read.
    const stranger = await seedUser();
    await pool.query('UPDATE letters SET user_id = $1 WHERE letter_id = $2', [stranger, letterId]);
    await expect(drafts.getDraftState(draftId)).resolves.toMatchObject({ consumed_letter_id: letterId, letter_status: null });
    await expect(drafts.getDraftState(randomUUID())).resolves.toBeNull();
  }, 60_000);

  it('frees the duplicate guard: the same mail can be sent again once cancelled', async () => {
    const userId = await seedUser();
    const body = `The same words ${randomUUID()}`;
    const letterId = await sendHeld(userId, body);

    // While it stands, the same mail is refused as a recent duplicate (#412).
    await expect(sendHeld(userId, body)).rejects.toMatchObject({ code: 'DUPLICATE_RECENT_MAIL' });

    await expect(held.cancelScheduledMail({ letterId, userId })).resolves.toMatchObject({ ok: true });
    await expect(sendHeld(userId, body)).resolves.toEqual(expect.any(String));
  }, 60_000);

  it("keeps a held letter's sent draft until 7 days after its mail date, and deletes an ordinary one at 7 days (#564)", async () => {
    const userId = await seedUser();
    const heldLetter = await sendHeld(userId);
    const plainDraft = await seedDraft(userId);
    await mailSend.createMailOrderFromDraft({ draftId: plainDraft, userId, mailType: 'letter' });
    const heldDraft = (await pool.query('SELECT draft_id FROM letter_drafts WHERE consumed_letter_id = $1', [heldLetter])).rows[0].draft_id;
    // Both sent a month ago, as far as the sweep can tell.
    await pool.query(
      "UPDATE letter_drafts SET updated_at = NOW() - INTERVAL '30 days' WHERE draft_id IN ($1, $2)",
      [heldDraft, plainDraft]
    );
    const left = async () =>
      (await pool.query('SELECT draft_id FROM letter_drafts WHERE draft_id IN ($1, $2)', [heldDraft, plainDraft])).rows.map(row => row.draft_id);

    await drafts.cleanupOldDrafts(7);
    expect(await left()).toEqual([heldDraft]);

    // Seven days after its mail date, it is kept still; eight days after, it goes.
    await pool.query("UPDATE letters SET mail_on = CURRENT_DATE - 7, arrive_by = CURRENT_DATE - 5 WHERE letter_id = $1", [heldLetter]);
    await drafts.cleanupOldDrafts(7);
    expect(await left()).toEqual([heldDraft]);
    await pool.query("UPDATE letters SET mail_on = CURRENT_DATE - 8, arrive_by = CURRENT_DATE - 6 WHERE letter_id = $1", [heldLetter]);
    await drafts.cleanupOldDrafts(7);
    expect(await left()).toEqual([]);
  }, 60_000);
});
