import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import { repositoryMigrations, validateDisposableDatabaseUrl } from './support/disposableDatabase.js';
import { installStubProvider, providerSuccess, resetStubProvider, STUB_PROVIDER_NAME, stubProvider } from './support/stubProvider.js';

/**
 * Held mail prints as previewed (migration 065, #697, decision D3).
 *
 *   the columns' CHECKs: each value's shape, the engine exactly with the
 *   fingerprint, a stored PDF only with a fingerprint and only for held mail
 *   a held send our renderer drew records the fingerprint of what the print
 *   lays out, and the engine, in its transaction; after the commit it stores
 *   the PDF and records the SHA-256 of exactly the stored bytes
 *   mail not held, and mail the legacy HTML drew, records nothing
 *   the dispatch hands the provider the stored bytes and the fingerprint,
 *   and deletes the PDF once the provider has accepted the mail
 *   a cancel deletes the PDF
 *   the maintenance backfill stores what the send could not, and the sweep
 *   deletes what no waiting letter records while keeping what one does
 *
 * Against real PostgreSQL because the CHECKs, the statements' predicates and
 * the send's transaction are the change's substance, and a mocked query()
 * honours none of them. The bucket runs in memory, in this process.
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

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const RECIPIENT = { name: 'Sam Rivera', addressLine1: '350 5th Ave', city: 'New York', state: 'NY', postalCode: '10118', country: 'US' };
const SENDER = { name: 'Test Sender', addressLine1: '1 Main St', city: 'Springfield', state: 'IL', postalCode: '62701', country: 'US' };

describePostgres('held mail prints as previewed (migration 065, #697)', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let schema: string;
  let mailSend: typeof import('../../src/services/mailSendService.js');
  let drafts: typeof import('../../src/services/draftService.js');
  let jobs: typeof import('../../src/services/letterJobService.js');
  let schedule: typeof import('../../src/services/deliverySchedule.js');
  let held: typeof import('../../src/services/scheduledMailService.js');
  let heldPrint: typeof import('../../src/services/heldPrintService.js');
  let store: typeof import('../../src/services/tempImageStore.js');
  let render: typeof import('../../src/render/index.js');
  let closeServicePool: (() => Promise<void>) | undefined;

  const saved = {
    account: process.env.LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP,
    global: process.env.LETTER_IRL_BETA_GLOBAL_DAILY_MAIL_CEILING,
    cap: process.env.LETTER_IRL_SCHEDULE_DAILY_CAP,
    store: process.env.TEMP_IMAGE_STORE,
    outbox: process.env.LETTER_IRL_OUTBOX_DISPATCH_ENABLED
  };

  beforeAll(async () => {
    process.env.LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP = '1000';
    process.env.LETTER_IRL_BETA_GLOBAL_DAILY_MAIL_CEILING = '100000';
    // Every held letter here shares a mail date: its cap is not what this file tests.
    process.env.LETTER_IRL_SCHEDULE_DAILY_CAP = '1000';
    process.env.TEMP_IMAGE_STORE = 'memory';
    const baseUrl = validateDisposableDatabaseUrl(process.env.LIRL_TEST_DATABASE_URL);
    adminPool = new Pool({ connectionString: baseUrl });
    schema = schemaName('lirl_held_print');
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const scoped = databaseUrlForSchema(baseUrl, schema);
    await migrate({ connectionString: scoped, migrationsDirectory: repositoryMigrations });
    pool = new Pool({ connectionString: scoped, max: 4 });

    process.env.DATABASE_URL = scoped;
    await installStubProvider();
    // Routing consults provider_routing before LETTER_PROVIDER, and migration
    // 015 seeds it with postgrid (failedSendRefund.postgres.test.ts says why).
    await pool.query('UPDATE provider_routing SET provider = $1, enabled = true', [STUB_PROVIDER_NAME]);
    mailSend = await import('../../src/services/mailSendService.js');
    drafts = await import('../../src/services/draftService.js');
    jobs = await import('../../src/services/letterJobService.js');
    schedule = await import('../../src/services/deliverySchedule.js');
    held = await import('../../src/services/scheduledMailService.js');
    heldPrint = await import('../../src/services/heldPrintService.js');
    store = await import('../../src/services/tempImageStore.js');
    render = await import('../../src/render/index.js');
    closeServicePool = (await import('../../src/db/index.js')).closePool;
  }, 180_000);

  afterAll(async () => {
    for (const [name, value] of [
      ['LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP', saved.account],
      ['LETTER_IRL_BETA_GLOBAL_DAILY_MAIL_CEILING', saved.global],
      ['LETTER_IRL_SCHEDULE_DAILY_CAP', saved.cap],
      ['TEMP_IMAGE_STORE', saved.store],
      ['LETTER_IRL_OUTBOX_DISPATCH_ENABLED', saved.outbox]
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

  beforeEach(async () => {
    resetStubProvider();
    for (const { letterId } of await store.listHeldPdfs()) await store.deleteHeldPdf(letterId);
  });

  async function seedUser(credits = 20): Promise<string> {
    const userId = `auth0|held-print-${randomUUID()}`;
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

  function upcoming(): { arriveBy: string; mailOn: string } {
    const arriveBy = schedule.addCalendarDays(schedule.newYorkDate(new Date()), 21);
    return { arriveBy, mailOn: schedule.mailOnFor(arriveBy, 7) };
  }

  async function send(
    userId: string,
    options: { dates?: { arriveBy: string; mailOn: string }; rendererVersion?: string } = {}
  ) {
    const { draftId } = await drafts.createDraft({
      userId,
      sender: SENDER,
      recipient: RECIPIENT,
      bodyText: `Dear Sam,\n\nHello ${randomUUID()}.`,
      signOff: 'Warmly,\nTest',
      requiredCredits: 2,
      ...(options.rendererVersion ? { rendererVersion: options.rendererVersion } : {}),
      ...(options.dates ? { schedule: options.dates } : {})
    });
    return mailSend.createMailOrderFromDraft({ draftId, userId, mailType: 'letter' });
  }

  const letterRow = async (letterId: string) => (await pool.query('SELECT * FROM letters WHERE letter_id = $1', [letterId])).rows[0];

  it('checks each value, the engine with the fingerprint, and a PDF only with a fingerprint, of held mail', async () => {
    const userId = await seedUser();
    const letterId = randomUUID();
    await pool.query(
      `INSERT INTO letters (letter_id, user_id, content, recipient, credits_cost, status, mail_type, funding_type)
       VALUES ($1, $2, '{}', $3, 2, 'draft', 'letter', 'prepaid_balance')`,
      [letterId, userId, JSON.stringify(RECIPIENT)]
    );
    const fingerprint = `fp1:${'a'.repeat(64)}`;
    const attempt = (sets: string, values: unknown[]) =>
      pool.query(`UPDATE letters SET ${sets} WHERE letter_id = $1`, [letterId, ...values]);
    for (const [sets, values, constraint] of [
      ['print_layout_fingerprint = $2, print_layout_engine = $3', ['fp1:short', 'layout-1'], 'letters_print_layout_fingerprint_shape'],
      ['print_layout_fingerprint = $2, print_layout_engine = $3', [fingerprint, 'layout-0'], 'letters_print_layout_engine_shape'],
      ['print_layout_fingerprint = $2', [fingerprint], 'letters_print_layout_engine_with_fingerprint'],
      ['print_layout_engine = $2', ['layout-1'], 'letters_print_layout_engine_with_fingerprint'],
      ['print_pdf_sha256 = $2', ['B'.repeat(64)], 'letters_print_pdf_sha256_shape'],
      ['print_pdf_sha256 = $2', ['b'.repeat(64)], 'letters_print_pdf_needs_fingerprint'],
      ['print_pdf_sha256 = $2, print_layout_fingerprint = $3, print_layout_engine = $4', ['b'.repeat(64), fingerprint, 'layout-1'], 'letters_print_pdf_held_only']
    ] as const) {
      await expect(attempt(sets, [...values])).rejects.toMatchObject({ code: '23514', constraint });
    }
    // A fingerprint alone is any letter's; a PDF with it, held mail's.
    await attempt('print_layout_fingerprint = $2, print_layout_engine = $3', [fingerprint, 'layout-1']);
    await attempt("arrive_by = '2026-12-16', mail_on = '2026-12-09', print_pdf_sha256 = $2", ['b'.repeat(64)]);
    expect((await letterRow(letterId)).print_pdf_sha256).toBe('b'.repeat(64));
  }, 60_000);

  it("records a held letter's layout in the send, then stores its PDF and the SHA-256 of the stored bytes", async () => {
    const userId = await seedUser();
    const result = await send(userId, { dates: upcoming(), rendererVersion: render.RENDERER_VERSION });

    const letter = await letterRow(result.letter.letter_id);
    const print = heldPrint.printLayoutOf(letter);
    expect(letter.print_layout_fingerprint).toBe(render.layoutFingerprint(print.layout, print.rendererVersion));
    expect(letter.print_layout_engine).toBe(render.LAYOUT_ENGINE_VERSION);
    const stored = await store.getHeldPdf(letter.letter_id);
    expect(stored).not.toBeNull();
    expect(letter.print_pdf_sha256).toBe(sha256(stored!));
    expect(stored!.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  }, 60_000);

  it('records nothing for mail not held, or drawn by the legacy HTML', async () => {
    const userId = await seedUser();
    const now = await send(userId, { rendererVersion: render.RENDERER_VERSION });
    const legacy = await send(userId, { dates: upcoming() });
    for (const result of [now, legacy]) {
      const letter = await letterRow(result.letter.letter_id);
      expect([letter.print_layout_fingerprint, letter.print_layout_engine, letter.print_pdf_sha256]).toEqual([null, null, null]);
      expect(await store.getHeldPdf(letter.letter_id)).toBeNull();
    }
  }, 60_000);

  it('hands the provider the stored bytes and the fingerprint on its date, then deletes the PDF', async () => {
    process.env.LETTER_IRL_OUTBOX_DISPATCH_ENABLED = 'true';
    try {
      const userId = await seedUser();
      const result = await send(userId, { dates: upcoming(), rendererVersion: render.RENDERER_VERSION });
      const letter = await letterRow(result.letter.letter_id);
      const stored = await store.getHeldPdf(letter.letter_id);
      // Its date has come.
      await pool.query(`UPDATE letter_jobs SET next_attempt_at = NOW() - INTERVAL '1 minute' WHERE letter_id = $1`, [letter.letter_id]);
      stubProvider.nextResult = providerSuccess('held-tracking');

      await expect(jobs.processLetterJob(result.job!.job_id)).resolves.toMatchObject({ claimed: true, completed: true });

      expect(stubProvider.calls).toHaveLength(1);
      const handed = stubProvider.calls[0].params.heldPrint!;
      expect(handed.layoutFingerprint).toBe(letter.print_layout_fingerprint);
      expect(handed.pdf!.equals(stored!)).toBe(true);
      expect(await store.getHeldPdf(letter.letter_id)).toBeNull();
    } finally {
      delete process.env.LETTER_IRL_OUTBOX_DISPATCH_ENABLED;
    }
  }, 60_000);

  it('hands only the fingerprint when the stored bytes are not the ones recorded', async () => {
    process.env.LETTER_IRL_OUTBOX_DISPATCH_ENABLED = 'true';
    try {
      const userId = await seedUser();
      const result = await send(userId, { dates: upcoming(), rendererVersion: render.RENDERER_VERSION });
      await store.storeHeldPdf(result.letter.letter_id, Buffer.from('%PDF- not the one recorded'));
      await pool.query(`UPDATE letter_jobs SET next_attempt_at = NOW() - INTERVAL '1 minute' WHERE letter_id = $1`, [result.letter.letter_id]);
      stubProvider.nextResult = providerSuccess('held-tracking-2');

      await jobs.processLetterJob(result.job!.job_id);

      expect(stubProvider.calls[0].params.heldPrint).toEqual({ layoutFingerprint: (await letterRow(result.letter.letter_id)).print_layout_fingerprint });
    } finally {
      delete process.env.LETTER_IRL_OUTBOX_DISPATCH_ENABLED;
    }
  }, 60_000);

  it('deletes the PDF of held mail the person cancels', async () => {
    const userId = await seedUser();
    const result = await send(userId, { dates: upcoming(), rendererVersion: render.RENDERER_VERSION });
    expect(await store.getHeldPdf(result.letter.letter_id)).not.toBeNull();
    await expect(held.cancelScheduledMail({ letterId: result.letter.letter_id, userId })).resolves.toMatchObject({ ok: true });
    expect(await store.getHeldPdf(result.letter.letter_id)).toBeNull();
  }, 60_000);

  it('backfills a held letter the send left without a PDF, once the grace has passed', async () => {
    const userId = await seedUser();
    const result = await send(userId, { dates: upcoming(), rendererVersion: render.RENDERER_VERSION });
    const letterId = result.letter.letter_id;
    // As a bucket outage at the send leaves it.
    await store.deleteHeldPdf(letterId);
    await pool.query('UPDATE letters SET print_pdf_sha256 = NULL WHERE letter_id = $1', [letterId]);

    // Within the grace it is the send's to store.
    expect((await heldPrint.backfillHeldPrints()).stored).toBe(0);
    await pool.query(`UPDATE letters SET created_at = created_at - INTERVAL '20 minutes' WHERE letter_id = $1`, [letterId]);
    expect((await heldPrint.backfillHeldPrints()).stored).toBe(1);

    const letter = await letterRow(letterId);
    expect(letter.print_pdf_sha256).toBe(sha256((await store.getHeldPdf(letterId))!));
  }, 60_000);

  it('reports, and does not store, a held letter that now lays out otherwise', async () => {
    const userId = await seedUser();
    const result = await send(userId, { dates: upcoming(), rendererVersion: render.RENDERER_VERSION });
    const letterId = result.letter.letter_id;
    await store.deleteHeldPdf(letterId);
    await pool.query(
      `UPDATE letters SET print_pdf_sha256 = NULL, created_at = created_at - INTERVAL '20 minutes',
              content = jsonb_set(content, '{bodyText}', to_jsonb('Dear Pat,'::text))
        WHERE letter_id = $1`,
      [letterId]
    );
    await expect(heldPrint.storeHeldPrint(letterId)).resolves.toBe('layout_changed');
    expect(await store.getHeldPdf(letterId)).toBeNull();
  }, 60_000);

  it('sweeps a PDF no waiting letter records, and keeps one a waiting letter does', async () => {
    const userId = await seedUser();
    const waiting = await send(userId, { dates: upcoming(), rendererVersion: render.RENDERER_VERSION });
    const gone = await send(userId, { dates: upcoming(), rendererVersion: render.RENDERER_VERSION });
    // A letter that stopped waiting without its PDF deleted (an operator's cancel).
    await pool.query("UPDATE letters SET status = 'cancelled' WHERE letter_id = $1", [gone.letter.letter_id]);
    const stray = randomUUID();
    await store.storeHeldPdf(stray, Buffer.from('%PDF- of no letter'));

    // Nothing younger than the grace is swept.
    expect((await heldPrint.sweepHeldPdfs()).deleted).toBe(0);
    const later = new Date(Date.now() + heldPrint.HELD_PDF_GRACE_MS + 60_000);
    expect(await heldPrint.sweepHeldPdfs(later)).toEqual({ kept: 1, deleted: 2 });
    expect((await store.listHeldPdfs()).map((entry) => entry.letterId)).toEqual([waiting.letter.letter_id]);
  }, 60_000);
});
