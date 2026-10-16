import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import { repositoryMigrations, validateDisposableDatabaseUrl } from './support/disposableDatabase.js';

/**
 * The confirmation page's API (#470), against real PostgreSQL.
 *
 * This is where the person presses Send. The unit suite
 * (tests/unit/api/sendConfirmationApi.test.ts) fakes the draft store, the
 * send service and the balance read, so it cannot say whether the refusals
 * the page keys on are the ones the real service throws, or whether a send
 * leaves exactly one order, one outbox row and one deduction behind. What only
 * a real database settles here:
 *
 *   - the page's view: the draft's own row, and the balance read from `users`;
 *   - one send, then a replay that returns the same order and charges nothing;
 *   - the service's own refusals reaching the page as the reasons it keys on:
 *     no letters (the ledger's sentence, matched by its opening), an expired
 *     draft, the same mail twice, and an account whose sends are blocked, as
 *     an erased account's are;
 *   - another account's draft, a missing one and an id that is not a UUID all
 *     answering 404, the last without reaching the uuid column.
 *
 * Only sign-in, the rate limit and the hand-off to the printer are stubbed.
 * Every test uses its own account, so no cleanup is needed between them.
 */

const session = vi.hoisted(() => ({ userId: '', clientId: 'website-client' }));
const dispatched = vi.hoisted(() => [] as string[]);

vi.mock('../../src/api/middleware/restAuth.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/api/middleware/restAuth.js')>()),
  authenticateRestRequest: async () => ({
    ok: true,
    user: {
      userId: session.userId,
      scopes: ['mail:read', 'mail:draft', 'mail:send'],
      clientId: session.clientId
    }
  })
}));

vi.mock('../../src/api/middleware/rateLimit.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/api/middleware/rateLimit.js')>()),
  rateLimitAccount: async () => false
}));

vi.mock('../../src/services/letterJobService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/services/letterJobService.js')>()),
  processLetterJob: async (jobId: unknown) => {
    dispatched.push(String(jobId));
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
const IMAGE = 'data:image/jpeg;base64,' + 'A'.repeat(64);
const PREVIEW = '<div class="letter">Hi Sam</div>';

function request(method: string, body?: string): IncomingMessage {
  return Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(body)]), {
    method,
    headers: { authorization: 'Bearer website-session' }
  }) as unknown as IncomingMessage;
}

function response() {
  const state = { status: 0, body: '' };
  const res = {
    statusCode: 0,
    setHeader() {},
    end(chunk?: string) {
      state.status = this.statusCode;
      state.body = chunk ?? '';
    }
  };
  return { res: res as unknown as ServerResponse, state };
}

