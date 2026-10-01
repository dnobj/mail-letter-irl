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
    // The outbox's switch on, so "not claimed" is the hold, not a pause (#444).
    const savedSwitch = process.env.LETTER_IRL_OUTBOX_DISPATCH_ENABLED;
    process.env.LETTER_IRL_OUTBOX_DISPATCH_ENABLED = 'true';
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
    if (savedSwitch === undefined) delete process.env.LETTER_IRL_OUTBOX_DISPATCH_ENABLED;
    else process.env.LETTER_IRL_OUTBOX_DISPATCH_ENABLED = savedSwitch;
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
});
