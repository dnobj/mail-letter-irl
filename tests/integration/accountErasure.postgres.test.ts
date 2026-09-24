import { createHash, randomUUID } from 'node:crypto';
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
 * Account erasure (#289) against real PostgreSQL, with both halves on the
 * roles they run as in production:
 *
 *   - the command previews through the reader role and queues through the
 *     operator role, with the grants provisioning gives them, unchanged;
 *   - the worker erases as the database owner, through the service's own pool.
 *
 * Real PostgreSQL because every property that matters belongs to a statement
 * or a constraint: the gate's allow-lists, which rows each scrub reaches, the
 * draft that cannot be deleted, migration 027's guard on a purchase lot, the
 * job-state CHECK a cancellation must satisfy, the tombstone CHECK, and the
 * savepoint that must take a half-done erasure back. A mocked client agrees
 * with all of them.
 */

const { Pool } = pg;
const enabled = process.env.LIRL_RUN_POSTGRES_INTEGRATION === 'true';
const describePostgres = enabled ? describe : describe.skip;

const READER_ROLE = 'letter_irl_admin_reader_development';
const OPERATOR_ROLE = 'letter_irl_admin_operator_development';
const ROLE_PASSWORD = 'account-erasure-test-password';
const OWNER = 'owner@example.com';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const NO_BLOCKERS = {
  ordersInFlight: 0,
  lettersInFlight: 0,
  jobsInFlight: 0,
  disputesOpen: 0,
  refundsInFlight: 0,
  imagesInFlight: 0
};

const hex64 = (value: string) => createHash('sha256').update(value).digest('hex');

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

function giftCode(): string {
  return Array.from({ length: 8 }, () => CROCKFORD[Math.floor(Math.random() * CROCKFORD.length)]).join('');
}

describePostgres('account erasure', () => {
  let adminPool: pg.Pool;
  let owner: pg.Pool;
  let reader: pg.Pool;
  let operator: pg.Pool;
  let schema: string;
  let config: AdminRuntimeConfig;
  let commands: typeof import('../../src/admin/commands/index.js');
  let runner: typeof import('../../src/admin/commands/runner.js');
  let erasure: typeof import('../../src/services/accountErasureService.js');
  let userService: typeof import('../../src/services/userService.js');
  let accountErased: typeof import('../../src/auth/accountErased.js');
  let identity: typeof import('../../src/auth/identity.js');
  let gifts: typeof import('../../src/services/giftLetterService.js');
  let operatorAccounts: typeof import('../../src/services/operatorAccountService.js');
  let alerts: typeof import('../../src/services/commerceAlertService.js');
  let db: typeof import('../../src/db/index.js');

  beforeAll(async () => {
    const baseUrl = validateDisposableDatabaseUrl(process.env.LIRL_TEST_DATABASE_URL);
    adminPool = new Pool({ connectionString: baseUrl });
    schema = schemaName('lirl_erasure');
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

    // The worker runs in maintenance, as the owner: the service pool is the
    // owner here. The command writes only through the runner's operator
    // transaction, so it never reaches this pool.
    process.env.DATABASE_URL = scoped;
    commands = await import('../../src/admin/commands/index.js');
    runner = await import('../../src/admin/commands/runner.js');
    erasure = await import('../../src/services/accountErasureService.js');
    userService = await import('../../src/services/userService.js');
    accountErased = await import('../../src/auth/accountErased.js');
    identity = await import('../../src/auth/identity.js');
    gifts = await import('../../src/services/giftLetterService.js');
    operatorAccounts = await import('../../src/services/operatorAccountService.js');
    alerts = await import('../../src/services/commerceAlertService.js');
    db = await import('../../src/db/index.js');

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

  function elevatedSession(): AdminSession {
    const store = new AdminSessionStore({ idleTtlMs: 60_000, absoluteTtlMs: 600_000 });
    const session = store.create({ login: OWNER, name: 'Owner', node: 'laptop.tail1234.ts.net', peerAddress: '100.64.0.5' });
    session.elevatedUntil = Date.now() + 10 * 60_000;
    return session;
  }

  function deps() {
    const session = elevatedSession();
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

  async function preview(userId: string) {
    const command = commands.findAdminCommand('account.erase')!;
    return withReadOnlyTransaction(reader, (client) =>
      runner.prepareCommandPreview(command, client, 'development', userId, new Map())
    );
  }

  async function confirmation(userId: string) {
    const command = commands.findAdminCommand('account.erase')!;
    const prepared = await preview(userId);
    return {
      command,
      fields: new Map(
        Object.entries({
          previewDigest: prepared.previewDigest,
          expectedVersion: prepared.preview.expectedVersion ?? '',
          idempotencyKey: prepared.idempotencyKey,
          reason: 'integration test: customer asked by email',
          phrase: prepared.phrase
        })
      )
    };
  }

  // ---------------------------------------------------------------- seeding

  async function seedUser(extra: { returnAddress?: boolean } = {}): Promise<{ userId: string; email: string }> {
    const userId = `auth0|erasure-${randomUUID()}`;
    const email = `erasure.${randomUUID().slice(0, 8)}@example.test`;
    await owner.query(
      `INSERT INTO users (user_id, email, credits, credits_purchased, credits_used, return_address, return_address_validated_at)
       VALUES ($1, $2, 4, 10, 6, $3::jsonb, $4)`,
      [
        userId,
        email,
        extra.returnAddress ? JSON.stringify({ name: 'Jane Customer', addressLine1: '1 Secret Street', city: 'Leeds' }) : null,
        extra.returnAddress ? new Date() : null
      ]
    );
    return { userId, email };
  }

  async function seedLetter(userId: string, status: string): Promise<string> {
    const letterId = `letter_${randomUUID()}`;
    await owner.query(
      `INSERT INTO letters (letter_id, user_id, content, recipient, credits_cost, status, mail_type, preview_html)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, 2, $5, 'letter', '<p>Dear Sam, a secret</p>')`,
      [
        letterId,
        userId,
        JSON.stringify({ bodyText: 'Dear Sam, a secret', sender: { name: 'Jane Customer', addressLine1: '1 Secret Street' } }),
        JSON.stringify({ name: 'Sam Recipient', addressLine1: '2 Private Road' }),
        status
      ]
    );
    return letterId;
  }

  async function seedJob(
    letterId: string,
    job: { status: string; outcome: string; attempts: number; maxAttempts?: number }
  ): Promise<string> {
    const jobId = randomUUID();
    await owner.query(
      `INSERT INTO letter_jobs (job_id, letter_id, status, attempts, max_attempts, scheduled_at, idempotency_key,
         next_attempt_at, provider_outcome)
       VALUES ($1, $2, $3, $4, $5, NOW(), $2, NOW(), $6)`,
      [jobId, letterId, job.status, job.attempts, job.maxAttempts ?? 3, job.outcome]
    );
    return jobId;
  }

  async function seedDraft(userId: string): Promise<string> {
    const draftId = randomUUID();
    await owner.query(
      `INSERT INTO letter_drafts (draft_id, user_id, sender, recipient, body_text, sign_off, required_credits, status, expires_at)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, 'Dear Sam, a draft secret', 'Love, Jane', 2, 'pending', NOW() + INTERVAL '1 day')`,
      [
        draftId,
        userId,
        JSON.stringify({ name: 'Jane Customer', addressLine1: '1 Secret Street' }),
        JSON.stringify({ name: 'Sam Recipient', addressLine1: '2 Private Road' })
      ]
    );
    return draftId;
  }

  /** jit_mail orders require credits IS NULL and a draft (migration 021). */
  async function seedJitOrder(userId: string, status: string, draftId: string, letterId?: string): Promise<string> {
    const orderId = `order_${randomUUID()}`;
    await owner.query(
      `INSERT INTO orders (order_id, user_id, credits, amount_cents, currency, status, order_type, product_code,
         idempotency_key, draft_id, letter_id)
       VALUES ($1, $2, NULL, 499, 'USD', $3, 'jit_mail', 'jit-letter', $4, $5, $6)`,
      [orderId, userId, status, `idem_${orderId}`, draftId, letterId ?? null]
    );
    return orderId;
  }

  async function seedPackOrder(userId: string, status = 'fulfilled'): Promise<{ orderId: string; paymentIntent: string }> {
    const orderId = `order_${randomUUID()}`;
    const paymentIntent = `pi_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    await owner.query(
      `INSERT INTO orders (order_id, user_id, credits, amount_cents, currency, status, order_type, product_code,
         idempotency_key, stripe_payment_intent_id)
       VALUES ($1, $2, 10, 1000, 'USD', $5, 'letter_pack', 'credit-pack-10', $3, $4)`,
      [orderId, userId, `idem_${orderId}`, paymentIntent, status]
    );
    return { orderId, paymentIntent };
  }

  async function seedDispute(options: { userId: string | null; paymentIntent: string; resolved: boolean }): Promise<string> {
    const disputeId = `dp_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    await owner.query(
      `INSERT INTO stripe_disputes (dispute_id, charge_id, payment_intent_id, user_id, amount_cents, currency, status, resolved_at)
       VALUES ($1, 'ch_x', $2, $3, 1000, 'usd', $4, $5)`,
      [disputeId, options.paymentIntent, options.userId, options.resolved ? 'won' : 'needs_response', options.resolved ? new Date() : null]
    );
    return disputeId;
  }

  async function seedPackRefund(userId: string, settled: boolean): Promise<void> {
    const { orderId, paymentIntent } = await seedPackOrder(userId);
    await owner.query(
      `INSERT INTO commerce_pack_refunds (order_id, user_id, environment, letters, credits, amount_cents, currency, status,
         stripe_payment_intent_id, stripe_refund_id, stripe_idempotency_key, reason_code, actor_subject_hash,
         idempotency_key_hash, settled_at)
       VALUES ($1, $2, 'development', 1, 2, 250, 'usd', $3, $4, $5, $6, 'customer_request', $7, $8, $9)`,
      [
        orderId,
        userId,
        settled ? 'succeeded' : 'letters_revoked',
        paymentIntent,
        settled ? `re_${randomUUID().slice(0, 12)}` : null,
        `key_${orderId}`,
        hex64(`actor:${orderId}`),
        hex64(`key:${orderId}`),
        settled ? new Date() : null
      ]
    );
  }

  async function seedReservation(userId: string, settled: boolean): Promise<void> {
    const entitlement = await db.transaction((client) =>
      operatorAccounts.grantOperatorImageEntitlement(client, { userId, quantity: 2, reference: `test:${randomUUID()}` })
    );
    if (settled) {
      await owner.query(
        `INSERT INTO image_generation_reservations (entitlement_id, user_id, status, completed_at, resolution_reason)
         VALUES ($1, $2, 'released', NOW(), 'definite_failure')`,
        [entitlement!.entitlement_id, userId]
      );
    } else {
      await owner.query(
        `INSERT INTO image_generation_reservations (entitlement_id, user_id, status, lease_expires_at)
         VALUES ($1, $2, 'reserved', NOW() + INTERVAL '10 minutes')`,
        [entitlement!.entitlement_id, userId]
      );
    }
  }

  async function blockersOf(userId: string) {
    return withReadOnlyTransaction(reader, (client) => erasure.readErasureBlockers(client, userId));
  }

  /** The follow-up alerts an erasure of this account opened (#453). */
  async function followUps(userId: string): Promise<number> {
    const result = await owner.query(
      `SELECT 1 FROM commerce_operational_alerts
        WHERE alert_type = 'account_erasure_followup' AND details->>'userId' = $1`,
      [userId]
    );
    return result.rowCount ?? 0;
  }

  // ------------------------------------------------------------------ tests

  it('reads each kind of money or mail in flight from the reader role, and nothing once it has settled', async () => {
    const cases: Array<{ name: string; seed: (userId: string, settled: boolean) => Promise<void>; key: keyof typeof NO_BLOCKERS }> = [
      {
        name: 'an open checkout',
        key: 'ordersInFlight',
        seed: async (userId, settled) => {
          await seedJitOrder(userId, settled ? 'cancelled' : 'checkout_pending', await seedDraft(userId));
        }
      },
      {
        name: 'a letter still on its way',
        key: 'lettersInFlight',
        seed: async (userId, settled) => {
          await seedLetter(userId, settled ? 'delivered' : 'queued');
        }
      },
      {
        name: 'a job the outbox would retry by itself',
        key: 'jobsInFlight',
        seed: async (userId, settled) => {
          const letterId = await seedLetter(userId, 'failed');
          await seedJob(
            letterId,
            settled
              ? { status: 'failed', outcome: 'definite_failure', attempts: 1 }
              : { status: 'failed', outcome: 'not_dispatched', attempts: 1 }
          );
        }
      },
      {
        name: 'a failed job with its attempts used up is finished',
        key: 'jobsInFlight',
        seed: async (userId, settled) => {
          const letterId = await seedLetter(userId, 'failed');
          await seedJob(
            letterId,
            settled
              ? { status: 'failed', outcome: 'not_dispatched', attempts: 3, maxAttempts: 3 }
              : { status: 'pending', outcome: 'not_dispatched', attempts: 0 }
          );
        }
      },
      {
        name: 'an open dispute on the account',
        key: 'disputesOpen',
        seed: async (userId, settled) => {
          await seedDispute({ userId, paymentIntent: `pi_${randomUUID().slice(0, 12)}`, resolved: settled });
        }
      },
      {
        name: "an open dispute that reaches the account only through its order's payment",
        key: 'disputesOpen',
        seed: async (userId, settled) => {
          const { paymentIntent } = await seedPackOrder(userId);
          await seedDispute({ userId: null, paymentIntent, resolved: settled });
        }
      },
      {
        name: 'a pack refund in progress',
        key: 'refundsInFlight',
        seed: (userId, settled) => seedPackRefund(userId, settled)
      },
      {
        name: 'an image generation in flight',
        key: 'imagesInFlight',
        seed: (userId, settled) => seedReservation(userId, settled)
      }
    ];

    for (const testCase of cases) {
      const moving = await seedUser();
      await testCase.seed(moving.userId, false);
      expect(await blockersOf(moving.userId), testCase.name).toEqual({ ...NO_BLOCKERS, [testCase.key]: 1 });

      const settled = await seedUser();
      await testCase.seed(settled.userId, true);
      expect(await blockersOf(settled.userId), `${testCase.name}, settled`).toEqual(NO_BLOCKERS);
    }
  }, 120_000);

  it('treats a disputed order as settled once every dispute on its payment has closed, and holds one it cannot explain', async () => {
    // Won: the order stays disputed for good, because charge.dispute.closed
    // writes that status again (#446 review).
    const won = await seedUser();
    const wonOrder = await seedPackOrder(won.userId, 'disputed');
    await seedDispute({ userId: won.userId, paymentIntent: wonOrder.paymentIntent, resolved: true });
    expect(await blockersOf(won.userId)).toEqual(NO_BLOCKERS);

    // Still open: held twice over.
    const open = await seedUser();
    const openOrder = await seedPackOrder(open.userId, 'disputed');
    await seedDispute({ userId: open.userId, paymentIntent: openOrder.paymentIntent, resolved: false });
    expect(await blockersOf(open.userId)).toEqual({ ...NO_BLOCKERS, ordersInFlight: 1, disputesOpen: 1 });

    // Disputed with no record of any dispute: nothing explains it, so it holds.
    const unexplained = await seedUser();
    await seedPackOrder(unexplained.userId, 'disputed');
    expect(await blockersOf(unexplained.userId)).toEqual({ ...NO_BLOCKERS, ordersInFlight: 1 });
  }, 60_000);

  it('queues through the operator role and erases as the owner: content and identity go, money records stay', async () => {
    const { userId, email } = await seedUser({ returnAddress: true });
    const other = await seedUser();

    // Mail, finished: one delivered, one the provider definitely rejected.
    const delivered = await seedLetter(userId, 'delivered');
    const rejected = await seedLetter(userId, 'failed');
    const rejectedJob = await seedJob(rejected, { status: 'failed', outcome: 'definite_failure', attempts: 3 });

    // A free draft, and one a fulfilled Pay & Send order still points at.
    const freeDraft = await seedDraft(userId);
    const boundDraft = await seedDraft(userId);
    const jitOrder = await seedJitOrder(userId, 'fulfilled', boundDraft, delivered);
    await owner.query(
      `UPDATE orders SET checkout_url = 'https://checkout.stripe.com/c/pay/cs_test_erasure' WHERE order_id = $1`,
      [jitOrder]
    );

    // Retention copies of both kinds.
    for (const [table, id] of [['letters', delivered], ['letter_drafts', boundDraft]]) {
      await owner.query(
        `INSERT INTO redacted_content_quarantine (source_table, source_id, content, purge_after)
         VALUES ($1, $2, '{"bodyText":"a saved secret"}'::jsonb, NOW() + INTERVAL '7 days')`,
        [table, id]
      );
    }

    // Money: a pack and its purchase lot, a won dispute, a legacy operator reason.
    const { orderId: packOrder, paymentIntent } = await seedPackOrder(userId);
    const lot = await owner.query<{ ledger_id: string }>(
      `INSERT INTO credit_ledger (user_id, initial_amount, remaining_amount, source_type, source_reference_id,
         source_order_id, expiration_policy, status, description)
       VALUES ($1, 10, 4, 'purchase', $2, $2, 'never', 'active', 'Pack for Jane Customer')
       RETURNING ledger_id`,
      [userId, packOrder]
    );
    await owner.query(
      `INSERT INTO credit_transactions (user_id, amount, balance_after, type, description, reference_type, reference_id)
       VALUES ($1, 2, 4, 'adjustment', 'Operator adjustment: Jane Customer called about 1 Secret Street', NULL, NULL)`,
      [userId]
    );
    const dispute = await seedDispute({ userId, paymentIntent, resolved: true });

    // Identity and odds and ends.
    await owner.query(
      `INSERT INTO personal_access_tokens (user_id, name, token_hash, token_prefix) VALUES ($1, 'Jane laptop', 'hash', 'abcd')`,
      [userId]
    );
    await owner.query(
      `INSERT INTO recent_uploads (user_id, image_url, context) VALUES ($1, 'https://files.example.test/jane.png', 'postcard')`,
      [userId]
    );
    await owner.query(
      `INSERT INTO feature_requests (user_id, title, description, category, attempted_action, contact_email, contact_consent)
       VALUES ($1, 'Jane wants', 'Please add', 'other', 'asked', $2, true)`,
      [userId, email]
    );

    // A seed-code claim with its address, and two gift codes: one nobody
    // redeemed, and one another account did.
    const campaign = await owner.query<{ campaign_id: string }>(
      `INSERT INTO promo_campaigns (code, name, credits_amount, status) VALUES ($1, 'Seed', 2, 'active') RETURNING campaign_id`,
      [`SEED-${randomUUID().slice(0, 8)}`]
    );
    const promoLot = await owner.query<{ ledger_id: string }>(
      `INSERT INTO credit_ledger (user_id, initial_amount, remaining_amount, source_type, source_reference_id, status)
       VALUES ($1, 2, 2, 'promo', $2, 'active') RETURNING ledger_id`,
      [userId, campaign.rows[0].campaign_id]
    );
    await owner.query(
      `INSERT INTO promo_redemptions (campaign_id, user_id, ledger_id, email_normalized) VALUES ($1, $2, $3, $4)`,
      [campaign.rows[0].campaign_id, userId, promoLot.rows[0].ledger_id, email]
    );
    const grants = await db.transaction((client) =>
      gifts.grantGiftLettersWithClient(client, {
        userId,
        quantity: 3,
        generationsRemaining: 1,
        source: 'operator',
        sourceReferenceId: `test:${randomUUID()}`
      })
    );
    const issuedCode = giftCode();
    const redeemedCode = giftCode();
    const issuedLetter = await seedLetter(userId, 'delivered');
    const redeemedLetter = await seedLetter(userId, 'delivered');
    await owner.query(
      `INSERT INTO gift_codes (code, gift_id, letter_id, issued_to_user_id, grants_generations_remaining, expires_at)
       VALUES ($1, $2, $3, $4, 0, NOW() + INTERVAL '30 days')`,
      [issuedCode, grants[0].gift_id, issuedLetter, userId]
    );
    await owner.query(
      `INSERT INTO gift_codes (code, gift_id, letter_id, issued_to_user_id, grants_generations_remaining, expires_at,
         status, redeemed_at, redeemed_by_user_id)
       VALUES ($1, $2, $3, $4, 0, NOW() + INTERVAL '30 days', 'redeemed', NOW(), $5)`,
      [redeemedCode, grants[1].gift_id, redeemedLetter, userId, other.userId]
    );

    // ---- preview, as the reader
    const prepared = await preview(userId);
    expect(prepared.phrase).toBe(`CONFIRM ${userId}`);
    expect(prepared.preview.summary).toMatchObject({
      blocked: false,
      blockers: NO_BLOCKERS,
      scope: {
        letters: 4,
        draftsToDelete: 1,
        draftsToScrub: 1,
        savedCopies: 2,
        accessTokens: 1,
        featureRequests: 1,
        unredeemedGiftCodes: 1,
        seedCodeEmails: 1,
        failedJobsToCancel: 1,
        ordersKept: 2,
        unusedGiftLetters: 3,
        openAlerts: 0
      },
      creditsForfeited: 4
    });
    expect(JSON.stringify(prepared.preview.summary)).not.toContain(email);

    // ---- confirm, as the operator: one queued operation, nothing erased yet
    const { command, fields } = await confirmation(userId);
    const outcome = await runner.runAdminCommand(deps(), command, userId, fields);
    expect(outcome).toMatchObject({ status: 'succeeded', replayed: false, result: { status: 'queued' } });
    const operationId = String(outcome.result.operationId);
    const queued = await owner.query(
      `SELECT status, environment, payload_json, command_id FROM admin_operations WHERE id = $1`,
      [operationId]
    );
    expect(queued.rows[0]).toEqual({
      status: 'pending',
      environment: 'development',
      payload_json: { userId },
      command_id: outcome.commandId
    });
    const audit = await owner.query<{ text: string }>(
      `SELECT before_summary_json::text || after_summary_json::text AS text FROM admin_audit_events WHERE command_id = $1`,
      [outcome.commandId]
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].text).not.toContain(email);
    expect((await owner.query(`SELECT email FROM users WHERE user_id = $1`, [userId])).rows[0].email).toBe(email);

    // A replay returns the first outcome and queues nothing more; a second
    // erasure is refused while this one waits.
    expect(await runner.runAdminCommand(deps(), command, userId, fields)).toMatchObject({
      commandId: outcome.commandId,
      replayed: true
    });
    expect((await owner.query(`SELECT 1 FROM admin_operations WHERE payload_json->>'userId' = $1`, [userId])).rowCount).toBe(1);
    await expect(preview(userId)).rejects.toMatchObject({ code: 'ADMIN_INVALID_STATE' });

    // ---- the worker, as the owner
    expect(await erasure.processAccountErasures()).toEqual({ erased: 1, refused: 0, retrying: 0, failed: 0 });

    const account = await owner.query(
      `SELECT email, return_address, return_address_validated_at, erased_at, sends_blocked_at, sends_blocked_reason,
              credits, credits_purchased
         FROM users WHERE user_id = $1`,
      [userId]
    );
    expect(account.rows[0]).toMatchObject({
      return_address: null,
      return_address_validated_at: null,
      sends_blocked_reason: 'account_erased',
      credits: 4,
      credits_purchased: 10
    });
    expect(account.rows[0].email).toMatch(/^erased-[0-9a-f-]{36}@erased\.invalid$/);
    expect(account.rows[0].erased_at).toBeInstanceOf(Date);
    expect(account.rows[0].sends_blocked_at).toBeInstanceOf(Date);

    const letters = await owner.query(
      `SELECT letter_id, content, recipient, preview_html, redacted_at, status FROM letters WHERE user_id = $1 ORDER BY letter_id`,
      [userId]
    );
    expect(letters.rows).toHaveLength(4);
    for (const letter of letters.rows) {
      // toEqual, not toMatchObject: a partial match of {} accepts any object.
      expect(letter.content).toEqual({});
      expect(letter.recipient).toEqual({});
      expect(letter.preview_html).toBeNull();
      expect(letter.redacted_at).toBeInstanceOf(Date);
    }
    expect(letters.rows.find((row) => row.letter_id === delivered)?.status).toBe('delivered');

    const job = await owner.query(
      `SELECT status, operator_resolution, resolved_at, provider_outcome FROM letter_jobs WHERE job_id = $1`,
      [rejectedJob]
    );
    expect(job.rows[0]).toMatchObject({ status: 'cancelled', operator_resolution: 'account_erased', provider_outcome: 'definite_failure' });

    expect((await owner.query(`SELECT 1 FROM letter_drafts WHERE draft_id = $1`, [freeDraft])).rowCount).toBe(0);
    const bound = await owner.query(
      `SELECT sender, recipient, body_text, sign_off, preview_html, redacted_at FROM letter_drafts WHERE draft_id = $1`,
      [boundDraft]
    );
    expect(bound.rows[0].sender).toEqual({});
    expect(bound.rows[0].recipient).toEqual({});
    expect(bound.rows[0]).toMatchObject({ body_text: '', sign_off: '', preview_html: null });
    expect(bound.rows[0].redacted_at).toBeInstanceOf(Date);
    expect((await owner.query(`SELECT 1 FROM orders WHERE order_id = $1 AND draft_id = $2`, [jitOrder, boundDraft])).rowCount).toBe(1);
    // The kept order no longer carries a link into its Stripe session.
    expect((await owner.query(`SELECT checkout_url FROM orders WHERE order_id = $1`, [jitOrder])).rows[0].checkout_url).toBeNull();

    expect(
      (await owner.query(`SELECT 1 FROM redacted_content_quarantine WHERE source_id IN ($1, $2)`, [delivered, boundDraft])).rowCount
    ).toBe(0);
    for (const table of ['personal_access_tokens', 'recent_uploads', 'feature_requests']) {
      expect((await owner.query(`SELECT 1 FROM ${table} WHERE user_id = $1`, [userId])).rowCount, table).toBe(0);
    }
    const redemption = await owner.query(`SELECT email_normalized FROM promo_redemptions WHERE user_id = $1`, [userId]);
    expect(redemption.rows).toEqual([{ email_normalized: null }]);
    const codes = await owner.query<{ code: string }>(
      `SELECT code FROM gift_codes WHERE issued_to_user_id = $1`,
      [userId]
    );
    expect(codes.rows).toEqual([{ code: redeemedCode }]);
    expect((await owner.query(`SELECT 1 FROM gift_letters WHERE user_id = $1`, [userId])).rowCount).toBe(3);

    // The money trail stands, without its free text.
    const lots = await owner.query(
      `SELECT ledger_id, description, source_order_id FROM credit_ledger WHERE user_id = $1 ORDER BY created_at`,
      [userId]
    );
    expect(lots.rows).toHaveLength(2);
    expect(lots.rows.every((row) => row.description === null)).toBe(true);
    expect(lots.rows.find((row) => row.ledger_id === lot.rows[0].ledger_id)?.source_order_id).toBe(packOrder);
    expect((await owner.query(`SELECT description FROM credit_transactions WHERE user_id = $1`, [userId])).rows).toEqual([
      { description: null }
    ]);
    expect((await owner.query(`SELECT 1 FROM orders WHERE user_id = $1`, [userId])).rowCount).toBe(2);
    expect((await owner.query(`SELECT 1 FROM stripe_disputes WHERE dispute_id = $1 AND user_id = $2`, [dispute, userId])).rowCount).toBe(1);

    // The other account is untouched.
    expect((await owner.query(`SELECT email FROM users WHERE user_id = $1`, [other.userId])).rows[0].email).toBe(other.email);

    // What is left by hand is an operator alert, raised with the tombstone:
    // one, open, naming the account by its id and nothing else (#453).
    const followUpRows = await owner.query(
      `SELECT alert_type, severity, status, order_id, source_event_id, details
         FROM commerce_operational_alerts
        WHERE alert_type = 'account_erasure_followup' AND details->>'userId' = $1`,
      [userId]
    );
    expect(followUpRows.rows).toEqual([
      {
        alert_type: 'account_erasure_followup',
        severity: 'warning',
        status: 'open',
        order_id: null,
        source_event_id: null,
        details: { userId }
      }
    ]);
    expect(JSON.stringify(followUpRows.rows)).not.toContain(email);
    expect(await followUps(other.userId)).toBe(0);
    // The panel's reader finds it for the account page.
    const followUp = await withReadOnlyTransaction(reader, (client) => erasure.readErasureFollowup(client, userId));
    expect(followUp).toMatchObject({ status: 'open', resolvedAt: null, resolutionCode: null });

    const done = await owner.query(
      `SELECT status, error_code, completed_at, sanitized_result_json FROM admin_operations WHERE id = $1`,
      [operationId]
    );
    expect(done.rows[0]).toMatchObject({
      status: 'succeeded',
      error_code: null,
      sanitized_result_json: {
        lettersScrubbed: 4,
        jobsCancelled: 1,
        draftsScrubbed: 1,
        draftsDeleted: 1,
        savedCopiesDeleted: 2,
        accessTokensDeleted: 1,
        uploadsDeleted: 1,
        featureRequestsDeleted: 1,
        seedCodeEmailsCleared: 1,
        giftCodesDeleted: 1,
        descriptionsCleared: 2
      }
    });
    expect(done.rows[0].completed_at).toBeInstanceOf(Date);

    // Nothing left to claim, and nothing left to erase.
    expect(await erasure.processAccountErasures()).toEqual({ erased: 0, refused: 0, retrying: 0, failed: 0 });
    await expect(preview(userId)).rejects.toMatchObject({ code: 'ADMIN_INVALID_STATE' });
    expect(await withReadOnlyTransaction(reader, (client) => erasure.readLatestErasure(client, userId))).toMatchObject({
      operationId,
      status: 'succeeded'
    });
    expect(await followUps(userId)).toBe(1);

    // The operator resolves it through the alert transition, which the new
    // type passes, with the code the panel offers.
    await alerts.transitionCommerceAlert({
      alertId: followUp!.alertId,
      status: 'resolved',
      resolutionCode: erasure.ERASURE_FOLLOWUP_RESOLUTION,
      idempotencyKey: randomUUID(),
      actorId: OWNER
    });
    expect(await withReadOnlyTransaction(reader, (client) => erasure.readErasureFollowup(client, userId))).toMatchObject({
      alertId: followUp!.alertId,
      status: 'resolved',
      resolutionCode: 'auth0_user_deleted'
    });
  }, 120_000);

  it('refuses to queue while money is moving, and the worker refuses what starts after queuing', async () => {
    const busy = await seedUser();
    await seedJitOrder(busy.userId, 'checkout_pending', await seedDraft(busy.userId));
    const blockedPreview = await preview(busy.userId);
    expect(blockedPreview.preview.summary).toMatchObject({ blocked: true, blockers: { ...NO_BLOCKERS, ordersInFlight: 1 } });
    const refused = await confirmation(busy.userId);
    await expect(runner.runAdminCommand(deps(), refused.command, busy.userId, refused.fields)).rejects.toMatchObject({
      code: 'ADMIN_INVALID_STATE'
    });
    // Rolled back whole: no run row, no operation.
    expect(
      (await owner.query(`SELECT 1 FROM admin_command_runs WHERE idempotency_key = $1`, [refused.fields.get('idempotencyKey')])).rowCount
    ).toBe(0);
    expect((await owner.query(`SELECT 1 FROM admin_operations WHERE payload_json->>'userId' = $1`, [busy.userId])).rowCount).toBe(0);

    // Clear at confirmation; a checkout opens before the worker runs.
    const late = await seedUser({ returnAddress: true });
    const { command, fields } = await confirmation(late.userId);
    const outcome = await runner.runAdminCommand(deps(), command, late.userId, fields);
    await seedJitOrder(late.userId, 'checkout_pending', await seedDraft(late.userId));
    expect(await erasure.processAccountErasures()).toEqual({ erased: 0, refused: 1, retrying: 0, failed: 0 });
    const operation = await owner.query(
      `SELECT status, error_code, sanitized_result_json FROM admin_operations WHERE id = $1`,
      [String(outcome.result.operationId)]
    );
    expect(operation.rows[0]).toEqual({
      status: 'failed',
      error_code: 'ACCOUNT_ERASURE_BLOCKED',
      sanitized_result_json: { ...NO_BLOCKERS, ordersInFlight: 1 }
    });
    const untouched = await owner.query(`SELECT email, erased_at, return_address FROM users WHERE user_id = $1`, [late.userId]);
    expect(untouched.rows[0]).toMatchObject({ email: late.email, erased_at: null });
    expect(untouched.rows[0].return_address).not.toBeNull();
    // A refusal leaves nothing for an operator to follow up.
    expect(await followUps(late.userId)).toBe(0);
    // A refused erasure can be previewed and queued again once things settle.
    expect((await preview(late.userId)).preview.summary).toMatchObject({ blocked: true });
  }, 120_000);

  it('takes a failed attempt back whole, retries it an hour later, and gives up after three', async () => {
    const { userId, email } = await seedUser({ returnAddress: true });
    const letterId = await seedLetter(userId, 'delivered');
    await owner.query(
      `INSERT INTO redacted_content_quarantine (source_table, source_id, content, purge_after)
       VALUES ('letters', $1, '{"bodyText":"a saved secret"}'::jsonb, NOW() + INTERVAL '7 days')`,
      [letterId]
    );
    const { command, fields } = await confirmation(userId);
    const outcome = await runner.runAdminCommand(deps(), command, userId, fields);
    const operationId = String(outcome.result.operationId);

    // Fail the letters scrub, which runs after the retention copy is deleted.
    await owner.query(`
      CREATE FUNCTION erasure_test_refuse() RETURNS trigger AS $$
      BEGIN
        IF NEW.user_id = '${userId}' THEN
          RAISE EXCEPTION 'refused for the test';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await owner.query(
      `CREATE TRIGGER erasure_test_refuse BEFORE UPDATE ON letters FOR EACH ROW EXECUTE FUNCTION erasure_test_refuse()`
    );
    try {
      expect(await erasure.processAccountErasures()).toEqual({ erased: 0, refused: 0, retrying: 1, failed: 0 });
      const waiting = await owner.query(
        `SELECT status, attempts, error_code, available_at > NOW() + INTERVAL '50 minutes' AS later, sanitized_result_json
           FROM admin_operations WHERE id = $1`,
        [operationId]
      );
      expect(waiting.rows[0]).toMatchObject({ status: 'pending', attempts: 1, error_code: null, later: true });
      expect(waiting.rows[0].sanitized_result_json).toEqual({ lastErrorClass: expect.any(String) });
      // The savepoint took the half-done erasure back: the copy deleted before
      // the failure is still there, and so is the address.
      expect((await owner.query(`SELECT 1 FROM redacted_content_quarantine WHERE source_id = $1`, [letterId])).rowCount).toBe(1);
      expect((await owner.query(`SELECT email FROM users WHERE user_id = $1`, [userId])).rows[0].email).toBe(email);

      // Not due again for an hour.
      expect(await erasure.processAccountErasures()).toEqual({ erased: 0, refused: 0, retrying: 0, failed: 0 });

      await owner.query(`UPDATE admin_operations SET available_at = NOW() WHERE id = $1`, [operationId]);
      expect(await erasure.processAccountErasures()).toEqual({ erased: 0, refused: 0, retrying: 1, failed: 0 });
      await owner.query(`UPDATE admin_operations SET available_at = NOW() WHERE id = $1`, [operationId]);
      expect(await erasure.processAccountErasures()).toEqual({ erased: 0, refused: 0, retrying: 0, failed: 1 });
      const failed = await owner.query(
        `SELECT status, attempts, error_code, completed_at IS NOT NULL AS completed FROM admin_operations WHERE id = $1`,
        [operationId]
      );
      expect(failed.rows[0]).toEqual({ status: 'failed', attempts: 3, error_code: 'ACCOUNT_ERASURE_ERROR', completed: true });
      // No attempt got as far as the alert.
      expect(await followUps(userId)).toBe(0);
    } finally {
      await owner.query(`DROP TRIGGER IF EXISTS erasure_test_refuse ON letters`);
      await owner.query(`DROP FUNCTION IF EXISTS erasure_test_refuse()`);
    }

    // Queued again, it goes through, and opens its one follow-up.
    const again = await confirmation(userId);
    await runner.runAdminCommand(deps(), again.command, userId, again.fields);
    expect(await erasure.processAccountErasures()).toEqual({ erased: 1, refused: 0, retrying: 0, failed: 0 });
    expect(await followUps(userId)).toBe(1);
  }, 120_000);

  it('commits the tombstone and its follow-up alert together, or neither (#453)', async () => {
    const { userId, email } = await seedUser({ returnAddress: true });
    const { command, fields } = await confirmation(userId);
    const outcome = await runner.runAdminCommand(deps(), command, userId, fields);
    const operationId = String(outcome.result.operationId);

    // Refuse the alert, the erasure's last write: the tombstone before it must
    // go back with it, or an erasure could finish with nobody told to follow up.
    await owner.query(`
      CREATE FUNCTION erasure_test_refuse_alert() RETURNS trigger AS $$
      BEGIN
        IF NEW.details->>'userId' = '${userId}' THEN
          RAISE EXCEPTION 'refused for the test';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await owner.query(
      `CREATE TRIGGER erasure_test_refuse_alert BEFORE INSERT ON commerce_operational_alerts
         FOR EACH ROW EXECUTE FUNCTION erasure_test_refuse_alert()`
    );
    try {
      expect(await erasure.processAccountErasures()).toEqual({ erased: 0, refused: 0, retrying: 1, failed: 0 });
      const account = await owner.query(`SELECT email, erased_at, return_address FROM users WHERE user_id = $1`, [userId]);
      expect(account.rows[0]).toMatchObject({ email, erased_at: null });
      expect(account.rows[0].return_address).not.toBeNull();
      expect(await followUps(userId)).toBe(0);
    } finally {
      await owner.query(`DROP TRIGGER IF EXISTS erasure_test_refuse_alert ON commerce_operational_alerts`);
      await owner.query(`DROP FUNCTION IF EXISTS erasure_test_refuse_alert()`);
    }

    // Once the alert can be written, the retry erases and opens it.
    await owner.query(`UPDATE admin_operations SET available_at = NOW() WHERE id = $1`, [operationId]);
    expect(await erasure.processAccountErasures()).toEqual({ erased: 1, refused: 0, retrying: 0, failed: 0 });
    expect(await followUps(userId)).toBe(1);
  }, 120_000);

  it('refuses an erased account at every sign-in path, and the tombstone refuses a real address', async () => {
    const { userId, email } = await seedUser({ returnAddress: true });
    expect(await db.transaction((client) => erasure.eraseAccountWithClient(client, userId))).toMatchObject({ outcome: 'erased' });
    expect(await db.transaction((client) => erasure.eraseAccountWithClient(client, userId))).toEqual({ outcome: 'already_erased' });
    // The second pass found nothing to do, and opened no second follow-up.
    expect(await followUps(userId)).toBe(1);

    await expect(userService.getOrCreateUser(userId, email)).rejects.toBeInstanceOf(accountErased.AccountErasedError);
    const withClaim = { userId, token: 't', authType: 'jwt' as const, scopes: [], claims: { email, email_verified: true } };
    await expect(identity.prepareAuthenticatedUser(withClaim)).rejects.toBeInstanceOf(accountErased.AccountErasedError);
    const noClaim = { userId, token: 't', authType: 'pat' as const, scopes: [], claims: {} };
    await expect(identity.prepareAuthenticatedUser(noClaim)).rejects.toBeInstanceOf(accountErased.AccountErasedError);
    // Nothing wrote the address back.
    const stored = await owner.query<{ email: string }>(`SELECT email FROM users WHERE user_id = $1`, [userId]);
    expect(stored.rows[0].email).toMatch(/@erased\.invalid$/);

    for (const write of [
      `UPDATE users SET email = 'back@example.test' WHERE user_id = $1`,
      `UPDATE users SET return_address = '{"name":"Jane"}'::jsonb WHERE user_id = $1`
    ]) {
      await expect(owner.query(write, [userId]), write).rejects.toMatchObject({ code: '23514' });
    }
    // Reopening by hand clears the marker in the same statement.
    await owner.query(`UPDATE users SET erased_at = NULL, email = $2 WHERE user_id = $1`, [userId, email]);
    expect(await withReadOnlyTransaction(reader, (client) => erasure.readAccountErased(client, userId))).toBe(false);
  }, 60_000);
});
