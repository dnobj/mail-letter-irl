import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import { repositoryMigrations, validateDisposableDatabaseUrl } from './support/disposableDatabase.js';

/**
 * A letter's own copy of the person's signature (migration 051, #608).
 *
 *   a draft holds its signature with renderer pdf-4, and pdf-4 only with one;
 *   only a letter holds one; pdf-4 admits a theme, so a signed letter keeps
 *   its stationery
 *   createDraft stores the copy, and the send copies it into letters.content
 *   a restyle keeps a signed draft on pdf-4, whatever theme it is given
 *   retention empties the copy rather than nulling it, so the pair holds, and
 *   a restore puts it back; an unsigned draft's comes back NULL
 *   a preview's explicit choice is remembered on the saved signature
 *
 * Against real PostgreSQL because the CHECKs and the redaction's CASE are the
 * change's whole substance, and a mocked query() honours none of them.
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

const RECIPIENT = { name: 'Sam Rivera', addressLine1: '350 5th Ave', city: 'New York', state: 'NY', postalCode: '10118', country: 'US' };
const SENDER = { name: 'Test Sender', addressLine1: '1 Main St', city: 'Springfield', state: 'IL', postalCode: '62701', country: 'US' };
const SIGNATURE = `data:image/png;base64,${Buffer.from('89504e470d0a1a0a0000000d49484452000004b00000012c', 'hex').toString('base64')}`;
const BOTANICAL = { theme: 'botanical', dateLine: 'October 2, 2026' };
const PAGE = '<!DOCTYPE html><html><body data-renderer="pdf-4"><svg></svg></body></html>';

describePostgres('a letter\'s signature (migration 051, #608)', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let schema: string;
  let mailSend: typeof import('../../src/services/mailSendService.js');
  let drafts: typeof import('../../src/services/draftService.js');
  let retention: typeof import('../../src/services/retentionService.js');
  let signatures: typeof import('../../src/services/signatureService.js');
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
    schema = schemaName('lirl_signature_drafts');
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const scoped = databaseUrlForSchema(baseUrl, schema);
    await migrate({ connectionString: scoped, migrationsDirectory: repositoryMigrations });
    pool = new Pool({ connectionString: scoped, max: 4 });

    process.env.DATABASE_URL = scoped;
    mailSend = await import('../../src/services/mailSendService.js');
    drafts = await import('../../src/services/draftService.js');
    retention = await import('../../src/services/retentionService.js');
    signatures = await import('../../src/services/signatureService.js');
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
    const userId = `auth0|signature-${randomUUID()}`;
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

  /** A preview's draft through createDraft; each body differs so the duplicate check (#412) stays out of it. */
  async function previewed(userId: string, options: { signed?: boolean; stationery?: typeof BOTANICAL } = {}): Promise<string> {
    const { draftId } = await drafts.createDraft({
      userId,
      sender: SENDER,
      recipient: RECIPIENT,
      bodyText: `Hello ${randomUUID()}`,
      signOff: 'Warmly,\nTest',
      requiredCredits: 2,
      previewHtml: PAGE,
      layoutType: 'text_only',
      rendererVersion: options.signed ? 'pdf-4' : options.stationery ? 'pdf-2' : 'pdf-1',
      stationery: options.stationery as never,
      signatureImage: options.signed ? SIGNATURE : undefined
    });
    return draftId;
  }

  const read = async (draftId: string) =>
    (await pool.query<{ signature_image: string | null; renderer_version: string | null; stationery: unknown }>(
      'SELECT signature_image, renderer_version, stationery FROM letter_drafts WHERE draft_id = $1',
      [draftId]
    )).rows[0];

  it('holds a signature with pdf-4, and pdf-4 only with one', async () => {
    const userId = await seedUser();
    const signed = await previewed(userId, { signed: true });
    expect(await read(signed)).toEqual({ signature_image: SIGNATURE, renderer_version: 'pdf-4', stationery: null });

    const plain = await previewed(userId);
    expect(await read(plain)).toMatchObject({ signature_image: null, renderer_version: 'pdf-1' });
    // A signature drawn by another renderer, pdf-4 without one, and a legacy draft with one.
    await expect(pool.query('UPDATE letter_drafts SET signature_image = $2 WHERE draft_id = $1', [plain, SIGNATURE]))
      .rejects.toMatchObject({ code: '23514', constraint: 'letter_drafts_signature_drawn_by_pdf_4' });
    await expect(pool.query("UPDATE letter_drafts SET renderer_version = 'pdf-4' WHERE draft_id = $1", [plain]))
      .rejects.toMatchObject({ code: '23514', constraint: 'letter_drafts_signature_drawn_by_pdf_4' });
    await expect(pool.query('UPDATE letter_drafts SET renderer_version = NULL WHERE draft_id = $1', [signed]))
      .rejects.toMatchObject({ code: '23514', constraint: 'letter_drafts_signature_drawn_by_pdf_4' });
    // An unknown version is still refused by its own check.
    await expect(pool.query("UPDATE letter_drafts SET renderer_version = 'pdf-5' WHERE draft_id = $1", [plain]))
      .rejects.toMatchObject({ code: '23514', constraint: 'letter_drafts_renderer_version_known' });
  }, 60_000);

  it('admits a theme beside a signature, keeps pdf-2 to a theme, and holds a signature to letters only', async () => {
    const userId = await seedUser();
    const signed = await previewed(userId, { signed: true });
    await pool.query('UPDATE letter_drafts SET stationery = $2::jsonb WHERE draft_id = $1', [signed, JSON.stringify(BOTANICAL)]);
    expect(await read(signed)).toMatchObject({ renderer_version: 'pdf-4', stationery: BOTANICAL });

    // pdf-2 still needs a theme, and a theme still needs pdf-2 or pdf-4: never no version (#612 review round 1).
    const themed = await previewed(userId, { stationery: BOTANICAL });
    expect(await read(themed)).toMatchObject({ renderer_version: 'pdf-2', stationery: BOTANICAL });
    await expect(pool.query('UPDATE letter_drafts SET renderer_version = NULL WHERE draft_id = $1', [themed]))
      .rejects.toMatchObject({ code: '23514', constraint: 'letter_drafts_stationery_drawn_by_pdf_2' });
    const plain = await previewed(userId);
    await expect(pool.query("UPDATE letter_drafts SET renderer_version = 'pdf-2' WHERE draft_id = $1", [plain]))
      .rejects.toMatchObject({ code: '23514', constraint: 'letter_drafts_stationery_drawn_by_pdf_2' });
    await expect(pool.query('UPDATE letter_drafts SET stationery = $2::jsonb WHERE draft_id = $1', [plain, JSON.stringify(BOTANICAL)]))
      .rejects.toMatchObject({ code: '23514', constraint: 'letter_drafts_stationery_drawn_by_pdf_2' });

    await expect(pool.query("UPDATE letter_drafts SET mail_type = 'postcard' WHERE draft_id = $1", [signed]))
      .rejects.toMatchObject({ code: '23514' });
    // A postcard every other check admits (rendererVersion.postgres.test.ts), then the same with a signature.
    const postcard = (signature: string | null, rendererVersion: string) => pool.query(
      `INSERT INTO letter_drafts (
         draft_id, user_id, sender, recipient, body_text, required_credits, expires_at, status,
         mail_type, front_image_data, postcard_size, renderer_version, signature_image
       ) VALUES ($1, $2, $3, $4, $5, 2, NOW() + INTERVAL '1 day', 'pending',
                 'postcard', 'data:image/png;base64,AAAA', '6x9', $6, $7)`,
      [randomUUID(), userId, JSON.stringify(SENDER), JSON.stringify(RECIPIENT), `Wish you were here ${randomUUID()}`, rendererVersion, signature]
    );
    await expect(postcard(null, 'pdf-1')).resolves.toMatchObject({ rowCount: 1 });
    await expect(postcard(SIGNATURE, 'pdf-4'))
      .rejects.toMatchObject({ code: '23514', constraint: 'letter_drafts_signature_letters_only' });
  }, 60_000);

  it('copies the signature into the letter the send creates, and none for an unsigned one', async () => {
    const userId = await seedUser();
    const signedDraft = await previewed(userId, { signed: true });
    const plainDraft = await previewed(userId);

    const signed = await mailSend.createMailOrderFromDraft({ draftId: signedDraft, userId, mailType: 'letter' });
    const plain = await mailSend.createMailOrderFromDraft({ draftId: plainDraft, userId, mailType: 'letter' });

    const stored = await pool.query<{ letter_id: string; version: string; image: string | null; has_key: boolean }>(
      `SELECT letter_id, content->>'rendererVersion' AS version, content->>'signatureImage' AS image,
              content ? 'signatureImage' AS has_key
         FROM letters WHERE letter_id = ANY($1)`,
      [[signed.letter.letter_id, plain.letter.letter_id]]
    );
    const byId = new Map(stored.rows.map(row => [row.letter_id, row]));
    expect(byId.get(signed.letter.letter_id)).toMatchObject({ version: 'pdf-4', image: SIGNATURE, has_key: true });
    expect(byId.get(plain.letter.letter_id)).toMatchObject({ version: 'pdf-1', has_key: false });
  }, 60_000);

  it('keeps a signed draft on pdf-4 through a restyle, in a theme and back to Classic', async () => {
    const userId = await seedUser();
    const draftId = await previewed(userId, { signed: true });
    const words = (await pool.query<{ body_text: string; sign_off: string }>(
      'SELECT body_text, sign_off FROM letter_drafts WHERE draft_id = $1', [draftId]
    )).rows[0];
    const drawnFrom = { bodyText: words.body_text, signOff: words.sign_off };

    await expect(drafts.setDraftStationery(draftId, userId, { stationery: { ...BOTANICAL, source: 'asked' } as never, previewHtml: PAGE, drawnFrom }))
      .resolves.toBeNull();
    expect(await read(draftId)).toEqual({ signature_image: SIGNATURE, renderer_version: 'pdf-4', stationery: BOTANICAL });

    await expect(drafts.setDraftStationery(draftId, userId, { stationery: { theme: 'classic', source: 'asked' } as never, previewHtml: PAGE, drawnFrom }))
      .resolves.toBeNull();
    expect(await read(draftId)).toEqual({ signature_image: SIGNATURE, renderer_version: 'pdf-4', stationery: null });

    // An unsigned draft still takes the version that goes with its theme.
    const plain = await previewed(userId);
    const plainWords = (await pool.query<{ body_text: string; sign_off: string }>(
      'SELECT body_text, sign_off FROM letter_drafts WHERE draft_id = $1', [plain]
    )).rows[0];
    await drafts.setDraftStationery(plain, userId, {
      stationery: { ...BOTANICAL, source: 'asked' } as never,
      previewHtml: PAGE,
      drawnFrom: { bodyText: plainWords.body_text, signOff: plainWords.sign_off }
    });
    expect(await read(plain)).toMatchObject({ signature_image: null, renderer_version: 'pdf-2' });
  }, 60_000);

  it("empties a swept draft's signature, holding the pair, and a restore puts it back; an unsigned one's comes back NULL", async () => {
    const userId = await seedUser();
    const signed = await previewed(userId, { signed: true });
    const plain = await previewed(userId);
    for (const draftId of [signed, plain]) {
      // Abandoned at checkout eight days ago: due at 7 (contentRetention.postgres.test.ts).
      await pool.query("UPDATE letter_drafts SET created_at = NOW() - INTERVAL '8 days' WHERE draft_id = $1", [draftId]);
      const orderId = `order_${randomUUID()}`;
      await pool.query(
        `INSERT INTO orders (
           order_id, user_id, credits, amount_cents, currency, status,
           order_type, product_code, idempotency_key, draft_id
         ) VALUES ($1, $2, NULL, 499, 'USD', 'cancelled', 'jit_mail', 'jit-letter', $3, $4)`,
        [orderId, userId, `idem_${orderId}`, draftId]
      );
    }

    expect(await retention.purgeAbandonedDraftContent()).toBe(2);
    expect(await read(signed)).toMatchObject({ signature_image: '', renderer_version: 'pdf-4' });
    expect(await read(plain)).toMatchObject({ signature_image: null, renderer_version: 'pdf-1' });
    const saved = await pool.query<{ image: string | null }>(
      "SELECT content->>'signature_image' AS image FROM redacted_content_quarantine WHERE source_table = 'letter_drafts' AND source_id = $1",
      [signed]
    );
    expect(saved.rows[0].image).toBe(SIGNATURE);

    expect(await retention.restoreQuarantinedContent('letter_drafts', signed)).toBe(true);
    expect(await retention.restoreQuarantinedContent('letter_drafts', plain)).toBe(true);
    expect(await read(signed)).toMatchObject({ signature_image: SIGNATURE, renderer_version: 'pdf-4' });
    expect(await read(plain)).toMatchObject({ signature_image: null, renderer_version: 'pdf-1' });
  }, 60_000);

  it('signs and unsigns a draft in place, with the version each pair needs, and remembers the choice (#608 part 4)', async () => {
    const userId = await seedUser();
    await signatures.saveSignature(userId, { png: Buffer.from('89504e470d0a1a0a00000000', 'hex'), width: 600, height: 150 });
    const choice = async () =>
      (await pool.query<{ use_by_default: boolean }>('SELECT use_by_default FROM user_signatures WHERE user_id = $1', [userId])).rows[0]
        .use_by_default;
    /** What a page is drawn from, as the tool reads it before the lock. */
    const drawnFrom = async (draftId: string) => {
      const row = (await pool.query<{ body_text: string; sign_off: string | null; stationery: unknown; signature_image: string | null }>(
        'SELECT body_text, sign_off, stationery, signature_image FROM letter_drafts WHERE draft_id = $1',
        [draftId]
      )).rows[0];
      return { words: { bodyText: row.body_text, signOff: row.sign_off }, stationery: row.stationery, signature: row.signature_image };
    };
    const set = async (draftId: string, signatureImage: string | null) =>
      drafts.setDraftSignature(draftId, userId, { signatureImage, previewHtml: PAGE, pages: 1, drawnFrom: await drawnFrom(draftId) });

    // A Classic letter: pdf-4 signed, pdf-1 again unsigned.
    const plain = await previewed(userId);
    await expect(set(plain, SIGNATURE)).resolves.toBeNull();
    expect(await read(plain)).toEqual({ signature_image: SIGNATURE, renderer_version: 'pdf-4', stationery: null });
    expect(await choice()).toBe(true);
    // What get_draft_status reads of it: signed, never the picture.
    expect((await drafts.getDraftState(plain))?.signed).toBe(true);
    await expect(set(plain, null)).resolves.toBeNull();
    expect(await read(plain)).toEqual({ signature_image: null, renderer_version: 'pdf-1', stationery: null });
    expect(await choice()).toBe(false);
    expect((await drafts.getDraftState(plain))?.signed).toBe(false);

    // A themed letter keeps its theme: pdf-4 signed, pdf-2 again unsigned.
    const themed = await previewed(userId, { stationery: BOTANICAL });
    await expect(set(themed, SIGNATURE)).resolves.toBeNull();
    expect(await read(themed)).toEqual({ signature_image: SIGNATURE, renderer_version: 'pdf-4', stationery: BOTANICAL });
    await expect(set(themed, null)).resolves.toBeNull();
    expect(await read(themed)).toEqual({ signature_image: null, renderer_version: 'pdf-2', stationery: BOTANICAL });

    // Drawn from a signature it no longer has: refused, unchanged.
    const stale = { ...(await drawnFrom(themed)), signature: SIGNATURE };
    await expect(
      drafts.setDraftSignature(themed, userId, { signatureImage: null, previewHtml: PAGE, pages: 1, drawnFrom: stale })
    ).resolves.toBe('changed');
    expect(await read(themed)).toEqual({ signature_image: null, renderer_version: 'pdf-2', stationery: BOTANICAL });

    // Another account's draft is not found.
    const stranger = await seedUser();
    await expect(
      drafts.setDraftSignature(plain, stranger, { signatureImage: null, previewHtml: PAGE, pages: 1, drawnFrom: await drawnFrom(plain) })
    ).resolves.toBe('not_found');
  }, 60_000);

  it("remembers a preview's explicit choice on the saved signature, and does nothing without one", async () => {
    const userId = await seedUser();
    await signatures.saveSignature(userId, { png: Buffer.from('89504e470d0a1a0a00000000', 'hex'), width: 600, height: 150 });
    const choice = async () =>
      (await pool.query<{ use_by_default: boolean }>('SELECT use_by_default FROM user_signatures WHERE user_id = $1', [userId])).rows[0]
        .use_by_default;
    expect(await choice()).toBe(true);
    await signatures.rememberSignatureChoice(userId, false);
    expect(await choice()).toBe(false);
    await signatures.rememberSignatureChoice(userId, true);
    expect(await choice()).toBe(true);

    const unsaved = await seedUser();
    await expect(signatures.rememberSignatureChoice(unsaved, false)).resolves.toBeUndefined();
    expect((await pool.query('SELECT 1 FROM user_signatures WHERE user_id = $1', [unsaved])).rowCount).toBe(0);
  }, 60_000);
});
