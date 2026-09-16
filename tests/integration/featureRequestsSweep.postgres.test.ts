import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import { repositoryMigrations, validateDisposableDatabaseUrl } from './support/disposableDatabase.js';

/**
 * Issue #393 - a feature request is kept for 12 months after submission and
 * then deleted, the optional contact email with it.
 *
 *   purgeExpiredFeatureRequests deletes a row 12 months after created_at
 *
 * These run against real PostgreSQL because the properties that matter are
 * properties of the statement: the boundary, the direction of the comparison,
 * the month arithmetic and the interval cast. A mocked query() accepts a
 * predicate that deletes every row, or none.
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

/**
 * Explicit clocks relative to the boundary the sweep uses, written the way the
 * sweep writes it so month-end clamping lands on the same day for both sides.
 * Fixed SQL expressions, never data.
 */
const JUST_INSIDE = `NOW() - INTERVAL '12 months' + INTERVAL '1 day'`;
const JUST_PAST = `NOW() - INTERVAL '12 months' - INTERVAL '1 day'`;
const RECENT = `NOW() - INTERVAL '5 minutes'`;
const LONG_AGO = `NOW() - INTERVAL '3 years'`;

describePostgres('feature requests sweep', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let schema: string;
  let service: typeof import('../../src/services/featureRequestService.js');
  let closeServicePool: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const baseUrl = validateDisposableDatabaseUrl(process.env.LIRL_TEST_DATABASE_URL);
    adminPool = new Pool({ connectionString: baseUrl });
    schema = schemaName('lirl_feature_requests');
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const scoped = databaseUrlForSchema(baseUrl, schema);
    await migrate({ connectionString: scoped, migrationsDirectory: repositoryMigrations });
    pool = new Pool({ connectionString: scoped, max: 4 });

    process.env.DATABASE_URL = scoped;
    service = await import('../../src/services/featureRequestService.js');
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
    await pool.query(`TRUNCATE feature_requests, users RESTART IDENTITY CASCADE`);
  });

  async function seedUser(): Promise<string> {
    const userId = `user_${randomUUID()}`;
    await pool.query(`INSERT INTO users (user_id, email, credits) VALUES ($1, $2, 0)`, [
      userId,
      `${userId}@test.invalid`
    ]);
    return userId;
  }

  /**
   * An INSERT with an explicit clock; the updated_at trigger fires only on
   * UPDATE. `createdAt` is one of the fixed expressions above.
   */
  async function seedRequest(
    userId: string,
    createdAt: string,
    contactEmail: string | null = null
  ): Promise<string> {
    const result = await pool.query<{ request_id: string }>(
      `INSERT INTO feature_requests
         (user_id, title, description, category, attempted_action, contact_email, contact_consent,
          created_at, updated_at)
       VALUES ($1, 'Fixture title', 'Fixture description', 'other', 'fixture action', $2, $3,
               ${createdAt}, ${createdAt})
       RETURNING request_id`,
      [userId, contactEmail, contactEmail !== null]
    );
    return result.rows[0].request_id;
  }

  async function readRequest(requestId: string): Promise<{ contact_email: string | null } | null> {
    const result = await pool.query<{ contact_email: string | null }>(
      `SELECT contact_email FROM feature_requests WHERE request_id = $1`,
      [requestId]
    );
    return result.rows[0] ?? null;
  }

  it('deletes a request just past 12 months and keeps one just inside', async () => {
    const userId = await seedUser();
    const inside = await seedRequest(userId, JUST_INSIDE);
    const past = await seedRequest(userId, JUST_PAST);

    await expect(service.purgeExpiredFeatureRequests()).resolves.toBe(1);

    expect(await readRequest(inside)).not.toBeNull();
    expect(await readRequest(past)).toBeNull();
  });

  it('leaves recent rows and other users alone, and a second run deletes nothing', async () => {
    const stale = await seedUser();
    const fresh = await seedUser();
    const staleA = await seedRequest(stale, LONG_AGO);
    const staleB = await seedRequest(stale, JUST_PAST);
    const freshA = await seedRequest(fresh, RECENT);
    const freshB = await seedRequest(fresh, JUST_INSIDE);

    await expect(service.purgeExpiredFeatureRequests()).resolves.toBe(2);
    await expect(service.purgeExpiredFeatureRequests()).resolves.toBe(0);

    expect(await readRequest(staleA)).toBeNull();
    expect(await readRequest(staleB)).toBeNull();
    expect(await readRequest(freshA)).not.toBeNull();
    expect(await readRequest(freshB)).not.toBeNull();
  });

  it('keeps the optional contact email exactly as long as its request, and no longer', async () => {
    const userId = await seedUser();
    const inside = await seedRequest(userId, JUST_INSIDE, 'reply-here@example.invalid');
    const past = await seedRequest(userId, JUST_PAST, 'gone-with-it@example.invalid');

    await expect(service.purgeExpiredFeatureRequests()).resolves.toBe(1);

    expect(await readRequest(inside)).toEqual({ contact_email: 'reply-here@example.invalid' });
    expect(await readRequest(past)).toBeNull();
  });

  it('counts from submission, so a later update does not extend the period', async () => {
    // Nothing in the application updates a row today; if something starts to,
    // the period must still run from created_at, or the sweep would never fire.
    const userId = await seedUser();
    const requestId = await seedRequest(userId, JUST_PAST);
    await pool.query(`UPDATE feature_requests SET admin_notes = 'fixture note' WHERE request_id = $1`, [
      requestId
    ]);
    const touched = await pool.query<{ moved: boolean }>(
      `SELECT updated_at > created_at AS moved FROM feature_requests WHERE request_id = $1`,
      [requestId]
    );
    expect(touched.rows[0].moved).toBe(true);

    await expect(service.purgeExpiredFeatureRequests()).resolves.toBe(1);
    expect(await readRequest(requestId)).toBeNull();
  });

  it('removes the requests when the user is deleted', async () => {
    const userId = await seedUser();
    const requestId = await seedRequest(userId, RECENT);

    await pool.query(`DELETE FROM users WHERE user_id = $1`, [userId]);

    expect(await readRequest(requestId)).toBeNull();
  });
});
