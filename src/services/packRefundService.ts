/**
 * Proportional refunds of letter packs (#323): "refund N unspent letters of
 * order X", as an operator command in the service layer.
 *
 * Three phases, in the shape of the Pay & Send refund lane:
 *
 *   1. One transaction that locks the order, then the account, then the pack's
 *      live lots; checks every precondition against what is actually on the
 *      account; revokes exactly N letters FIFO; records the command row, the
 *      operator audit row and an order event; and commits. From here the
 *      customer has already lost the letters.
 *   2. A Stripe refund for an amount the app computed, carrying the command id
 *      in metadata, under an idempotency key stored on the row. No transaction.
 *   3. A finalising transaction that records what Stripe said. The webhook and
 *      the maintenance sweep share it, so whichever hears first settles the row
 *      and the rest no-op.
 *
 * Letters leave before money moves, on purpose: a crash between the phases
 * leaves letters revoked and no money sent, which the sweep finishes with the
 * same key, never the customer holding both. A refund Stripe will not pay out
 * is compensated with a new ledger lot rather than by editing history.
 *
 * No customer-facing tool calls this. Requests arrive by email with the order
 * id; a person decides; the surface that runs it is the admin panel, or until
 * that exists, nothing.
 */
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type Stripe from 'stripe';
import { query, transaction } from '../db/index.js';
import { createAdminPreviewDigest } from '../admin/commands/foundation.js';
import { resolveDeploymentMode } from '../config/deploymentConfig.js';
import { CREDITS_PER_LETTER, formatAmountForCurrency } from '../config/products.js';
import {
  carriedDiagnosticClass,
  classifyDiagnosticError,
  isTerminalDiagnosticClass,
  writeDiagnostic
} from '../utils/diagnosticLog.js';
import { positiveIntegerSetting } from '../utils/envSettings.js';
import { lockAccountForBalanceChange } from './accountLock.js';
import {
  compensatePackRefund,
  lockPackRefund,
  recordOrderEvent,
  revokePackLots,
  settlePackRefund,
  type PackRefundRow,
  type PackRefundStatus
} from './commerceService.js';
import { createPartialPaymentRefund, listPaymentRefunds, retrieveRefund } from './stripeService.js';
import type { Order } from './types.js';

export const PACK_REFUND_REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{2,79}$/;
export const PACK_REFUND_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
export const PACK_REFUND_ENABLED_FLAG = 'LETTER_IRL_PACK_REFUND_COMMAND_ENABLED';

/**
 * Stripe error codes that mean this refund will never succeed as issued. The
 * diagnostic classifier's terminal classes (credentials, configuration,
 * resource_missing, amount limits) are added to these at the call site.
 */
const TERMINAL_STRIPE_REFUND_CODES = new Set([
  'charge_already_refunded',
  'refund_disputed_payment',
  'charge_disputed',
  'resource_missing',
  'amount_too_large',
  'amount_too_small'
]);

/** Dispute statuses under which no money was, or will be, taken from us. */
const NON_LOSS_DISPUTE_STATUSES = [
  'won',
  'prevented',
  'warning_needs_response',
  'warning_under_review',
  'warning_closed'
];

export type PackRefundRefusal =
  | 'PACK_REFUND_DISABLED'
  | 'PACK_REFUND_ENVIRONMENT_MISMATCH'
  | 'PACK_REFUND_INVALID_INPUT'
  | 'PACK_REFUND_NOT_FOUND'
  | 'PACK_REFUND_NOT_A_PACK'
  | 'PACK_REFUND_ORDER_STATE'
  | 'PACK_REFUND_UNREFUNDABLE_ORDER'
  | 'PACK_REFUND_ALREADY_ISSUED'
  | 'PACK_REFUND_DISPUTED'
  | 'PACK_REFUND_TOO_MANY_LETTERS'
  | 'PACK_REFUND_WOULD_BE_FULL'
  | 'PACK_REFUND_PREVIEW_STALE'
  | 'idempotency_conflict';

export class PackRefundError extends Error {
  readonly code: PackRefundRefusal;

  constructor(code: PackRefundRefusal, message: string) {
    super(message);
    this.name = 'PackRefundError';
    this.code = code;
  }
}

