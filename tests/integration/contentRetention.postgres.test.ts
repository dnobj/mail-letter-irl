import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import { repositoryMigrations, validateDisposableDatabaseUrl } from './support/disposableDatabase.js';

/**
 * Issue #153 - enforce the published retention schedule.
 *
 * The decision record (2026-08-26) approved:
 *   sent letter content        -> anonymized 90 days after sending
 *   drafts attached to an order -> the same schedule
 *   unsent, unpaid drafts       -> deleted at 7 days (cleanupOldDrafts, unchanged)
 *
 * These run against real PostgreSQL because every property that matters here
 * is a property of the STATEMENT, not of the TypeScript around it: the
 * boundary comparison, the two NOT EXISTS holds, the idempotency predicate,
 * and the fact that anonymization leaves the financial audit trail standing.
 * A mocked query() proves none of them - it would happily accept a predicate
 * that matches every row in the table.
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

  async function seedUser(): Promise<string> {
    const userId = `user_${randomUUID()}`;
    await pool.query(
      `INSERT INTO users (user_id, email, credits) VALUES ($1, $2, 0)`,
      [userId, `${userId}@test.invalid`]
    );
    return userId;
  }

  /** A sent letter carrying real content, dated `sentDaysAgo` days back. */
  async function seedSentLetter(sentDaysAgo: number): Promise<{ userId: string; letterId: string }> {
    const userId = await seedUser();
    const letterId = `letter_${randomUUID()}`;
    await pool.query(
      `INSERT INTO letters (
         letter_id, user_id, content, recipient, credits_cost, status,
         preview_html, sent_at
       ) VALUES ($1, $2, $3::jsonb, $4::jsonb, 2, 'sent', $5,
                 NOW() - make_interval(days => $6::int))`,
      [
        letterId,
        userId,
        JSON.stringify({ bodyText: SECRET_BODY, signOff: 'Yours, Alex' }),
        JSON.stringify({ name: 'Sam', addressLine1: SECRET_STREET, city: 'London' }),
        `<p>${SECRET_BODY}</p>`,
        sentDaysAgo
      ]
    );
    return { userId, letterId };
  }

  async function readLetter(letterId: string) {
    const { rows } = await pool.query(
      `SELECT content, recipient, preview_html, status, credits_cost, sent_at
         FROM letters WHERE letter_id = $1`,
      [letterId]
    );
    return rows[0];
  }

  it('anonymizes content once the retention window has passed', async () => {
    const { letterId } = await seedSentLetter(91);

    const redacted = await retention.purgeExpiredLetterContent();

    expect(redacted).toBeGreaterThanOrEqual(1);
    const row = await readLetter(letterId);
    expect(row.content).toEqual({ redacted: true });
    expect(row.recipient).toEqual({ redacted: true });
    expect(row.preview_html).toBeNull();
    // Nothing recognisable survives anywhere in the row.
    expect(JSON.stringify(row)).not.toContain(SECRET_BODY);
    expect(JSON.stringify(row)).not.toContain(SECRET_STREET);
  });

  it('leaves a letter INSIDE the window untouched', async () => {
    // The boundary is the whole guarantee. A predicate that redacted this row
    // would be destroying content the policy promises to keep for disputes.
    const { letterId } = await seedSentLetter(89);

    await retention.purgeExpiredLetterContent();

    const row = await readLetter(letterId);
    expect(row.content.bodyText).toBe(SECRET_BODY);
    expect(row.recipient.addressLine1).toBe(SECRET_STREET);
  });

  it('preserves the non-content columns it is not allowed to touch', async () => {
    const { letterId } = await seedSentLetter(120);

    await retention.purgeExpiredLetterContent();

    const row = await readLetter(letterId);
    // Anonymize, never delete: the fulfilment and financial trail must stand.
    expect(row.status).toBe('sent');
    expect(row.credits_cost).toBe(2);
    expect(row.sent_at).not.toBeNull();
  });

  it('is idempotent - a second sweep re-redacts nothing', async () => {
    await seedSentLetter(200);

    const first = await retention.purgeExpiredLetterContent();
    const second = await retention.purgeExpiredLetterContent();

    expect(first).toBeGreaterThanOrEqual(1);
    // The constant sentinel is what makes this exact: a redaction stamp
    // carrying a timestamp would re-match every previously redacted row.
    expect(second).toBe(0);
  });

  it('HOLDS a letter that still has work in flight', async () => {
    // letterJobService builds its provider params from letters.content and
    // letters.recipient. Redacting under a live job would hand the provider
    // an empty letter and an empty address.
    const { letterId } = await seedSentLetter(365);
    await pool.query(
      `INSERT INTO letter_jobs (job_id, letter_id, status, idempotency_key)
       VALUES ($1, $2, 'pending', $3)`,
      [`job_${randomUUID()}`, letterId, `idem_${letterId}`]
    );

    await retention.purgeExpiredLetterContent();

    const row = await readLetter(letterId);
    expect(row.content.bodyText).toBe(SECRET_BODY);
  });

  it('HOLDS a letter whose order is disputed, because the content is the evidence', async () => {
    const { userId, letterId } = await seedSentLetter(365);
    await pool.query(
      `INSERT INTO orders (
         order_id, user_id, credits, amount_cents, currency, status,
         order_type, product_code, idempotency_key, letter_id
       ) VALUES ($1, $2, 2, 499, 'USD', 'disputed', 'jit_mail', 'jit-letter', $3, $4)`,
      [`order_${randomUUID()}`, userId, `idem_${letterId}`, letterId]
    );

    await retention.purgeExpiredLetterContent();

    const row = await readLetter(letterId);
    expect(row.content.bodyText).toBe(SECRET_BODY);
  });

  it('releases the hold once the dispute is resolved', async () => {
    // #153 requires holds to be scoped and auditable, not a switch that
    // silently disables cleanup forever.
    const { userId, letterId } = await seedSentLetter(365);
    const orderId = `order_${randomUUID()}`;
    await pool.query(
      `INSERT INTO orders (
         order_id, user_id, credits, amount_cents, currency, status,
         order_type, product_code, idempotency_key, letter_id
       ) VALUES ($1, $2, 2, 499, 'USD', 'refund_pending', 'jit_mail', 'jit-letter', $3, $4)`,
      [orderId, userId, `idem_${letterId}`, letterId]
    );
    await retention.purgeExpiredLetterContent();
    expect((await readLetter(letterId)).content.bodyText).toBe(SECRET_BODY);

    await pool.query(`UPDATE orders SET status = 'fulfilled' WHERE order_id = $1`, [orderId]);
    await retention.purgeExpiredLetterContent();

    expect((await readLetter(letterId)).content).toEqual({ redacted: true });
  });

  it('respects the batch limit so one sweep cannot lock the table unbounded', async () => {
    await seedSentLetter(400);
    await seedSentLetter(400);
    await seedSentLetter(400);

    const first = await retention.purgeExpiredLetterContent(90, 2);

    expect(first).toBe(2);
  });

  it('anonymizes a PAID draft, the rows cleanupOldDrafts can never reach', async () => {
    // cleanupOldDrafts excludes any draft with an order row - correct for
    // deletion, but it left paid drafts holding a full body and address
    // forever. This is that gap.
    const userId = await seedUser();
    const draftId = randomUUID();
    await pool.query(
      `INSERT INTO letter_drafts (
         draft_id, user_id, sender, recipient, body_text, sign_off,
         required_credits, preview_html, status, expires_at, consumed_at, updated_at
       ) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, 'Yours, Alex', 2, $6,
                 'consumed', NOW() - INTERVAL '120 days',
                 NOW() - INTERVAL '120 days', NOW() - INTERVAL '120 days')`,
      [
        draftId,
        userId,
        JSON.stringify({ name: 'Alex', addressLine1: SECRET_STREET }),
        JSON.stringify({ name: 'Sam', addressLine1: SECRET_STREET }),
        SECRET_BODY,
        `<p>${SECRET_BODY}</p>`
      ]
    );
    await pool.query(
      `INSERT INTO orders (
         order_id, user_id, credits, amount_cents, currency, status,
         order_type, product_code, idempotency_key, draft_id
       ) VALUES ($1, $2, 2, 499, 'USD', 'fulfilled', 'jit_mail', 'jit-letter', $3, $4)`,
      [`order_${randomUUID()}`, userId, `idem_${draftId}`, draftId]
    );

    const redacted = await retention.purgePaidDraftContent();

    expect(redacted).toBeGreaterThanOrEqual(1);
    const { rows } = await pool.query(
      `SELECT sender, recipient, body_text, sign_off, preview_html, required_credits
         FROM letter_drafts WHERE draft_id = $1`,
      [draftId]
    );
    expect(rows[0].body_text).toBe('');
    expect(rows[0].sender).toEqual({ redacted: true });
    expect(rows[0].recipient).toEqual({ redacted: true });
    expect(rows[0].preview_html).toBeNull();
    expect(JSON.stringify(rows[0])).not.toContain(SECRET_STREET);
    // Non-content, still load-bearing for refunds, and CHECK (> 0).
    expect(rows[0].required_credits).toBe(2);
  });

  it('leaves an UNPAID draft to cleanupOldDrafts rather than redacting it', async () => {
    const userId = await seedUser();
    const draftId = randomUUID();
    await pool.query(
      `INSERT INTO letter_drafts (
         draft_id, user_id, sender, recipient, body_text, sign_off,
         required_credits, status, expires_at, updated_at
       ) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, 'Yours, Alex', 2,
                 'expired', NOW() - INTERVAL '200 days', NOW() - INTERVAL '200 days')`,
      [
        draftId,
        userId,
        JSON.stringify({ name: 'Alex' }),
        JSON.stringify({ name: 'Sam' }),
        SECRET_BODY
      ]
    );

    await retention.purgePaidDraftContent();

    const { rows } = await pool.query(
      `SELECT body_text FROM letter_drafts WHERE draft_id = $1`,
      [draftId]
    );
    // The 7-day deletion owns this row; redacting it here would leave an
    // undeletable husk behind instead.
    expect(rows[0].body_text).toBe(SECRET_BODY);
  });

  it('reports counts and a more-waiting flag, and nothing else', async () => {
    const summary = await retention.runRetentionSweep(90, 1);

    expect(Object.keys(summary).sort()).toEqual([
      'draftsRedacted',
      'lettersRedacted',
      'moreWaiting'
    ]);
    expect(JSON.stringify(summary)).not.toContain(SECRET_BODY);
    expect(JSON.stringify(summary)).not.toContain(SECRET_STREET);
  });
});
