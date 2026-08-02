/** Platform-neutral commerce orchestration backed by the Stripe adapter. */

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type Stripe from 'stripe';
import { query, transaction } from '../db/index.js';
import { lockAccountForBalanceChange } from './accountLock.js';
import { addCreditsToLedgerWithClient } from './creditLedgerService.js';
import { grantImageEntitlementWithClient } from './imageGenerationLimitService.js';
import { createMailOrderFromDraftWithClient } from './mailSendService.js';
import {
  createJitCheckoutSession,
  createPackCheckoutSession,
  createPaymentRefund,
  findPaymentRefund,
  getJitProductConfig,
  getPackProductConfig,
  isJitPurchaseEnabled,
  retrieveCheckoutSession,
  retrieveRefund,
  type CommerceProductConfig,
  type PackProductId
} from './stripeService.js';
import type { LetterDraft, MailType, Order, OrderStatus } from './types.js';
import { classifyDiagnosticError, writeDiagnostic } from '../utils/diagnosticLog.js';

// Must mirror idx_orders_active_jit_draft_unique in migration 023.
export const ACTIVE_JIT_STATUSES: OrderStatus[] = [
  'checkout_pending',
  'paid',
  'fulfillment_pending',
  'refund_pending',
  'disputed',
  'held'
];
/**
 * Statuses in which a paid Checkout Session has already been acted on. A
 * replayed, duplicated, or late `checkout.session.completed` for one of these
 * must be ignored: `disputed` and `held` are financial holds that a fulfillment
 * transition would silently clear.
 */
export const FUNDED_OR_REVERSED_ORDER_STATUSES: OrderStatus[] = [
  'fulfillment_pending',
  'fulfilled',
  'refund_pending',
  'refunded',
  'disputed',
  'held'
];
const PURCHASE_CREDIT_EXPIRY_DAYS = 730;
const MINIMUM_REFUND_RETRY_DELAY_SECONDS = 30;

export interface CommerceCheckoutResult {
  success: true;
  orderId: string;
  sessionId?: string;
  sessionUrl?: string;
  error?: string;
  checkoutUrl?: string;
  amountCents: number;
  currency: string;
  productDescription: string;
  expiresAt?: string;
  status: OrderStatus;
  reused: boolean;
}

export interface CreatePackCheckoutParams {
  userId: string;
  userEmail: string;
  productId: PackProductId;
  successUrl: string;
  cancelUrl: string;
}

export interface CreateJitCheckoutParams {
  userId: string;
  draftId: string;
}

export interface PurchaseStatusResult {
  orderId: string;
  purchaseStatus:
    | 'pending_payment'
    | 'processing'
    | 'sent'
    | 'payment_failed'
    | 'refund_pending'
    | 'refunded'
    | 'cancelled';
  orderStatus: OrderStatus;
  productDescription: string;
  amountCents: number;
  currency: string;
  mailType?: MailType;
  letterId?: string;
  checkoutExpiresAt?: string;
  updatedAt: string;
  message: string;
}

export interface StripeEventProcessingResult {
  duplicate: boolean;
  orderId?: string;
  status?: OrderStatus;
}

export interface CommerceMaintenanceResult {
  expiredCheckouts: number;
  recoveredFulfillments: number;
  reconciledPayments: number;
  refundAttempts: number;
  stuckOrders: number;
}

export interface SendEligibility {
  prepaid: {
    eligible: boolean;
    requiredCredits: number;
    availableCredits: number;
  };
  payAndSend: {
    available: boolean;
    amountCents?: number;
    currency?: string;
    productDescription?: string;
    unavailableReason?: string;
  };
  letterPack: {
    available: boolean;
    purchaseUrl: string;
  };
}