/** The Stripe seam, substituted by the PostgreSQL suites. */
export interface PackRefundOperations {
  createPartialPaymentRefund: typeof createPartialPaymentRefund;
  listPaymentRefunds: typeof listPaymentRefunds;
  retrieveRefund: typeof retrieveRefund;
}

export const livePackRefundOperations: PackRefundOperations = {
  createPartialPaymentRefund,
  listPaymentRefunds,
  retrieveRefund
};

export interface RefundPackLettersInput {
  orderId: string;
  /** N, a positive integer. */
  letters: number;
  /** e.g. 'goodwill_unused', 'customer_request'. */
  reasonCode: string;
  /** Hashed into the audit rows; never stored in clear. */
  actor: { id: string };
  /** Operator-controlled; a replay with the same key returns the first outcome. */
  idempotencyKey: string;
  /** Must equal the running deployment's mode. */
  environment: 'development' | 'production';
  /** admin_command_runs.id when invoked through the admin foundation. */
  adminCommandId?: string;
  /** The digest of the preview the operator confirmed; a stale one refuses. */
  expectedPreviewDigest?: string;
}

export interface PackRefundPreview {
  orderId: string;
  letters: number;
  lettersInPack: number;
  lettersRemaining: number;
  lettersRefundedBefore: number;
  perLetterCents: number;
  amountCents: number;
  amountDisplay: string;
  currency: string;
  previewDigest: string;
}

export interface RefundPackLettersResult {
  packRefundId: string;
  status: PackRefundStatus;
  amountCents: number;
  replayed: boolean;
}

export interface PackRefundSweepResult {
  retried: number;
  adopted: number;
  settled: number;
  compensated: number;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function commandEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PACK_REFUND_ENABLED_FLAG] === 'true';
}

function packFigures(order: Order, letters: number) {
  const lettersInPack = (order.credits ?? 0) / CREDITS_PER_LETTER;
  return {
    lettersInPack,
    perLetterCents: Math.floor(order.amount_cents / lettersInPack),
    // Floor once on the product: never exceeds the pro-rata share, and never
    // under-refunds by more than one cent in total (plan D1).
    amountCents: Math.floor((letters * order.amount_cents) / lettersInPack)
  };
}

function previewDigest(order: Order, letters: number, lettersRemaining: number, amountCents: number): string {
  return createAdminPreviewDigest({
    orderId: order.order_id,
    letters,
    amountCents,
    lettersRemaining,
    orderUpdatedAt: new Date(order.updated_at).toISOString()
  });
}

const LIVE_LOT_PREDICATE = `
     WHERE user_id = $1 AND source_type IN ('purchase', 'adjustment')
       AND (source_reference_id = $2 OR source_metadata->>'stripe_session_id' = $3)
       AND status = 'active' AND remaining_amount > 0
       AND (expires_at IS NULL OR expires_at > NOW())`;

/**
 * Letters of this pack still on the account: active, unexpired credits in
 * the lots attributed to the order, the same attribution the refund path
 * uses. `lock` takes them FOR UPDATE inside the command's transaction.
 */
type Runner = (text: string, params: unknown[]) => Promise<{ rows: Array<{ credits: number | string | null }> }>;

async function lettersRemainingOnPack(
  run: Runner,
  order: Order,
  lock: boolean
): Promise<number> {
  const result = await run(
    `SELECT ${lock ? 'remaining_amount AS credits' : 'COALESCE(SUM(remaining_amount), 0) AS credits'}
       FROM credit_ledger${LIVE_LOT_PREDICATE}${lock ? ' ORDER BY expires_at NULLS LAST, created_at ASC FOR UPDATE' : ''}`,
    [order.user_id, order.order_id, order.stripe_checkout_session_id || null]
  );
  const credits = result.rows.reduce((sum, row) => sum + Number(row.credits ?? 0), 0);
  return Math.floor(credits / CREDITS_PER_LETTER);
}

function assertPackOrder(order: Order | undefined, orderId: string): asserts order is Order {
  if (!order) throw new PackRefundError('PACK_REFUND_NOT_FOUND', `Order ${orderId} does not exist`);
  if (order.order_type !== 'letter_pack') {
    throw new PackRefundError('PACK_REFUND_NOT_A_PACK', 'Only letter-pack orders can be refunded proportionally');
  }
  const credits = order.credits ?? 0;
  if (credits <= 0 || credits % CREDITS_PER_LETTER !== 0 || !order.stripe_payment_intent_id || order.amount_known === false) {
    throw new PackRefundError('PACK_REFUND_UNREFUNDABLE_ORDER', 'The order has no refundable payment or letter count');
  }
}

