import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import { repositoryMigrations, validateDisposableDatabaseUrl } from './support/disposableDatabase.js';
import { AdminAuditWriter } from '../../src/admin/auditService.js';
import { parseAdminEnvironmentConfig } from '../../src/admin/config.js';
import { verifyDatabaseIdentity, withReadOnlyTransaction } from '../../src/admin/db.js';
import { ADMIN_LATEST_REQUIRED_MIGRATION, buildAdminGrantStatements } from '../../src/admin/provisioning.js';
import { readAccountDetail, revealAccountEmail } from '../../src/admin/queries/accounts.js';
import { countAlerts, listAlerts, listUnmatchedWebhookEvents } from '../../src/admin/queries/alerts.js';
import { listAuditEvents } from '../../src/admin/queries/audit.js';
import { listBlockedAccounts, listDisputes } from '../../src/admin/queries/disputes.js';
import { listAttentionJobs, readJob } from '../../src/admin/queries/jobs.js';
import { lookupIdentifier } from '../../src/admin/queries/lookup.js';
import { readMaintenanceHealth } from '../../src/admin/queries/maintenance.js';
import { readOrderDetail } from '../../src/admin/queries/orders.js';
import { validDevelopmentAdminConfig } from '../fixtures/admin.js';

/**
 * The read-only panel connects as letter_irl_admin_reader_<env>. This suite
 * logs in as that role against real PostgreSQL and proves two things the
 * unit tests cannot: that the column-level grants keep letter content,
 * recipients, return addresses and token hashes unselectable, and that every
 * read model the P0 pages use works with exactly those grants.
 */

const { Pool } = pg;
const enabled = process.env.LIRL_RUN_POSTGRES_INTEGRATION === 'true';
const describePostgres = enabled ? describe : describe.skip;

const READER_ROLE = 'letter_irl_admin_reader_development';
const OPERATOR_ROLE = 'letter_irl_admin_operator_development';
const ROLE_PASSWORD = 'admin-read-models-test-password';

