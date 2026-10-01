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
  async function seedDraft(userId: string, dates?: { arriveBy: string; mailOn: string }): Promise<string> {
    const { draftId } = await drafts.createDraft({
      userId,
      sender: SENDER,
      recipient: RECIPIENT,
      bodyText: `Hello ${randomUUID()}`,
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
    try {
      await holder.query('BEGIN');
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
      await expect(change).resolves.toBe('sent');
      expect(await datesOf(draftId)).toEqual([null, null]);
    } finally {
      holder.release();
    }
  }, 60_000);
});