function assertLetters(letters: number): void {
  if (!Number.isInteger(letters) || letters < 1) {
    throw new PackRefundError('PACK_REFUND_INVALID_INPUT', 'letters must be a positive integer');
  }
}

/**
 * The numbers an operator confirms before anything moves. Not locked: the
 * digest binds the confirmation to what was shown, and the command refuses
 * if a send changed the picture in between.
 */
export async function previewPackRefund(orderId: string, letters: number): Promise<PackRefundPreview> {
  assertLetters(letters);
  const result = await query<Order>('SELECT * FROM orders WHERE order_id = $1', [orderId]);
  const order = result.rows[0];
  assertPackOrder(order, orderId);
  const lettersRemaining = await lettersRemainingOnPack((text, params) => query(text, params), order, false);
  const figures = packFigures(order, letters);
  return {
    orderId,
    letters,
    lettersInPack: figures.lettersInPack,
    lettersRemaining,
    lettersRefundedBefore: Math.floor((order.credits_refunded ?? 0) / CREDITS_PER_LETTER),
    perLetterCents: figures.perLetterCents,
    amountCents: figures.amountCents,
    amountDisplay: formatAmountForCurrency(figures.amountCents, order.currency),
    currency: order.currency,
    previewDigest: previewDigest(order, letters, lettersRemaining, figures.amountCents)
  };
}

interface ReplayedCommand {
  packRefundId: string;
}

/**
 * Operator idempotency: the same key with the same intent returns the first
 * outcome; the same key with a different intent is a conflict. Same shape as
 * transitionCommerceAlert's, on the same audit table.
 */
async function replayOrNull(
  client: Pick<pg.PoolClient, 'query'>,
  input: RefundPackLettersInput
): Promise<ReplayedCommand | null> {
  const replay = await client.query<{
    operation: string;
    target_type: string;
    target_reference_hash: string;
    actor_subject_hash: string;
    reason_code: string;
    after_state: { packRefundId?: string; letters?: number } | string;
  }>(
    `SELECT operation, target_type, target_reference_hash, actor_subject_hash, reason_code, after_state
       FROM commerce_operator_audit_events
      WHERE idempotency_key_hash = $1`,
    [hash(input.idempotencyKey)]
  );
  const existing = replay.rows[0];
  if (!existing) return null;
  const after = (typeof existing.after_state === 'string'
    ? JSON.parse(existing.after_state)
    : existing.after_state) as { packRefundId?: string; letters?: number };
  if (
    existing.operation !== 'pack_refund' ||
    existing.target_type !== 'order' ||
    existing.target_reference_hash !== hash(input.orderId) ||
    existing.actor_subject_hash !== hash(input.actor.id) ||
    existing.reason_code !== input.reasonCode ||
    after.letters !== input.letters ||
    !after.packRefundId
  ) {
    throw new PackRefundError('idempotency_conflict', 'Idempotency key reused with different inputs');
  }
  return { packRefundId: after.packRefundId };
}

