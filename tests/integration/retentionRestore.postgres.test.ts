import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import { repositoryMigrations, validateDisposableDatabaseUrl } from './support/disposableDatabase.js';
import { AdminAuditWriter } from '../../src/admin/auditService.js';
import { parseAdminEnvironmentConfig } from '../../src/admin/config.js';
import { withReadOnlyTransaction } from '../../src/admin/db.js';
import { ElevationGuard } from '../../src/admin/http/elevation.js';
import { AdminSessionStore, hashSessionId, type AdminSession } from '../../src/admin/http/session.js';
import { buildAdminGrantStatements } from '../../src/admin/provisioning.js';
import { parseAdminRuntimeConfig, type AdminRuntimeConfig } from '../../src/admin/runtimeConfig.js';
import { validDevelopmentAdminConfig } from '../fixtures/admin.js';

/**
 * Restoring quarantined content through the admin panel (#153), against real
 * PostgreSQL and the roles each half runs as: the command previews through
 * the reader and queues through the operator, which cannot write letter
 * content; the maintenance half puts the content back as the owner.
 */

const { Pool } = pg;
const enabled = process.env.LIRL_RUN_POSTGRES_INTEGRATION === 'true';
const describePostgres = enabled ? describe : describe.skip;

const READER_ROLE = 'letter_irl_admin_reader_development';
const OPERATOR_ROLE = 'letter_irl_admin_operator_development';
const ROLE_PASSWORD = 'retention-restore-test-password';
const OWNER = 'owner@example.com';
const SECRET_BODY = 'Dear Sam, the restore secret';

