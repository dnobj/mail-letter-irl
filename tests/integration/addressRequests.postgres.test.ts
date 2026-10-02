import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import { repositoryMigrations, validateDisposableDatabaseUrl } from './support/disposableDatabase.js';

/**
 * Issue #604 - address request links, against real PostgreSQL (migration 049).
 *
 * The properties that matter are properties of the statements and the table:
 * a link answered once when two answers race, the caps held under the
 * account lock, expiry read from the clock, the token kept only as its hash,
 * and the CHECKs that tie an address to an answer. A mocked query() accepts
 * an UPDATE that answers twice, or a cap counted outside the lock.
 *
 * Each test truncates first, so none depends on another's leftovers.
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

const ADDRESS = {
  name: 'Ruth Example',
  addressLine1: '1 Main St',
  city: 'Tucson',
  state: 'AZ',
  postalCode: '85701',
  country: 'US' as const
};

describePostgres('address requests (#604)', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let schema: string;
  let service: typeof import('../../src/services/addressRequestService.js');
  let closeServicePool: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const baseUrl = validateDisposableDatabaseUrl(process.env.LIRL_TEST_DATABASE_URL);
    adminPool = new Pool({ connectionString: baseUrl });
    schema = schemaName('lirl_address_requests');
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const scoped = databaseUrlForSchema(baseUrl, schema);
    await migrate({ connectionString: scoped, migrationsDirectory: repositoryMigrations });
    pool = new Pool({ connectionString: scoped, max: 4 });

    process.env.DATABASE_URL = scoped;
    service = await import('../../src/services/addressRequestService.js');
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
    await pool.query(`TRUNCATE address_requests, users RESTART IDENTITY CASCADE`);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function seedUser(): Promise<string> {
    const userId = `auth0|${randomUUID()}`;
    await pool.query(`INSERT INTO users (user_id, email, credits) VALUES ($1, $2, 0)`, [userId, `${randomUUID()}@test.invalid`]);
    return userId;
  }

  async function made(userId: string, recipientName = 'Ruth') {
    const created = await service.createAddressRequest({ userId, recipientName, senderFirstName: 'Pat' });
    if (!created.ok) throw new Error(`refused: ${created.refusal}`);
    return created;
  }

  /** Moves a request's clock back, as if it had been made `days` ago. */
  async function age(requestId: string, days: number): Promise<void> {
    await pool.query(
      `UPDATE address_requests
          SET created_at = created_at - make_interval(days => $2::int),
              expires_at = expires_at - make_interval(days => $2::int)
        WHERE request_id = $1::uuid`,
      [requestId, days]
    );
  }

  it('keeps the token only as its SHA-256, and the link lasts the days configured', async () => {
    vi.stubEnv('LETTER_IRL_ADDRESS_REQUEST_LINK_DAYS', '3');
    const userId = await seedUser();
    const { request, token } = await made(userId);
    expect(token).toMatch(/^[A-Za-z0-9_-]{24}$/);

    const row = (await pool.query(`SELECT * FROM address_requests WHERE request_id = $1::uuid`, [request.requestId])).rows[0];
    expect(Buffer.compare(row.token_hash, createHash('sha256').update(token).digest())).toBe(0);
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row).toMatchObject({ status: 'waiting', address: null, closed_at: null, recipient_name: 'Ruth', sender_first_name: 'Pat' });
    const days = (row.expires_at.getTime() - row.created_at.getTime()) / 86_400_000;
    expect(days).toBe(3);
    expect(request).toMatchObject({ state: 'waiting', recipientName: 'Ruth', senderFirstName: 'Pat', address: null, closedAt: null });
  });

  it('answers a link once when two answers race, keeping the first', async () => {
    const userId = await seedUser();
    const { request, token } = await made(userId);
    const other = { ...ADDRESS, addressLine1: '2 Other Rd' };
    const results = await Promise.all([service.answerAddressRequest(token, ADDRESS), service.answerAddressRequest(token, other)]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok)).toEqual([{ ok: false, refusal: 'answered' }]);

    const stored = await service.getAddressRequest({ userId, requestId: request.requestId });
    expect(stored?.state).toBe('answered');
    expect([ADDRESS, other]).toContainEqual(stored?.address);
    expect(stored?.closedAt).not.toBeNull();
    // A decline after the answer changes nothing.
    await expect(service.declineAddressRequest(token)).resolves.toEqual({ ok: false, refusal: 'answered' });
  });

  it('lets a cancel and an answer at once leave one outcome, each told the other won', async () => {
    const userId = await seedUser();
    const { request, token } = await made(userId);
    const [cancelled, answered] = await Promise.all([
      service.cancelAddressRequest({ userId, requestId: request.requestId }),
      service.answerAddressRequest(token, ADDRESS)
    ]);
    const stored = await service.getAddressRequest({ userId, requestId: request.requestId });
    if (answered.ok) {
      expect(stored?.state).toBe('answered');
      expect(cancelled).toMatchObject({ ok: true, alreadyClosed: true, request: { state: 'answered' } });
    } else {
      expect(answered).toEqual({ ok: false, refusal: 'cancelled' });
      expect(cancelled).toMatchObject({ ok: true, alreadyClosed: false });
      expect(stored).toMatchObject({ state: 'cancelled', address: null });
    }
  });

  it('refuses a request on an erased account, and stores nothing (#605 review round 1)', async () => {
    const userId = await seedUser();
    // A tombstone as erasure leaves it: migration 035's users_erased_tombstone
    // holds the email to the placeholder whenever erased_at is set.
    await pool.query(
      `UPDATE users SET erased_at = NOW(), email = 'erased-' || gen_random_uuid()::text || '@erased.invalid' WHERE user_id = $1`,
      [userId]
    );
    await expect(service.createAddressRequest({ userId, recipientName: 'Ruth', senderFirstName: 'Pat' })).resolves.toEqual({
      ok: false,
      refusal: 'account_closed'
    });
    await expect(service.createAddressRequest({ userId: `auth0|${randomUUID()}`, recipientName: 'Ruth', senderFirstName: 'Pat' })).resolves.toEqual({
      ok: false,
      refusal: 'account_closed'
    });
    expect((await pool.query(`SELECT COUNT(*)::int AS n FROM address_requests`)).rows[0].n).toBe(0);
  });

  it('takes a decline once, and refuses an answer after it', async () => {
    const userId = await seedUser();
    const { request, token } = await made(userId);
    await expect(service.declineAddressRequest(token)).resolves.toEqual({ ok: true });
    await expect(service.answerAddressRequest(token, ADDRESS)).resolves.toEqual({ ok: false, refusal: 'declined' });
    const stored = await service.getAddressRequest({ userId, requestId: request.requestId });
    expect(stored).toMatchObject({ state: 'declined', address: null });
  });

  it('reads a waiting request past its expiry as expired, and refuses an answer or a cancel then', async () => {
    const userId = await seedUser();
    const { request, token } = await made(userId);
    await age(request.requestId, 8);
    await expect(service.getAddressRequest({ userId, requestId: request.requestId })).resolves.toMatchObject({ state: 'expired' });
    await expect(service.answerAddressRequest(token, ADDRESS)).resolves.toEqual({ ok: false, refusal: 'expired' });
    await expect(service.readAddressRequestPage(token)).resolves.toMatchObject({ state: 'expired' });
    const cancelled = await service.cancelAddressRequest({ userId, requestId: request.requestId });
    expect(cancelled).toMatchObject({ ok: true, alreadyClosed: true, request: { state: 'expired' } });
    expect((await pool.query(`SELECT status FROM address_requests`)).rows).toEqual([{ status: 'waiting' }]);
  });

  it('cancels a waiting request, after which its link answers nothing', async () => {
    const userId = await seedUser();
    const { request, token } = await made(userId);
    await expect(service.cancelAddressRequest({ userId, requestId: request.requestId })).resolves.toMatchObject({
      ok: true,
      alreadyClosed: false,
      request: { state: 'cancelled' }
    });
    await expect(service.cancelAddressRequest({ userId, requestId: request.requestId })).resolves.toMatchObject({
      ok: true,
      alreadyClosed: true
    });
    await expect(service.answerAddressRequest(token, ADDRESS)).resolves.toEqual({ ok: false, refusal: 'cancelled' });
  });

  it("gives another account nothing of a request, and the page only the sender's first name and the state", async () => {
    const userId = await seedUser();
    const stranger = await seedUser();
    const { request, token } = await made(userId);
    await expect(service.getAddressRequest({ userId: stranger, requestId: request.requestId })).resolves.toBeNull();
    await expect(service.cancelAddressRequest({ userId: stranger, requestId: request.requestId })).resolves.toEqual({
      ok: false,
      refusal: 'not_found'
    });
    await expect(service.readAddressRequestPage(token)).resolves.toEqual({
      state: 'waiting',
      senderFirstName: 'Pat',
      expiresAt: request.expiresAt
    });
    await expect(service.readAddressRequestPage('A'.repeat(24))).resolves.toBeNull();
    await expect(service.readAddressRequestPage('not a token')).resolves.toBeNull();
    await expect(service.answerAddressRequest('not a token', ADDRESS)).resolves.toEqual({ ok: false, refusal: 'not_found' });
    await expect(service.getAddressRequest({ userId, requestId: 'not-a-uuid' })).resolves.toBeNull();
  });

  it('holds the waiting cap, counting neither closed nor expired requests', async () => {
    vi.stubEnv('LETTER_IRL_ADDRESS_REQUEST_WAITING_CAP', '2');
    const userId = await seedUser();
    const first = await made(userId);
    const second = await made(userId);
    await expect(service.createAddressRequest({ userId, recipientName: 'Sam', senderFirstName: 'Pat' })).resolves.toEqual({
      ok: false,
      refusal: 'waiting_cap',
      cap: 2
    });
    await service.declineAddressRequest(first.token);
    await age(second.request.requestId, 8);
    await made(userId);
    await made(userId);
  });

  it('holds the daily cap, counting every request of the last 24 hours', async () => {
    vi.stubEnv('LETTER_IRL_ADDRESS_REQUEST_DAILY_CAP', '2');
    const userId = await seedUser();
    const first = await made(userId);
    const second = await made(userId);
    await service.cancelAddressRequest({ userId, requestId: first.request.requestId });
    await expect(service.createAddressRequest({ userId, recipientName: 'Sam', senderFirstName: 'Pat' })).resolves.toEqual({
      ok: false,
      refusal: 'daily_cap',
      cap: 2
    });
    // A day on, the earliest no longer counts.
    await age(first.request.requestId, 2);
    await made(userId);
    expect(second.request.requestId).not.toBe(first.request.requestId);
  });

  it('lets one of two requests at once take the last place under the cap', async () => {
    vi.stubEnv('LETTER_IRL_ADDRESS_REQUEST_WAITING_CAP', '1');
    const userId = await seedUser();
    const results = await Promise.all([
      service.createAddressRequest({ userId, recipientName: 'Ruth', senderFirstName: 'Pat' }),
      service.createAddressRequest({ userId, recipientName: 'Sam', senderFirstName: 'Pat' })
    ]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect((await pool.query(`SELECT COUNT(*)::int AS n FROM address_requests`)).rows[0].n).toBe(1);
  });

  it('ties an address to an answer, and closed_at to a closed request, in the table itself', async () => {
    const userId = await seedUser();
    const insert = (status: string, address: string | null, closed: boolean) =>
      pool.query(
        `INSERT INTO address_requests (user_id, token_hash, recipient_name, sender_first_name, status, address, expires_at, closed_at)
         VALUES ($1, sha256(gen_random_uuid()::text::bytea), 'Ruth', 'Pat', $2, $3::jsonb, NOW() + INTERVAL '1 day', ${closed ? 'NOW()' : 'NULL'})`,
        [userId, status, address]
      );
    await expect(insert('answered', null, true)).rejects.toThrow(/valid_address_request_address/);
    await expect(insert('declined', JSON.stringify(ADDRESS), true)).rejects.toThrow(/valid_address_request_address/);
    await expect(insert('waiting', null, true)).rejects.toThrow(/valid_address_request_closed/);
    await expect(insert('declined', null, false)).rejects.toThrow(/valid_address_request_closed/);
    await expect(insert('expired', null, true)).rejects.toThrow(/valid_address_request_status/);
    await expect(insert('answered', JSON.stringify(ADDRESS), true)).resolves.toBeDefined();
    await expect(
      pool.query(
        `INSERT INTO address_requests (user_id, token_hash, recipient_name, sender_first_name, expires_at)
         VALUES ($1, '\\x00'::bytea, 'Ruth', 'Pat', NOW() + INTERVAL '1 day')`,
        [userId]
      )
    ).rejects.toThrow(/valid_address_request_token_hash/);
  });
});