export async function refundPackLetters(
  input: RefundPackLettersInput,
  stripeRefunds: PackRefundOperations = livePackRefundOperations,
  env: NodeJS.ProcessEnv = process.env
): Promise<RefundPackLettersResult> {
  if (!commandEnabled(env)) {
    throw new PackRefundError('PACK_REFUND_DISABLED', `${PACK_REFUND_ENABLED_FLAG} is not 'true'`);
  }
  const { mode } = resolveDeploymentMode(env);
  if (mode === 'test' || mode !== input.environment) {
    throw new PackRefundError(
      'PACK_REFUND_ENVIRONMENT_MISMATCH',
      `The command names ${input.environment}; this deployment is ${mode}`
    );
  }
  assertLetters(input.letters);
  if (!PACK_REFUND_REASON_CODE_PATTERN.test(input.reasonCode)) {
    throw new PackRefundError('PACK_REFUND_INVALID_INPUT', 'reasonCode must match ^[a-z][a-z0-9_]{2,79}$');
  }
  if (!PACK_REFUND_IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)) {
    throw new PackRefundError('PACK_REFUND_INVALID_INPUT', 'idempotencyKey must be 8-128 URL-safe characters');
  }
  if (!input.actor?.id) {
    throw new PackRefundError('PACK_REFUND_INVALID_INPUT', 'actor.id is required');
  }

  // Phase 1: revoke and record intent.
  const phaseOne = await transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [input.idempotencyKey]);
    const replayed = await replayOrNull(client, input);
    if (replayed) return { replayed: true as const, packRefundId: replayed.packRefundId };

    const orderResult = await client.query<Order>(
      'SELECT * FROM orders WHERE order_id = $1 FOR UPDATE',
      [input.orderId]
    );
    const order = orderResult.rows[0];
    assertPackOrder(order, input.orderId);
    if (order.status !== 'fulfilled') {
      throw new PackRefundError('PACK_REFUND_ORDER_STATE', `Order is ${order.status}; only a fulfilled pack can be refunded`);
    }
    const live = await client.query(
      `SELECT 1 FROM commerce_pack_refunds
        WHERE order_id = $1 AND status IN ('letters_revoked', 'stripe_pending', 'succeeded')`,
      [order.order_id]
    );
    if ((live.rowCount ?? live.rows.length) > 0) {
      throw new PackRefundError('PACK_REFUND_ALREADY_ISSUED', 'One proportional refund per pack');
    }
    const disputed = await client.query(
      `SELECT 1 FROM stripe_disputes
        WHERE payment_intent_id = $1 AND status <> ALL($2::text[])`,
      [order.stripe_payment_intent_id, NON_LOSS_DISPUTE_STATUSES]
    );
    const blocked = await client.query<{ sends_blocked_reason: string | null }>(
      'SELECT sends_blocked_reason FROM users WHERE user_id = $1',
      [order.user_id]
    );
    if ((disputed.rowCount ?? disputed.rows.length) > 0 || blocked.rows[0]?.sends_blocked_reason) {
      throw new PackRefundError('PACK_REFUND_DISPUTED', 'The payment is disputed or the account is blocked');
    }

    await lockAccountForBalanceChange(client, order.user_id);
    const lettersRemaining = await lettersRemainingOnPack((text, params) => client.query(text, params), order, true);
    if (input.letters > lettersRemaining) {
      throw new PackRefundError(
        'PACK_REFUND_TOO_MANY_LETTERS',
        `${input.letters} letters requested but ${lettersRemaining} remain on the pack`
      );
    }
    const figures = packFigures(order, input.letters);
    const alreadyRefunded = order.amount_refunded_cents ?? 0;
    if (figures.amountCents < 1 || alreadyRefunded + figures.amountCents >= order.amount_cents) {
      throw new PackRefundError(
        'PACK_REFUND_WOULD_BE_FULL',
        'A refund that completes the payment is a full refund and takes the full-refund path'
      );
    }
    if (
      input.expectedPreviewDigest &&
      input.expectedPreviewDigest !== previewDigest(order, input.letters, lettersRemaining, figures.amountCents)
    ) {
      throw new PackRefundError('PACK_REFUND_PREVIEW_STALE', 'The pack changed since the preview; preview again');
    }

    const packRefundId = randomUUID();
    const credits = input.letters * CREDITS_PER_LETTER;
    const inserted = await client.query<PackRefundRow>(
      `INSERT INTO commerce_pack_refunds (
         pack_refund_id, order_id, user_id, environment, letters, credits, amount_cents, currency,
         status, stripe_payment_intent_id, stripe_idempotency_key, reason_code,
         actor_subject_hash, idempotency_key_hash, admin_command_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'letters_revoked', $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        packRefundId,
        order.order_id,
        order.user_id,
        input.environment,
        input.letters,
        credits,
        figures.amountCents,
        order.currency,
        order.stripe_payment_intent_id,
        `pack-refund:${packRefundId}`,
        input.reasonCode,
        hash(input.actor.id),
        hash(input.idempotencyKey),
        input.adminCommandId ?? null
      ]
    );
    await revokePackLots(client, order, { credits, cause: 'partial_refund', packRefundId });
    await client.query(
      'UPDATE orders SET credits_refunded = credits_refunded + $2, updated_at = NOW() WHERE order_id = $1',
      [order.order_id, credits]
    );
    await client.query(
      `INSERT INTO commerce_operator_audit_events
         (idempotency_key_hash, actor_subject_hash, operation, target_type,
          target_reference_hash, reason_code, before_state, after_state)
       VALUES ($1, $2, 'pack_refund', 'order', $3, $4, $5, $6)`,
      [
        hash(input.idempotencyKey),
        hash(input.actor.id),
        hash(order.order_id),
        input.reasonCode,
        JSON.stringify({
          lettersRemaining,
          creditsRefunded: order.credits_refunded ?? 0,
          amountRefundedCents: alreadyRefunded
        }),
        JSON.stringify({
          packRefundId,
          letters: input.letters,
          amountCents: figures.amountCents,
          lettersRemaining: lettersRemaining - input.letters,
          creditsRefunded: (order.credits_refunded ?? 0) + credits
        })
      ]
    );
    await recordOrderEvent(client, order.order_id, 'pack_refund.letters_revoked', 'fulfilled', 'fulfilled', {
      packRefundId,
      letters: input.letters,
      creditsRevoked: credits,
      amountCents: figures.amountCents
    });
    return { replayed: false as const, row: inserted.rows[0] };
  });

  if (phaseOne.replayed) {
    const current = await query<{ status: PackRefundStatus; amount_cents: number }>(
      'SELECT status, amount_cents FROM commerce_pack_refunds WHERE pack_refund_id = $1',
      [phaseOne.packRefundId]
    );
    return {
      packRefundId: phaseOne.packRefundId,
      status: current.rows[0]?.status ?? 'letters_revoked',
      amountCents: current.rows[0]?.amount_cents ?? 0,
      replayed: true
    };
  }

  writeDiagnostic('info', 'pack_refund.letters_revoked', { letters: input.letters });
  const status = await submitPackRefund(phaseOne.row, stripeRefunds);
  return { packRefundId: phaseOne.row.pack_refund_id, status, amountCents: phaseOne.row.amount_cents, replayed: false };
}

/** Phase 2 then 3: create the Stripe refund under the stored key and record the answer. */
async function submitPackRefund(row: PackRefundRow, stripeRefunds: PackRefundOperations): Promise<PackRefundStatus> {
  let refund: Stripe.Refund;
  try {
    refund = await stripeRefunds.createPartialPaymentRefund({
      paymentIntentId: row.stripe_payment_intent_id,
      amountCents: row.amount_cents,
      orderId: row.order_id,
      packRefundId: row.pack_refund_id,
      lettersRefunded: row.letters,
      idempotencyKey: row.stripe_idempotency_key
    });
  } catch (error) {
    return handleStripeFailure(row, error);
  }
  return finalizeWithStripe(row, refund, 'pack_refund.stripe_response');
}

/** Phase 3, shared with the sweep: lock the order, then the row, then settle. */
async function finalizeWithStripe(
  row: PackRefundRow,
  refund: Stripe.Refund,
  source: string
): Promise<PackRefundStatus> {
  return transaction(async client => {
    // Lock order: orders, then the command row - the same order the webhook
    // takes, so the two can never wait on each other.
    await client.query('SELECT order_id FROM orders WHERE order_id = $1 FOR UPDATE', [row.order_id]);
    const locked = await lockPackRefund(client, row.pack_refund_id);
    if (!locked) return 'failed';
    return settlePackRefund(
      client,
      locked,
      { id: refund.id, status: refund.status, failureReason: refund.failure_reason },
      source
    );
  });
}

async function handleStripeFailure(row: PackRefundRow, error: unknown): Promise<PackRefundStatus> {
  const code = (error as { code?: string })?.code;
  const errorClass = carriedDiagnosticClass(error) ?? classifyDiagnosticError(error, 'provider_error');
  const terminal = isTerminalDiagnosticClass(errorClass) || (code !== undefined && TERMINAL_STRIPE_REFUND_CODES.has(code));
  if (terminal) {
    return transaction(async client => {
      await client.query('SELECT order_id FROM orders WHERE order_id = $1 FOR UPDATE', [row.order_id]);
      const locked = await lockPackRefund(client, row.pack_refund_id);
      if (!locked || locked.status !== 'letters_revoked') return locked?.status ?? 'failed';
      return compensatePackRefund(client, locked, {
        lastErrorCode: (code ?? errorClass).slice(0, 100),
        failureReason: error instanceof Error ? error.message.slice(0, 80) : errorClass
      });
    });
  }
  await query(
    `UPDATE commerce_pack_refunds
        SET stripe_attempts = stripe_attempts + 1, last_error_code = $2, updated_at = NOW()
      WHERE pack_refund_id = $1 AND status = 'letters_revoked'`,
    [row.pack_refund_id, (code ?? errorClass).slice(0, 100)]
  );
  writeDiagnostic('warn', 'pack_refund.stripe_indeterminate', { errorClass });
  return 'letters_revoked';
}

/**
 * The maintenance sweep. Rows still `letters_revoked` after the retry delay
 * are LISTED at Stripe first and adopted by metadata, because an idempotency
 * key may be pruned after 24 hours and a blind retry past that point would
 * create a second refund; only if nothing is found is the create retried with
 * the stored key. Rows pending for 30 days are re-read from Stripe. Rows past
 * the attempt limit are compensated.
 */
export async function reconcilePackRefunds(
  stripeRefunds: PackRefundOperations = livePackRefundOperations
): Promise<PackRefundSweepResult> {
  const result: PackRefundSweepResult = { retried: 0, adopted: 0, settled: 0, compensated: 0 };
  const delaySeconds = positiveIntegerSetting('PACK_REFUND_RETRY_DELAY_SECONDS', 300, 60);
  const attemptLimit = positiveIntegerSetting('PACK_REFUND_STRIPE_ATTEMPT_LIMIT', 5, 1);
  const due = await query<PackRefundRow>(
    `SELECT * FROM commerce_pack_refunds
      WHERE status = 'letters_revoked' AND updated_at <= NOW() - ($1 * INTERVAL '1 second')
      ORDER BY created_at ASC LIMIT 50`,
    [delaySeconds]
  );
  for (const row of due.rows) {
    try {
      if (row.stripe_attempts >= attemptLimit) {
        const outcome = await transaction(async client => {
          await client.query('SELECT order_id FROM orders WHERE order_id = $1 FOR UPDATE', [row.order_id]);
          const locked = await lockPackRefund(client, row.pack_refund_id);
          if (!locked || locked.status !== 'letters_revoked') return null;
          return compensatePackRefund(client, locked, {
            lastErrorCode: 'PACK_REFUND_STRIPE_UNREACHABLE',
            failureReason: `Stripe unreachable after ${row.stripe_attempts} attempts`
          });
        });
        if (outcome) result.compensated += 1;
        continue;
      }
      const refunds = await stripeRefunds.listPaymentRefunds(row.stripe_payment_intent_id);
      const found = refunds.find(refund => refund.metadata?.packRefundId === row.pack_refund_id);
      if (found) {
        await finalizeWithStripe(row, found, 'pack_refund.sweep_adopted');
        result.adopted += 1;
      } else {
        await submitPackRefund(row, stripeRefunds);
        result.retried += 1;
      }
    } catch (error) {
      writeDiagnostic('error', 'pack_refund.sweep_failed', {
        errorClass: carriedDiagnosticClass(error) ?? classifyDiagnosticError(error, 'provider_error')
      });
    }
  }
  const pending = await query<PackRefundRow>(
    `SELECT * FROM commerce_pack_refunds
      WHERE status = 'stripe_pending' AND updated_at <= NOW() - INTERVAL '30 days'
      ORDER BY created_at ASC LIMIT 50`
  );
  for (const row of pending.rows) {
    if (!row.stripe_refund_id) continue;
    try {
      const refund = await stripeRefunds.retrieveRefund(row.stripe_refund_id);
      await finalizeWithStripe(row, refund, 'pack_refund.sweep_settled');
      result.settled += 1;
    } catch (error) {
      writeDiagnostic('error', 'pack_refund.sweep_failed', {
        errorClass: carriedDiagnosticClass(error) ?? classifyDiagnosticError(error, 'provider_error')
      });
    }
  }
  return result;
}
