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

describePostgres('renderer version, stationery and pages (migrations 039 and 044 to 047, #534, #563, #586)', () => {
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
        "UPDATE letter_drafts SET renderer_version = 'pdf-2', stationery = '{\"theme\": \"floral\"}'::jsonb WHERE draft_id = $1",
        [plain]
      )).rejects.toMatchObject({ code: '23514', constraint: 'letter_drafts_stationery_theme_known' });
      // Typewriter and Handwritten are themes like the others (migration 046).
      for (const theme of ['typewriter', 'handwritten']) {
        const drawn = await seedDraft(userId, 'pdf-1');
        await pool.query(
          "UPDATE letter_drafts SET renderer_version = 'pdf-2', stationery = $2::jsonb WHERE draft_id = $1",
          [drawn, JSON.stringify({ theme, dateLine: 'October 1, 2026' })]
        );
        expect((await pool.query('SELECT stationery FROM letter_drafts WHERE draft_id = $1', [drawn])).rows[0].stationery)
          .toEqual({ theme, dateLine: 'October 1, 2026' });
      }
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

  describe('room to write (#586, migration 047)', () => {
    const pagesOf = async (draftId: string) =>
      (await pool.query<{ pages: number }>('SELECT pages FROM letter_drafts WHERE draft_id = $1', [draftId])).rows[0].pages;

    it('records one page by default, admits two and three on a letter our renderer drew, and no other count', async () => {
      const userId = await seedUser();
      expect(await pagesOf(await seedDraft(userId, null))).toBe(1);

      const drawn = await seedDraft(userId, 'pdf-1');
      expect(await pagesOf(drawn)).toBe(1);
      for (const pages of [2, 3, 1]) {
        await pool.query('UPDATE letter_drafts SET pages = $2::smallint WHERE draft_id = $1', [drawn, pages]);
        expect(await pagesOf(drawn)).toBe(pages);
      }
      for (const pages of [0, 4, -1]) {
        await expect(pool.query('UPDATE letter_drafts SET pages = $2::smallint WHERE draft_id = $1', [drawn, pages]))
          .rejects.toMatchObject({ code: '23514', constraint: 'letter_drafts_pages_known' });
      }
    }, 60_000);

    it('stores the pages createDraft is given, one by default, and refuses a longer legacy draft before writing', async () => {
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
      const long = await drafts.createDraft({ ...draft, bodyText: `Hello ${randomUUID()}`, rendererVersion: 'pdf-1', pages: 3 });
      const short = await drafts.createDraft({ ...draft, bodyText: `Hello ${randomUUID()}`, rendererVersion: 'pdf-1' });
      expect(await pagesOf(long.draftId)).toBe(3);
      expect(await pagesOf(short.draftId)).toBe(1);

      const before = (await pool.query('SELECT COUNT(*)::int AS n FROM letter_drafts WHERE user_id = $1', [userId])).rows[0].n;
      await expect(drafts.createDraft({ ...draft, bodyText: `Hello ${randomUUID()}`, pages: 2 }))
        .rejects.toMatchObject({ code: 'DRAFT_PAGES_INVALID' });
      expect((await pool.query('SELECT COUNT(*)::int AS n FROM letter_drafts WHERE user_id = $1', [userId])).rows[0].n).toBe(before);
    }, 60_000);

    it('admits more than one page only on a letter our renderer drew that is no gift send', async () => {
      const userId = await seedUser();
      const refused = { code: '23514', constraint: 'letter_drafts_pages_paid_per_send' };

      // The legacy HTML draws one page, and a gift letter pays for one (#579).
      const legacy = await seedDraft(userId, null);
      await expect(pool.query('UPDATE letter_drafts SET pages = 2 WHERE draft_id = $1', [legacy])).rejects.toMatchObject(refused);
      const gift = await seedDraft(userId, 'pdf-1');
      await pool.query('UPDATE letter_drafts SET is_gift_send = TRUE WHERE draft_id = $1', [gift]);
      await expect(pool.query('UPDATE letter_drafts SET pages = 2 WHERE draft_id = $1', [gift])).rejects.toMatchObject(refused);

      // Nor does a longer letter become one: a gift send, a postcard, or the legacy HTML.
      const long = await seedDraft(userId, 'pdf-1');
      await pool.query('UPDATE letter_drafts SET pages = 3 WHERE draft_id = $1', [long]);
      for (const change of [
        'is_gift_send = TRUE',
        // A postcard as the other postcard checks want one, so only this check refuses it.
        "mail_type = 'postcard', postcard_size = '6x9', front_image_data = 'data:image/jpeg;base64,AA=='",
        'renderer_version = NULL'
      ]) {
        await expect(pool.query(`UPDATE letter_drafts SET ${change} WHERE draft_id = $1`, [long]), change)
          .rejects.toMatchObject(refused);
      }
      expect(await pagesOf(long)).toBe(3);
    }, 60_000);

    it('copies the pages a longer letter was laid out on into the letter Pay & Send creates, and none for one page', async () => {
      const userId = await seedUser();
      const long = await seedDraft(userId, 'pdf-1');
      await pool.query('UPDATE letter_drafts SET pages = 2 WHERE draft_id = $1', [long]);
      const orderId = `order-${randomUUID()}`;
      await pool.query(
        `INSERT INTO orders (order_id, user_id, credits, amount_cents, currency, status, order_type, product_code,
           idempotency_key, draft_id)
         VALUES ($1, $2, NULL, 599, 'usd', 'paid', 'jit_mail', 'jit-letter-2-pages', $3, $4)`,
        [orderId, userId, `idem_${orderId}`, long]
      );
      const short = await seedDraft(userId, 'pdf-1');

      const paid = await mailSend.createMailOrderFromDraft({
        draftId: long, userId, mailType: 'letter', funding: { type: 'jit_order', orderId }
      });
      const prepaid = await mailSend.createMailOrderFromDraft({ draftId: short, userId, mailType: 'letter' });

      const stored = await pool.query<{ letter_id: string; content: Record<string, unknown> }>(
        'SELECT letter_id, content FROM letters WHERE letter_id = ANY($1)',
        [[paid.letter.letter_id, prepaid.letter.letter_id]]
      );
      const byId = new Map(stored.rows.map(row => [row.letter_id, row.content]));
      expect(byId.get(paid.letter.letter_id)).toMatchObject({ rendererVersion: 'pdf-1', pages: 2 });
      expect(byId.get(prepaid.letter.letter_id)).not.toHaveProperty('pages');
    }, 60_000);
  });

  describe('set_stationery and the remembered theme (#563, migration 045)', () => {
    const BOTANICAL = { theme: 'botanical' as const, dateLine: 'October 1, 2026' };
    const PAGE = '<!DOCTYPE html><html><body data-renderer="pdf-2"><svg></svg></body></html>';
    /** The words a seeded draft's page is drawn from, as a restyle reads them (#586). */
    const drawnFrom = (draftId: string) => ({ bodyText: `Hello ${draftId}`, signOff: 'Warmly, Test' });

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

    it('remembers no theme by default, admits the six, and refuses any other', async () => {
      const userId = await seedUser();
      expect((await pool.query('SELECT stationery_theme FROM users WHERE user_id = $1', [userId])).rows[0].stationery_theme).toBeNull();
      for (const theme of ['classic', 'monogram', 'botanical', 'celebration', 'typewriter', 'handwritten']) {
        await pool.query('UPDATE users SET stationery_theme = $2 WHERE user_id = $1', [userId, theme]);
        expect((await pool.query('SELECT stationery_theme FROM users WHERE user_id = $1', [userId])).rows[0].stationery_theme).toBe(theme);
      }
      await expect(pool.query("UPDATE users SET stationery_theme = 'floral' WHERE user_id = $1", [userId]))
        .rejects.toMatchObject({ code: '23514', constraint: 'users_stationery_theme_known' });
    }, 60_000);

    it('restyles a pending draft into Typewriter and Handwritten through set_stationery, remembering each (#563 PR 8b)', async () => {
      const userId = await seedUser();
      const draftId = await seedDraft(userId, 'pdf-1');
      for (const theme of ['typewriter', 'handwritten'] as const) {
        const stationery = { theme, dateLine: 'October 1, 2026' };
        await expect(drafts.setDraftStationery(draftId, userId, { stationery, previewHtml: PAGE, drawnFrom: drawnFrom(draftId) })).resolves.toBeNull();
        expect(await stateOf(draftId, userId)).toEqual({ stationery, renderer_version: 'pdf-2', preview_html: PAGE, theme });
      }
    }, 60_000);

    it('stores the pages a restyle laid the letter out on, and keeps them when none are given (#586)', async () => {
      const userId = await seedUser();
      const draftId = await seedDraft(userId, 'pdf-1');
      const row = async () =>
        (await pool.query('SELECT pages, renderer_version FROM letter_drafts WHERE draft_id = $1', [draftId])).rows[0];

      await expect(drafts.setDraftStationery(draftId, userId, { stationery: BOTANICAL, previewHtml: PAGE, pages: 2, drawnFrom: drawnFrom(draftId) })).resolves.toBeNull();
      expect(await row()).toEqual({ pages: 2, renderer_version: 'pdf-2' });
      // get_draft_status reads them back (getDraftState).
      await expect(drafts.getDraftState(draftId)).resolves.toMatchObject({ pages: 2 });
      await expect(drafts.setDraftStationery(draftId, userId, { stationery: { theme: 'classic' }, previewHtml: '<svg/>', pages: 1, drawnFrom: drawnFrom(draftId) }))
        .resolves.toBeNull();
      expect(await row()).toEqual({ pages: 1, renderer_version: 'pdf-1' });

      // A restyle that names no pages leaves the draft's own.
      await pool.query('UPDATE letter_drafts SET pages = 3 WHERE draft_id = $1', [draftId]);
      await expect(drafts.setDraftStationery(draftId, userId, { stationery: BOTANICAL, previewHtml: PAGE, drawnFrom: drawnFrom(draftId) })).resolves.toBeNull();
      expect(await row()).toEqual({ pages: 3, renderer_version: 'pdf-2' });

      // A gift letter pays for one page: migration 047 refuses more, whatever a caller passes.
      const gift = await seedDraft(userId, 'pdf-1');
      await pool.query('UPDATE letter_drafts SET is_gift_send = TRUE WHERE draft_id = $1', [gift]);
      await expect(drafts.setDraftStationery(gift, userId, { stationery: BOTANICAL, previewHtml: PAGE, pages: 2, drawnFrom: drawnFrom(gift) }))
        .rejects.toMatchObject({ code: '23514', constraint: 'letter_drafts_pages_paid_per_send' });
    }, 60_000);

    it('restyles a pending draft into a theme and back to Classic, remembering each, within the pair check', async () => {
      const userId = await seedUser();
      const draftId = await seedDraft(userId, 'pdf-1');

      await expect(drafts.setDraftStationery(draftId, userId, { stationery: BOTANICAL, previewHtml: PAGE, drawnFrom: drawnFrom(draftId) }))
        .resolves.toBeNull();
      expect(await stateOf(draftId, userId)).toEqual({ stationery: BOTANICAL, renderer_version: 'pdf-2', preview_html: PAGE, theme: 'botanical' });

      await expect(drafts.setDraftStationery(draftId, userId, { stationery: { theme: 'classic' }, previewHtml: '<svg/>', drawnFrom: drawnFrom(draftId) }))
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

      await expect(drafts.setDraftStationery(draftId, userId, { stationery: BOTANICAL, previewHtml: PAGE, drawnFrom: drawnFrom(draftId) })).resolves.toBeNull();
      expect(await stateOf(draftId, userId)).toEqual({ stationery: BOTANICAL, renderer_version: 'pdf-2', preview_html: PAGE, theme: null });
    }, 60_000);

    it('leaves a draft an erasure emptied as it was, its dates and its style (#573 review round 1)', async () => {
      const { DRAFT_REDACTION_SET } = await import('../../src/services/retentionService.js');
      const userId = await seedUser();
      const draftId = await seedDraft(userId, 'pdf-1');
      // As the erasure empties a draft an order points at: still pending, unexpired.
      await pool.query(`UPDATE letter_drafts ${DRAFT_REDACTION_SET} WHERE draft_id = $1`, [draftId]);

      await expect(drafts.setDraftStationery(draftId, userId, { stationery: BOTANICAL, previewHtml: PAGE, drawnFrom: drawnFrom(draftId) })).resolves.toBe('expired');
      await expect(drafts.setDraftSchedule(draftId, userId, { arriveBy: '2026-12-01', mailOn: '2026-11-20' })).resolves.toBe('expired');
      expect(await stateOf(draftId, userId)).toEqual({ stationery: null, renderer_version: 'pdf-1', preview_html: null, theme: null });
      const row = (await pool.query('SELECT status, body_text, arrive_by FROM letter_drafts WHERE draft_id = $1', [draftId])).rows[0];
      expect(row).toEqual({ status: 'pending', body_text: '', arrive_by: null });
    }, 60_000);

    it("leaves a sent, expired, Pay & Send or someone else's draft as it was, and remembers nothing", async () => {
      const userId = await seedUser();
      const other = await seedUser();
      const change = (draftId: string) => ({ stationery: BOTANICAL, previewHtml: PAGE, drawnFrom: drawnFrom(draftId) });

      const sent = await seedDraft(userId, 'pdf-1');
      await mailSend.createMailOrderFromDraft({ draftId: sent, userId, mailType: 'letter' });
      await expect(drafts.setDraftStationery(sent, userId, change(sent))).resolves.toBe('sent');

      const expired = await seedDraft(userId, 'pdf-1');
      await pool.query("UPDATE letter_drafts SET expires_at = NOW() - INTERVAL '1 minute' WHERE draft_id = $1", [expired]);
      await expect(drafts.setDraftStationery(expired, userId, change(expired))).resolves.toBe('expired');

      const paying = await seedDraft(userId, 'pdf-1');
      await seedPayAndSend(userId, paying, 'checkout_pending', '20 minutes');
      await expect(drafts.setDraftStationery(paying, userId, change(paying))).resolves.toBe('checkout_pending');

      const theirs = await seedDraft(other, 'pdf-1');
      await expect(drafts.setDraftStationery(theirs, userId, change(theirs))).resolves.toBe('not_found');

      for (const [draftId, owner] of [[sent, userId], [expired, userId], [paying, userId], [theirs, other]]) {
        expect(await stateOf(draftId, owner), draftId).toMatchObject({ stationery: null, renderer_version: 'pdf-1', theme: null });
      }
    }, 60_000);
  });

  describe('set_letter_words (#586)', () => {
    const BOTANICAL = { theme: 'botanical' as const, dateLine: 'October 1, 2026' };
    const PAGE = '<!DOCTYPE html><html><body data-renderer="pdf-1"><svg></svg><svg></svg></body></html>';
    const words = async (draftId: string) =>
      (await pool.query('SELECT body_text, sign_off, preview_html, pages, stationery FROM letter_drafts WHERE draft_id = $1', [draftId])).rows[0];

    /** The words a seeded draft has, as a change of them names what it replaces (#593 review round 1). */
    const seeded = (draftId: string) => ({ bodyText: `Hello ${draftId}`, signOff: 'Warmly, Test' });

    it('writes the words, the page and the pages, and 047 refuses two pages on a gift send', async () => {
      const userId = await seedUser();
      const draftId = await seedDraft(userId, 'pdf-1');
      await expect(
        drafts.setDraftWords(draftId, userId, {
          bodyText: 'Dear Sam,\n\nMore.', signOff: 'Love, Pat', previewHtml: PAGE, pages: 2, drawnIn: null, replacing: seeded(draftId)
        })
      ).resolves.toBeNull();
      expect(await words(draftId)).toEqual({ body_text: 'Dear Sam,\n\nMore.', sign_off: 'Love, Pat', preview_html: PAGE, pages: 2, stationery: null });
      // get_draft_status reads the pages and the words back (getDraftState).
      await expect(drafts.getDraftState(draftId)).resolves.toMatchObject({ pages: 2, body_text: 'Dear Sam,\n\nMore.', sign_off: 'Love, Pat' });

      const gift = await seedDraft(userId, 'pdf-1');
      await pool.query('UPDATE letter_drafts SET is_gift_send = TRUE WHERE draft_id = $1', [gift]);
      await expect(
        drafts.setDraftWords(gift, userId, { bodyText: 'Long', signOff: 'Pat', previewHtml: PAGE, pages: 2, drawnIn: null, replacing: seeded(gift) })
      ).rejects.toMatchObject({ code: '23514', constraint: 'letter_drafts_pages_paid_per_send' });
    }, 60_000);

    it('refuses a restyle drawn from words that changed under it, and words drawn in stationery, or over words, that changed', async () => {
      const userId = await seedUser();
      const draftId = await seedDraft(userId, 'pdf-1');
      const before = seeded(draftId);
      const newWords = { bodyText: 'New words', signOff: 'Love' };

      // New words land first: a restyle drawn from the old ones is refused, and changes nothing.
      await expect(drafts.setDraftWords(draftId, userId, { ...newWords, previewHtml: PAGE, pages: 1, drawnIn: null, replacing: before }))
        .resolves.toBeNull();
      await expect(drafts.setDraftStationery(draftId, userId, { stationery: BOTANICAL, previewHtml: '<svg/>', drawnFrom: before }))
        .resolves.toBe('changed');
      expect(await words(draftId)).toMatchObject({ body_text: 'New words', stationery: null, preview_html: PAGE });
      expect((await pool.query('SELECT stationery_theme FROM users WHERE user_id = $1', [userId])).rows[0].stationery_theme).toBeNull();

      // And other words over the old ones are refused too: the card's change and the chat's cannot overwrite each other unseen.
      await expect(drafts.setDraftWords(draftId, userId, { bodyText: 'Other', signOff: 'Pat', previewHtml: PAGE, pages: 1, drawnIn: null, replacing: before }))
        .resolves.toBe('changed');
      expect(await words(draftId)).toMatchObject({ body_text: 'New words' });

      // Drawn from the words it has, the restyle goes through.
      await expect(drafts.setDraftStationery(draftId, userId, { stationery: BOTANICAL, previewHtml: '<svg/>', drawnFrom: newWords }))
        .resolves.toBeNull();

      // Now words drawn on the plain page it had are refused; drawn in the stationery read back, they go through.
      await expect(drafts.setDraftWords(draftId, userId, { bodyText: 'Newer', signOff: 'Love', previewHtml: PAGE, pages: 1, drawnIn: null, replacing: newWords }))
        .resolves.toBe('changed');
      expect(await words(draftId)).toMatchObject({ body_text: 'New words', stationery: BOTANICAL });
      const stored = (await words(draftId)).stationery;
      await expect(drafts.setDraftWords(draftId, userId, { bodyText: 'Newer', signOff: 'Love', previewHtml: PAGE, pages: 1, drawnIn: stored, replacing: newWords }))
        .resolves.toBeNull();
      expect(await words(draftId)).toMatchObject({ body_text: 'Newer', stationery: BOTANICAL });
    }, 60_000);

    it("leaves a sent, expired or someone else's draft as it was", async () => {
      const userId = await seedUser();
      const other = await seedUser();
      const change = (draftId: string) => ({ bodyText: 'New words', signOff: 'Love', previewHtml: PAGE, pages: 1, drawnIn: null, replacing: seeded(draftId) });

      const sent = await seedDraft(userId, 'pdf-1');
      await mailSend.createMailOrderFromDraft({ draftId: sent, userId, mailType: 'letter' });
      await expect(drafts.setDraftWords(sent, userId, change(sent))).resolves.toBe('sent');

      const expired = await seedDraft(userId, 'pdf-1');
      await pool.query("UPDATE letter_drafts SET expires_at = NOW() - INTERVAL '1 minute' WHERE draft_id = $1", [expired]);
      await expect(drafts.setDraftWords(expired, userId, change(expired))).resolves.toBe('expired');

      const theirs = await seedDraft(other, 'pdf-1');
      await expect(drafts.setDraftWords(theirs, userId, change(theirs))).resolves.toBe('not_found');

      for (const draftId of [sent, expired, theirs]) {
        expect((await words(draftId)).body_text, draftId).toBe(`Hello ${draftId}`);
      }
    }, 60_000);
  });

  describe('postcard fronts (#594, migration 048)', () => {
    const BORDER = { layout: 'border', caption: 'Cape Cod, August 2026' } as const;
    const GREETINGS = { layout: 'greetings', place: 'Asheville' } as const;

    /** A pending postcard draft, as a preview stores one; each message differs, for the duplicate check (#412). */
    async function seedPostcard(userId: string, rendererVersion: string | null, front: unknown = null): Promise<string> {
      const draftId = randomUUID();
      await pool.query(
        `INSERT INTO letter_drafts (
           draft_id, user_id, sender, recipient, body_text, required_credits, expires_at, status,
           mail_type, front_image_data, postcard_size, renderer_version, postcard_front
         ) VALUES ($1, $2, $3, $4, $5, 2, NOW() + INTERVAL '1 day', 'pending',
                   'postcard', 'data:image/png;base64,AAAA', '6x9', $6, $7::jsonb)`,
        [draftId, userId, JSON.stringify(SENDER), JSON.stringify(RECIPIENT), `Wish you were here ${draftId}`, rendererVersion,
          front === null ? null : JSON.stringify(front)]
      );
      return draftId;
    }

    it('admits a front with pdf-3 only, pdf-3 only with a front, a front only on a postcard, and only the layouts it knows', async () => {
      const userId = await seedUser();
      for (const front of [BORDER, GREETINGS, { layout: 'border' }]) {
        const drawn = await seedPostcard(userId, 'pdf-3', front);
        const row = await pool.query('SELECT postcard_front, renderer_version FROM letter_drafts WHERE draft_id = $1', [drawn]);
        expect(row.rows[0]).toEqual({ postcard_front: front, renderer_version: 'pdf-3' });
      }
      // Full bleed, as every postcard before: no front, and pdf-1 or the legacy HTML.
      for (const version of ['pdf-1', null]) {
        const plain = await seedPostcard(userId, version);
        expect((await pool.query('SELECT postcard_front FROM letter_drafts WHERE draft_id = $1', [plain])).rows[0].postcard_front).toBeNull();
      }

      // A front drawn as pdf-1, and pdf-3 without a front.
      await expect(seedPostcard(userId, 'pdf-1', BORDER))
        .rejects.toMatchObject({ code: '23514', constraint: 'letter_drafts_postcard_front_drawn_by_pdf_3' });
      await expect(seedPostcard(userId, 'pdf-3'))
        .rejects.toMatchObject({ code: '23514', constraint: 'letter_drafts_postcard_front_drawn_by_pdf_3' });
      // A layout no build draws, or JSON that names none.
      for (const stored of ['{"layout": "collage"}', '{"layout": "full_bleed"}', '{}', '{"layout": null}', '"border"', '[]']) {
        await expect(seedPostcard(userId, 'pdf-3', JSON.parse(stored)), stored)
          .rejects.toMatchObject({ code: '23514', constraint: 'letter_drafts_postcard_front_layout_known' });
      }
      // A letter never has one, even drawn as pdf-3.
      const letterDraft = await seedDraft(userId, 'pdf-1');
      await expect(pool.query(
        "UPDATE letter_drafts SET renderer_version = 'pdf-3', postcard_front = $2::jsonb WHERE draft_id = $1",
        [letterDraft, JSON.stringify(BORDER)]
      )).rejects.toMatchObject({ code: '23514', constraint: 'letter_drafts_postcard_front_layout_known' });
      // pdf-3 is a version the check admits, and pdf-2 still is.
      await expect(seedDraft(userId, 'pdf-4')).rejects.toMatchObject({ code: '23514', constraint: 'letter_drafts_renderer_version_known' });
    }, 60_000);

    it('copies the front into the letter the send creates, and none for full bleed', async () => {
      const userId = await seedUser();
      const bordered = await seedPostcard(userId, 'pdf-3', BORDER);
      const plain = await seedPostcard(userId, 'pdf-1');

      const sent = await mailSend.createMailOrderFromDraft({ draftId: bordered, userId, mailType: 'postcard' });
      const full = await mailSend.createMailOrderFromDraft({ draftId: plain, userId, mailType: 'postcard' });

      const stored = await pool.query<{ letter_id: string; content: Record<string, unknown> }>(
        'SELECT letter_id, content FROM letters WHERE letter_id = ANY($1)',
        [[sent.letter.letter_id, full.letter.letter_id]]
      );
      const byId = new Map(stored.rows.map(row => [row.letter_id, row.content]));
      expect(byId.get(sent.letter.letter_id)).toMatchObject({ rendererVersion: 'pdf-3', postcardFront: BORDER });
      expect(byId.get(full.letter.letter_id)).toMatchObject({ rendererVersion: 'pdf-1' });
      expect(byId.get(full.letter.letter_id)).not.toHaveProperty('postcardFront');
    }, 60_000);

    it('stores the front a preview creates its draft with, beside pdf-3, for the send to copy (#594 PR 4b-2)', async () => {
      const userId = await seedUser();
      const postcard = () => ({
        userId,
        sender: SENDER,
        recipient: RECIPIENT,
        message: `Wish you were here ${randomUUID()}`,
        frontImageData: 'data:image/png;base64,AAAA',
        frontImageUrl: 'https://files.example/beach.jpg'
      });
      const greeted = await drafts.createPostcardDraft({ ...postcard(), rendererVersion: 'pdf-3', postcardFront: GREETINGS });
      const plain = await drafts.createPostcardDraft({ ...postcard(), rendererVersion: 'pdf-1', postcardFront: null });
      const stored = await pool.query<{ draft_id: string; postcard_front: unknown; renderer_version: string }>(
        'SELECT draft_id, postcard_front, renderer_version FROM letter_drafts WHERE draft_id = ANY($1)',
        [[greeted.draftId, plain.draftId]]
      );
      const byId = new Map(stored.rows.map(row => [row.draft_id, row]));
      expect(byId.get(greeted.draftId)).toMatchObject({ postcard_front: GREETINGS, renderer_version: 'pdf-3' });
      expect(byId.get(plain.draftId)).toMatchObject({ postcard_front: null, renderer_version: 'pdf-1' });

      // The pair is the preview's to keep: a front given with another version is refused by 048, not stored.
      await expect(drafts.createPostcardDraft({ ...postcard(), rendererVersion: 'pdf-1', postcardFront: BORDER }))
        .rejects.toMatchObject({ code: '23514', constraint: 'letter_drafts_postcard_front_drawn_by_pdf_3' });

      const sent = await mailSend.createMailOrderFromDraft({ draftId: greeted.draftId, userId, mailType: 'postcard' });
      const content = await pool.query('SELECT content FROM letters WHERE letter_id = $1', [sent.letter.letter_id]);
      expect(content.rows[0].content).toMatchObject({ rendererVersion: 'pdf-3', postcardFront: GREETINGS });
    }, 60_000);
    it('restyles a pending postcard in place: its size, front, version and picture together (#594 PR 5a)', async () => {
      const userId = await seedUser();
      const draftId = await seedPostcard(userId, 'pdf-1');
      const BEFORE = '<!DOCTYPE html><html><body data-renderer="pdf-1"><svg>before</svg><svg></svg></body></html>';
      const PAGE = '<!DOCTYPE html><html><body data-renderer="pdf-1"><svg>after</svg><svg></svg></body></html>';
      const WIDER = 'data:image/jpeg;base64,BBBB';
      await pool.query('UPDATE letter_drafts SET preview_html = $2 WHERE draft_id = $1', [draftId, BEFORE]);
      const row = async () =>
        (await pool.query(
          'SELECT postcard_size, postcard_front, renderer_version, preview_html, front_image_data FROM letter_drafts WHERE draft_id = $1',
          [draftId]
        )).rows[0];

      // A new size and a border: the picture cropped again with them, and pdf-3, which 048 pairs with a front.
      await expect(drafts.setDraftPostcardStyle(draftId, userId, {
        size: '6x11', front: BORDER, previewHtml: PAGE, frontImageData: WIDER, drawnFrom: { previewHtml: BEFORE }
      })).resolves.toBeNull();
      expect(await row()).toEqual({ postcard_size: '6x11', postcard_front: BORDER, renderer_version: 'pdf-3', preview_html: PAGE, front_image_data: WIDER });

      // Drawn from a preview it no longer has: refused, nothing written.
      await expect(drafts.setDraftPostcardStyle(draftId, userId, {
        size: '6x9', front: null, previewHtml: BEFORE, drawnFrom: { previewHtml: BEFORE }
      })).resolves.toBe('changed');
      expect((await row()).postcard_size).toBe('6x11');

      // Back to full bleed at its size: no front, pdf-1, and the picture kept.
      await expect(drafts.setDraftPostcardStyle(draftId, userId, {
        size: '6x11', front: null, previewHtml: BEFORE, drawnFrom: { previewHtml: PAGE }
      })).resolves.toBeNull();
      expect(await row()).toEqual({ postcard_size: '6x11', postcard_front: null, renderer_version: 'pdf-1', preview_html: BEFORE, front_image_data: WIDER });
    }, 60_000);

    it('keeps a gift postcard a 6x9, and leaves a sent, Pay & Send or someone else\'s postcard as it was (#594 PR 5a)', async () => {
      const userId = await seedUser();
      const other = await seedUser();
      const change = { size: '6x4' as const, front: GREETINGS, previewHtml: 'after', drawnFrom: { previewHtml: null } };

      const gift = await seedPostcard(userId, 'pdf-1');
      await pool.query('UPDATE letter_drafts SET is_gift_send = true WHERE draft_id = $1', [gift]);
      await expect(drafts.setDraftPostcardStyle(gift, userId, change)).resolves.toBe('changed');
      // At its own size it takes a front.
      await expect(drafts.setDraftPostcardStyle(gift, userId, { ...change, size: '6x9' })).resolves.toBeNull();

      const sent = await seedPostcard(userId, 'pdf-1');
      await mailSend.createMailOrderFromDraft({ draftId: sent, userId, mailType: 'postcard' });
      await expect(drafts.setDraftPostcardStyle(sent, userId, change)).resolves.toBe('sent');

      const paying = await seedPostcard(userId, 'pdf-1');
      const orderId = `order-${randomUUID()}`;
      await pool.query(
        `INSERT INTO orders (order_id, user_id, credits, amount_cents, currency, status, order_type, product_code,
           idempotency_key, draft_id, checkout_expires_at)
         VALUES ($1, $2, NULL, 399, 'USD', 'checkout_pending', 'jit_mail', 'jit-postcard', $3, $4, NOW() + INTERVAL '20 minutes')`,
        [orderId, userId, `idem_${orderId}`, paying]
      );
      await expect(drafts.setDraftPostcardStyle(paying, userId, change)).resolves.toBe('checkout_pending');

      const theirs = await seedPostcard(other, 'pdf-1');
      await expect(drafts.setDraftPostcardStyle(theirs, userId, change)).resolves.toBe('not_found');

      for (const draftId of [gift, sent, paying, theirs]) {
        const kept = (await pool.query('SELECT postcard_size FROM letter_drafts WHERE draft_id = $1', [draftId])).rows[0];
        expect(kept.postcard_size, draftId).toBe('6x9');
      }
    }, 60_000);
  });
});