function integerSetting(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

type RefundClaim = Order & { previous_refund_attempts: number };

function refundRetryDelaySeconds(): number {
  return Math.max(
    MINIMUM_REFUND_RETRY_DELAY_SECONDS,
    integerSetting('JIT_REFUND_RETRY_DELAY_SECONDS', 300)
  );
}

export function getSendEligibility(
  availableCredits: number,
  requiredCredits: number,
  mailType: MailType
): SendEligibility {
  const prepaidEligible = availableCredits >= requiredCredits;
  const product = getJitProductConfig(mailType);
  const configured = Boolean(product.priceId && product.amountCents > 0);
  const allowedWithBalance = process.env.JIT_ALLOW_WITH_PREPAID_BALANCE === 'true';
  const available =
    isJitPurchaseEnabled() && configured && (!prepaidEligible || allowedWithBalance);
  let unavailableReason: string | undefined;
  if (!isJitPurchaseEnabled()) unavailableReason = 'Pay & Send is not enabled.';
  else if (!configured) unavailableReason = 'Pay & Send pricing is not configured.';
  else if (prepaidEligible && !allowedWithBalance) {
    unavailableReason = 'Use your existing prepaid letter balance.';
  }

  return {
    prepaid: {
      eligible: prepaidEligible,
      requiredCredits,
      availableCredits
    },
    payAndSend: {
      available,
      amountCents: configured ? product.amountCents : undefined,
      currency: configured ? product.currency : undefined,
      productDescription: configured ? product.name : undefined,
      unavailableReason
    },
    letterPack: {
      available: true,
      purchaseUrl:
        process.env.LETTER_IRL_PACKS_URL ||
        process.env.LETTER_IRL_PUBLIC_BASE_URL ||
        'https://letterirl.com'
    }
  };
}

function checkoutExpiry(draftExpiresAt: Date): Date {
  const configuredMinutes = Math.min(
    24 * 60,
    Math.max(30, integerSetting('JIT_CHECKOUT_EXPIRY_MINUTES', 30))
  );
  // Stripe requires expires_at to remain at least 30 minutes in the future
  // when the API request arrives, so retain a small network/clock margin.
  const configured = new Date(Date.now() + configuredMinutes * 60_000 + 5_000);
  const draftExpiry = new Date(draftExpiresAt);
  if (draftExpiry.getTime() - Date.now() < 30 * 60_000 + 5_000) {
    throw Object.assign(
      new Error('Draft expires too soon to open a safe checkout. Please create a new preview.'),
      { code: 'DRAFT_TOO_CLOSE_TO_EXPIRY' }
    );
  }
  return configured < draftExpiry ? configured : draftExpiry;
}

function appendQuery(base: string, values: Record<string, string>): string {
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}${Object.entries(values)
    .map(([key, value]) => `${encodeURIComponent(key)}=${value}`)
    .join('&')}`;
}

function jitReturnUrls(orderId: string): {
  successUrl: string;
  cancelUrl: string;
} {
  const publicBase = (
    process.env.JIT_CHECKOUT_RETURN_URL ||
    process.env.LETTER_IRL_PUBLIC_BASE_URL ||
    process.env.LETTER_IRL_API_URL ||
    'https://api.letterirl.com/purchase/return'
  ).replace(/\/$/, '');
  const returnBase = publicBase.endsWith('/purchase/return')
    ? publicBase
    : `${publicBase}/purchase/return`;
  return {
    successUrl: appendQuery(returnBase, {
      outcome: 'success',
      order_id: encodeURIComponent(orderId),
      session_id: '{CHECKOUT_SESSION_ID}'
    }),
    cancelUrl: appendQuery(returnBase, {
      outcome: 'cancelled',
      order_id: encodeURIComponent(orderId)
    })
  };
}

function productSnapshot(product: CommerceProductConfig): Record<string, unknown> {
  return {
    name: product.name,
    description: product.description,
    mailType: product.mailType
  };
}

function asCheckoutResult(order: Order, reused: boolean): CommerceCheckoutResult {
  return {
    success: true,
    orderId: order.order_id,
    sessionId: order.stripe_checkout_session_id,
    sessionUrl: order.checkout_url,
    checkoutUrl: order.checkout_url,
    amountCents: order.amount_cents,
    currency: order.currency,
    productDescription: String(order.product_snapshot?.name || order.product_code),
    expiresAt: order.checkout_expires_at
      ? new Date(order.checkout_expires_at).toISOString()
      : undefined,
    status: order.status,
    reused
  };
}

async function recordOrderEvent(
  client: Pick<pg.PoolClient, 'query'>,
  orderId: string,
  eventType: string,
  fromStatus: OrderStatus | null,
  toStatus: OrderStatus | null,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await client.query(
    `INSERT INTO commerce_order_events (
       order_id, event_type, from_status, to_status, metadata
     ) VALUES ($1, $2, $3, $4, $5)`,
    [orderId, eventType, fromStatus, toStatus, JSON.stringify(metadata)]
  );
}

async function markCheckoutCreationFailure(orderId: string, error: string): Promise<void> {
  await query(
    `UPDATE orders
     SET last_error_code = 'CHECKOUT_CREATION_FAILED', last_error = $2, updated_at = NOW()
     WHERE order_id = $1`,
    [orderId, error]
  );
}

async function attachCheckout(
  orderId: string,
  sessionId: string,
  checkoutUrl: string | undefined,
  expiresAt: Date | undefined
): Promise<Order> {
  return transaction(async client => {
    const current = await client.query<Order>(
      'SELECT * FROM orders WHERE order_id = $1 FOR UPDATE',
      [orderId]
    );
    const order = current.rows[0];
    if (!order) throw new Error(`Commerce order not found: ${orderId}`);
    const updated = await client.query<Order>(
      `UPDATE orders
       SET stripe_checkout_session_id = $2,
           checkout_url = COALESCE(checkout_url, $3),
           checkout_expires_at = COALESCE($4, checkout_expires_at),
           last_error_code = NULL, last_error = NULL, updated_at = NOW()
       WHERE order_id = $1
       RETURNING *`,
      [orderId, sessionId, checkoutUrl || null, expiresAt || null]
    );
    await recordOrderEvent(
      client,
      orderId,
      'checkout.session.created',
      order.status,
      order.status,
      { sessionId }
    );
    return updated.rows[0];
  });
}

export class PackAmountNotConfiguredError extends Error {
  readonly code = 'PACK_AMOUNT_NOT_CONFIGURED';
  constructor(readonly productCode: string) {
    super(`Pack amount is not configured for ${productCode}`);
    this.name = 'PackAmountNotConfiguredError';
  }
}

/**
 * Fail closed when a pack price is configured without its authoritative amount.
 * Amounts are never inferred from a Stripe Price ID: an unknown amount must
 * disable the purchase rather than create an order that cannot be reconciled or
 * refunded against a trusted figure.
 */
export function assertConfiguredAmount(
  product: Pick<CommerceProductConfig, 'amountCents'>,
  productCode: string
): void {
  if (!Number.isInteger(product.amountCents) || product.amountCents <= 0) {
    throw new PackAmountNotConfiguredError(productCode);
  }
}

export async function createPackCheckout(
  params: CreatePackCheckoutParams
): Promise<CommerceCheckoutResult> {
  const product = getPackProductConfig(params.productId);
  if (!product) throw new Error(`Invalid product ID: ${params.productId}`);
  if (!product.priceId) throw new Error(`Price ID not configured for ${params.productId}`);
  // A missing STRIPE_*_AMOUNT_CENTS must fail before any authoritative order
  // exists. Persisting a zero amount would make the order unreconcilable
  // against Stripe and would leave any later refund without a trusted amount.
  assertConfiguredAmount(product, params.productId);

  const orderId = randomUUID();
  const idempotencyKey = `pack-checkout:${orderId}`;
  const inserted = await query<Order>(
    `INSERT INTO orders (
       order_id, user_id, order_type, product_code, product_snapshot, credits,
       amount_cents, currency, payment_provider, idempotency_key, status
     ) VALUES ($1, $2, 'letter_pack', $3, $4, $5, $6, $7, 'stripe', $8, 'checkout_pending')
     RETURNING *`,
    [
      orderId,
      params.userId,
      product.productCode,
      JSON.stringify(productSnapshot(product)),
      product.credits,
      product.amountCents,
      product.currency,
      idempotencyKey
    ]
  );

  const checkout = await createPackCheckoutSession({
    orderId,
    userEmail: params.userEmail,
    product,
    successUrl: params.successUrl,
    cancelUrl: params.cancelUrl,
    idempotencyKey
  });
  if (!checkout.success || !checkout.sessionId) {
    await markCheckoutCreationFailure(orderId, checkout.error || 'Unknown Stripe error');
    throw new Error(checkout.error || 'Failed to create checkout session');
  }
  const order = await attachCheckout(
    orderId,
    checkout.sessionId,
    checkout.sessionUrl,
    checkout.expiresAt
  );
  return asCheckoutResult(order || inserted.rows[0], false);
}

async function prepareJitOrder(
  params: CreateJitCheckoutParams
): Promise<{ order: Order; reused: boolean }> {
  return transaction(async client => {
    const draftResult = await client.query<LetterDraft>(
      'SELECT * FROM letter_drafts WHERE draft_id = $1 FOR UPDATE',
      [params.draftId]
    );
    const draft = draftResult.rows[0];
    if (!draft)
      throw Object.assign(new Error('Draft not found'), {
        code: 'DRAFT_NOT_FOUND'
      });
    if (draft.user_id !== params.userId) {
      throw Object.assign(new Error('Draft does not belong to this user'), {
        code: 'DRAFT_NOT_OWNED'
      });
    }
    if (draft.status !== 'pending') {
      throw Object.assign(new Error(`Draft is ${draft.status}`), {
        code: 'DRAFT_INVALID_STATE'
      });
    }
    if (new Date(draft.expires_at).getTime() <= Date.now()) {
      throw Object.assign(new Error('Draft has expired'), {
        code: 'DRAFT_EXPIRED'
      });
    }

    const active = await client.query<Order>(
      `SELECT * FROM orders
       WHERE draft_id = $1 AND order_type = 'jit_mail'
         AND status = ANY($2::varchar[])
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE`,
      [params.draftId, ACTIVE_JIT_STATUSES]
    );
    const existing = active.rows[0];
    if (existing) {
      if (
        existing.status === 'checkout_pending' &&
        existing.checkout_expires_at &&
        new Date(existing.checkout_expires_at).getTime() <= Date.now() &&
        !existing.stripe_checkout_session_id
      ) {
        await client.query(
          `UPDATE orders SET status = 'cancelled', updated_at = NOW()
           WHERE order_id = $1`,
          [existing.order_id]
        );
        await recordOrderEvent(
          client,
          existing.order_id,
          'checkout.expired_locally',
          existing.status,
          'cancelled'
        );
      } else {
        return { order: existing, reused: true };
      }
    }

    const actualMailType = (draft.mail_type || 'letter') as MailType;
    const product = getJitProductConfig(actualMailType);
    if (!product.priceId || product.amountCents <= 0) {
      throw Object.assign(new Error('Pay & Send pricing is not configured'), {
        code: 'JIT_NOT_CONFIGURED'
      });
    }
    if (process.env.JIT_ALLOW_WITH_PREPAID_BALANCE !== 'true') {
      const balance = await client.query<{ credits: number }>(
        'SELECT credits FROM users WHERE user_id = $1',
        [params.userId]
      );
      if ((balance.rows[0]?.credits || 0) >= draft.required_credits) {
        throw Object.assign(new Error('This draft can be sent from the existing prepaid balance'), {
          code: 'PREPAID_BALANCE_AVAILABLE'
        });
      }
    }

    const orderId = randomUUID();
    const expiresAt = checkoutExpiry(new Date(draft.expires_at));
    const inserted = await client.query<Order>(
      `INSERT INTO orders (
         order_id, user_id, order_type, draft_id, product_code, product_snapshot,
         credits, amount_cents, currency, payment_provider, idempotency_key,
         checkout_expires_at, status
       ) VALUES ($1, $2, 'jit_mail', $3, $4, $5, NULL, $6, $7, 'stripe', $8, $9, 'checkout_pending')
       RETURNING *`,
      [
        orderId,
        params.userId,
        params.draftId,
        product.productCode,
        JSON.stringify(productSnapshot(product)),
        product.amountCents,
        product.currency,
        `jit-checkout:${orderId}`,
        expiresAt
      ]
    );
    await recordOrderEvent(client, orderId, 'order.created', null, 'checkout_pending');
    return { order: inserted.rows[0], reused: false };
  });
}

export async function createJitCheckout(
  params: CreateJitCheckoutParams
): Promise<CommerceCheckoutResult> {
  if (!isJitPurchaseEnabled()) {
    throw Object.assign(new Error('Pay & Send is not currently enabled'), {
      code: 'JIT_DISABLED'
    });
  }
  const prepared = await prepareJitOrder(params);
  if (prepared.order.status !== 'checkout_pending' || prepared.order.checkout_url) {
    return asCheckoutResult(prepared.order, true);
  }

  const mailType = String(prepared.order.product_snapshot.mailType || 'letter') as MailType;
  const product = getJitProductConfig(mailType);
  const urls = jitReturnUrls(prepared.order.order_id);
  const checkout = await createJitCheckoutSession({
    orderId: prepared.order.order_id,
    product,
    successUrl: urls.successUrl,
    cancelUrl: urls.cancelUrl,
    expiresAt: prepared.order.checkout_expires_at
      ? new Date(prepared.order.checkout_expires_at)
      : undefined,
    idempotencyKey: prepared.order.idempotency_key
  });
  if (!checkout.success || !checkout.sessionId) {
    await markCheckoutCreationFailure(
      prepared.order.order_id,
      checkout.error || 'Unknown Stripe error'
    );
    throw new Error(checkout.error || 'Failed to create Pay & Send checkout');
  }

  const order = await attachCheckout(
    prepared.order.order_id,
    checkout.sessionId,
    checkout.sessionUrl,
    checkout.expiresAt
  );
  return asCheckoutResult(order, prepared.reused);
}

function paymentIntentId(session: Stripe.Checkout.Session): string | null {
  if (typeof session.payment_intent === 'string') return session.payment_intent;
  return session.payment_intent?.id || null;
}

async function findCheckoutOrder(
  client: Pick<pg.PoolClient, 'query'>,
  session: Stripe.Checkout.Session
): Promise<Order | null> {
  const orderId = session.metadata?.orderId || session.client_reference_id;
  const result = orderId
    ? await client.query<Order>(
        `SELECT * FROM orders
         WHERE order_id = $1 OR stripe_checkout_session_id = $2
         ORDER BY CASE WHEN order_id = $1 THEN 0 ELSE 1 END
         LIMIT 1 FOR UPDATE`,
        [orderId, session.id]
      )
    : await client.query<Order>(
        'SELECT * FROM orders WHERE stripe_checkout_session_id = $1 LIMIT 1 FOR UPDATE',
        [session.id]
      );
  return result.rows[0] || null;
}

async function createLegacyPackOrder(
  client: Pick<pg.PoolClient, 'query'>,
  session: Stripe.Checkout.Session
): Promise<Order | null> {
  const userId = session.metadata?.userId || session.metadata?.user_id;
  const productCode = session.metadata?.productId || session.metadata?.product_id;
  const product = productCode ? getPackProductConfig(productCode as PackProductId) : null;
  if (!userId || !product) {
    return null;
  }
  // Without a configured amount this INSERT would violate the amount_cents
  // CHECK and roll back the whole webhook transaction, including the event
  // claim, leaving Stripe to retry forever with no operator signal. Refuse the
  // adoption instead so the unmatched-money path records it durably.
  if (!Number.isInteger(product.amountCents) || product.amountCents <= 0) {
    writeDiagnostic('error', 'commerce.legacy_pack_amount_not_configured', {
      productCode: product.productCode
    });
    return null;
  }
  const orderId = `stripe-${session.id}`;
  const inserted = await client.query<Order>(
    `INSERT INTO orders (
       order_id, user_id, order_type, product_code, product_snapshot, credits,
       amount_cents, currency, payment_provider, stripe_checkout_session_id,
       stripe_payment_intent_id, idempotency_key, status, checkout_expires_at
     ) VALUES ($1, $2, 'letter_pack', $3, $4, $5, $6, $7, 'stripe', $8, $9, $10,
       'checkout_pending', $11)
     RETURNING *`,
    [
      orderId,
      userId,
      product.productCode,
      JSON.stringify({
        ...productSnapshot(product),
        migratedFromLegacyCheckout: true
      }),
      product.credits,
      product.amountCents,
      product.currency,
      session.id,
      paymentIntentId(session),
      `legacy-checkout:${session.id}`,
      new Date(session.expires_at * 1000)
    ]
  );
  await recordOrderEvent(
    client,
    orderId,
    'order.created_from_legacy_checkout',
    null,
    'checkout_pending'
  );
  return inserted.rows[0];
}

async function claimStripeEvent(
  client: Pick<pg.PoolClient, 'query'>,
  eventId: string,
  eventType: string,
  providerObjectId: string
): Promise<boolean> {
  const claimed = await client.query<{ event_id: string }>(
    `INSERT INTO stripe_webhook_events (event_id, event_type, provider_object_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [eventId, eventType, providerObjectId]
  );
  return Boolean(claimed.rows[0]);
}