function schemaName(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function urlForRole(baseUrl: string, schema: string, role: string): string {
  const parsed = new URL(baseUrl);
  parsed.username = role;
  parsed.password = ROLE_PASSWORD;
  parsed.searchParams.set('options', `-c search_path=${schema},public`);
  return parsed.toString();
}

function databaseUrlForSchema(baseUrl: string, schema: string): string {
  const parsed = new URL(baseUrl);
  parsed.searchParams.set('options', `-c search_path=${schema},public`);
  return parsed.toString();
}

function stripeId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

describePostgres('admin read models through the reader role', () => {
  let adminPool: pg.Pool;
  let owner: pg.Pool;
  let reader: pg.Pool;
  let schema: string;

  const userId = `auth0|${randomUUID()}`;
  const email = `pack.holder.${randomUUID().slice(0, 8)}@example.test`;
  const blockedUserId = `auth0|${randomUUID()}`;
  const orderId = `order_${randomUUID()}`;
  const paymentIntentId = stripeId('pi');
  const sessionId = stripeId('cs');
  const sentLetterId = `letter_${randomUUID()}`;
  const heldLetterId = `letter_${randomUUID()}`;
  const heldJobId = randomUUID();
  const disputeId = stripeId('dp');
  const eventId = stripeId('evt');
  let alertId: string;
  let lotId: string;

  beforeAll(async () => {
    const baseUrl = validateDisposableDatabaseUrl(process.env.LIRL_TEST_DATABASE_URL);
    adminPool = new Pool({ connectionString: baseUrl });
    schema = schemaName('lirl_adminread');
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const scoped = databaseUrlForSchema(baseUrl, schema);
    await migrate({ connectionString: scoped, migrationsDirectory: repositoryMigrations });
    owner = new Pool({ connectionString: scoped, max: 4 });

    // Login roles with a password, so the read models run as a real login and
    // not as the schema owner with SET ROLE. Idempotent: another suite may have
    // created the same cluster-wide roles without a password.
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
    const config = parseAdminEnvironmentConfig(validDevelopmentAdminConfig);
    for (const statement of buildAdminGrantStatements(config, schema)) {
      await owner.query(statement);
    }
    reader = new Pool({ connectionString: urlForRole(baseUrl, schema, READER_ROLE), max: 2 });

    // A customer who bought a two-letter pack ($19.99), mailed one letter, and
    // has one letter held on an ambiguous provider outcome.
    await owner.query(
      `INSERT INTO users (user_id, email, credits, credits_purchased, credits_used, return_address)
       VALUES ($1, $2, 2, 4, 2, '{"line1":"1 Private Way"}'::jsonb)`,
      [userId, email]
    );
    await owner.query(
      `INSERT INTO orders (order_id, user_id, credits, amount_cents, currency, stripe_payment_intent_id,
         stripe_checkout_session_id, status, order_type, product_code, idempotency_key, paid_at, fulfilled_at)
       VALUES ($1, $2, 4, 1999, 'usd', $3, $4, 'fulfilled', 'letter_pack', 'starter', $5, NOW(), NOW())`,
      [orderId, userId, paymentIntentId, sessionId, `idem_${orderId}`]
    );
    const lot = await owner.query<{ ledger_id: string }>(
      `INSERT INTO credit_ledger (user_id, initial_amount, remaining_amount, source_type, source_reference_id,
         source_order_id, source_metadata, activated_at, expires_at, expiration_policy, status)
       VALUES ($1, 4, 2, 'purchase', $2, $2, $3::jsonb, NOW(), NOW() + INTERVAL '365 days', 'days_from_activation', 'active')
       RETURNING ledger_id`,
      [userId, orderId, JSON.stringify({ stripe_session_id: sessionId })]
    );
    lotId = lot.rows[0].ledger_id;
    for (const [letterId, status] of [
      [sentLetterId, 'accepted'],
      [heldLetterId, 'held']
    ] as const) {
      await owner.query(
        `INSERT INTO letters (letter_id, user_id, content, recipient, credits_cost, status, tracking_id, mail_type)
         VALUES ($1, $2, '{"body":"private words"}'::jsonb, '{"name":"Private Person"}'::jsonb, 2, $3, $4, 'letter')`,
        [letterId, userId, status, status === 'accepted' ? stripeId('trk') : null]
      );
    }
    const deduction = await owner.query<{ transaction_id: number }>(
      `INSERT INTO credit_transactions (user_id, amount, balance_after, type, reference_type, reference_id, description)
       VALUES ($1, -2, 2, 'deduction', 'letter', $2, 'Letter to Wilhelmina Ashgrove') RETURNING transaction_id`,
      [userId, sentLetterId]
    );
    await owner.query(
      `INSERT INTO credit_consumption (transaction_id, ledger_id, amount, ledger_remaining_after) VALUES ($1, $2, 2, 2)`,
      [deduction.rows[0].transaction_id, lotId]
    );
    await owner.query(
      `INSERT INTO letter_jobs (job_id, letter_id, status, attempts, max_attempts, scheduled_at, idempotency_key,
         next_attempt_at, provider_outcome, provider_dispatch_started_at, held_at, hold_reason)
       VALUES ($1, $2, 'held', 1, 3, NOW(), $2, NOW(), 'ambiguous', NOW(), NOW(), 'provider_timeout')`,
      [heldJobId, heldLetterId]
    );
    await owner.query(
      `INSERT INTO stripe_webhook_events (event_id, event_type, provider_object_id, provider_payment_intent_id, processing_status)
       VALUES ($1, 'charge.refunded', $2, $3, 'unmatched')`,
      [eventId, stripeId('ch'), stripeId('pi')]
    );
    const alert = await owner.query<{ alert_id: string }>(
      `INSERT INTO commerce_operational_alerts (source_event_id, order_id, alert_type, severity, status, details)
       VALUES ($1, $2, 'stripe_partial_refund_unmatched', 'critical', 'open', '{"amountCents":500}'::jsonb)
       RETURNING alert_id`,
      [eventId, orderId]
    );
    alertId = alert.rows[0].alert_id;
    await owner.query(
      `INSERT INTO users (user_id, email, credits, credits_purchased, credits_used, sends_blocked_at, sends_blocked_reason)
       VALUES ($1, $2, 0, 2, 2, NOW(), 'payment_disputed')`,
      [blockedUserId, `blocked.${randomUUID().slice(0, 8)}@example.test`]
    );
    await owner.query(
      `INSERT INTO stripe_disputes (dispute_id, charge_id, payment_intent_id, user_id, amount_cents, currency, reason, status, evidence_due_by)
       VALUES ($1, $2, $3, $4, 999, 'usd', 'fraudulent', 'needs_response', NOW() + INTERVAL '7 days')`,
      [disputeId, stripeId('ch'), stripeId('pi'), blockedUserId]
    );
    await owner.query(
      `INSERT INTO maintenance_tasks (task_name, last_started_at, last_completed_at, last_status)
       VALUES ('provider-status-sync', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '59 minutes', 'completed')`
    );
  }, 180_000);

  afterAll(async () => {
    await reader?.end();
    await owner?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.query(`DROP ROLE IF EXISTS "${READER_ROLE}", "${OPERATOR_ROLE}"`);
      await adminPool.end();
    }
  });

  it('keeps content, recipients, return addresses and token hashes unselectable, and refuses every write', async () => {
    for (const forbidden of [
      'SELECT content FROM letters LIMIT 1',
      'SELECT recipient FROM letters LIMIT 1',
      'SELECT preview_html FROM letters LIMIT 1',
      'SELECT return_address FROM users LIMIT 1',
      'SELECT token_hash FROM personal_access_tokens LIMIT 1',
      'SELECT body_text FROM letter_drafts LIMIT 1',
      // The two free-text ledger descriptions: the send path wrote the
      // recipient's name here, and an operator adjustment wrote the operator's
      // reason (issue #162 security review, A-01 and A-13).
      'SELECT description FROM credit_transactions LIMIT 1',
      'SELECT description FROM credit_ledger LIMIT 1',
      'SELECT * FROM letters LIMIT 1',
      'SELECT * FROM users LIMIT 1',
      'SELECT * FROM credit_transactions LIMIT 1',
      'SELECT * FROM credit_ledger LIMIT 1',
      `UPDATE users SET credits = 0 WHERE user_id = '${userId}'`,
      `UPDATE commerce_operational_alerts SET status = 'resolved'`,
      `INSERT INTO credit_ledger (user_id, initial_amount, remaining_amount, source_type) VALUES ('${userId}', 1, 1, 'adjustment')`,
      `DELETE FROM letters`
    ]) {
      await expect(reader.query(forbidden), forbidden).rejects.toMatchObject({ code: '42501' });
    }
    await expect(reader.query('SELECT letter_id, status, tracking_id FROM letters LIMIT 1')).resolves.toBeTruthy();
    await expect(reader.query('SELECT user_id, email, credits FROM users LIMIT 1')).resolves.toBeTruthy();
    await expect(
      reader.query('SELECT transaction_id, amount, balance_after, type FROM credit_transactions LIMIT 1')
    ).resolves.toBeTruthy();
    await expect(
      reader.query('SELECT ledger_id, initial_amount, remaining_amount, status FROM credit_ledger LIMIT 1')
    ).resolves.toBeTruthy();
    // The reader records its own audit rows, and can never rewrite them.
    const audit = await reader.query<{ id: string }>(
      `INSERT INTO admin_audit_events (actor_sid, actor_name, environment, mode, session_id_hash, correlation_id,
         action, target_type, outcome)
       VALUES ('owner@example.com', 'Owner', 'development', 'read-only', $1, $2, 'pii.reveal', 'user', 'succeeded')
       RETURNING id`,
      ['a'.repeat(64), randomUUID()]
    );
    await expect(
      reader.query(`UPDATE admin_audit_events SET reason = 'rewritten' WHERE id = $1`, [audit.rows[0].id])
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('verifies the connected role and the environment marker, and fails closed on either', async () => {
    await expect(
      verifyDatabaseIdentity(reader, { role: READER_ROLE, environment: 'development' })
    ).resolves.toMatchObject({ roleName: READER_ROLE, marker: 'development' });
    await expect(
      verifyDatabaseIdentity(reader, { role: READER_ROLE, environment: 'production' })
    ).rejects.toMatchObject({ code: 'ADMIN_ENVIRONMENT_MISMATCH' });
    await expect(
      verifyDatabaseIdentity(reader, { role: OPERATOR_ROLE, environment: 'development' })
    ).rejects.toMatchObject({ code: 'ADMIN_DATABASE_ROLE_MISMATCH' });
  });

  it('refuses a write inside the read-only transaction wrapper', async () => {
    await expect(
      withReadOnlyTransaction(reader, (client) =>
        client.query(`UPDATE admin_command_runs SET status = 'failed'`)
      )
    ).rejects.toBeTruthy();
  });

  it('reads an account with its lots, orders and letters, masking the email until revealed', async () => {
    const detail = await withReadOnlyTransaction(reader, (client) => readAccountDetail(client, userId));
    expect(detail).not.toBeNull();
    expect(detail!.account.emailMasked).toBe(`p***@example.test`);
    expect(detail!.account.ledgerAvailable).toBe(2);
    expect(detail!.account.cacheMismatch).toBe(false);
    expect(detail!.lots).toHaveLength(1);
    expect(detail!.lots[0]).toMatchObject({ ledgerId: lotId, remainingAmount: 2, spendable: true, sourceOrderId: orderId });
    expect(detail!.orders.map((order) => order.orderId)).toEqual([orderId]);
    expect(detail!.letters).toHaveLength(2);
    const held = detail!.letters.find((letter) => letter.letterId === heldLetterId);
    expect(held).toMatchObject({ jobId: heldJobId, jobStatus: 'held', jobHoldReason: 'provider_timeout', hasTrackingId: false });
    expect(JSON.stringify(detail)).not.toContain('private words');
    expect(JSON.stringify(detail)).not.toContain('Private');
    // The seeded transaction description carries a recipient's name in the
    // shape the send path used to write. The account detail must not carry it:
    // this is the case whose absence let A-01 through, because the earlier
    // assertions only covered columns that hold content directly.
    expect(JSON.stringify(detail)).not.toContain('Wilhelmina');
    expect(JSON.stringify(detail)).not.toContain('Ashgrove');
    expect(await withReadOnlyTransaction(reader, (client) => revealAccountEmail(client, userId))).toBe(email);
    expect(await withReadOnlyTransaction(reader, (client) => readAccountDetail(client, 'auth0|nobody'))).toBeNull();
  });

  it('computes the pack figures the refund command would, from the same lots', async () => {
    const detail = await withReadOnlyTransaction(reader, (client) => readOrderDetail(client, orderId));
    expect(detail).not.toBeNull();
    expect(detail!.pack).toEqual({
      lettersInPack: 2,
      lettersRemaining: 1,
      creditsRemaining: 2,
      lettersRefundedBefore: 0,
      lettersConsumed: 1,
      perLetterCents: 999,
      // floor(1 * 1999 / 2) = 999: the pro-rata share, never more.
      maxProportionalRefundCents: 999,
      amountRefundedCents: 0,
      refundable: true,
      refundableReason: null
    });
    expect(detail!.letters.map((letter) => letter.letterId)).toEqual([sentLetterId]);
    expect(detail!.lots.map((lot) => lot.ledgerId)).toEqual([lotId]);
    expect(detail!.alerts.map((alert) => alert.alertId)).toEqual([alertId]);
    expect(detail!.emailMasked).toBe('p***@example.test');
  });

  it('lists what needs an operator: the held job, the open alert, the unmatched event, the dispute and the blocked account', async () => {
    const data = await withReadOnlyTransaction(reader, async (client) => ({
      jobs: await listAttentionJobs(client, 50),
      job: await readJob(client, heldJobId),
      alerts: await listAlerts(client, { filter: 'active', limit: 25 }),
      counts: await countAlerts(client),
      unmatched: await listUnmatchedWebhookEvents(client, 25),
      disputes: await listDisputes(client, { limit: 25, openOnly: true }),
      blocked: await listBlockedAccounts(client, 25)
    }));
    expect(data.jobs.map((job) => job.jobId)).toContain(heldJobId);
    expect(data.job).toMatchObject({ status: 'held', providerOutcome: 'ambiguous', userId, letterId: heldLetterId });
    expect(data.alerts.rows.map((alert) => alert.alertId)).toContain(alertId);
    expect(data.alerts.rows.find((alert) => alert.alertId === alertId)).toMatchObject({
      orderId,
      severity: 'critical',
      status: 'open'
    });
    expect(data.counts).toEqual({ open: 1, acknowledged: 0, critical: 1 });
    expect(data.unmatched.map((event) => event.eventId)).toEqual([eventId]);
    expect(data.disputes.map((dispute) => dispute.disputeId)).toEqual([disputeId]);
    expect(data.blocked).toHaveLength(1);
    expect(data.blocked[0]).toMatchObject({ userId: blockedUserId, sendsBlockedReason: 'payment_disputed', openDisputes: 1 });
  });

  it('reports maintenance health from the reader role', async () => {
    const health = await withReadOnlyTransaction(reader, (client) => readMaintenanceHealth(client));
    expect(health.marker).toBe('development');
    // Not a literal: provisioningGrants.test.ts already proves this constant is
    // the newest migration on disk, so naming it here leaves one place to edit
    // when a migration lands rather than two that drift.
    expect(health.latestMigration).toBe(ADMIN_LATEST_REQUIRED_MIGRATION);
    expect(health.outbox.held).toBe(1);
    expect(health.alerts).toEqual({ open: 1, acknowledged: 0, critical: 1 });
    expect(health.unmatchedWebhookEvents).toBe(1);
    expect(health.blockedAccounts).toBe(1);
    expect(health.accounts).toBe(2);
    expect(health.tasks.map((task) => task.taskName)).toContain('provider-status-sync');
    expect(health.lastWebhookReceivedAt).toBeInstanceOf(Date);
  });

  it('looks identifiers up exactly and never partially', async () => {
    const lookup = (term: string) => withReadOnlyTransaction(reader, (client) => lookupIdentifier(client, term));
    expect(await lookup(email.toUpperCase())).toEqual([
      expect.objectContaining({ kind: 'account', id: userId })
    ]);
    expect(await lookup(paymentIntentId)).toEqual([expect.objectContaining({ kind: 'order', id: orderId })]);
    expect(await lookup(heldJobId)).toEqual([expect.objectContaining({ kind: 'job', id: heldJobId })]);
    expect(await lookup(alertId)).toEqual([expect.objectContaining({ kind: 'alert', id: alertId })]);
    expect(await lookup(disputeId)).toEqual([expect.objectContaining({ kind: 'dispute', id: disputeId })]);
    expect(await lookup(eventId)).toEqual([expect.objectContaining({ kind: 'webhook_event', id: eventId })]);
    expect(await lookup(email.slice(0, 5))).toEqual([]);
  });

  it('pages the audit log the reader itself writes', async () => {
    const writer = new AdminAuditWriter();
    for (const action of ['admin.session_start', 'pii.reveal']) {
      await writer.appendEvent(reader, {
        actor: { id: 'owner@example.com', name: 'Owner', node: 'laptop.tail1234.ts.net' },
        environment: 'development',
        mode: 'read-only',
        sessionIdHash: 'b'.repeat(64),
        correlationId: randomUUID(),
        action,
        targetType: 'session',
        outcome: 'succeeded'
      });
    }
    const first = await withReadOnlyTransaction(reader, (client) => listAuditEvents(client, { limit: 1 }));
    expect(first.rows).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    expect(first.rows[0].inputSummary).toContain('laptop.tail1234.ts.net');
    const second = await withReadOnlyTransaction(reader, (client) =>
      listAuditEvents(client, { limit: 1, cursor: first.nextCursor ?? undefined })
    );
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0].id).not.toBe(first.rows[0].id);
  });
});
