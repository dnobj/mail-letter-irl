import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import { repositoryMigrations, validateDisposableDatabaseUrl } from './support/disposableDatabase.js';

/**
 * Issue #398 - operator audit records are deleted as the 2 years after the
 * action they record run out: two days before, and not sooner.
 *
 * Both audit tables refuse UPDATE and DELETE through a trigger (022, 023),
 * and still do. Migration 062's purge_expired_audit_records switches the
 * triggers off inside its own transaction and deletes only rows due. These run against real PostgreSQL because the rule is in that
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
/**
 * Fixed SQL clocks around the due date: two days before the two years are up,
 * so a sweep that runs late still deletes inside "up to 2 years". A day of
 * margin either side of it.
 */
const EXPIRED = `NOW() - INTERVAL '2 years' + INTERVAL '1 day'`;
const NOT_YET = `NOW() - INTERVAL '2 years' + INTERVAL '3 days'`;
const COMMERCE_DUE = `NOW() + INTERVAL '1 day'`;
const COMMERCE_NOT_YET = `NOW() + INTERVAL '3 days'`;

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
    await commerceRow(COMMERCE_DUE);
    const keptCommerce = [await commerceRow(COMMERCE_NOT_YET), await commerceRow(`NOW() + INTERVAL '2 years'`)].sort();

    await expect(service.purgeExpiredAuditRecords()).resolves.toEqual({ adminDeleted: 1, commerceDeleted: 1 });
    expect(await adminIds()).toEqual(keptAdmin);
    expect(await commerceIds()).toEqual(keptCommerce);
    // Nothing left to do: a second run deletes nothing.
    await expect(service.purgeExpiredAuditRecords()).resolves.toEqual({ adminDeleted: 0, commerceDeleted: 0 });
  });

  it('works in batches, oldest first, a bounded number per run', async () => {
    // Inserted newest first, so the order the rows went in is not their age.
    const newest = await adminRow(`NOW() - INTERVAL '2 years' - INTERVAL '10 days'`);
    await adminRow(`NOW() - INTERVAL '2 years' - INTERVAL '30 days'`);
    await adminRow(`NOW() - INTERVAL '2 years' - INTERVAL '20 days'`);
    const newestCommerce = await commerceRow(`NOW() - INTERVAL '10 days'`);
    await commerceRow(`NOW() - INTERVAL '30 days'`);
    await commerceRow(`NOW() - INTERVAL '20 days'`);
    await expect(service.purgeExpiredAuditRecords(1, 2)).resolves.toEqual({ adminDeleted: 2, commerceDeleted: 2 });
    expect(await adminIds()).toEqual([newest]);
    expect(await commerceIds()).toEqual([newestCommerce]);
    await expect(service.purgeExpiredAuditRecords(1, 2)).resolves.toEqual({ adminDeleted: 1, commerceDeleted: 1 });
    expect(await adminIds()).toHaveLength(0);
    expect(await commerceIds()).toHaveLength(0);
  });

  it("leaves the connection's lock_timeout as it was, after a purge and after a refusal", async () => {
    const client = await pool.connect();
    try {
      await client.query('SELECT * FROM purge_expired_audit_records(10)');
      expect((await client.query<{ lock_timeout: string }>('SHOW lock_timeout')).rows[0].lock_timeout).toBe('0');
      await expect(client.query('SELECT * FROM purge_expired_audit_records(NULL)')).rejects.toThrow(/positive integer/);
      expect((await client.query<{ lock_timeout: string }>('SHOW lock_timeout')).rows[0].lock_timeout).toBe('0');
    } finally {
      client.release();
    }
  });

  it('gives up on an open writer on the admin table too, holding nothing afterwards (#398 review)', async () => {
    const due = await commerceRow(COMMERCE_DUE);
    const writer = await pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query(
        `INSERT INTO admin_audit_events
           (occurred_at, actor_sid, actor_name, environment, mode, session_id_hash,
            correlation_id, action, target_type, outcome)
         VALUES (NOW(), 'operator', 'Operator', 'development', 'full', $1,
                 gen_random_uuid(), 'test.action', 'account', 'succeeded')`,
        [HEX]
      );
      const started = Date.now();
      await expect(service.purgeExpiredAuditRecords()).rejects.toMatchObject({ code: '55P03' });
      // It waited for the lock rather than failing at once.
      expect(Date.now() - started).toBeGreaterThanOrEqual(4_000);
      // Nothing was deleted, and the commerce lock it held while waiting is gone.
      expect(await commerceIds()).toEqual([due]);
      await expect(commerceRow(COMMERCE_NOT_YET)).resolves.toBeTruthy();
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      writer.release();
    }
    await expect(service.purgeExpiredAuditRecords()).resolves.toEqual({ adminDeleted: 0, commerceDeleted: 1 });
  }, 30_000);

  it('gives up after a few seconds when a writer holds a table, and leaves it as it was (#398 review)', async () => {
    const due = await adminRow(EXPIRED);
    const writer = await pool.connect();
    try {
      await writer.query('BEGIN');
      // An open writer on the commerce table: the purge must not wait on it for ever.
      await writer.query(
        `INSERT INTO commerce_operator_audit_events
           (idempotency_key_hash, actor_subject_hash, operation, target_type,
            target_reference_hash, reason_code, before_state, after_state)
         VALUES (encode(sha256(gen_random_uuid()::text::bytea), 'hex'), $1, 'commerce_alert_transition',
                 'commerce_alert', $1, 'operator_acknowledged', '{}', '{}')`,
        [HEX]
      );
      const started = Date.now();
      await expect(service.purgeExpiredAuditRecords()).rejects.toMatchObject({ code: '55P03' });
      expect(Date.now() - started).toBeGreaterThanOrEqual(4_000);
      expect(Date.now() - started).toBeLessThan(15_000);
      // Nothing was deleted, and the admin table's writers were not held.
      expect(await adminIds()).toEqual([due]);
      await expect(adminRow('NOW()')).resolves.toBeTruthy();
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      writer.release();
    }
    await expect(service.purgeExpiredAuditRecords()).resolves.toEqual({ adminDeleted: 1, commerceDeleted: 0 });
  }, 30_000);

  /**
   * The session in this database blocked by `pid`'s locks, once there is one,
   * or null. Polled for at most about 2 seconds, well inside the purge's 5
   * second lock_timeout, so a slow runner fails here rather than at a timeout.
   */
  async function sessionBlockedBy(prober: pg.PoolClient, pid: number): Promise<number | null> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const { rows } = await prober.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND pg_blocking_pids(pid) @> ARRAY[$1::int]
          LIMIT 1`,
        [pid]
      );
      if (rows[0]) return rows[0].pid;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return null;
  }

  it('waits behind an admin command writing commerce then admin, rather than deadlocking it (#398 review)', async () => {
    const command = await pool.connect();
    const prober = await pool.connect();
    let purge: Promise<unknown> | undefined;
    try {
      await command.query('BEGIN');
      // As src/admin/commands/runner.ts writes them: the command's commerce row first...
      await command.query(
        `INSERT INTO commerce_operator_audit_events
           (idempotency_key_hash, actor_subject_hash, operation, target_type,
            target_reference_hash, reason_code, before_state, after_state)
         VALUES (encode(sha256(gen_random_uuid()::text::bytea), 'hex'), $1, 'commerce_alert_transition',
                 'commerce_alert', $1, 'operator_acknowledged', '{}', '{}')`,
        [HEX]
      );
      const commandPid = (await command.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      purge = service.purgeExpiredAuditRecords();
      purge.catch(() => undefined);
      // ...the purge waits for it...
      expect(await sessionBlockedBy(prober, commandPid)).not.toBeNull();
      // ...and the command's admin row is not behind the purge. Taken in the
      // other order, the purge would hold the admin table here, and PostgreSQL
      // would fail one of the two as a deadlock.
      await command.query(
        `INSERT INTO admin_audit_events
           (occurred_at, actor_sid, actor_name, environment, mode, session_id_hash,
            correlation_id, action, target_type, outcome)
         VALUES (NOW(), 'operator', 'Operator', 'development', 'full', $1,
                 gen_random_uuid(), 'test.action', 'account', 'succeeded')`,
        [HEX]
      );
      await command.query('COMMIT');
      await expect(purge).resolves.toEqual({ adminDeleted: 0, commerceDeleted: 0 });
    } finally {
      await command.query('ROLLBACK').catch(() => undefined);
      // On a failure above, let the purge end before the next test.
      await purge?.catch(() => undefined);
      command.release();
      prober.release();
    }
  }, 30_000);

  it('rolls the triggers back on with the deletes when it fails after switching them off (#398 review)', async () => {
    const due = await adminRow(EXPIRED);
    const holder = await pool.connect();
    const prober = await pool.connect();
    let purge: Promise<unknown> | undefined;
    try {
      await holder.query('BEGIN');
      // A row lock does not conflict with the purge's table locks, so the purge
      // switches the trigger off, then waits at its DELETE until lock_timeout.
      await holder.query('SELECT 1 FROM admin_audit_events WHERE id = $1 FOR UPDATE', [due]);
      const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      purge = service.purgeExpiredAuditRecords();
      purge.catch(() => undefined);
      const purgePid = await sessionBlockedBy(prober, holderPid);
      expect(purgePid).not.toBeNull();
      // Where it waits: it holds both tables, and waits for the holder's row,
      // at its DELETE, which the code runs after switching the trigger off. A
      // purge that never switched it off would wait there too (the trigger
      // locks the row first); the deletion tests above catch that one, since
      // the trigger would refuse their deletes.
      const locks = await prober.query<{ locktype: string; relation: string | null; mode: string; granted: boolean }>(
        `SELECT locktype, relation::regclass::text AS relation, mode, granted FROM pg_locks WHERE pid = $1`,
        [purgePid]
      );
      expect(locks.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ relation: 'admin_audit_events', mode: 'ShareRowExclusiveLock', granted: true }),
          expect.objectContaining({ relation: 'commerce_operator_audit_events', mode: 'ShareRowExclusiveLock', granted: true }),
        ])
      );
      expect(locks.rows.some(lock => !lock.granted && (lock.locktype === 'transactionid' || lock.locktype === 'tuple'))).toBe(true);
      await expect(purge).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await purge?.catch(() => undefined);
      holder.release();
      prober.release();
    }
    const triggers = await pool.query<{ tgenabled: string }>(
      `SELECT tgenabled FROM pg_trigger
        WHERE tgname IN ('admin_audit_events_append_only', 'commerce_operator_audit_events_append_only')
          AND tgrelid IN (to_regclass('admin_audit_events'), to_regclass('commerce_operator_audit_events'))`
    );
    expect(triggers.rows).toEqual([{ tgenabled: 'O' }, { tgenabled: 'O' }]);
    expect(await adminIds()).toEqual([due]);
    await expect(pool.query('DELETE FROM admin_audit_events WHERE id = $1', [due])).rejects.toMatchObject({ code: '55000' });
  }, 30_000);

  it('leaves the triggers refusing every other delete and every update, before and after a purge', async () => {
    const oldAdmin = await adminRow(EXPIRED);
    const oldCommerce = await commerceRow(COMMERCE_DUE);
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
    // A NULL ACL is the default, which grants PUBLIC execute: it must have been
    // set, and without a PUBLIC entry ("=X/..."), so only the owner may run it.
    expect(acl.rows[0].proacl).not.toBeNull();
    expect(acl.rows[0].proacl).not.toMatch(/(^|[{,])=X/);
    await expect(pool.query('SELECT * FROM purge_expired_audit_records(0)')).rejects.toThrow(/positive integer/);
  });
});