function schemaName(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function urlFor(baseUrl: string, schema: string, role?: string): string {
  const parsed = new URL(baseUrl);
  if (role) {
    parsed.username = role;
    parsed.password = ROLE_PASSWORD;
  }
  parsed.searchParams.set('options', `-c search_path=${schema},public`);
  return parsed.toString();
}

describePostgres('retention restore through the admin panel', () => {
  let adminPool: pg.Pool;
  let owner: pg.Pool;
  let reader: pg.Pool;
  let operator: pg.Pool;
  let schema: string;
  let config: AdminRuntimeConfig;
  let commands: typeof import('../../src/admin/commands/index.js');
  let runner: typeof import('../../src/admin/commands/runner.js');
  let retention: typeof import('../../src/services/retentionService.js');
  let db: typeof import('../../src/db/index.js');
  let opsQueries: typeof import('../../src/admin/queries/ops.js');
  let accountQueries: typeof import('../../src/admin/queries/accounts.js');

  beforeAll(async () => {
    const baseUrl = validateDisposableDatabaseUrl(process.env.LIRL_TEST_DATABASE_URL);
    adminPool = new Pool({ connectionString: baseUrl });
    schema = schemaName('lirl_restore');
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const scoped = urlFor(baseUrl, schema);
    await migrate({ connectionString: scoped, migrationsDirectory: repositoryMigrations });
    owner = new Pool({ connectionString: scoped, max: 4 });

    for (const role of [READER_ROLE, OPERATOR_ROLE]) {
      await adminPool.query(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
            CREATE ROLE "${role}" LOGIN PASSWORD '${ROLE_PASSWORD}';
          ELSE
            ALTER ROLE "${role}" WITH LOGIN PASSWORD '${ROLE_PASSWORD}';
          END IF;
        END $$`);
    }
    await owner.query(
      `INSERT INTO admin_environment_marker (environment, configured_by) VALUES ('development', 'test')`
    );
    for (const statement of buildAdminGrantStatements(parseAdminEnvironmentConfig(validDevelopmentAdminConfig), schema)) {
      await owner.query(statement);
    }
    const readerUrl = urlFor(baseUrl, schema, READER_ROLE);
    const operatorUrl = urlFor(baseUrl, schema, OPERATOR_ROLE);
    reader = new Pool({ connectionString: readerUrl, max: 2 });
    operator = new Pool({ connectionString: operatorUrl, max: 4 });

    // The sweep and the restore run in maintenance, as the owner.
    process.env.DATABASE_URL = scoped;
    commands = await import('../../src/admin/commands/index.js');
    runner = await import('../../src/admin/commands/runner.js');
    retention = await import('../../src/services/retentionService.js');
    db = await import('../../src/db/index.js');
    opsQueries = await import('../../src/admin/queries/ops.js');
    accountQueries = await import('../../src/admin/queries/accounts.js');

    config = parseAdminRuntimeConfig({
      LETTER_IRL_DEPLOYMENT_ENVIRONMENT: 'development',
      ADMIN_MODE: 'full',
      ADMIN_OPERATOR_LOGINS: OWNER,
      ADMIN_READER_DATABASE_URL: readerUrl,
      DATABASE_URL: operatorUrl,
      ADMIN_SESSION_SECRET: 's'.repeat(40),
      ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      PORT: '8080',
      ADMIN_APP_PORT: '8790'
    });
  }, 180_000);

  afterAll(async () => {
    await db?.closePool();
    await reader?.end();
    await operator?.end();
    await owner?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.query(`DROP ROLE IF EXISTS "${READER_ROLE}", "${OPERATOR_ROLE}"`);
      await adminPool.end();
    }
  });

  function deps() {
    const store = new AdminSessionStore({ idleTtlMs: 60_000, absoluteTtlMs: 600_000 });
    const session: AdminSession = store.create({ login: OWNER, name: 'Owner', node: 'laptop.tail1234.ts.net', peerAddress: '100.64.0.5' });
    session.elevatedUntil = Date.now() + 10 * 60_000;
    return {
      config,
      reader,
      operator,
      audit: new AdminAuditWriter(),
      actor: { id: OWNER, name: 'Owner', node: 'laptop.tail1234.ts.net' },
      session,
      elevation: new ElevationGuard(),
      sessionIdHash: hashSessionId(session.id),
      correlationId: randomUUID(),
      now: () => Date.now()
    };
  }

  async function preview(quarantineId: string) {
    const command = commands.findAdminCommand('retention.restore')!;
    return withReadOnlyTransaction(reader, (client) =>
      runner.prepareCommandPreview(command, client, 'development', quarantineId, new Map())
    );
  }

  async function confirm(quarantineId: string) {
    const command = commands.findAdminCommand('retention.restore')!;
    const prepared = await preview(quarantineId);
    const fields = new Map(
      Object.entries({
        previewDigest: prepared.previewDigest,
        expectedVersion: prepared.preview.expectedVersion ?? '',
        idempotencyKey: prepared.idempotencyKey,
        reason: 'integration test: wrong sweep',
        phrase: prepared.phrase
      })
    );
    return runner.runAdminCommand(deps(), command, quarantineId, fields);
  }

  /** A delivered letter far past the window, swept into the quarantine. */
  async function sweptLetter(): Promise<{ letterId: string; quarantineId: string }> {
    const userId = `auth0|restore-${randomUUID()}`;
    await owner.query(`INSERT INTO users (user_id, email) VALUES ($1, $2)`, [userId, `${randomUUID()}@example.test`]);
    const letterId = `letter_${randomUUID()}`;
    await owner.query(
      `INSERT INTO letters (letter_id, user_id, content, recipient, credits_cost, status, mail_type, sent_at)
       VALUES ($1, $2, $3::jsonb, '{"name":"Sam"}'::jsonb, 2, 'delivered', 'letter', NOW() - INTERVAL '120 days')`,
      [letterId, userId, JSON.stringify({ bodyText: SECRET_BODY })]
    );
    await retention.purgeExpiredLetterContent();
    const saved = await owner.query<{ quarantine_id: string }>(
      `SELECT quarantine_id FROM redacted_content_quarantine WHERE source_table = 'letters' AND source_id = $1`,
      [letterId]
    );
    expect(saved.rows).toHaveLength(1);
    return { letterId, quarantineId: saved.rows[0].quarantine_id };
  }

  it('previews through the reader, queues through the operator, and restores as the owner', async () => {
    const { letterId, quarantineId } = await sweptLetter();

    const prepared = await preview(quarantineId);
    expect(prepared.phrase).toBe(`CONFIRM ${quarantineId}`);
    expect(prepared.preview.summary).toMatchObject({ sourceTable: 'letters', sourceId: letterId });
    expect(JSON.stringify(prepared.preview.summary)).not.toContain(SECRET_BODY);

    const outcome = await confirm(quarantineId);
    expect(outcome).toMatchObject({ status: 'succeeded', result: { status: 'queued' } });
    const operationId = String(outcome.result.operationId);
    // Nothing is back until maintenance runs, and a second restore waits its turn.
    expect((await owner.query(`SELECT content FROM letters WHERE letter_id = $1`, [letterId])).rows[0].content).toEqual({});
    await expect(preview(quarantineId)).rejects.toMatchObject({ code: 'ADMIN_INVALID_STATE' });

    expect(await retention.processRetentionRestores()).toEqual({ done: 1, refused: 0, retrying: 0, failed: 0 });

    const letter = await owner.query(`SELECT content, redacted_at FROM letters WHERE letter_id = $1`, [letterId]);
    expect(letter.rows[0].content).toEqual({ bodyText: SECRET_BODY });
    expect(letter.rows[0].redacted_at).toBeNull();
    expect((await owner.query(`SELECT 1 FROM redacted_content_quarantine WHERE quarantine_id = $1`, [quarantineId])).rowCount).toBe(0);
    const operation = await owner.query(
      `SELECT status, error_code, sanitized_result_json FROM admin_operations WHERE id = $1`,
      [operationId]
    );
    expect(operation.rows[0]).toEqual({ status: 'succeeded', error_code: null, sanitized_result_json: { sourceTable: 'letters' } });
    const payload = await owner.query(`SELECT payload_json FROM admin_operations WHERE id = $1`, [operationId]);
    expect(payload.rows[0].payload_json).toEqual({ quarantineId, sourceTable: 'letters', sourceId: letterId });
    // The copy is gone, so there is nothing left to preview.
    await expect(preview(quarantineId)).rejects.toMatchObject({ code: 'ADMIN_NOT_FOUND' });
  }, 60_000);

  it('refuses at preview when the window has closed or the content is live', async () => {
    const closed = await sweptLetter();
    await owner.query(
      `UPDATE redacted_content_quarantine
          SET quarantined_at = NOW() - INTERVAL '10 days', purge_after = NOW() - INTERVAL '1 hour'
        WHERE quarantine_id = $1`,
      [closed.quarantineId]
    );
    await expect(preview(closed.quarantineId)).rejects.toMatchObject({ code: 'ADMIN_INVALID_STATE' });

    const live = await sweptLetter();
    await owner.query(`UPDATE letters SET redacted_at = NULL WHERE letter_id = $1`, [live.letterId]);
    await expect(preview(live.quarantineId)).rejects.toMatchObject({ code: 'ADMIN_INVALID_STATE' });
  }, 60_000);

  it('refuses in maintenance when the copy is gone by the time it runs', async () => {
    const { quarantineId } = await sweptLetter();
    const outcome = await confirm(quarantineId);
    await owner.query(`DELETE FROM redacted_content_quarantine WHERE quarantine_id = $1`, [quarantineId]);

    expect(await retention.processRetentionRestores()).toEqual({ done: 0, refused: 1, retrying: 0, failed: 0 });

    const operation = await owner.query(
      `SELECT status, error_code, sanitized_result_json FROM admin_operations WHERE id = $1`,
      [String(outcome.result.operationId)]
    );
    expect(operation.rows[0]).toEqual({
      status: 'failed',
      error_code: 'RETENTION_RESTORE_UNAVAILABLE',
      sanitized_result_json: { reason: 'window_closed' }
    });
  }, 60_000);

  it('finds a copy by its letter or its account, and shows the restore, through the reader (#450 review)', async () => {
    const { letterId, quarantineId } = await sweptLetter();
    const userId = (await owner.query(`SELECT user_id FROM letters WHERE letter_id = $1`, [letterId])).rows[0].user_id;

    // Older copies than the newest page are still reachable: by account, and by the letter.
    const byAccount = await withReadOnlyTransaction(reader, (client) => opsQueries.listQuarantine(client, 100, userId));
    expect(byAccount).toEqual([expect.objectContaining({ quarantineId, sourceTable: 'letters', sourceId: letterId, userId })]);
    const byLetter = await withReadOnlyTransaction(reader, (client) => opsQueries.listQuarantine(client, 100, letterId));
    expect(byLetter.map((row) => row.quarantineId)).toEqual([quarantineId]);
    expect(await withReadOnlyTransaction(reader, (client) => opsQueries.listQuarantine(client, 100, `auth0|nobody-${randomUUID()}`))).toEqual([]);
    // And from the letter's own page.
    const detail = await withReadOnlyTransaction(reader, (client) => accountQueries.readLetterDetail(client, letterId));
    expect(detail?.savedCopy).toEqual({ quarantineId, purgeAfter: expect.any(Date) });

    const outcome = await confirm(quarantineId);
    const operationId = String(outcome.result.operationId);
    const queued = await withReadOnlyTransaction(reader, (client) => opsQueries.listRecentRestores(client, 20));
    expect(queued.find((row) => row.operationId === operationId)).toMatchObject({
      status: 'pending',
      sourceTable: 'letters',
      sourceId: letterId
    });

    expect(await retention.processRetentionRestores()).toEqual({ done: 1, refused: 0, retrying: 0, failed: 0 });
    const finished = await withReadOnlyTransaction(reader, (client) => opsQueries.listRecentRestores(client, 20));
    expect(finished.find((row) => row.operationId === operationId)).toMatchObject({
      status: 'succeeded',
      result: { sourceTable: 'letters' }
    });
    expect((await withReadOnlyTransaction(reader, (client) => accountQueries.readLetterDetail(client, letterId)))?.savedCopy).toBeNull();

    // A second restore of the same copy - the panel's check and its enqueue are
    // separate transactions - finds the first one's success and counts as done.
    const again = await db.transaction((client) => retention.handleRetentionRestore(client, { quarantineId: quarantineId.toUpperCase() }));
    expect(again).toEqual({ outcome: 'done', result: { alreadyRestored: true }, diagnostic: { alreadyRestored: true } });
  }, 60_000);

  it('cannot restore through the operator role directly', async () => {
    const { letterId } = await sweptLetter();
    await expect(
      operator.query(`UPDATE letters SET content = '{"bodyText":"x"}'::jsonb WHERE letter_id = $1`, [letterId])
    ).rejects.toMatchObject({ code: '42501' });
    await expect(operator.query(`SELECT content FROM redacted_content_quarantine LIMIT 1`)).rejects.toMatchObject({
      code: '42501'
    });
  }, 60_000);
});