describePostgres('the confirmation page API against PostgreSQL (#470)', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let schema: string;
  let handler: typeof import('../../src/api/sendConfirmationApiHandler.js');
  let closeServicePool: (() => Promise<void>) | undefined;

  const saved: Record<string, string | undefined> = {};
  const ENV = {
    LETTER_IRL_SEND_CONFIRMATION_ENABLED: 'true',
    LETTER_IRL_WEBSITE_CLIENT_ID: 'website-client',
    // The daily caps count every letter created today, and their defaults
    // (3 per account, 25 in all) are not what this file tests.
    LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP: '1000',
    LETTER_IRL_BETA_GLOBAL_DAILY_MAIL_CEILING: '100000'
  };

  beforeAll(async () => {
    for (const [name, value] of Object.entries(ENV)) {
      saved[name] = process.env[name];
      process.env[name] = value;
    }
    const baseUrl = validateDisposableDatabaseUrl(process.env.LIRL_TEST_DATABASE_URL);
    adminPool = new Pool({ connectionString: baseUrl });
    schema = schemaName('lirl_confirm');
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const scoped = databaseUrlForSchema(baseUrl, schema);
    await migrate({ connectionString: scoped, migrationsDirectory: repositoryMigrations });
    pool = new Pool({ connectionString: scoped, max: 4 });

    process.env.DATABASE_URL = scoped;
    handler = await import('../../src/api/sendConfirmationApiHandler.js');
    closeServicePool = (await import('../../src/db/index.js')).closePool;
  }, 180_000);

  afterAll(async () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await closeServicePool?.();
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }, 60_000);

  /** An account with ten credits (five letters) by default. */
  async function seedUser(credits = 10): Promise<string> {
    const userId = `auth0|confirm-${randomUUID()}`;
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

  async function seedDraft(
    userId: string,
    seed: { mailType?: 'letter' | 'postcard'; expired?: boolean } = {}
  ): Promise<string> {
    const draftId = randomUUID();
    const postcard = seed.mailType === 'postcard';
    await pool.query(
      `INSERT INTO letter_drafts (
         draft_id, user_id, sender, recipient, body_text, sign_off, required_credits,
         expires_at, status, mail_type, layout_type, front_image_data, postcard_size, preview_html
       ) VALUES ($1, $2, $3, $4, 'Hi Sam, see you soon.', $5, 2,
                 NOW() + make_interval(hours => $6), 'pending', $7, 'text_only', $8, $9, $10)`,
      [
        draftId,
        userId,
        JSON.stringify(SENDER),
        JSON.stringify(RECIPIENT),
        postcard ? null : 'Love, Dee',
        seed.expired ? -1 : 24,
        seed.mailType ?? 'letter',
        postcard ? IMAGE : null,
        postcard ? '6x9' : null,
        PREVIEW
      ]
    );
    return draftId;
  }

  /** Calls the handler as the website would, signed in as `userId`. */
  async function call(userId: string, method: 'GET' | 'POST', draftId: string, body?: string) {
    session.userId = userId;
    const { res, state } = response();
    const handled = await handler.handleSendConfirmationApiRequest(
      request(method, body),
      res,
      `/api/sends/${draftId}`
    );
    expect(handled).toBe(true);
    return { status: state.status, body: state.body ? JSON.parse(state.body) : undefined };
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

  async function draftRow(draftId: string) {
    const result = await pool.query<{ status: string; consumed_letter_id: string | null }>(
      'SELECT status, consumed_letter_id FROM letter_drafts WHERE draft_id = $1',
      [draftId]
    );
    return result.rows[0];
  }

  it("shows the person their own draft, with the balance read from the database", async () => {
    const userId = await seedUser(7);
    const draftId = await seedDraft(userId);

    const { status, body } = await call(userId, 'GET', draftId);

    expect(status).toBe(200);
    expect(body).toMatchObject({
      draftId,
      mailType: 'letter',
      state: 'ready',
      orderId: null,
      previewHtml: PREVIEW,
      bodyText: 'Hi Sam, see you soon.',
      signOff: 'Love, Dee',
      isGiftSend: false,
      lettersRequired: 1,
      lettersAvailable: 3
    });
    expect(body.recipient).toEqual({
      name: 'Sam Rivera',
      addressLine1: '350 5th Ave',
      addressLine2: 'Suite 8701',
      city: 'New York',
      state: 'NY',
      postalCode: '10118'
    });
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('sends once: one letter, one outbox row, one deduction, and a replay changes nothing', async () => {
    const userId = await seedUser();
    const draftId = await seedDraft(userId);
    const before = dispatched.length;

    const first = await call(userId, 'POST', draftId);

    expect(first.status).toBe(200);
    expect(first.body).toEqual({ orderId: expect.any(String), alreadySent: false, lettersRemaining: 4 });
    const orderId = first.body.orderId as string;
    expect(await accountState(userId)).toEqual({ credits: 8, letters: '1', jobs: '1' });
    expect(await draftRow(draftId)).toEqual({ status: 'consumed', consumed_letter_id: orderId });
    const job = await pool.query<{ job_id: unknown }>('SELECT job_id FROM letter_jobs WHERE letter_id = $1', [
      orderId
    ]);
    // Handed to the printer once, by the job the send committed.
    expect(dispatched.slice(before)).toEqual([String(job.rows[0].job_id)]);

    const replay = await call(userId, 'POST', draftId);

    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ orderId, alreadySent: true });
    expect(await accountState(userId)).toEqual({ credits: 8, letters: '1', jobs: '1' });
    expect(dispatched.length).toBe(before + 1);

    const view = await call(userId, 'GET', draftId);
    expect(view.body).toMatchObject({ state: 'sent', orderId });
  });

  it('sends a postcard as a postcard', async () => {
    const userId = await seedUser();
    const draftId = await seedDraft(userId, { mailType: 'postcard' });

    const view = await call(userId, 'GET', draftId);
    expect(view.body).toMatchObject({ mailType: 'postcard', lettersRequired: 1, signOff: '' });

    const sent = await call(userId, 'POST', draftId);

    expect(sent.status).toBe(200);
    const letter = await pool.query<{ mail_type: string }>('SELECT mail_type FROM letters WHERE letter_id = $1', [
      sent.body.orderId
    ]);
    expect(letter.rows[0].mail_type).toBe('postcard');
    expect(await accountState(userId)).toEqual({ credits: 8, letters: '1', jobs: '1' });
  });

  it('refuses with no letters left, in the words the page keys on, and changes nothing', async () => {
    const userId = await seedUser(0);
    const draftId = await seedDraft(userId);

    expect((await call(userId, 'GET', draftId)).body).toMatchObject({ lettersAvailable: 0, lettersRequired: 1 });
    const { status, body } = await call(userId, 'POST', draftId);

    expect(status).toBe(402);
    expect(body.error).toBe('no_letters');
    expect(await accountState(userId)).toEqual({ credits: 0, letters: '0', jobs: '0' });
    expect((await draftRow(draftId)).status).toBe('pending');
  });

  it('shows an expired draft as expired, and refuses to send it', async () => {
    const userId = await seedUser();
    const draftId = await seedDraft(userId, { expired: true });

    expect((await call(userId, 'GET', draftId)).body).toMatchObject({ state: 'expired', orderId: null });
    const { status, body } = await call(userId, 'POST', draftId);

    expect(status).toBe(410);
    expect(body.error).toBe('expired');
    expect(await accountState(userId)).toEqual({ credits: 10, letters: '0', jobs: '0' });
  });

  it('refuses the same letter twice unless the person asks for another copy', async () => {
    const userId = await seedUser();
    const first = await seedDraft(userId);
    const second = await seedDraft(userId);
    expect((await call(userId, 'POST', first)).status).toBe(200);

    const refused = await call(userId, 'POST', second);

    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({
      error: 'duplicate',
      message: expect.any(String),
      duplicate: { kind: 'sent', mailType: 'letter', recipientName: 'Sam Rivera', ageMinutes: 0 }
    });
    // The refusal rolled the second deduction back.
    expect(await accountState(userId)).toEqual({ credits: 8, letters: '1', jobs: '1' });
    expect((await draftRow(second)).status).toBe('pending');

    const another = await call(userId, 'POST', second, JSON.stringify({ sendAnotherCopy: true }));

    expect(another.status).toBe(200);
    expect(another.body.alreadySent).toBe(false);
    expect(await accountState(userId)).toEqual({ credits: 6, letters: '2', jobs: '2' });
  });

  it('refuses an erased account, whose sends are blocked, and changes nothing', async () => {
    const userId = await seedUser();
    const draftId = await seedDraft(userId);
    // What the erasure leaves on the row (accountErasureService).
    await pool.query(
      `UPDATE users
          SET email = $2, erased_at = NOW(),
              sends_blocked_at = NOW(), sends_blocked_reason = 'account_erased'
        WHERE user_id = $1`,
      [userId, `erased-${randomUUID()}@erased.invalid`]
    );

    const { status, body } = await call(userId, 'POST', draftId);

    expect(status).toBe(403);
    expect(body.error).toBe('blocked');
    expect(await accountState(userId)).toEqual({ credits: 10, letters: '0', jobs: '0' });
    expect((await draftRow(draftId)).status).toBe('pending');
  });

  it("answers another account's draft like a missing one, and leaves it alone", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    const draftId = await seedDraft(owner);

    const missing = await call(stranger, 'GET', randomUUID());
    const read = await call(stranger, 'GET', draftId);
    const sent = await call(stranger, 'POST', draftId);

    expect(missing).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(read).toEqual(missing);
    expect(sent).toEqual(missing);
    expect(await accountState(owner)).toEqual({ credits: 10, letters: '0', jobs: '0' });
    expect(await accountState(stranger)).toEqual({ credits: 10, letters: '0', jobs: '0' });
    expect((await draftRow(draftId)).status).toBe('pending');
  });

  it('answers an id that is not a UUID with 404, before the uuid column could refuse it', async () => {
    const userId = await seedUser();

    for (const id of ['not-a-uuid', "1' OR '1'='1", '%E0%A4%A']) {
      expect(await call(userId, 'GET', id)).toEqual({ status: 404, body: { error: 'not_found' } });
      expect(await call(userId, 'POST', id)).toEqual({ status: 404, body: { error: 'not_found' } });
    }
  });
});
