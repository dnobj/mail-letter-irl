import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import { repositoryMigrations, validateDisposableDatabaseUrl } from './support/disposableDatabase.js';
import { AdminAuditWriter } from '../../src/admin/auditService.js';
import { parseAdminEnvironmentConfig } from '../../src/admin/config.js';
import { withReadOnlyTransaction } from '../../src/admin/db.js';
import { AdminSessionStore, hashSessionId, type AdminSession } from '../../src/admin/http/session.js';
import { buildAdminGrantStatements } from '../../src/admin/provisioning.js';
import { parseAdminRuntimeConfig, type AdminRuntimeConfig } from '../../src/admin/runtimeConfig.js';
import { validDevelopmentAdminConfig } from '../fixtures/admin.js';

/**
 * The command runner against real PostgreSQL as the operator role: the run
 * row, the panel audit row and the domain's own change commit together; a
 * replayed confirmation returns the first outcome without a second mutation;
 * two identical confirmations at once produce one mutation; a stale preview
 * is refused before anything is written; and the operator role can do
 * exactly these writes and nothing else.
 */

const { Pool } = pg;
const enabled = process.env.LIRL_RUN_POSTGRES_INTEGRATION === 'true';
const describePostgres = enabled ? describe : describe.skip;

const READER_ROLE = 'letter_irl_admin_reader_development';
const OPERATOR_ROLE = 'letter_irl_admin_operator_development';
const ROLE_PASSWORD = 'admin-commands-test-password';
const OWNER = 'owner@example.com';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

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

