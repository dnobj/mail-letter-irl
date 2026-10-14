import { createHash, randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import { repositoryMigrations, validateDisposableDatabaseUrl } from './support/disposableDatabase.js';

/**
 * A personal access token is found by the SHA-256 of the whole token
 * (migration 059, #730).
 *
 *   a new token carries its hash, and is found by it
 *   a token made before 059 (no hash) is found by its suffix and a bcrypt
 *   compare once, given its hash, and found by that from then on
 *   two tokens can never share a hash (the unique index)
 *   a revoked token is refused however it is found
 *
 * Against real PostgreSQL because the column, the partial unique index and
 * the fill-in UPDATE are what matter, and a mocked query() honours none.
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

const USER_ID = 'auth0|pat-lookup';

function sha256(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

describePostgres('finding a personal access token by its hash', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let schema: string;
  let patService: typeof import('../../src/services/patService.js');
  let closeServicePool: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const baseUrl = validateDisposableDatabaseUrl(process.env.LIRL_TEST_DATABASE_URL);
    adminPool = new Pool({ connectionString: baseUrl });
    schema = schemaName('lirl_pat_lookup');
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const scoped = databaseUrlForSchema(baseUrl, schema);
    await migrate({ connectionString: scoped, migrationsDirectory: repositoryMigrations });
    pool = new Pool({ connectionString: scoped, max: 4 });

    process.env.DATABASE_URL = scoped;
    patService = await import('../../src/services/patService.js');
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
    await pool.query('TRUNCATE personal_access_tokens, users CASCADE');
    await pool.query(
      `INSERT INTO users (user_id, email, credits, credits_purchased, credits_used) VALUES ($1, $2, 0, 0, 0)`,
      [USER_ID, 'pat-lookup@example.invalid']
    );
  });

  async function lookupOf(tokenId: number): Promise<string | null> {
    const { rows } = await pool.query<{ token_lookup: string | null }>(
      'SELECT token_lookup FROM personal_access_tokens WHERE token_id = $1',
      [tokenId]
    );
    return rows[0].token_lookup;
  }

  it('stores a new token with its hash and finds it by that', async () => {
    const created = await patService.createToken(USER_ID, 'Laptop');
    expect(await lookupOf(created.tokenId)).toBe(sha256(created.token));
    expect(await patService.validateToken(created.token)).toMatchObject({ valid: true, userId: USER_ID, tokenId: created.tokenId });
  });

  it('finds a token made before 059 once by its suffix, then by the hash it is given', async () => {
    const raw = `lirl_pat_${'b'.repeat(28)}old1`;
    const { rows } = await pool.query<{ token_id: number }>(
      `INSERT INTO personal_access_tokens (user_id, name, token_hash, token_prefix)
       VALUES ($1, 'Before 059', $2, 'old1') RETURNING token_id`,
      [USER_ID, await bcrypt.hash(raw, 4)]
    );
    const tokenId = rows[0].token_id;
    expect(await lookupOf(tokenId)).toBeNull();

    expect(await patService.validateToken(raw)).toMatchObject({ valid: true, tokenId });
    expect(await lookupOf(tokenId)).toBe(sha256(raw));

    // Found by the hash now: a wrong bcrypt hash no longer matters.
    await pool.query(`UPDATE personal_access_tokens SET token_hash = 'not-a-real-hash' WHERE token_id = $1`, [tokenId]);
    expect(await patService.validateToken(raw)).toMatchObject({ valid: true, tokenId });

    // Revoked is refused, found by the hash.
    await patService.revokeToken(USER_ID, tokenId);
    expect(await patService.validateToken(raw)).toEqual({ valid: false, error: 'Token has been revoked' });
  });

  it('refuses a second token with the same hash, and leaves any number without one', async () => {
    const created = await patService.createToken(USER_ID, 'Laptop');
    await expect(
      pool.query(
        `INSERT INTO personal_access_tokens (user_id, name, token_hash, token_prefix, token_lookup)
         VALUES ($1, 'Copy', 'h', 'copy', $2)`,
        [USER_ID, sha256(created.token)]
      )
    ).rejects.toMatchObject({ code: '23505', constraint: 'idx_pat_token_lookup' });
    await pool.query(
      `INSERT INTO personal_access_tokens (user_id, name, token_hash, token_prefix)
       VALUES ($1, 'One', 'h1', 'one1'), ($1, 'Two', 'h2', 'two2')`,
      [USER_ID]
    );
  });

  it('does not find an unknown token either way', async () => {
    await patService.createToken(USER_ID, 'Laptop');
    expect(await patService.validateToken(`lirl_pat_${'c'.repeat(32)}`)).toEqual({ valid: false, error: 'Token not found' });
  });
});
