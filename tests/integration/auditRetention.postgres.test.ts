import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import { repositoryMigrations, validateDisposableDatabaseUrl } from './support/disposableDatabase.js';

/**
 * Issue #398 - operator audit records are deleted 2 years after the action
 * they record, and not a moment before.
 *
 * Both audit tables refuse UPDATE and DELETE through a trigger (022, 023),
 * and still do. Migration 062's purge_expired_audit_records switches the
 * triggers off inside its own transaction and deletes only rows past their two
 * years. These run against real PostgreSQL because the rule is in that
 * function: a mocked query() would accept a purge that deleted every row.
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

const HEX = 'a'.repeat(64);
/** Fixed SQL clocks around the two years; two days of margin either side. */
const EXPIRED = `NOW() - INTERVAL '2 years' - INTERVAL '2 days'`;
const NOT_YET = `NOW() - INTERVAL '2 years' + INTERVAL '2 days'`;

describePostgres('operator audit retention', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let schema: string;
  let service: typeof import('../../src/services/auditRetentionService.js');
  let closeServicePool: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const baseUrl = validateDisposableDatabaseUrl(process.env.LIRL_TEST_DATABASE_URL);
    adminPool = new Pool({ connectionString: baseUrl });
    schema = schemaName('lirl_audit_retention');
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const scoped = databaseUrlForSchema(baseUrl, schema);
    await migrate({ connectionString: scoped, migrationsDirectory: repositoryMigrations });
    pool = new Pool({ connectionString: scoped, max: 4 });

    process.env.DATABASE_URL = scoped;
    service = await import('../../src/services/auditRetentionService.js');
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
    // TRUNCATE is not a row DELETE, so the triggers let it clear the tables.
    await pool.query('TRUNCATE admin_audit_events, commerce_operator_audit_events');
  });

  /** An admin audit row whose action happened at `when` (a fixed SQL clock). */
  async function adminRow(when: string): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO admin_audit_events
         (occurred_at, actor_sid, actor_name, environment, mode, session_id_hash,
          correlation_id, action, target_type, outcome)
       VALUES (${when}, 'operator', 'Operator', 'development', 'full', $1,
               gen_random_uuid(), 'test.action', 'account', 'succeeded')
       RETURNING id`,
      [HEX]
    );
    return result.rows[0].id;
  }

  /** A commerce audit row that expires at `when` (a fixed SQL clock). */
  async function commerceRow(when: string): Promise<string> {
    const result = await pool.query<{ audit_event_id: string }>(
      `INSERT INTO commerce_operator_audit_events
         (idempotency_key_hash, actor_subject_hash, operation, target_type,
          target_reference_hash, reason_code, before_state, after_state, retention_expires_at)
       VALUES (encode(sha256(gen_random_uuid()::text::bytea), 'hex'), $1, 'commerce_alert_transition',
               'commerce_alert', $1, 'operator_acknowledged', '{}', '{}', ${when})
       RETURNING audit_event_id`,
      [HEX]
    );
    return result.rows[0].audit_event_id;
  }

  async function adminIds(): Promise<string[]> {
    return (await pool.query<{ id: string }>('SELECT id FROM admin_audit_events')).rows.map(row => row.id).sort();
  }

  async function commerceIds(): Promise<string[]> {
    return (await pool.query<{ audit_event_id: string }>('SELECT audit_event_id FROM commerce_operator_audit_events'))
      .rows.map(row => row.audit_event_id).sort();
  }

  it('deletes only records past their two years, from both tables', async () => {
    await adminRow(EXPIRED);
    const keptAdmin = [await adminRow(NOT_YET), await adminRow('NOW()')].sort();
    await commerceRow(`NOW() - INTERVAL '1 day'`);
    const keptCommerce = [await commerceRow(`NOW() + INTERVAL '1 day'`), await commerceRow(`NOW() + INTERVAL '2 years'`)].sort();

    await expect(service.purgeExpiredAuditRecords()).resolves.toEqual({ adminDeleted: 1, commerceDeleted: 1 });
    expect(await adminIds()).toEqual(keptAdmin);
    expect(await commerceIds()).toEqual(keptCommerce);
    // Nothing left to do: a second run deletes nothing.
    await expect(service.purgeExpiredAuditRecords()).resolves.toEqual({ adminDeleted: 0, commerceDeleted: 0 });
  });

  it('works in batches, a bounded number per run', async () => {
    for (let i = 0; i < 3; i += 1) await adminRow(EXPIRED);
    await expect(service.purgeExpiredAuditRecords(1, 2)).resolves.toEqual({ adminDeleted: 2, commerceDeleted: 0 });
    expect(await adminIds()).toHaveLength(1);
    await expect(service.purgeExpiredAuditRecords(1, 2)).resolves.toEqual({ adminDeleted: 1, commerceDeleted: 0 });
    expect(await adminIds()).toHaveLength(0);
  });

  it('leaves the triggers refusing every other delete and every update, before and after a purge', async () => {
    const oldAdmin = await adminRow(EXPIRED);
    const oldCommerce = await commerceRow(`NOW() - INTERVAL '1 day'`);
    const refusals = async () => {
      await expect(pool.query('DELETE FROM admin_audit_events WHERE id = $1', [oldAdmin]))
        .rejects.toMatchObject({ code: '55000', message: 'admin_audit_events is append-only' });
      await expect(pool.query('DELETE FROM commerce_operator_audit_events WHERE audit_event_id = $1', [oldCommerce]))
        .rejects.toMatchObject({ code: '55000', message: 'commerce_operator_audit_events is append-only' });
      await expect(pool.query("UPDATE admin_audit_events SET actor_name = 'Changed' WHERE id = $1", [oldAdmin]))
        .rejects.toMatchObject({ code: '55000' });
    };
    await refusals();

    // After a purge the triggers are on again, and refuse a row it kept.
    const youngAdmin = await adminRow(NOT_YET);
    await expect(service.purgeExpiredAuditRecords()).resolves.toEqual({ adminDeleted: 1, commerceDeleted: 1 });
    const triggers = await pool.query<{ tgname: string; tgenabled: string }>(
      `SELECT tgname, tgenabled FROM pg_trigger
        WHERE tgname IN ('admin_audit_events_append_only', 'commerce_operator_audit_events_append_only')
          AND tgrelid IN (to_regclass('admin_audit_events'), to_regclass('commerce_operator_audit_events'))
        ORDER BY tgname`
    );
    expect(triggers.rows).toEqual([
      { tgname: 'admin_audit_events_append_only', tgenabled: 'O' },
      { tgname: 'commerce_operator_audit_events_append_only', tgenabled: 'O' }
    ]);
    await expect(pool.query('DELETE FROM admin_audit_events WHERE id = $1', [youngAdmin]))
      .rejects.toMatchObject({ code: '55000' });
  });

  it('is the owner\'s alone: nobody else may run it', async () => {
    const acl = await pool.query<{ proacl: string | null }>(
      `SELECT proacl::text AS proacl FROM pg_proc
        WHERE oid = to_regprocedure('purge_expired_audit_records(integer)')`
    );
    expect(acl.rows).toHaveLength(1);
    // An ACL with no PUBLIC entry ("=X/...") grants execute to the owner only.
    expect(acl.rows[0].proacl ?? '').not.toMatch(/(^|[{,])=X/);
    await expect(pool.query('SELECT * FROM purge_expired_audit_records(0)')).rejects.toThrow(/positive integer/);
  });
});