describePostgres('admin commands through the operator role', () => {
  let adminPool: pg.Pool;
  let owner: pg.Pool;
  let reader: pg.Pool;
  let operator: pg.Pool;
  let schema: string;
  let config: AdminRuntimeConfig;
  let commands: typeof import('../../src/admin/commands/index.js');
  let runner: typeof import('../../src/admin/commands/runner.js');
  let stripeCommands: typeof import('../../src/admin/commands/stripe.js');
  let closeServicePool: (() => Promise<void>) | undefined;

  const userId = `auth0|${randomUUID()}`;
  const heldLetterId = `letter_${randomUUID()}`;
  const heldJobId = randomUUID();
  const failedLetterId = `letter_${randomUUID()}`;
  const failedJobId = randomUUID();
  let alertId: string;

  beforeAll(async () => {
    const baseUrl = validateDisposableDatabaseUrl(process.env.LIRL_TEST_DATABASE_URL);
    adminPool = new Pool({ connectionString: baseUrl });
    schema = schemaName('lirl_admincmd');
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

    // The domain services run through the global pool, which is the
    // operator role in full mode: their writes prove the grants.
    process.env.DATABASE_URL = operatorUrl;
    commands = await import('../../src/admin/commands/index.js');
    runner = await import('../../src/admin/commands/runner.js');
    stripeCommands = await import('../../src/admin/commands/stripe.js');
    closeServicePool = (await import('../../src/db/index.js')).closePool;

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

    await owner.query(
      `INSERT INTO users (user_id, email, credits, credits_purchased, credits_used) VALUES ($1, $2, 4, 6, 2)`,
      [userId, `commands.${randomUUID().slice(0, 8)}@example.test`]
    );
    for (const [letterId, letterStatus] of [
      [heldLetterId, 'held'],
      [failedLetterId, 'failed']
    ] as const) {
      await owner.query(
        `INSERT INTO letters (letter_id, user_id, content, recipient, credits_cost, status, mail_type)
         VALUES ($1, $2, '{"body":"x"}'::jsonb, '{"name":"y"}'::jsonb, 2, $3, 'letter')`,
        [letterId, userId, letterStatus]
      );
    }
    await owner.query(
      `INSERT INTO letter_jobs (job_id, letter_id, status, attempts, max_attempts, scheduled_at, idempotency_key,
         next_attempt_at, provider_outcome, provider_dispatch_started_at, held_at, hold_reason)
       VALUES ($1, $2, 'held', 1, 3, NOW(), $2, NOW(), 'ambiguous', NOW(), NOW(), 'provider_timeout')`,
      [heldJobId, heldLetterId]
    );
    await owner.query(
      `INSERT INTO letter_jobs (job_id, letter_id, status, attempts, max_attempts, scheduled_at, idempotency_key,
         next_attempt_at, provider_outcome, last_error)
       VALUES ($1, $2, 'failed', 3, 3, NOW(), $2, NOW(), 'definite_failure', 'provider rejected: bad address')`,
      [failedJobId, failedLetterId]
    );
    const alert = await owner.query<{ alert_id: string }>(
      `INSERT INTO commerce_operational_alerts (alert_type, severity, status, details)
       VALUES ('mail_provider_outcome_ambiguous', 'critical', 'open', '{}'::jsonb) RETURNING alert_id`
    );
    alertId = alert.rows[0].alert_id;
  }, 180_000);

  afterAll(async () => {
    await closeServicePool?.();
    await reader?.end();
    await operator?.end();
    await owner?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.query(`DROP ROLE IF EXISTS "${READER_ROLE}", "${OPERATOR_ROLE}"`);
      await adminPool.end();
    }
  });

  function elevatedSession(): AdminSession {
    const store = new AdminSessionStore({ idleTtlMs: 60_000, absoluteTtlMs: 600_000 });
    const session = store.create({ login: OWNER, name: 'Owner', node: 'laptop.tail1234.ts.net', peerAddress: '100.64.0.5' });
    session.elevatedUntil = Date.now() + 10 * 60_000;
    return session;
  }

  function deps(overrides: Partial<AdminRuntimeConfig> = {}) {
    const session = elevatedSession();
    const effective = { ...config, ...overrides };
    return {
      config: effective,
      reader,
      operator: effective.mode === 'full' ? operator : null,
      audit: new AdminAuditWriter(),
      actor: { id: OWNER, name: 'Owner', node: 'laptop.tail1234.ts.net' },
      session,
      sessionIdHash: hashSessionId(session.id),
      correlationId: randomUUID(),
      now: () => Date.now()
    };
  }

  async function confirmation(commandName: string, targetId: string, input: Record<string, string>, reason = 'integration test reason') {
    const command = commands.findAdminCommand(commandName)!;
    const prepared = await withReadOnlyTransaction(reader, (client) =>
      runner.prepareCommandPreview(command, client, 'development', targetId, new Map(Object.entries(input)))
    );
    return {
      command,
      fields: new Map(
        Object.entries({
          ...input,
          previewDigest: prepared.previewDigest,
          expectedVersion: prepared.preview.expectedVersion ?? '',
          idempotencyKey: prepared.idempotencyKey,
          reason,
          phrase: prepared.phrase
        })
      )
    };
  }

  async function operatorAuditRows(targetId: string): Promise<number> {
    const result = await owner.query(
      `SELECT 1 FROM commerce_operator_audit_events WHERE target_reference_hash = $1`,
      [hash(targetId)]
    );
    return result.rowCount ?? 0;
  }

  it('acknowledges an alert: run row, panel audit and domain audit commit together, and a replay runs nothing twice', async () => {
    const { command, fields } = await confirmation('alert.transition', alertId, { status: 'acknowledged' });
    expect(fields.get('phrase')).toBe(`CONFIRM ${alertId}`);

    const outcome = await runner.runAdminCommand(deps(), command, alertId, fields);
    expect(outcome).toMatchObject({ status: 'succeeded', replayed: false, result: { status: 'acknowledged', domainReplayed: false } });

    const alert = await owner.query<{ status: string; acknowledged_by_actor_hash: string }>(
      `SELECT status, acknowledged_by_actor_hash FROM commerce_operational_alerts WHERE alert_id = $1`,
      [alertId]
    );
    expect(alert.rows[0]).toEqual({ status: 'acknowledged', acknowledged_by_actor_hash: hash(OWNER) });
    const run = await owner.query<{ status: string; actor_sid: string; action: string; target_id: string }>(
      `SELECT status, actor_sid, action, target_id FROM admin_command_runs WHERE id = $1`,
      [outcome.commandId]
    );
    expect(run.rows[0]).toEqual({ status: 'succeeded', actor_sid: OWNER, action: 'alert.transition', target_id: alertId });
    const audit = await owner.query<{ outcome: string; reason: string; input_summary_json: Record<string, unknown> }>(
      `SELECT outcome, reason, input_summary_json FROM admin_audit_events WHERE command_id = $1`,
      [outcome.commandId]
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ outcome: 'succeeded', reason: 'integration test reason' });
    expect(audit.rows[0].input_summary_json).toMatchObject({ status: 'acknowledged', actorNode: 'laptop.tail1234.ts.net' });
    expect(await operatorAuditRows(alertId)).toBe(1);

    const replay = await runner.runAdminCommand(deps(), command, alertId, fields);
    expect(replay).toMatchObject({ commandId: outcome.commandId, status: 'succeeded', replayed: true });
    expect(await operatorAuditRows(alertId)).toBe(1);
  }, 60_000);

  it('refuses a stale preview before writing anything', async () => {
    const { command, fields } = await confirmation('alert.transition', alertId, { status: 'resolved', resolutionCode: 'stale_probe' });
    await owner.query(`UPDATE commerce_operational_alerts SET updated_at = NOW() + INTERVAL '1 second' WHERE alert_id = $1`, [alertId]);
    await expect(runner.runAdminCommand(deps(), command, alertId, fields)).rejects.toMatchObject({ code: 'ADMIN_STALE_PREVIEW' });
    const runs = await owner.query(`SELECT 1 FROM admin_command_runs WHERE idempotency_key = $1`, [fields.get('idempotencyKey')]);
    expect(runs.rowCount).toBe(0);
    const alert = await owner.query<{ status: string }>(`SELECT status FROM commerce_operational_alerts WHERE alert_id = $1`, [alertId]);
    expect(alert.rows[0].status).toBe('acknowledged');
  }, 60_000);

  it('yields one mutation for two identical confirmations submitted at once', async () => {
    const { command, fields } = await confirmation('alert.transition', alertId, { status: 'resolved', resolutionCode: 'handled_in_dashboard' });
    const [first, second] = await Promise.all([
      runner.runAdminCommand(deps(), command, alertId, fields),
      runner.runAdminCommand(deps(), command, alertId, fields)
    ]);
    expect(first.status).toBe('succeeded');
    expect(second.status).toBe('succeeded');
    expect(first.commandId).toBe(second.commandId);
    const alert = await owner.query<{ status: string; resolution_code: string }>(
      `SELECT status, resolution_code FROM commerce_operational_alerts WHERE alert_id = $1`,
      [alertId]
    );
    expect(alert.rows[0]).toEqual({ status: 'resolved', resolution_code: 'handled_in_dashboard' });
    // One acknowledge and one resolve: the concurrent pair produced a single domain audit row.
    expect(await operatorAuditRows(alertId)).toBe(2);
    const runs = await owner.query(`SELECT status FROM admin_command_runs WHERE idempotency_key = $1`, [fields.get('idempotencyKey')]);
    expect(runs.rows).toEqual([{ status: 'succeeded' }]);
  }, 60_000);

  it('refuses a transition the state machine forbids at preview time, with no run row', async () => {
    await expect(confirmation('alert.transition', alertId, { status: 'acknowledged' })).rejects.toMatchObject({ code: 'ADMIN_INVALID_STATE' });
  });

  it('resolves an ambiguous job as accepted with provider evidence', async () => {
    const { command, fields } = await confirmation('job.resolve', heldJobId, {
      decision: 'accepted',
      providerName: 'dummy',
      providerTrackingId: 'trk_integration_1'
    });
    expect(fields.get('phrase')).toBe(`CONFIRM ${heldJobId}`);
    const outcome = await runner.runAdminCommand(deps(), command, heldJobId, fields);
    expect(outcome).toMatchObject({ status: 'succeeded', result: { decision: 'accepted', jobStatus: 'completed', letterStatus: 'accepted' } });
    const letter = await owner.query<{ status: string; tracking_id: string; provider: string }>(
      `SELECT status, tracking_id, provider FROM letters WHERE letter_id = $1`,
      [heldLetterId]
    );
    expect(letter.rows[0]).toEqual({ status: 'accepted', tracking_id: 'trk_integration_1', provider: 'dummy' });
    const job = await owner.query<{ status: string; provider_outcome: string; operator_resolution: string }>(
      `SELECT status, provider_outcome, operator_resolution FROM letter_jobs WHERE job_id = $1`,
      [heldJobId]
    );
    expect(job.rows[0]).toMatchObject({ status: 'completed', provider_outcome: 'accepted' });
    expect(await operatorAuditRows(heldJobId)).toBe(1);
    // The audit summary carries a hash of the provider reference, never the reference.
    const audit = await owner.query<{ before_summary_json: Record<string, unknown> }>(
      `SELECT before_summary_json FROM admin_audit_events WHERE command_id = $1`,
      [outcome.commandId]
    );
    expect(JSON.stringify(audit.rows[0].before_summary_json)).not.toContain('trk_integration_1');
    expect(audit.rows[0].before_summary_json.providerTrackingIdHash).toBe(hash('trk_integration_1'));
  }, 60_000);

  it('retries a definite failure and then refuses to retry the re-queued job', async () => {
    const { command, fields } = await confirmation('job.retry', failedJobId, {}, 'provider confirmed the rejection was transient');
    const outcome = await runner.runAdminCommand(deps(), command, failedJobId, fields);
    expect(outcome).toMatchObject({ status: 'succeeded', result: { jobStatus: 'pending' } });
    const job = await owner.query<{ status: string; provider_outcome: string }>(
      `SELECT status, provider_outcome FROM letter_jobs WHERE job_id = $1`,
      [failedJobId]
    );
    expect(job.rows[0]).toEqual({ status: 'pending', provider_outcome: 'not_dispatched' });
    const letter = await owner.query<{ status: string }>(`SELECT status FROM letters WHERE letter_id = $1`, [failedLetterId]);
    expect(letter.rows[0].status).toBe('queued');
    await expect(confirmation('job.retry', failedJobId, {})).rejects.toMatchObject({ code: 'ADMIN_INVALID_STATE' });
  }, 60_000);

  it('refuses in read-only mode and without elevation, touching nothing', async () => {
    const { command, fields } = await confirmation('job.resolve', heldJobId, { decision: 'rejected', providerName: 'dummy' }).catch(() => ({
      command: commands.findAdminCommand('job.resolve')!,
      fields: new Map<string, string>()
    }));
    await expect(runner.runAdminCommand(deps({ mode: 'read-only' }), command, heldJobId, fields)).rejects.toMatchObject({
      code: 'ADMIN_READ_ONLY_MODE'
    });
    const unelevated = deps();
    unelevated.session.elevatedUntil = null;
    await expect(runner.runAdminCommand(unelevated, command, heldJobId, fields)).rejects.toMatchObject({
      code: 'ADMIN_ELEVATION_REQUIRED'
    });
  });

  it('refunds one letter of a pack through the command: letters first, the run id on the refund row, Stripe stubbed', async () => {
    const packUserId = `auth0|${randomUUID()}`;
    const orderId = `order_${randomUUID()}`;
    const paymentIntentId = `pi_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const sessionId = `cs_test_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    await owner.query(
      `INSERT INTO users (user_id, email, credits, credits_purchased, credits_used) VALUES ($1, $2, 4, 4, 0)`,
      [packUserId, `pack.${randomUUID().slice(0, 8)}@example.test`]
    );
    await owner.query(
      `INSERT INTO orders (order_id, user_id, credits, amount_cents, currency, stripe_payment_intent_id,
         stripe_checkout_session_id, status, order_type, product_code, idempotency_key, paid_at, fulfilled_at)
       VALUES ($1, $2, 4, 1999, 'usd', $3, $4, 'fulfilled', 'letter_pack', 'starter', $5, NOW(), NOW())`,
      [orderId, packUserId, paymentIntentId, sessionId, `idem_${orderId}`]
    );
    await owner.query(
      `INSERT INTO credit_ledger (user_id, initial_amount, remaining_amount, source_type, source_reference_id,
         source_order_id, source_metadata, activated_at, expires_at, expiration_policy, status)
       VALUES ($1, 4, 4, 'purchase', $2, $2, $3::jsonb, NOW(), NOW() + INTERVAL '365 days', 'days_from_activation', 'active')`,
      [packUserId, orderId, JSON.stringify({ stripe_session_id: sessionId })]
    );

    const created: Array<Record<string, unknown>> = [];
    const stripe = stripeCommands.createStripeCommands({
      packRefundOperations: {
        async createPartialPaymentRefund(params) {
          created.push(params as unknown as Record<string, unknown>);
          return {
            id: `re_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
            object: 'refund',
            status: 'succeeded',
            amount: params.amountCents,
            payment_intent: params.paymentIntentId,
            metadata: { orderId: params.orderId, packRefundId: params.packRefundId, lettersRefunded: String(params.lettersRefunded) }
          } as never;
        },
        async listPaymentRefunds() {
          return [];
        },
        async retrieveRefund() {
          throw new Error('not expected');
        }
      },
      environment: () => ({ LETTER_IRL_DEPLOYMENT_ENVIRONMENT: 'development', LETTER_IRL_PACK_REFUND_COMMAND_ENABLED: 'true' })
    });
    const enabledConfig = { ...config, packRefundCommandEnabled: true };
    const prepared = await withReadOnlyTransaction(reader, (client) =>
      runner.prepareCommandPreview(stripe.refundLetters, client, 'development', orderId, new Map([['letters', '1'], ['reasonCode', 'customer_request']]))
    );
    expect(prepared.preview.summary).toMatchObject({ amountCents: 999, lettersInPack: 2, lettersRemaining: 2 });
    const fields = new Map(
      Object.entries({
        letters: '1',
        reasonCode: 'customer_request',
        previewDigest: prepared.previewDigest,
        expectedVersion: prepared.preview.expectedVersion ?? '',
        idempotencyKey: prepared.idempotencyKey,
        reason: 'customer asked for one letter back',
        phrase: prepared.phrase
      })
    );

    const outcome = await runner.runAdminCommand({ ...deps(), config: enabledConfig }, stripe.refundLetters, orderId, fields);
    expect(outcome).toMatchObject({ status: 'succeeded', result: { status: 'succeeded', amountCents: 999, domainReplayed: false } });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ paymentIntentId, amountCents: 999, orderId, lettersRefunded: 1 });

    const refundRow = await owner.query<{ status: string; admin_command_id: string; letters: number; amount_cents: number }>(
      `SELECT status, admin_command_id, letters, amount_cents FROM commerce_pack_refunds WHERE order_id = $1`,
      [orderId]
    );
    expect(refundRow.rows).toEqual([{ status: 'succeeded', admin_command_id: outcome.commandId, letters: 1, amount_cents: 999 }]);
    const lot = await owner.query<{ remaining_amount: number }>(`SELECT remaining_amount FROM credit_ledger WHERE source_order_id = $1 AND source_type = 'purchase'`, [orderId]);
    expect(lot.rows[0].remaining_amount).toBe(2);
    const user = await owner.query<{ credits: number }>(`SELECT credits FROM users WHERE user_id = $1`, [packUserId]);
    expect(user.rows[0].credits).toBe(2);
    const order = await owner.query<{ credits_refunded: number; amount_refunded_cents: number }>(
      `SELECT credits_refunded, amount_refunded_cents FROM orders WHERE order_id = $1`,
      [orderId]
    );
    expect(order.rows[0]).toEqual({ credits_refunded: 2, amount_refunded_cents: 999 });

    // The flag gates the command at the panel as well as in the service.
    await expect(
      runner.runAdminCommand({ ...deps(), config: { ...config, packRefundCommandEnabled: false } }, stripe.refundLetters, orderId, fields)
    ).rejects.toMatchObject({ code: 'ADMIN_COMMAND_DISABLED' });
  }, 60_000);

  it('lets the operator role perform exactly the granted writes', async () => {
    await expect(operator.query(`DELETE FROM letters WHERE letter_id = $1`, [heldLetterId])).rejects.toMatchObject({ code: '42501' });
    await expect(operator.query(`UPDATE admin_audit_events SET reason = 'x'`)).rejects.toMatchObject({ code: '42501' });
    await expect(operator.query(`SELECT token_hash FROM personal_access_tokens LIMIT 1`)).rejects.toMatchObject({ code: '42501' });
    await expect(operator.query(`TRUNCATE commerce_operational_alerts`)).rejects.toMatchObject({ code: '42501' });
    // The domain services select whole rows from letters, so the operator may.
    await expect(operator.query(`SELECT * FROM letters WHERE letter_id = $1`, [heldLetterId])).resolves.toBeTruthy();
    await expect(operator.query(`INSERT INTO admin_operations (command_id, operation_type, environment, payload_json)
      VALUES ($1, 'probe', 'development', '{}'::jsonb)`, [randomUUID()])).rejects.toBeTruthy(); // FK to a run that does not exist
  });
});
