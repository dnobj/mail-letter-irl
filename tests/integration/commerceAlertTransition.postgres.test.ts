import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import { repositoryMigrations, validateDisposableDatabaseUrl } from './support/disposableDatabase.js';

/**
 * Issue #189 - an operator must be able to acknowledge and resolve an alert.
 *
 * The transition statement bound one parameter both to `status` (a varchar
 * column) and to comparisons against bare literals, which PostgreSQL refuses to
 * plan. Every acknowledge and every resolve therefore threw, and the audit
 * insert underneath never ran either.
 *
 * It survived because nothing could reach it. The admin surface is local-only -
 * `validateAdminRequestBoundary` answers 404 unless the request is loopback with
 * the operator header and the local-only environment set - so no deployed
 * environment executes this path, and no test did either. These run against
 * real PostgreSQL because a mocked `pg` cannot fail the way this failed.
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

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

describePostgres('commerce alert transitions', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let schema: string;
  let admin: typeof import('../../src/api/adminApiHandler.js');
  let closeServicePool: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const baseUrl = validateDisposableDatabaseUrl(process.env.LIRL_TEST_DATABASE_URL);
    adminPool = new Pool({ connectionString: baseUrl });
    schema = schemaName('lirl_alerttx');
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const scoped = databaseUrlForSchema(baseUrl, schema);
    await migrate({ connectionString: scoped, migrationsDirectory: repositoryMigrations });
    pool = new Pool({ connectionString: scoped, max: 8 });

    process.env.DATABASE_URL = scoped;
    admin = await import('../../src/api/adminApiHandler.js');
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

  async function seedAlert(status = 'open'): Promise<string> {
    const inserted = await pool.query<{ alert_id: string }>(
      `INSERT INTO commerce_operational_alerts (alert_type, severity, status, details)
       VALUES ('mail_provider_outcome_ambiguous', 'critical', $1, '{}'::jsonb)
       RETURNING alert_id`,
      [status]
    );
    return inserted.rows[0].alert_id;
  }

  async function seedResolvedAlert(): Promise<string> {
    const inserted = await pool.query<{ alert_id: string }>(
      `INSERT INTO commerce_operational_alerts
         (alert_type, severity, status, details, resolved_at, resolved_by_actor_hash, resolution_code)
       VALUES ('mail_provider_outcome_ambiguous', 'critical', 'resolved', '{}'::jsonb,
               NOW(), $1, 'already_handled')
       RETURNING alert_id`,
      [hash('earlier_operator')]
    );
    return inserted.rows[0].alert_id;
  }

  async function readAlert(alertId: string) {
    const result = await pool.query<{
      status: string;
      acknowledged_at: Date | null;
      acknowledged_by_actor_hash: string | null;
      resolved_at: Date | null;
      resolved_by_actor_hash: string | null;
      resolution_code: string | null;
    }>(
      `SELECT status, acknowledged_at, acknowledged_by_actor_hash,
              resolved_at, resolved_by_actor_hash, resolution_code
         FROM commerce_operational_alerts WHERE alert_id = $1`,
      [alertId]
    );
    return result.rows[0];
  }

  async function auditRows(alertId: string): Promise<number> {
    const result = await pool.query(
      `SELECT 1 FROM commerce_operator_audit_events
        WHERE operation = 'commerce_alert_transition' AND target_reference_hash = $1`,
      [hash(alertId)]
    );
    return result.rowCount ?? 0;
  }

  it('acknowledges an open alert and records who did it', async () => {
    const alertId = await seedAlert();

    // Before the casts this threw, and the operator got a 409 with no
    // explanation - the queue could only ever fill.
    const result = await admin.transitionCommerceAlert({
      alertId,
      status: 'acknowledged',
      idempotencyKey: `ack-${alertId}`,
      actorId: 'operator_test'
    });
    expect(result.replayed).toBe(false);

    const alert = await readAlert(alertId);
    expect(alert.status).toBe('acknowledged');
    expect(alert.acknowledged_at).not.toBeNull();
    expect(alert.acknowledged_by_actor_hash).toBe(hash('operator_test'));
    // The audit insert sits under the same transaction as the failing write,
    // so it is part of the same regression.
    expect(await auditRows(alertId)).toBe(1);
  }, 60_000);

  it('resolves an alert with its resolution code', async () => {
    const alertId = await seedAlert();

    await admin.transitionCommerceAlert({
      alertId,
      status: 'resolved',
      resolutionCode: 'provider_confirmed_delivered',
      idempotencyKey: `res-${alertId}`,
      actorId: 'operator_test'
    });

    const alert = await readAlert(alertId);
    expect(alert.status).toBe('resolved');
    expect(alert.resolved_at).not.toBeNull();
    expect(alert.resolved_by_actor_hash).toBe(hash('operator_test'));
    expect(alert.resolution_code).toBe('provider_confirmed_delivered');
    expect(await auditRows(alertId)).toBe(1);
  }, 60_000);

  /**
   * The ELSE NULL branches on the resolved_* columns look wrong beside the
   * acknowledged_* branches, which preserve their own column. They are not.
   * valid_commerce_alert_resolution admits an acknowledged row only while
   * resolved_at IS NULL, so an acknowledge has to clear them - and the database
   * refuses to hold the state where the question would even arise.
   *
   * Asserted because it is a trap: the asymmetry invites a future reader to
   * "fix" it into a constraint violation on every acknowledge.
   */
  it('acknowledges into a state the resolution constraint accepts', async () => {
    const alertId = await seedAlert();

    await admin.transitionCommerceAlert({
      alertId,
      status: 'acknowledged',
      idempotencyKey: `ack-shape-${alertId}`,
      actorId: 'operator_test'
    });

    const alert = await readAlert(alertId);
    expect(alert.status).toBe('acknowledged');
    expect(alert.acknowledged_at).not.toBeNull();
    expect(alert.resolved_at).toBeNull();

    // And the incoherent row the ELSE branches would otherwise have to defend
    // cannot be created in the first place.
    await expect(pool.query(
      `UPDATE commerce_operational_alerts
          SET resolved_at = NOW(), resolution_code = 'earlier_resolution'
        WHERE alert_id = $1`,
      [alertId]
    )).rejects.toThrow(/valid_commerce_alert_resolution/);
  }, 60_000);

  it('replays an identical transition without writing twice', async () => {
    const alertId = await seedAlert();
    const key = `replay-${alertId}`;

    const first = await admin.transitionCommerceAlert({
      alertId, status: 'acknowledged', idempotencyKey: key, actorId: 'operator_test'
    });
    const second = await admin.transitionCommerceAlert({
      alertId, status: 'acknowledged', idempotencyKey: key, actorId: 'operator_test'
    });

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    // One audit row, not two: the replay is absorbed rather than re-applied.
    expect(await auditRows(alertId)).toBe(1);
  }, 60_000);

  it('refuses a reused idempotency key that means something else', async () => {
    const alertId = await seedAlert();
    const key = `conflict-${alertId}`;

    await admin.transitionCommerceAlert({
      alertId, status: 'acknowledged', idempotencyKey: key, actorId: 'operator_test'
    });

    await expect(admin.transitionCommerceAlert({
      alertId,
      status: 'resolved',
      resolutionCode: 'provider_confirmed_delivered',
      idempotencyKey: key,
      actorId: 'operator_test'
    })).rejects.toThrow('idempotency_conflict');

    expect(await readAlert(alertId).then(a => a.status)).toBe('acknowledged');
  }, 60_000);

  it('refuses to act on an alert that is already resolved', async () => {
    // A resolved row must carry resolved_at and a resolution_code, or
    // valid_commerce_alert_resolution rejects the insert.
    const alertId = await seedResolvedAlert();

    await expect(admin.transitionCommerceAlert({
      alertId,
      status: 'resolved',
      resolutionCode: 'provider_confirmed_delivered',
      idempotencyKey: `done-${alertId}`,
      actorId: 'operator_test'
    })).rejects.toThrow('invalid_state');

    expect(await auditRows(alertId)).toBe(0);
  }, 60_000);
});