function packImageGrant(credits: number): number {
  const perLetter = integerSetting(
    'IMAGE_ENTITLEMENTS_PER_PACK_LETTER',
    integerSetting('IMAGE_GENERATION_LIMIT_PER_LETTER', 5)
  );
  return Math.floor(credits / 2) * perLetter;
}

export interface RepairFulfilledPackGrantParams {
  orderId: string;
  stripeSessionId: string;
  expectedCredits: number;
  paidAmountCents: number;
  paidCurrency: string;
}

/**
 * Repair a legacy/inconsistent fulfilled pack grant discovered from a paid
 * Stripe session. The exact order/session binding, ledger grant, image grant,
 * user balance, and order event are serialized by the order lock and commit in
 * one transaction. Checkout-pending or financially reversed orders must be
 * repaired by replaying their provider event instead of bypassing the commerce
 * state machine here.
 */
export async function repairFulfilledPackGrant(
  params: RepairFulfilledPackGrantParams
): Promise<'repaired' | 'already_granted'> {
  return transaction(async client => {
    const result = await client.query<Order>(
      `SELECT * FROM orders
       WHERE order_id = $1 AND order_type = 'letter_pack'
       FOR UPDATE`,
      [params.orderId]
    );
    const order = result.rows[0];
    if (
      !order ||
      order.status !== 'fulfilled' ||
      order.stripe_checkout_session_id !== params.stripeSessionId ||
      order.credits !== params.expectedCredits ||
      order.amount_cents !== params.paidAmountCents ||
      order.currency.toLowerCase() !== params.paidCurrency.toLowerCase()
    ) {
      throw new Error('Pack reconciliation does not match a fulfilled authoritative order');
    }

    // Canonical account lock order: users -> credit_ledger -> image_entitlements.
    await lockAccountForBalanceChange(client, order.user_id);
    const existing = await client.query<{ ledger_id: string }>(
      `SELECT ledger_id FROM credit_ledger
       WHERE source_type = 'purchase' AND source_reference_id = $1
       FOR UPDATE`,
      [order.order_id]
    );
    await grantImageEntitlementWithClient(client, {
      userId: order.user_id,
      sourceType: 'letter_pack',
      sourceReferenceId: order.order_id,
      sourceOrderId: order.order_id,
      quantity: packImageGrant(order.credits)
    });
    if (existing.rows[0]) return 'already_granted';

    await addCreditsToLedgerWithClient(client, {
      userId: order.user_id,
      credits: order.credits,
      sourceType: 'purchase',
      sourceReferenceId: order.order_id,
      sourceOrderId: order.order_id,
      sourceMetadata: {
        stripe_session_id: params.stripeSessionId,
        stripe_payment_intent_id: order.stripe_payment_intent_id,
        product_code: order.product_code,
        amount_cents: order.amount_cents,
        currency: order.currency
      },
      expirationDays: PURCHASE_CREDIT_EXPIRY_DAYS,
      description: `Repaired ${order.product_code} grant after Stripe reconciliation`
    });
    await recordOrderEvent(
      client,
      order.order_id,
      'maintenance.pack_grant_repaired',
      order.status,
      order.status,
      { source: 'stripe_reconciliation' }
    );
    return 'repaired';
  });
}

