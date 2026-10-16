import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import { repositoryMigrations, validateDisposableDatabaseUrl } from './support/disposableDatabase.js';

/**
 * Issue #398 - operator audit records are deleted 2 years after the action
 * they record, and not a moment before.
 *
 * Both audit tables refuse UPDATE and DELETE through a trigger (022, 023).
 * Migration 062 lets one DELETE through: of a row past its two years, in a
 * transaction with letter_irl.audit_retention_purge on. These run against real
 * PostgreSQL because the guarantee is the trigger's, not the sweep's WHERE
 * clause: a mocked query() would accept a purge that deleted every row.
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

  it('still refuses a delete without the purge setting, even of an expired record', async () => {
    const admin = await adminRow(EXPIRED);
    const commerce = await commerceRow(`NOW() - INTERVAL '1 day'`);
    await expect(pool.query('DELETE FROM admin_audit_events WHERE id = $1', [admin]))
      .rejects.toMatchObject({ code: '55000', message: 'admin_audit_events is append-only' });
    await expect(pool.query('DELETE FROM commerce_operator_audit_events WHERE audit_event_id = $1', [commerce]))
      .rejects.toMatchObject({ code: '55000', message: 'commerce_operator_audit_events is append-only' });
  });

  it('refuses, with the setting on, to delete a record inside its two years, or to change any record', async () => {
    const youngAdmin = await adminRow(NOT_YET);
    const youngCommerce = await commerceRow(`NOW() + INTERVAL '1 day'`);
    const oldAdmin = await adminRow(EXPIRED);
    const client = await pool.connect();
    try {
      for (const [statement, id] of [
        ['DELETE FROM admin_audit_events WHERE id = $1', youngAdmin],
        ['DELETE FROM commerce_operator_audit_events WHERE audit_event_id = $1', youngCommerce],
        ["UPDATE admin_audit_events SET actor_name = 'Changed' WHERE id = $1", oldAdmin],
        ["UPDATE commerce_operator_audit_events SET reason_code = 'changed' WHERE audit_event_id = $1", youngCommerce],
      ] as const) {
        await client.query('BEGIN');
        await client.query("SET LOCAL letter_irl.audit_retention_purge = 'on'");
        await expect(client.query(statement, [id]), statement).rejects.toMatchObject({ code: '55000' });
        await client.query('ROLLBACK');
      }
    } finally {
      client.release();
    }
    expect(await adminIds()).toEqual([youngAdmin, oldAdmin].sort());
    expect(await commerceIds()).toEqual([youngCommerce]);
  });

  it('does not leave the setting on after the purge', async () => {
    await adminRow(EXPIRED);
    await service.purgeExpiredAuditRecords();
    // SET LOCAL ends with its transaction: a later delete on any connection is refused.
    const old = await adminRow(EXPIRED);
    const client = await pool.connect();
    try {
      const setting = await client.query<{ value: string | null }>(
        "SELECT current_setting('letter_irl.audit_retention_purge', true) AS value"
      );
      expect(setting.rows[0].value === null || setting.rows[0].value === '').toBe(true);
      await expect(client.query('DELETE FROM admin_audit_events WHERE id = $1', [old])).rejects.toMatchObject({ code: '55000' });
    } finally {
      client.release();
    }
  });
});
