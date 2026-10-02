import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import { repositoryMigrations, validateDisposableDatabaseUrl } from './support/disposableDatabase.js';

/**
 * Which renderer drew a draft's preview (migration 039, #534).
 *
 *   a draft records no renderer by default (the legacy HTML), accepts 'pdf-1',
 *   and refuses any other value
 *   createDraft stores the version a preview drew with, in its own column
 *   the send copies the version into letters.content, so the letter prints
 *   with it however long it waits; a legacy draft's letter gets none
 *
 * Against real PostgreSQL because the column, its CHECK and the JSONB content
 * are the change's whole substance, and a mocked query() honours none of them.
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

describePostgres('renderer version (migration 039, #534)', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let schema: string;
  let mailSend: typeof import('../../src/services/mailSendService.js');
  let drafts: typeof import('../../src/services/draftService.js');
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
    schema = schemaName('lirl_renderer_version');
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const scoped = databaseUrlForSchema(baseUrl, schema);
    await migrate({ connectionString: scoped, migrationsDirectory: repositoryMigrations });
    pool = new Pool({ connectionString: scoped, max: 4 });

    process.env.DATABASE_URL = scoped;
    mailSend = await import('../../src/services/mailSendService.js');
    drafts = await import('../../src/services/draftService.js');
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
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  }, 60_000);

  async function seedUser(credits = 10): Promise<string> {
    const userId = `auth0|renderer-${randomUUID()}`;
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

  /** A pending text-only letter draft; each body differs so the duplicate check (#412) stays out of it. */
  async function seedDraft(userId: string, rendererVersion: string | null): Promise<string> {
    const draftId = randomUUID();
    await pool.query(
      `INSERT INTO letter_drafts (
         draft_id, user_id, sender, recipient, body_text, sign_off, required_credits,
         expires_at, status, mail_type, layout_type, renderer_version
       ) VALUES ($1, $2, $3, $4, $5, 'Warmly, Test', 2, NOW() + INTERVAL '1 day', 'pending',
                 'letter', 'text_only', $6)`,
      [draftId, userId, JSON.stringify(SENDER), JSON.stringify(RECIPIENT), `Hello ${draftId}`, rendererVersion]
    );
    return draftId;
  }

  it('records no renderer by default, accepts pdf-1, and refuses any other value', async () => {
    const userId = await seedUser();
    const byDefault = await pool.query<{ renderer_version: string | null }>(
      `INSERT INTO letter_drafts (draft_id, user_id, sender, recipient, body_text, sign_off, required_credits, expires_at)
       VALUES ($1, $2, $3, $4, 'body', 'regards', 2, NOW() + INTERVAL '1 day')
       RETURNING renderer_version`,
      [randomUUID(), userId, JSON.stringify(SENDER), JSON.stringify(RECIPIENT)]
    );
    expect(byDefault.rows[0].renderer_version).toBeNull();

    const rendered = await seedDraft(userId, 'pdf-1');
    const stored = await pool.query<{ renderer_version: string }>(
      'SELECT renderer_version FROM letter_drafts WHERE draft_id = $1',
      [rendered]
    );
    expect(stored.rows[0].renderer_version).toBe('pdf-1');

    await expect(seedDraft(userId, 'pdf-9')).rejects.toMatchObject({
      code: '23514',
      constraint: 'letter_drafts_renderer_version_known'
    });
  }, 60_000);

  it("stores the version a preview's draft is created with, and none without one", async () => {
    const userId = await seedUser();
    const draft = {
      userId,
      sender: SENDER,
      recipient: RECIPIENT,
      signOff: 'Warmly, Test',
      requiredCredits: 2,
      previewHtml: '<svg></svg>',
      layoutType: 'text_only' as const
    };
    const rendered = await drafts.createDraft({ ...draft, bodyText: `Hello ${randomUUID()}`, rendererVersion: 'pdf-1' });
    const legacy = await drafts.createDraft({ ...draft, bodyText: `Hello ${randomUUID()}` });

    const stored = await pool.query<{ draft_id: string; renderer_version: string | null; is_gift_send: boolean }>(
      'SELECT draft_id, renderer_version, is_gift_send FROM letter_drafts WHERE draft_id = ANY($1)',
      [[rendered.draftId, legacy.draftId]]
    );
    const byId = new Map(stored.rows.map(row => [row.draft_id, row]));
    expect(byId.get(rendered.draftId)).toMatchObject({ renderer_version: 'pdf-1', is_gift_send: false });
    expect(byId.get(legacy.draftId)).toMatchObject({ renderer_version: null, is_gift_send: false });
  }, 60_000);

  it('copies the version into the letter the send creates, and none for a legacy draft', async () => {
    const userId = await seedUser();
    const renderedDraft = await seedDraft(userId, 'pdf-1');
    const legacyDraft = await seedDraft(userId, null);

    const rendered = await mailSend.createMailOrderFromDraft({ draftId: renderedDraft, userId, mailType: 'letter' });
    const legacy = await mailSend.createMailOrderFromDraft({ draftId: legacyDraft, userId, mailType: 'letter' });

    const stored = await pool.query<{ letter_id: string; version: string | null; has_key: boolean }>(
      `SELECT letter_id, content->>'rendererVersion' AS version, content ? 'rendererVersion' AS has_key
         FROM letters WHERE letter_id = ANY($1)`,
      [[rendered.letter.letter_id, legacy.letter.letter_id]]
    );
    const byId = new Map(stored.rows.map(row => [row.letter_id, row]));
    expect(byId.get(rendered.letter.letter_id)).toMatchObject({ version: 'pdf-1', has_key: true });
    expect(byId.get(legacy.letter.letter_id)).toMatchObject({ version: null, has_key: false });
  }, 60_000);

  describe('stationery (#563, migration 044)', () => {
    const BOTANICAL = { theme: 'botanical', dateLine: 'October 1, 2026' };
    const base = (userId: string) => ({
      userId,
      sender: SENDER,
      recipient: RECIPIENT,
      signOff: 'Warmly, Test',
      requiredCredits: 2,
      previewHtml: '<svg></svg>',
      layoutType: 'text_only' as const
    });

    it('admits a theme with pdf-2 only, pdf-2 only with a theme, and only the themes it knows', async () => {
      const userId = await seedUser();
      const themed = await drafts.createDraft({
        ...base(userId),
        bodyText: `Hello ${randomUUID()}`,
        rendererVersion: 'pdf-2',
        stationery: { theme: 'botanical', dateLine: 'October 1, 2026' }
      });
      const row = await pool.query('SELECT stationery, renderer_version FROM letter_drafts WHERE draft_id = $1', [themed.draftId]);
      expect(row.rows[0]).toEqual({ stationery: BOTANICAL, renderer_version: 'pdf-2' });

      const plain = await seedDraft(userId, 'pdf-1');
      // A theme drawn as pdf-1, pdf-2 without a theme, and a theme no build draws.
      await expect(pool.query('UPDATE letter_drafts SET stationery = $2::jsonb WHERE draft_id = $1', [plain, JSON.stringify(BOTANICAL)]))
        .rejects.toMatchObject({ code: '23514', constraint: 'letter_drafts_stationery_drawn_by_pdf_2' });
      await expect(pool.query("UPDATE letter_drafts SET renderer_version = 'pdf-2' WHERE draft_id = $1", [plain]))
        .rejects.toMatchObject({ code: '23514', constraint: 'letter_drafts_stationery_drawn_by_pdf_2' });
      await expect(pool.query(
        "UPDATE letter_drafts SET renderer_version = 'pdf-2', stationery = '{\"theme\": \"typewriter\"}'::jsonb WHERE draft_id = $1",
        [plain]
      )).rejects.toMatchObject({ code: '23514', constraint: 'letter_drafts_stationery_theme_known' });
      // Classic is no theme: never stored. Nor is JSON that names no theme.
      for (const stored of ['{"theme": "classic"}', '{}', '{"theme": null}', '"botanical"', '[]']) {
        await expect(pool.query(
          "UPDATE letter_drafts SET renderer_version = 'pdf-2', stationery = $2::jsonb WHERE draft_id = $1",
          [plain, stored]
        )).rejects.toMatchObject({ code: '23514', constraint: 'letter_drafts_stationery_theme_known' });
      }
      // The legacy HTML stays without either.
      const legacy = await seedDraft(userId, null);
      expect((await pool.query('SELECT stationery FROM letter_drafts WHERE draft_id = $1', [legacy])).rows[0].stationery).toBeNull();
    }, 60_000);

    it('copies the stationery into the letter the send creates, and none for Classic', async () => {
      const userId = await seedUser();
      const themed = await drafts.createDraft({
        ...base(userId),
        bodyText: `Hello ${randomUUID()}`,
        rendererVersion: 'pdf-2',
        stationery: { theme: 'botanical', dateLine: 'October 1, 2026' }
      });
      const classicDraft = await seedDraft(userId, 'pdf-1');

      const sent = await mailSend.createMailOrderFromDraft({ draftId: themed.draftId, userId, mailType: 'letter' });
      const classic = await mailSend.createMailOrderFromDraft({ draftId: classicDraft, userId, mailType: 'letter' });

      const stored = await pool.query<{ letter_id: string; content: Record<string, unknown> }>(
        'SELECT letter_id, content FROM letters WHERE letter_id = ANY($1)',
        [[sent.letter.letter_id, classic.letter.letter_id]]
      );
      const byId = new Map(stored.rows.map(row => [row.letter_id, row.content]));
      expect(byId.get(sent.letter.letter_id)).toMatchObject({ rendererVersion: 'pdf-2', stationery: BOTANICAL });
      expect(byId.get(classic.letter.letter_id)).not.toHaveProperty('stationery');
    }, 60_000);

    it("gives get_draft_status what a draft's page was drawn with (#572)", async () => {
      const userId = await seedUser();
      const themed = await drafts.createDraft({
        ...base(userId),
        bodyText: `Hello ${randomUUID()}`,
        rendererVersion: 'pdf-2',
        stationery: { theme: 'botanical', dateLine: 'October 1, 2026' }
      });
      await expect(drafts.getDraftState(themed.draftId)).resolves.toMatchObject({
        mail_type: 'letter',
        renderer_version: 'pdf-2',
        stationery: BOTANICAL,
        preview_html: '<svg></svg>'
      });
      // Sent, its page is no longer read (#572 review round 2).
      await mailSend.createMailOrderFromDraft({ draftId: themed.draftId, userId, mailType: 'letter' });
      await expect(drafts.getDraftState(themed.draftId)).resolves.toMatchObject({ status: 'consumed', preview_html: null });
    }, 60_000);
  });

  describe('set_stationery and the remembered theme (#563, migration 045)', () => {
    const BOTANICAL = { theme: 'botanical' as const, dateLine: 'October 1, 2026' };
    const PAGE = '<!DOCTYPE html><html><body data-renderer="pdf-2"><svg></svg></body></html>';

    async function stateOf(draftId: string, userId: string) {
      const draft = (await pool.query('SELECT stationery, renderer_version, preview_html FROM letter_drafts WHERE draft_id = $1', [draftId])).rows[0];
      const theme = (await pool.query('SELECT stationery_theme FROM users WHERE user_id = $1', [userId])).rows[0].stationery_theme;
      return { ...draft, theme };
    }

    async function seedPayAndSend(userId: string, draftId: string, status: string, expiresIn: string): Promise<void> {
      const orderId = `order-${randomUUID()}`;
      await pool.query(
        `INSERT INTO orders (order_id, user_id, credits, amount_cents, currency, status, order_type, product_code,
           idempotency_key, draft_id, checkout_expires_at)
         VALUES ($1, $2, NULL, 499, 'USD', $3, 'jit_mail', 'jit-letter', $4, $5, NOW() + $6::interval)`,
        [orderId, userId, status, `idem_${orderId}`, draftId, expiresIn]
      );
    }

    it('remembers no theme by default, admits the four, and refuses any other', async () => {
      const userId = await seedUser();
      expect((await pool.query('SELECT stationery_theme FROM users WHERE user_id = $1', [userId])).rows[0].stationery_theme).toBeNull();
      for (const theme of ['classic', 'monogram', 'botanical', 'celebration']) {
        await pool.query('UPDATE users SET stationery_theme = $2 WHERE user_id = $1', [userId, theme]);
      }
      await expect(pool.query("UPDATE users SET stationery_theme = 'typewriter' WHERE user_id = $1", [userId]))
        .rejects.toMatchObject({ code: '23514', constraint: 'users_stationery_theme_known' });
    }, 60_000);

    it('restyles a pending draft into a theme and back to Classic, remembering each, within the pair check', async () => {
      const userId = await seedUser();
      const draftId = await seedDraft(userId, 'pdf-1');

      await expect(drafts.setDraftStationery(draftId, userId, { stationery: BOTANICAL, previewHtml: PAGE }))
        .resolves.toBeNull();
      expect(await stateOf(draftId, userId)).toEqual({ stationery: BOTANICAL, renderer_version: 'pdf-2', preview_html: PAGE, theme: 'botanical' });

      await expect(drafts.setDraftStationery(draftId, userId, { stationery: { theme: 'classic' }, previewHtml: '<svg/>' }))
        .resolves.toBeNull();
      expect(await stateOf(draftId, userId)).toEqual({ stationery: null, renderer_version: 'pdf-1', preview_html: '<svg/>', theme: 'classic' });
    }, 60_000);

    it('remembers no theme on an erased account (#571 review round 3)', async () => {
      const remembered = await import('../../src/services/stationeryDefaultService.js');
      const userId = await seedUser();
      await pool.query(
        `UPDATE users SET erased_at = NOW(), email = 'erased-' || gen_random_uuid()::text || '@erased.invalid',
                          return_address = NULL, return_address_validated_at = NULL
          WHERE user_id = $1`,
        [userId]
      );
      await remembered.rememberStationery(userId, 'botanical');
      expect((await pool.query('SELECT stationery_theme FROM users WHERE user_id = $1', [userId])).rows[0].stationery_theme).toBeNull();
    }, 60_000);

    it("restyles a draft but remembers nothing when the account was erased under it (#573 review round 1)", async () => {
      const userId = await seedUser();
      const draftId = await seedDraft(userId, 'pdf-1');
      await pool.query(
        `UPDATE users SET erased_at = NOW(), email = 'erased-' || gen_random_uuid()::text || '@erased.invalid',
                          return_address = NULL, return_address_validated_at = NULL
          WHERE user_id = $1`,
        [userId]
      );

      await expect(drafts.setDraftStationery(draftId, userId, { stationery: BOTANICAL, previewHtml: PAGE })).resolves.toBeNull();
      expect(await stateOf(draftId, userId)).toEqual({ stationery: BOTANICAL, renderer_version: 'pdf-2', preview_html: PAGE, theme: null });
    }, 60_000);

    it('leaves a draft an erasure emptied as it was, its dates and its style (#573 review round 1)', async () => {
      const { DRAFT_REDACTION_SET } = await import('../../src/services/retentionService.js');
      const userId = await seedUser();
      const draftId = await seedDraft(userId, 'pdf-1');
      // As the erasure empties a draft an order points at: still pending, unexpired.
      await pool.query(`UPDATE letter_drafts ${DRAFT_REDACTION_SET} WHERE draft_id = $1`, [draftId]);

      await expect(drafts.setDraftStationery(draftId, userId, { stationery: BOTANICAL, previewHtml: PAGE })).resolves.toBe('expired');
      await expect(drafts.setDraftSchedule(draftId, userId, { arriveBy: '2026-12-01', mailOn: '2026-11-20' })).resolves.toBe('expired');
      expect(await stateOf(draftId, userId)).toEqual({ stationery: null, renderer_version: 'pdf-1', preview_html: null, theme: null });
      const row = (await pool.query('SELECT status, body_text, arrive_by FROM letter_drafts WHERE draft_id = $1', [draftId])).rows[0];
      expect(row).toEqual({ status: 'pending', body_text: '', arrive_by: null });
    }, 60_000);

    it("leaves a sent, expired, Pay & Send or someone else's draft as it was, and remembers nothing", async () => {
      const userId = await seedUser();
      const other = await seedUser();
      const change = { stationery: BOTANICAL, previewHtml: PAGE };

      const sent = await seedDraft(userId, 'pdf-1');
      await mailSend.createMailOrderFromDraft({ draftId: sent, userId, mailType: 'letter' });
      await expect(drafts.setDraftStationery(sent, userId, change)).resolves.toBe('sent');

      const expired = await seedDraft(userId, 'pdf-1');
      await pool.query("UPDATE letter_drafts SET expires_at = NOW() - INTERVAL '1 minute' WHERE draft_id = $1", [expired]);
      await expect(drafts.setDraftStationery(expired, userId, change)).resolves.toBe('expired');

      const paying = await seedDraft(userId, 'pdf-1');
      await seedPayAndSend(userId, paying, 'checkout_pending', '20 minutes');
      await expect(drafts.setDraftStationery(paying, userId, change)).resolves.toBe('checkout_pending');

      const theirs = await seedDraft(other, 'pdf-1');
      await expect(drafts.setDraftStationery(theirs, userId, change)).resolves.toBe('not_found');

      for (const [draftId, owner] of [[sent, userId], [expired, userId], [paying, userId], [theirs, other]]) {
        expect(await stateOf(draftId, owner), draftId).toMatchObject({ stationery: null, renderer_version: 'pdf-1', theme: null });
      }
    }, 60_000);
  });
});