async function transitionPaidCheckout(
  client: pg.PoolClient,
  order: Order,
  session: Stripe.Checkout.Session,
  eventType: string
): Promise<OrderStatus> {
  const intentId = paymentIntentId(session);
  await client.query(
    `UPDATE orders
     SET stripe_checkout_session_id = COALESCE(stripe_checkout_session_id, $2),
         stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, $3),
         checkout_url = COALESCE(checkout_url, $4),
         updated_at = NOW()
     WHERE order_id = $1`,
    [order.order_id, session.id, intentId, session.url || null]
  );

  if (session.payment_status !== 'paid') return order.status;
  // Any order that has already been funded, compensated, disputed, or held is
  // terminal for this transition. A replayed or late Checkout event must never
  // re-grant credits, re-create mail, or reset a financial hold.
  if (FUNDED_OR_REVERSED_ORDER_STATUSES.includes(order.status)) {
    return order.status;
  }

  const paidAmount = session.amount_total || 0;
  const paidCurrency = (session.currency || '').toLowerCase();
  if (paidAmount !== order.amount_cents || paidCurrency !== order.currency.toLowerCase()) {
    await client.query(
      `UPDATE orders
       SET status = 'refund_pending', refund_pending_at = NOW(),
           last_error_code = 'PAYMENT_AMOUNT_MISMATCH',
           last_error = $2, updated_at = NOW()
       WHERE order_id = $1`,
      [
        order.order_id,
        `Expected ${order.amount_cents} ${order.currency}; received ${paidAmount} ${paidCurrency}`
      ]
    );
    await recordOrderEvent(client, order.order_id, eventType, order.status, 'refund_pending', {
      reason: 'payment_amount_mismatch'
    });
    return 'refund_pending';
  }

  await client.query(
    `UPDATE orders
     SET status = 'paid', paid_at = COALESCE(paid_at, NOW()),
         stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, $2),
         last_error_code = NULL, last_error = NULL, updated_at = NOW()
     WHERE order_id = $1`,
    [order.order_id, intentId]
  );
  await recordOrderEvent(client, order.order_id, eventType, order.status, 'paid');

  if (order.order_type === 'letter_pack') {
    const credits = order.credits || 0;
    await addCreditsToLedgerWithClient(client, {
      userId: order.user_id,
      email: session.customer_email || session.customer_details?.email || undefined,
      credits,
      sourceType: 'purchase',
      sourceReferenceId: order.order_id,
      sourceOrderId: order.order_id,
      sourceMetadata: {
        stripe_session_id: session.id,
        stripe_payment_intent_id: intentId,
        product_code: order.product_code,
        amount_cents: order.amount_cents,
        currency: order.currency
      },
      expirationDays: PURCHASE_CREDIT_EXPIRY_DAYS,
      description: `Purchased ${order.product_code} via Stripe Checkout`
    });
    await grantImageEntitlementWithClient(client, {
      userId: order.user_id,
      sourceType: 'letter_pack',
      sourceReferenceId: order.order_id,
      sourceOrderId: order.order_id,
      quantity: packImageGrant(credits)
    });
    await client.query(
      `UPDATE orders
       SET status = 'fulfilled', fulfilled_at = NOW(), completed_at = NOW(), updated_at = NOW()
       WHERE order_id = $1`,
      [order.order_id]
    );
    await recordOrderEvent(client, order.order_id, 'letter_pack.granted', 'paid', 'fulfilled');
    return 'fulfilled';
  }

  await client.query('SAVEPOINT jit_fulfillment');
  try {
    const mailType = String(order.product_snapshot.mailType || 'letter') as MailType;
    await createMailOrderFromDraftWithClient(client, {
      draftId: order.draft_id!,
      userId: order.user_id,
      mailType,
      funding: { type: 'jit_order', orderId: order.order_id }
    });
    await grantImageEntitlementWithClient(client, {
      userId: order.user_id,
      sourceType: 'jit_order',
      sourceReferenceId: order.order_id,
      sourceOrderId: order.order_id,
      quantity: integerSetting('IMAGE_ENTITLEMENTS_PER_JIT_ORDER', 1)
    });
    await client.query('RELEASE SAVEPOINT jit_fulfillment');
    await recordOrderEvent(
      client,
      order.order_id,
      'jit.fulfillment_queued',
      'paid',
      'fulfillment_pending'
    );
    return 'fulfillment_pending';
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT jit_fulfillment');
    const message = error instanceof Error ? error.message : 'JIT fulfillment failed';
    await client.query(
      `UPDATE orders
       SET status = 'refund_pending', refund_pending_at = NOW(),
           last_error_code = 'JIT_FULFILLMENT_REJECTED', last_error = $2,
           updated_at = NOW()
       WHERE order_id = $1`,
      [order.order_id, message]
    );
    await recordOrderEvent(
      client,
      order.order_id,
      'jit.fulfillment_rejected',
      'paid',
      'refund_pending',
      { error: message }
    );
    return 'refund_pending';
  }
}

async function processCheckoutSessionEvent(
  eventId: string,
  eventType: string,
  session: Stripe.Checkout.Session
): Promise<StripeEventProcessingResult> {
  return transaction(async client => {
    if (!(await claimStripeEvent(client, eventId, eventType, session.id))) {
      return { duplicate: true };
    }
    let order = await findCheckoutOrder(client, session);
    if (!order) order = await createLegacyPackOrder(client, session);
    if (!order) return { duplicate: false };
    await client.query('UPDATE stripe_webhook_events SET order_id = $2 WHERE event_id = $1', [
      eventId,
      order.order_id
    ]);

    const intentId = paymentIntentId(session);
    const unmatchedMoney = await client.query<{ event_id: string; event_type: string }>(
      `SELECT event_id, event_type FROM stripe_webhook_events
       WHERE processing_status = 'unmatched'
         AND (($1::varchar IS NOT NULL AND provider_payment_intent_id = $1)
           OR metadata_order_id = $2)
       ORDER BY processed_at FOR UPDATE`,
      [intentId, order.order_id]
    );
    if (unmatchedMoney.rows[0]) {
      const isDispute = unmatchedMoney.rows.some(row => row.event_type.startsWith('charge.dispute.'));
      const blockedStatus: OrderStatus = isDispute ? 'disputed' : 'refund_pending';
      await client.query(
        `UPDATE orders SET stripe_checkout_session_id = COALESCE(stripe_checkout_session_id, $2),
           stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, $3),
           status = $4::varchar, refund_pending_at = CASE WHEN $4::varchar = 'refund_pending'
             THEN COALESCE(refund_pending_at, NOW()) ELSE refund_pending_at END,
           last_error_code = 'UNMATCHED_MONEY_EVENT_RECOVERED', updated_at = NOW()
         WHERE order_id = $1`,
        [order.order_id, session.id, intentId, blockedStatus]
      );
      await client.query(
        `UPDATE stripe_webhook_events SET order_id = $2, processing_status = 'processed',
           resolved_at = NOW() WHERE event_id = ANY($1::varchar[])`,
        [unmatchedMoney.rows.map(row => row.event_id), order.order_id]
      );
      await client.query(
        `UPDATE commerce_operational_alerts SET status = 'resolved', resolved_at = NOW(),
           resolution_code = 'matched_later_checkout', updated_at = NOW()
         WHERE source_event_id = ANY($1::varchar[]) AND status <> 'resolved'`,
        [unmatchedMoney.rows.map(row => row.event_id)]
      );
      await recordOrderEvent(client, order.order_id, 'stripe.money_event_recovered',
        order.status, blockedStatus, { eventCount: unmatchedMoney.rows.length });
      return { duplicate: false, orderId: order.order_id, status: blockedStatus };
    }

    // Once a Checkout Session has been attached, never let a different
    // server-signed Session reuse metadata to authorize this order. The
    // metadata lookup is needed only for the legitimate webhook-before-attach
    // race immediately after Session creation.
    if (
      order.stripe_checkout_session_id &&
      order.stripe_checkout_session_id !== session.id
    ) {
      await recordOrderEvent(client, order.order_id, eventType, order.status, order.status, {
        ignored: true,
        reason: 'checkout_session_mismatch'
      });
      return { duplicate: false, orderId: order.order_id, status: order.status };
    }

    if (eventType === 'checkout.session.async_payment_failed') {
      if (order.status !== 'checkout_pending') {
        await recordOrderEvent(client, order.order_id, eventType, order.status, order.status, {
          ignored: true
        });
        return { duplicate: false, orderId: order.order_id, status: order.status };
      }
      await client.query(
        `UPDATE orders
         SET status = 'payment_failed', payment_failed_at = NOW(), updated_at = NOW()
         WHERE order_id = $1 AND status = 'checkout_pending'`,
        [order.order_id]
      );
      await recordOrderEvent(client, order.order_id, eventType, order.status, 'payment_failed');
      return {
        duplicate: false,
        orderId: order.order_id,
        status: 'payment_failed'
      };
    }
    if (eventType === 'checkout.session.expired') {
      if (order.status !== 'checkout_pending') {
        await recordOrderEvent(client, order.order_id, eventType, order.status, order.status, {
          ignored: true
        });
        return { duplicate: false, orderId: order.order_id, status: order.status };
      }
      await client.query(
        `UPDATE orders SET status = 'cancelled', updated_at = NOW()
         WHERE order_id = $1 AND status = 'checkout_pending'`,
        [order.order_id]
      );
      await recordOrderEvent(client, order.order_id, eventType, order.status, 'cancelled');
      return { duplicate: false, orderId: order.order_id, status: 'cancelled' };
    }

    const status = await transitionPaidCheckout(client, order, session, eventType);
    return { duplicate: false, orderId: order.order_id, status };
  });
}

async function revokePackCredits(
  client: Pick<pg.PoolClient, 'query'>,
  order: Order
): Promise<void> {
  // Canonical account lock order: users -> credit_ledger -> image_entitlements.
  // Reversal must take the account lock first so it cannot deadlock against a
  // concurrent ledger deduction or grant, which lock the user row first.
  await lockAccountForBalanceChange(client, order.user_id);
  const entries = await client.query<{
    ledger_id: string;
    initial_amount: number;
    remaining_amount: number;
  }>(
    `SELECT ledger_id, initial_amount, remaining_amount FROM credit_ledger
     WHERE user_id = $1 AND source_type = 'purchase'
       AND (source_reference_id = $2 OR source_metadata->>'stripe_session_id' = $3)
       AND status <> 'revoked'
     FOR UPDATE`,
    [order.user_id, order.order_id, order.stripe_checkout_session_id || null]
  );
  const remaining = entries.rows.reduce((sum, entry) => sum + entry.remaining_amount, 0);
  // Separate Stripe events can report the same completed refund. No
  // non-revoked purchase rows means this pack grant was already reversed.
  if (entries.rows.length === 0) return;
  await client.query(
    `UPDATE credit_ledger
     SET remaining_amount = 0, status = 'revoked', updated_at = NOW()
     WHERE ledger_id = ANY($1::uuid[])`,
    [entries.rows.map(entry => entry.ledger_id)]
  );
  for (const entry of entries.rows) {
    await client.query(
      `INSERT INTO credit_ledger (
         user_id, initial_amount, remaining_amount, source_type,
         source_reference_id, source_metadata, activated_at,
         expiration_policy, status, description, related_ledger_id
       ) VALUES ($1, $2, 0, 'refund', $3, $4, NOW(), 'never', 'revoked', $5, $6)`,
      [
        order.user_id,
        entry.initial_amount,
        order.order_id,
        JSON.stringify({ reason: 'payment_refunded', order_id: order.order_id }),
        `Payment refund for ${order.order_id}`,
        entry.ledger_id
      ]
    );
  }
  const user = await client.query<{ credits: number }>(
    `UPDATE users
     SET credits = GREATEST(credits - $1, 0),
         credits_purchased = GREATEST(credits_purchased - $2, 0),
         updated_at = NOW()
     WHERE user_id = $3
     RETURNING credits`,
    [remaining, order.credits || 0, order.user_id]
  );
  if (remaining > 0 && user.rows[0]) {
    await client.query(
      `INSERT INTO credit_transactions (
         user_id, amount, balance_after, type, reference_type, reference_id, description
       ) VALUES ($1, $2, $3, 'refund', 'order', $4, $5)`,
      [
        order.user_id,
        -remaining,
        user.rows[0].credits,
        order.order_id,
        `Revoked unused credits after refund of ${order.order_id}`
      ]
    );
  }
  await client.query(
    `WITH ranked AS (
       SELECT created_at, ROW_NUMBER() OVER (ORDER BY created_at) AS rank
       FROM credit_ledger AS purchase
       WHERE purchase.user_id = $1 AND purchase.source_type = 'purchase'
         AND NOT EXISTS (
           SELECT 1 FROM credit_ledger AS refund
           WHERE refund.source_type = 'refund'
             AND refund.related_ledger_id = purchase.ledger_id
         )
     ), eligibility AS (
       SELECT COUNT(*) AS purchase_count,
              MAX(created_at) FILTER (WHERE rank = 3) AS qualifying_at FROM ranked
     )
     UPDATE users SET tier = (CASE
       WHEN eligibility.purchase_count >= 3
        AND eligibility.qualifying_at <= NOW() - INTERVAL '120 days' THEN 'trusted'
       ELSE 'standard' END)::user_tier,
       tier_calculated_at = NOW(), updated_at = NOW()
     FROM eligibility WHERE users.user_id = $1`,
    [order.user_id]
  );
}

async function stopFundedMailBeforeFinancialReversal(
  client: pg.PoolClient,
  order: Order,
  sourceEventId: string,
  reason: 'payment_reversed' | 'payment_disputed'
): Promise<'none' | 'cancelled' | 'held'> {
  if (order.order_type !== 'jit_mail' || !order.letter_id) return 'none';
  await client.query('SELECT letter_id FROM letters WHERE letter_id = $1 FOR UPDATE', [order.letter_id]);
  const job = await client.query<{ job_id: string; status: string; provider_outcome: string }>(
    'SELECT job_id, status, provider_outcome FROM letter_jobs WHERE letter_id = $1 FOR UPDATE',
    [order.letter_id]
  );
  const current = job.rows[0];
  if (!current) return 'none';
  if (current.provider_outcome === 'not_dispatched') {
    await client.query(
      `UPDATE letter_jobs SET status = 'cancelled', completed_at = NOW(), locked_at = NULL,
         hold_reason = $2, updated_at = NOW() WHERE job_id = $1 AND status <> 'completed'`,
      [current.job_id, reason]
    );
    await client.query(
      `UPDATE letters SET status = 'cancelled', updated_at = NOW()
       WHERE letter_id = $1 AND status NOT IN ('accepted','sent','in_transit','delivered','returned')`,
      [order.letter_id]
    );
    return 'cancelled';
  }
  if (current.provider_outcome === 'dispatching' || current.provider_outcome === 'ambiguous') {
    await client.query(
      `UPDATE letter_jobs SET status = 'held', provider_outcome = 'ambiguous', held_at = NOW(),
         hold_reason = $2, locked_at = NULL, updated_at = NOW() WHERE job_id = $1`,
      [current.job_id, reason]
    );
    await client.query(
      `UPDATE letters SET status = 'held', updated_at = NOW()
       WHERE letter_id = $1 AND status NOT IN ('accepted','sent','in_transit','delivered','returned')`,
      [order.letter_id]
    );
    await client.query(
      `INSERT INTO commerce_operational_alerts
         (source_event_id, order_id, alert_type, severity, details)
       VALUES ($1, $2, 'refunded_mail_already_dispatched', 'critical', $3)
       ON CONFLICT (source_event_id, alert_type) DO NOTHING`,
      [sourceEventId, order.order_id, JSON.stringify({
        jobId: current.job_id, providerOutcome: current.provider_outcome
      })]
    );
    return 'held';
  }
  if (current.provider_outcome === 'accepted' || current.status === 'completed') {
    await client.query(
      `INSERT INTO commerce_operational_alerts
         (source_event_id, order_id, alert_type, severity, details)
       VALUES ($1, $2, 'refunded_mail_already_dispatched', 'critical', $3)
       ON CONFLICT (source_event_id, alert_type) DO NOTHING`,
      [sourceEventId, order.order_id, JSON.stringify({
        jobId: current.job_id, providerOutcome: 'accepted'
      })]
    );
  }
  return 'none';
}

async function processRefundEvent(
  eventId: string,
  eventType: string,
  refundOrCharge: Stripe.Refund | Stripe.Charge
): Promise<StripeEventProcessingResult> {
  const intent =
    typeof refundOrCharge.payment_intent === 'string'
      ? refundOrCharge.payment_intent
      : refundOrCharge.payment_intent?.id;
  const charge = 'charge' in refundOrCharge
    ? (typeof refundOrCharge.charge === 'string'
        ? refundOrCharge.charge
        : refundOrCharge.charge?.id)
    : refundOrCharge.id;
  return transaction(async client => {
    if (!(await claimStripeEvent(client, eventId, eventType, refundOrCharge.id))) {
      return { duplicate: true };
    }
    const metadataOrderId =
      'metadata' in refundOrCharge ? refundOrCharge.metadata?.orderId : undefined;
    await client.query(
      `UPDATE stripe_webhook_events SET provider_payment_intent_id = $2,
         provider_charge_id = $3, metadata_order_id = $4 WHERE event_id = $1`,
      [eventId, intent || null, charge || null, metadataOrderId || null]
    );
    const orderResult = await client.query<Order>(
      `SELECT * FROM orders
       WHERE ($1::varchar IS NOT NULL AND order_id = $1)
          OR ($2::varchar IS NOT NULL AND stripe_payment_intent_id = $2)
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [metadataOrderId || null, intent || null]
    );
    const order = orderResult.rows[0];
    if (!order) {
      await client.query(
        `UPDATE stripe_webhook_events SET processing_status = 'unmatched'
         WHERE event_id = $1`, [eventId]
      );
      await client.query(
        `INSERT INTO commerce_operational_alerts
           (source_event_id, alert_type, severity, details)
         VALUES ($1, 'stripe_money_event_unmatched', 'critical', $2)
         ON CONFLICT (source_event_id, alert_type) DO NOTHING`,
        [eventId, JSON.stringify({
          eventClass: eventType.startsWith('charge.dispute.') ? 'dispute' : 'refund',
          hasPaymentIntent: Boolean(intent), hasCharge: Boolean(charge),
          hasMetadataOrder: Boolean(metadataOrderId)
        })]
      );
      return { duplicate: false };
    }
    await client.query('UPDATE stripe_webhook_events SET order_id = $2 WHERE event_id = $1', [
      eventId,
      order.order_id
    ]);

    const isRefund = eventType.startsWith('refund.');
    const refundStatus = isRefund ? (refundOrCharge as Stripe.Refund).status : 'succeeded';
    const refundedAmount = isRefund
      ? (refundOrCharge as Stripe.Refund).amount
      : (refundOrCharge as Stripe.Charge).amount_refunded;
    if (refundedAmount < order.amount_cents) {
      await recordOrderEvent(client, order.order_id, eventType, order.status, order.status, {
        ignored: true,
        reason: 'partial_refund',
        refundedAmount
      });
      return { duplicate: false, orderId: order.order_id, status: order.status };
    }
    const nextStatus: OrderStatus = refundStatus === 'succeeded' ? 'refunded' : 'refund_pending';
    if (order.status === 'refunded') {
      await recordOrderEvent(client, order.order_id, eventType, order.status, order.status, {
        ignored: true,
        reason: 'already_refunded'
      });
      return { duplicate: false, orderId: order.order_id, status: order.status };
    }
    await stopFundedMailBeforeFinancialReversal(client, order, eventId, 'payment_reversed');
    if (nextStatus === 'refunded' && order.order_type === 'letter_pack') {
      await revokePackCredits(client, order);
    }
    if (nextStatus === 'refunded') {
      // JIT refunds never call revokePackCredits, so the account lock has to be
      // taken here or entitlements would be write-locked without it.
      await lockAccountForBalanceChange(client, order.user_id);
      await client.query(
        `UPDATE image_entitlements
         SET status = 'revoked', updated_at = NOW()
         WHERE source_order_id = $1 AND status <> 'revoked'`,
        [order.order_id]
      );
    }
    await client.query(
      `UPDATE orders
       SET status = $2::varchar,
           stripe_refund_id = COALESCE($3, stripe_refund_id),
           refund_pending_at = CASE WHEN $2::varchar = 'refund_pending' THEN COALESCE(refund_pending_at, NOW()) ELSE refund_pending_at END,
           refunded_at = CASE WHEN $2::varchar = 'refunded' THEN NOW() ELSE refunded_at END,
           updated_at = NOW()
       WHERE order_id = $1`,
      [order.order_id, nextStatus, isRefund ? refundOrCharge.id : null]
    );
    await recordOrderEvent(client, order.order_id, eventType, order.status, nextStatus);
    return { duplicate: false, orderId: order.order_id, status: nextStatus };
  });
}

async function processDisputeEvent(
  eventId: string,
  eventType: 'charge.dispute.created' | 'charge.dispute.closed',
  dispute: Stripe.Dispute
): Promise<StripeEventProcessingResult> {
  return transaction(async client => {
    if (!(await claimStripeEvent(client, eventId, eventType, dispute.id))) {
      return { duplicate: true };
    }
    const closed = eventType === 'charge.dispute.closed';
    const paymentIntentId = typeof dispute.payment_intent === 'string'
      ? dispute.payment_intent
      : dispute.payment_intent?.id;
    const disputeChargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id;
    const metadataOrderId = dispute.metadata?.orderId;
    await client.query(
      `UPDATE stripe_webhook_events SET provider_payment_intent_id = $2,
         provider_charge_id = $3, metadata_order_id = $4 WHERE event_id = $1`,
      [eventId, paymentIntentId || null, disputeChargeId || null, metadataOrderId || null]
    );
    const orderResult = paymentIntentId
      ? await client.query<Order>(
          'SELECT * FROM orders WHERE stripe_payment_intent_id = $1 FOR UPDATE',
          [paymentIntentId]
        )
      : { rows: [] as Order[] };
    const order = orderResult.rows[0];
    if (!order) {
      await client.query(
        `UPDATE stripe_webhook_events SET processing_status = 'unmatched'
         WHERE event_id = $1`, [eventId]
      );
      await client.query(
        `INSERT INTO commerce_operational_alerts
           (source_event_id, alert_type, severity, details)
         VALUES ($1, 'stripe_money_event_unmatched', 'critical', $2)
         ON CONFLICT (source_event_id, alert_type) DO NOTHING`,
        [eventId, JSON.stringify({ eventClass: 'dispute',
          hasPaymentIntent: Boolean(paymentIntentId), hasCharge: Boolean(disputeChargeId),
          hasMetadataOrder: Boolean(metadataOrderId) })]
      );
      return { duplicate: false };
    }
    if (order) {
      await client.query('UPDATE stripe_webhook_events SET order_id = $2 WHERE event_id = $1', [
        eventId, order.order_id
      ]);
      await stopFundedMailBeforeFinancialReversal(client, order, eventId, 'payment_disputed');
      await client.query(
        `UPDATE orders SET status = 'disputed',
           hold_previous_status = COALESCE(hold_previous_status, status),
           held_at = COALESCE(held_at, NOW()), hold_reason = 'payment_disputed',
           stripe_dispute_status = $2, updated_at = NOW() WHERE order_id = $1`,
        [order.order_id, dispute.status]
      );
      await recordOrderEvent(client, order.order_id, eventType, order.status, 'disputed', {
        disputeStatus: dispute.status
      });
      if (closed) {
        const resolutionCode = `stripe_dispute_${String(dispute.status || 'unknown')
          .toLowerCase()
          .replace(/[^a-z0-9_]/g, '_')}`.slice(0, 80);
        await client.query(
          `UPDATE commerce_operational_alerts SET status = 'resolved', resolved_at = NOW(),
             resolution_code = $2, updated_at = NOW()
           WHERE order_id = $1 AND alert_type = 'stripe_dispute_created' AND status <> 'resolved'
             AND source_event_id IN (
               SELECT event_id FROM stripe_webhook_events WHERE provider_object_id = $3
             )`,
          [order.order_id, resolutionCode, dispute.id]
        );
      }
    }
    const severity = closed
      ? dispute.status === 'lost'
        ? 'critical'
        : dispute.status === 'won'
          ? 'info'
          : 'warning'
      : 'warning';
    await client.query(
      `INSERT INTO commerce_operational_alerts (
         source_event_id, order_id, alert_type, severity, details
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (source_event_id, alert_type) DO NOTHING`,
      [
        eventId,
        order?.order_id || null,
        closed ? 'stripe_dispute_closed' : 'stripe_dispute_created',
        severity,
        JSON.stringify({
          disputeStatus: dispute.status,
          reason: dispute.reason || null,
          amountCents: dispute.amount,
          currency: dispute.currency,
          chargeReferencePresent: Boolean(dispute.charge)
        })
      ]
    );
    return { duplicate: false };
  });
}

export async function processStripeWebhookEvent(
  event: Stripe.Event
): Promise<StripeEventProcessingResult> {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
    case 'checkout.session.async_payment_failed':
    case 'checkout.session.expired':
      return processCheckoutSessionEvent(
        event.id,
        event.type,
        event.data.object as Stripe.Checkout.Session
      );
    case 'refund.created':
    case 'refund.updated':
    case 'refund.failed':
      return processRefundEvent(event.id, event.type, event.data.object as Stripe.Refund);
    case 'charge.refunded':
      return processRefundEvent(event.id, event.type, event.data.object as Stripe.Charge);
    case 'charge.dispute.created':
    case 'charge.dispute.closed':
      return processDisputeEvent(
        event.id,
        event.type,
        event.data.object as Stripe.Dispute
      );
    default:
      return transaction(async client => ({
        duplicate: !(await claimStripeEvent(
          client,
          event.id,
          event.type,
          String((event.data.object as { id?: string }).id || '')
        ))
      }));
  }
}

function publicPurchaseStatus(status: OrderStatus): PurchaseStatusResult['purchaseStatus'] {
  switch (status) {
    case 'checkout_pending':
      return 'pending_payment';
    case 'paid':
    case 'fulfillment_pending':
      return 'processing';
    case 'fulfilled':
      return 'sent';
    case 'payment_failed':
      return 'payment_failed';
    case 'refund_pending':
      return 'refund_pending';
    case 'refunded':
      return 'refunded';
    case 'disputed':
    case 'held':
      return 'refund_pending';
    case 'cancelled':
      return 'cancelled';
  }
}

function purchaseMessage(status: PurchaseStatusResult['purchaseStatus']): string {
  switch (status) {
    case 'pending_payment':
      return 'Checkout is awaiting payment.';
    case 'processing':
      return 'Payment is confirmed and the mail item is being prepared.';
    case 'sent':
      return 'The physical mail item was accepted by the print provider.';
    case 'payment_failed':
      return 'Payment was not completed.';
    case 'refund_pending':
      return 'The order could not be fulfilled and a refund is being processed.';
    case 'refunded':
      return 'The payment was refunded.';
    case 'cancelled':
      return 'The checkout was cancelled or expired without sending the draft.';
  }
}

export async function getPurchaseStatus(
  userId: string,
  orderId: string
): Promise<PurchaseStatusResult> {
  const result = await query<Order>('SELECT * FROM orders WHERE order_id = $1 AND user_id = $2', [
    orderId,
    userId
  ]);
  const order = result.rows[0];
  if (!order) {
    throw Object.assign(new Error('Purchase not found'), {
      code: 'PURCHASE_NOT_FOUND'
    });
  }
  const purchaseStatus = publicPurchaseStatus(order.status);
  return {
    orderId: order.order_id,
    purchaseStatus,
    orderStatus: order.status,
    productDescription: String(order.product_snapshot?.name || order.product_code),
    amountCents: order.amount_cents,
    currency: order.currency,
    mailType: order.product_snapshot?.mailType as MailType | undefined,
    letterId: order.letter_id,
    checkoutExpiresAt: order.checkout_expires_at
      ? new Date(order.checkout_expires_at).toISOString()
      : undefined,
    updatedAt: new Date(order.updated_at).toISOString(),
    message: purchaseMessage(purchaseStatus)
  };
}

export async function fulfillPaidOrder(orderId: string): Promise<boolean> {
  return transaction(async client => {
    const result = await client.query<Order>(
      'SELECT * FROM orders WHERE order_id = $1 FOR UPDATE',
      [orderId]
    );
    const order = result.rows[0];
    if (!order || order.order_type !== 'jit_mail' || order.status !== 'paid') return false;
    await client.query('SAVEPOINT recovery_fulfillment');
    try {
      await createMailOrderFromDraftWithClient(client, {
        draftId: order.draft_id!,
        userId: order.user_id,
        mailType: String(order.product_snapshot.mailType || 'letter') as MailType,
        funding: { type: 'jit_order', orderId }
      });
      await grantImageEntitlementWithClient(client, {
        userId: order.user_id,
        sourceType: 'jit_order',
        sourceReferenceId: order.order_id,
        sourceOrderId: order.order_id,
        quantity: integerSetting('IMAGE_ENTITLEMENTS_PER_JIT_ORDER', 1)
      });
      await client.query('RELEASE SAVEPOINT recovery_fulfillment');
      await recordOrderEvent(
        client,
        orderId,
        'maintenance.fulfillment_recovered',
        'paid',
        'fulfillment_pending'
      );
      return true;
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT recovery_fulfillment');
      const message = error instanceof Error ? error.message : 'Recovery failed';
      await client.query(
        `UPDATE orders SET status = 'refund_pending', refund_pending_at = NOW(),
           last_error_code = 'RECOVERY_FAILED', last_error = $2, updated_at = NOW()
         WHERE order_id = $1`,
        [orderId, message]
      );
      await recordOrderEvent(
        client,
        orderId,
        'maintenance.fulfillment_failed',
        'paid',
        'refund_pending'
      );
      return false;
    }
  });
}

export async function requestRefund(orderId: string, reason: string): Promise<boolean> {
  const retryLimit = integerSetting('JIT_REFUND_RETRY_LIMIT', 5);
  if (retryLimit === 0) return false;
  const claimed = await query<RefundClaim>(
    `WITH candidate AS (
       SELECT order_id, refund_attempts
       FROM orders
       WHERE order_id = $1 AND status = 'refund_pending'
         AND stripe_payment_intent_id IS NOT NULL
         AND (
           refund_attempts = 0
           OR updated_at <= NOW() - ($4 * INTERVAL '1 second')
         )
       FOR UPDATE
     )
     UPDATE orders AS refundable
     SET refund_attempts = CASE
           WHEN refundable.stripe_refund_id IS NULL
             AND candidate.refund_attempts < $3
             THEN candidate.refund_attempts + 1
           ELSE refundable.refund_attempts
         END,
         refund_pending_at = COALESCE(refund_pending_at, NOW()),
         last_error = $2, updated_at = NOW()
     FROM candidate
     WHERE refundable.order_id = candidate.order_id
     RETURNING refundable.*, candidate.refund_attempts AS previous_refund_attempts`,
    [orderId, reason, retryLimit, refundRetryDelaySeconds()]
  );
  const order = claimed.rows[0];
  if (!order?.stripe_payment_intent_id) return false;
  try {
    let refund: Stripe.Refund | null = null;
    if (order.stripe_refund_id) {
      try {
        const existingRefund = await retrieveRefund(order.stripe_refund_id);
        if (!['failed', 'canceled'].includes(existingRefund.status || '')) {
          refund = existingRefund;
        }
      } catch {
        // Confirm by payment intent below before creating another refund. This
        // covers a persisted stale ID without risking a duplicate refund.
      }
    }
    refund ??= await findPaymentRefund(order.stripe_payment_intent_id, order.order_id);
    if (!refund) {
      let attempt = order.refund_attempts;
      if (order.stripe_refund_id) {
        const retry = await query<{ refund_attempts: number }>(
          `UPDATE orders
           SET refund_attempts = refund_attempts + 1, updated_at = NOW()
           WHERE order_id = $1 AND status = 'refund_pending'
             AND refund_attempts = $2 AND refund_attempts < $3
           RETURNING refund_attempts`,
          [orderId, order.refund_attempts, retryLimit]
        );
        if (!retry.rows[0]) return false;
        attempt = retry.rows[0].refund_attempts;
      } else {
        const previousAttempts = Number(
          order.previous_refund_attempts ?? order.refund_attempts
        );
        if (previousAttempts >= retryLimit) return false;
      }
      refund = await createPaymentRefund(
        order.stripe_payment_intent_id,
        order.order_id,
        attempt
      );
    }
    const nextStatus: OrderStatus = refund.status === 'succeeded' ? 'refunded' : 'refund_pending';
    await transaction(async client => {
      // Serialize the external outcome with refund webhooks. If a webhook
      // finalized the same refund while Stripe was in flight, its transaction
      // wins and this path becomes a no-op instead of replaying revocations.
      await client.query('SELECT order_id FROM orders WHERE order_id = $1 FOR UPDATE', [orderId]);
      const finalized = await client.query<{ order_id: string }>(
        `UPDATE orders
         SET stripe_refund_id = $2, status = $3,
             refunded_at = CASE WHEN $3 = 'refunded' THEN NOW() ELSE refunded_at END,
             updated_at = NOW()
         WHERE order_id = $1 AND status = 'refund_pending'
         RETURNING order_id`,
        [orderId, refund.id, nextStatus]
      );
      if (!finalized?.rows[0]) return;
      if (nextStatus === 'refunded') {
        if (order.order_type === 'letter_pack') {
          await revokePackCredits(client, order);
        }
        await lockAccountForBalanceChange(client, order.user_id);
        await client.query(
          `UPDATE image_entitlements SET status = 'revoked', updated_at = NOW()
           WHERE source_order_id = $1 AND status <> 'revoked'`,
          [orderId]
        );
      }
      await recordOrderEvent(client, orderId, 'refund.requested', 'refund_pending', nextStatus, {
        reason,
        refundId: refund.id
      });
    });
    return true;
  } catch (error) {
    await query(
      `UPDATE orders SET last_error_code = 'REFUND_REQUEST_FAILED', last_error = $2,
         updated_at = NOW() WHERE order_id = $1 AND status = 'refund_pending'`,
      [orderId, error instanceof Error ? error.message : 'Refund request failed']
    );
    return false;
  }
}

export async function runCommerceMaintenance(): Promise<CommerceMaintenanceResult> {
  let recoveredFulfillments = 0;
  const paid = await query<{ order_id: string }>(
    `SELECT order_id FROM orders
     WHERE order_type = 'jit_mail' AND status = 'paid'
     ORDER BY paid_at NULLS FIRST, created_at
     LIMIT 25`
  );
  for (const order of paid.rows) {
    try {
      if (await fulfillPaidOrder(order.order_id)) recoveredFulfillments += 1;
    } catch (error) {
      writeDiagnostic('error', 'commerce.fulfillment_recovery_failed', {
        errorClass: classifyDiagnosticError(error, 'database_error')
      });
    }
  }

  let reconciledPayments = 0;
  let expiredCheckouts = 0;
  const pending = await query<{
    order_id: string;
    stripe_checkout_session_id: string;
  }>(
    `SELECT order_id, stripe_checkout_session_id FROM orders
     WHERE status = 'checkout_pending' AND stripe_checkout_session_id IS NOT NULL
       AND created_at < NOW() - INTERVAL '2 minutes'
     ORDER BY created_at LIMIT 25`
  );
  for (const order of pending.rows) {
    try {
      const session = await retrieveCheckoutSession(order.stripe_checkout_session_id);
      if (session.payment_status === 'paid') {
        const result = await processCheckoutSessionEvent(
          `reconcile:${session.id}:${paymentIntentId(session) || 'paid'}`,
          'maintenance.checkout.reconciled',
          session
        );
        if (!result.duplicate) reconciledPayments += 1;
      } else if (session.status === 'expired') {
        const result = await processCheckoutSessionEvent(
          `reconcile:${session.id}:expired`,
          'checkout.session.expired',
          session
        );
        if (!result.duplicate && result.status === 'cancelled') expiredCheckouts += 1;
      }
    } catch (error) {
      writeDiagnostic('error', 'commerce.checkout_reconciliation_failed', {
        errorClass: classifyDiagnosticError(error, 'provider_error')
      });
    }
  }

  // Only cancel checkout-creation orphans locally. Attached Stripe sessions
  // are cancelled above only after Stripe reports them expired; a completed
  // asynchronous payment may remain unpaid beyond its original expires_at.
  const orphaned = await query<{ order_id: string }>(
    `UPDATE orders SET status = 'cancelled', updated_at = NOW()
     WHERE status = 'checkout_pending' AND checkout_expires_at <= NOW()
       AND stripe_checkout_session_id IS NULL
     RETURNING order_id`
  );
  expiredCheckouts += orphaned.rowCount || 0;

  let refundAttempts = 0;
  const refunds = await query<{ order_id: string; last_error: string | null }>(
    `SELECT order_id, last_error FROM orders
     WHERE status = 'refund_pending'
       AND stripe_payment_intent_id IS NOT NULL
       AND refund_attempts < $2
       AND (
         refund_attempts = 0
         OR updated_at <= NOW() - ($1 * INTERVAL '1 second')
       )
     ORDER BY refund_pending_at NULLS FIRST, created_at
     LIMIT 25`,
    [refundRetryDelaySeconds(), integerSetting('JIT_REFUND_RETRY_LIMIT', 5)]
  );
  for (const order of refunds.rows) {
    try {
      if (
        await requestRefund(order.order_id, order.last_error || 'Pre-provider fulfillment failure')
      ) {
        refundAttempts += 1;
      }
    } catch (error) {
      writeDiagnostic('error', 'commerce.refund_recovery_failed', {
        errorClass: classifyDiagnosticError(error, 'database_error')
      });
    }
  }

  const stuck = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM orders
     WHERE status IN ('paid', 'fulfillment_pending', 'refund_pending')
       AND updated_at < NOW() - INTERVAL '30 minutes'`
  );
  const stuckOrders = Number.parseInt(stuck.rows[0]?.count || '0', 10);
  if (stuckOrders > 0) {
    writeDiagnostic('error', 'commerce.stuck_orders_detected', { count: stuckOrders });
  }

  return {
    expiredCheckouts,
    recoveredFulfillments,
    reconciledPayments,
    refundAttempts,
    stuckOrders
  };
}
