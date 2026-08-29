/** Platform-neutral commerce orchestration backed by the Stripe adapter. */

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type Stripe from 'stripe';
import { query, transaction } from '../db/index.js';
import { assertBetaAccess } from '../auth/betaAccess.js';
import { assertChargeWithinDailyCap, assertMailWithinDailyCaps } from './betaSpendLimits.js';
import {
  describeUnpriced,
  ensurePriceCatalog,
  formatPriceFailureSummary,
  kickPriceCatalog
} from './priceCatalog.js';
import {
  PACK_PRODUCTS,
  formatAmountForCurrency,
  jitProductCode,
  normalizedCurrency,
  packCurrency
} from '../config/products.js';
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
  type CheckoutSessionResult,
  type CommerceProductConfig,
  type PackProductId
} from './stripeService.js';
import type { LetterDraft, MailType, Order, OrderStatus } from './types.js';
import {
  carriedDiagnosticClass,
  classifyDiagnosticError,
  clearDiagnosticChangeSlot,
  isTerminalDiagnosticClass,
  writeDiagnostic,
  writeDiagnosticOnChange
} from '../utils/diagnosticLog.js';

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
    /** Pre-formatted per-currency amount for display surfaces. */
    displayAmount?: string;
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
  // One enabled read per call (three separate env reads before, against this
  // codebase's own hoisting standard), and the disabled default short-circuits
  // before building a product config whose only fate was to be discarded
  // (#278 round 7).
  const jitEnabled = isJitPurchaseEnabled();
  // ONE envelope. The round-7 short-circuit duplicated the whole
  // prepaid/letterPack literal for the disabled path, so a change to either
  // block had to be edited in two returns or the enabled and disabled quote
  // surfaces diverged (#278 round 8). Only payAndSend is branch-dependent.
  return {
    prepaid: {
      eligible: prepaidEligible,
      requiredCredits,
      availableCredits
    },
    payAndSend: jitEnabled
      ? enabledPayAndSend(mailType, prepaidEligible)
      : disabledPayAndSend(mailType),
    letterPack: {
      available: true,
      purchaseUrl:
        process.env.LETTER_IRL_PACKS_URL ||
        process.env.LETTER_IRL_PUBLIC_BASE_URL ||
        'https://letterirl.com'
    }
  };
}

function disabledPayAndSend(mailType: MailType): SendEligibility['payAndSend'] {
  // Still kick with the code: the catalog's unsold gate clears leftover
  // state recorded before the toggle - cooldowns AND memos, both mail types -
  // so neither an un-archived Price nor an archived one resurfaces stale
  // answers on re-enable. Without this, nothing would ever call with a JIT
  // code while disabled (#278 rounds 7-8).
  kickPriceCatalog(jitProductCode(mailType), 'send_eligibility_disabled');
  return {
    available: false,
    unavailableReason: 'Pay & Send is not enabled.'
  };
}

function enabledPayAndSend(
  mailType: MailType,
  prepaidEligible: boolean
): SendEligibility['payAndSend'] {
  const product = getJitProductConfig(mailType);
  // The eligibility accessor owns its own warmup kick - UNGATED beyond the
  // enabled check above, which is what makes the catalog's unsold-state
  // clearing reachable: gating the kick harder meant nothing ever called with
  // a JIT code while disabled, so toggle-off leftovers survived to resurface
  // on re-enable, the exact bug the clearing exists for (#278 round 7).
  kickPriceCatalog(product.productCode, 'send_eligibility');
  const configured = Boolean(product.priceId && product.amountCents > 0);
  if (configured) clearDiagnosticChangeSlot(`commerce.pay_and_send_unpriced:${product.productCode}`);
  const allowedWithBalance = process.env.JIT_ALLOW_WITH_PREPAID_BALANCE === 'true';
  const available = configured && (!prepaidEligible || allowedWithBalance);
  let unavailableReason: string | undefined;
  if (!configured) {
    // Pay & Send just switched itself off for every quote. Before this, a
    // 30-second Stripe blip and a permanently archived price produced the
    // identical customer-facing "not configured" message and NO log line
    // anywhere - the feature vanished silently and the operator learned about
    // it from a customer (#278 review round 2). Say which it is, in both
    // directions.
    // Non-null by contract: the "unattempted means transient" policy lives in
    // describeUnpriced, not in per-guard ?? chains (#278 rounds 5-6).
    const failure = describeUnpriced(product.productCode);
    const errorClass = failure.diagnosticClass;
    const rule = failure.rule;
    // Reported on CHANGE only. This is a synchronous accessor on the quote
    // path, and the module header notes quotes vastly outnumber purchases - so
    // an unconditional error line here turned one persistent config fault into
    // a continuous error stream and a permanently firing alert, scaling with
    // traffic rather than with the number of faults (#278 review round 3).
    // Change-only via the ONE shared throttle (the bespoke per-product map
    // this replaces had no reset hook and was the third hand-rolled copy of
    // the helper built to own this, #278 round 7). price.not_resolved is the
    // boot race - routine on every deploy - and logs at warn; a recorded
    // failure is news and stays at error (#278 round 6, corroborated x5).
    // The resolution epoch makes recovery part of the signature: without it,
    // a fault recurring after a recovery no quote happened to observe (quiet
    // hours, then re-broken) hashed identically and the second outage logged
    // NOTHING for its whole duration (#278 round 8).
    writeDiagnosticOnChange(
      `commerce.pay_and_send_unpriced:${product.productCode}`,
      formatPriceFailureSummary([failure]),
      rule === 'price.not_resolved' ? 'warn' : 'error',
      'commerce.pay_and_send_unpriced',
      {
        productCode: product.productCode,
        rule,
        errorClass,
        // The figures, when the fault has them: an operator reading this line
        // should not need the Stripe dashboard to see what disagreed.
        ...(failure.detail ? { detail: failure.detail } : {})
      }
    );
    unavailableReason = isTerminalDiagnosticClass(errorClass)
      ? 'Pay & Send pricing is not configured.'
      : 'Pay & Send is temporarily unavailable. Please try again shortly.';
  } else if (prepaidEligible && !allowedWithBalance) {
    unavailableReason = 'Use your existing prepaid letter balance.';
  }

  return {
    available,
    amountCents: configured ? product.amountCents : undefined,
    currency: configured ? product.currency : undefined,
    // Server-formatted for display: the widgets rendered amountCents/100
    // themselves, which is 100x wrong for zero-decimal currencies this
    // codebase declares supported (#278 round 6). Widgets prefer this and
    // fall back to /100 for older servers.
    displayAmount: configured
      ? formatAmountForCurrency(product.amountCents, product.currency)
      : undefined,
    productDescription: configured ? product.name : undefined,
    unavailableReason
  };
}

/**
 * Stripe's own floor for a Checkout Session's expires_at: it refuses a session
 * whose expiry is nearer than this.
 *
 * A sessionless row must forward its stored expiry verbatim - the idempotency
 * key that recovers a crashed attachment only replays for IDENTICAL
 * parameters - so a row inside this floor cannot open a session at all and is
 * retired in favour of a fresh one. How long a row stays reusable is
 * therefore set by how far ABOVE this floor it was stamped, which is what
 * CHECKOUT_REUSE_BUDGET_MINUTES below exists to guarantee (#278 r10-12).
 */
const STRIPE_MIN_CHECKOUT_WINDOW_MINUTES = 30;
const STRIPE_MIN_CHECKOUT_WINDOW_MS = STRIPE_MIN_CHECKOUT_WINDOW_MS_OF(
  STRIPE_MIN_CHECKOUT_WINDOW_MINUTES
);
function STRIPE_MIN_CHECKOUT_WINDOW_MS_OF(minutes: number): number {
  return minutes * 60_000;
}
/** Clock/network margin on a stamped expiry, so it is still valid on arrival. */
const CHECKOUT_STAMP_MARGIN_MS = 5_000;
/**
 * Headroom above Stripe's floor, so a sessionless row stays REUSABLE for a
 * while. A window stamped at exactly the floor leaves none: round 10's reuse
 * guard then cancelled every sessionless row more than five seconds old,
 * which made the round-7 reprice branch dead code, churned a cancelled order
 * per retry, and orphaned the Stripe session behind a crashed attachment
 * instead of replaying its idempotency key (three round-11 angles).
 */
const CHECKOUT_REUSE_BUDGET_MINUTES = 10;

function checkoutExpiry(draftExpiresAt: Date): Date {
  const configuredMinutes = Math.min(
    24 * 60,
    Math.max(
      STRIPE_MIN_CHECKOUT_WINDOW_MINUTES + CHECKOUT_REUSE_BUDGET_MINUTES,
      // Default matches the floor below, so the declared default is a value
      // the function can actually return (#278 round 12).
      integerSetting('JIT_CHECKOUT_EXPIRY_MINUTES', 40)
    )
  );
  const configured = new Date(
    Date.now() + configuredMinutes * 60_000 + CHECKOUT_STAMP_MARGIN_MS
  );
  const draftExpiry = new Date(draftExpiresAt);
  // The floor INCLUDES the reuse budget, because the value actually stamped
  // is min(configured, draftExpiry): raising only the configured branch left
  // a draft in its last 40 minutes stamping barely above Stripe's floor, so
  // the reuse window collapsed to seconds again for exactly those checkouts
  // - the five-second window round 11 believed it had closed (#278 r12).
  if (
    draftExpiry.getTime() - Date.now() <
    STRIPE_MIN_CHECKOUT_WINDOW_MS +
      CHECKOUT_REUSE_BUDGET_MINUTES * 60_000 +
      CHECKOUT_STAMP_MARGIN_MS
  ) {
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

/**
 * A transient Stripe failure leaves the order pending so a retry can pick it
 * up. A CONFIGURATION fault must not: retrying cannot succeed until a human
 * changes config, and a pending row is not inert. It strands a pack order
 * forever (the pack INSERT omits checkout_expires_at, and the only sweeper for
 * session-less rows compares `checkout_expires_at <= NOW()`, which is never
 * true for NULL), and it blocks a JIT draft from prepaid sending for the whole
 * checkout window behind a "checkout in progress" that does not exist.
 *
 * So a terminal fault cancels the order and records the transition. Introduced
 * with the price-drift guard (#275): making that guard fire deterministically
 * turned both leaks from rare-under-transient-errors into certain-under-drift.
 */
async function markCheckoutCreationFailure(
  orderId: string,
  error: string,
  options: { errorCode?: string; terminal?: boolean } = {}
): Promise<void> {
  const errorCode = options.errorCode ?? 'CHECKOUT_CREATION_FAILED';
  if (!options.terminal) {
    await query(
      `UPDATE orders
       SET last_error_code = $3, last_error = $2, updated_at = NOW()
       WHERE order_id = $1`,
      [orderId, error, errorCode]
    );
    return;
  }

  await transaction(async client => {
    const { rows } = await client.query(
      `UPDATE orders
       SET status = 'cancelled', last_error_code = $3, last_error = $2, updated_at = NOW()
       WHERE order_id = $1 AND status = 'checkout_pending'
       RETURNING order_id`,
      [orderId, error, errorCode]
    );
    // Only record the transition we actually made. A concurrent path may have
    // moved the order on already.
    if (rows.length === 0) return;
    await recordOrderEvent(client, orderId, 'checkout_creation_cancelled', 'checkout_pending', 'cancelled', {
      errorCode
    });
  });
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

/**
 * Mark the order's cleanup outcome and throw the carried-classification error
 * in ONE place: the pack and JIT paths each duplicated a ~15-line mark+throw
 * block whose four copies of `terminal ?? isTerminal(...)` could drift, and a
 * drifted pair cancels the order as terminal while telling the customer to
 * retry (#278 round 6). Terminality is derived from the class exactly once.
 */
async function failCheckoutCreation(
  orderId: string,
  checkout: CheckoutSessionResult,
  fallbackMessage: string
): Promise<Error> {
  const diagnosticClass = checkout.diagnosticClass ?? 'provider_error';
  await markCheckoutCreationFailure(orderId, checkout.error || fallbackMessage, {
    errorCode: checkout.errorCode,
    terminal: isTerminalDiagnosticClass(diagnosticClass)
  });
  // Returned, not thrown: `throw await` at the call site keeps TypeScript's
  // control-flow narrowing of checkout.sessionId, which an awaited
  // Promise<never> would not.
  return Object.assign(new Error(checkout.error || fallbackMessage), {
    code: checkout.errorCode,
    diagnosticClass
  });
}

export class PackAmountNotConfiguredError extends Error {
  readonly code = 'PACK_AMOUNT_NOT_CONFIGURED';
  // An unresolvable Stripe price is not a database fault. This guard throws
  // before any query runs, so the checkout handler's catch has no query to
  // blame and defaults an uncarried error to database_error - which is exactly
  // what sent issue #213 on a schema hunt for a config problem. Carrying the
  // real class makes the log name the right subsystem, the same mechanism #214
  // gave the Stripe-call path.
  //
  // The class is supplied, not assumed. Hard-coding configuration_error here
  // made the pack path structurally unable to report a transient fault: this
  // throws 22 lines before createPackCheckoutSession, so the branch in
  // stripeService that forwards the catalog's real class was dead, and a
  // 30-second Stripe outage was logged as an operator-must-act config fault
  // (#278 review round 2) - the #213 mislabel reintroduced one layer up.
  readonly diagnosticClass: string;
  constructor(readonly productCode: string, diagnosticClass = 'configuration_error') {
    super(`Pack amount is not configured for ${productCode}`);
    this.name = 'PackAmountNotConfiguredError';
    // No separate `terminal` property: three review angles independently
    // converged on carrying ONLY the class and deriving terminality at the
    // decision points - a carried pair can be minted mismatched, and consumers
    // were hedging with their own ?? re-derivations anyway (#278 round 6).
    this.diagnosticClass = diagnosticClass;
  }
}

/**
 * Fail closed when a pack price is configured without its authoritative amount.
 * Amounts are never inferred from a Stripe Price ID: an unknown amount must
 * disable the purchase rather than create an order that cannot be reconciled or
 * refunded against a trusted figure.
 *
 * The catalog's recorded failure says WHY it is unpriceable, and the class
 * travels with the error so the operator log names the right subsystem.
 */
export function assertConfiguredAmount(
  product: Pick<CommerceProductConfig, 'amountCents'>,
  productCode: string
): void {
  if (!Number.isInteger(product.amountCents) || product.amountCents <= 0) {
    throw new PackAmountNotConfiguredError(productCode, describeUnpriced(productCode).diagnosticClass);
  }
}

export async function createPackCheckout(
  params: CreatePackCheckoutParams
): Promise<CommerceCheckoutResult> {
  // Before the catalog work and long before Stripe. A refused account must not
  // be charged, and must not cost us a Stripe API call to find that out.
  assertBetaAccess(params.userId);
  // Prices resolve lazily (#275 stage A); every entrypoint that can reach a
  // product config awaits this first, so no process needs a bootstrap call.
  await ensurePriceCatalog(params.productId);
  const product = getPackProductConfig(params.productId);
  // Both guards throw before any query, so an uncarried error would take the
  // handler catch's database_error default and mislabel a non-database fault -
  // the #213 trap. An unknown product is bad input; a missing price id is
  // configuration. Naming each truthfully keeps the checkout log honest.
  if (!product) {
    throw Object.assign(new Error(`Invalid product ID: ${params.productId}`), {
      diagnosticClass: 'validation_error'
    });
  }
  if (!product.priceId) {
    throw Object.assign(new Error(`Price ID not configured for ${params.productId}`), {
      diagnosticClass: 'configuration_error'
    });
  }
  // An unresolved price must fail before any authoritative order
  // exists. Persisting a zero amount would make the order unreconcilable
  // against Stripe and would leave any later refund without a trusted amount.
  assertConfiguredAmount(product, params.productId);

  // Before the order row and long before Stripe. Buying credits is not
  // mailing, so only the charge ceiling applies here.
  await assertChargeWithinDailyCap(params.userId, product.amountCents);

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
    throw await failCheckoutCreation(orderId, checkout, 'Failed to create checkout session');
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
    if (draft.status === 'expired') {
      // Distinguished from the generic invalid-state throw: the sweeper flips
      // aged drafts to 'expired', and reporting those as DRAFT_INVALID_STATE
      // told the customer the draft had "already been sent or cancelled" -
      // false, and contradicting the message the SAME draft got one sweep
      // cycle earlier from the expiry check below (#278 round 12).
      throw Object.assign(new Error('Draft has expired'), { code: 'DRAFT_EXPIRED' });
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

    // ONE derivation for the whole transaction: the reprice branch and the
    // insert below must price against the SAME row or they silently diverge
    // (#278 round 8).
    const actualMailType = (draft.mail_type || 'letter') as MailType;
    const product = getJitProductConfig(actualMailType);

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
        // Not just PAST: Stripe refuses a Checkout Session whose expires_at
        // is under 30 minutes away, and a reused sessionless row forwards its
        // stored expiry verbatim. A row created 10 minutes ago on the default
        // 30-minute window has ~20 left, so every retry was rejected by
        // Stripe and left pending - the customer could not open a checkout
        // for that draft until the row finally aged out (#278 round 10).
        new Date(existing.checkout_expires_at).getTime() <=
          Date.now() + STRIPE_MIN_CHECKOUT_WINDOW_MS + CHECKOUT_STAMP_MARGIN_MS &&
        !existing.stripe_checkout_session_id
      ) {
        // The audit trail distinguishes the two: a row still inside its own
        // window was NOT "expired locally" - saying so in order history is a
        // statement an operator would act on, and the round-10 gate started
        // producing it for rows with most of their window left (#278 r11).
        const past = new Date(existing.checkout_expires_at).getTime() <= Date.now();
        await client.query(
          `UPDATE orders SET status = 'cancelled',
             last_error_code = $2, last_error = $3, updated_at = NOW()
           WHERE order_id = $1`,
          [
            existing.order_id,
            past ? 'CHECKOUT_EXPIRED' : 'CHECKOUT_WINDOW_TOO_SHORT',
            // The PAIR, like every other code-setting path here. Writing only
            // the code left the previous failure's message beside it, so the
            // two columns described different events - in the branch added to
            // make order history honest (#278 round 12).
            past
              ? 'Checkout window expired before a session was opened'
              : 'Checkout window too short for Stripe to open a session'
          ]
        );
        await recordOrderEvent(
          client,
          existing.order_id,
          past ? 'checkout.expired_locally' : 'checkout.window_too_short',
          existing.status,
          'cancelled'
        );
      } else if (existing.stripe_checkout_session_id || existing.checkout_url) {
        // A Stripe session already exists: the customer will pay exactly what
        // that session says, which matches this order row. Reuse is safe.
        return { order: existing, reused: true };
      } else if (existing.status !== 'checkout_pending') {
        // A sessionless row in a funded/held state exists only via operator
        // surgery, but the reprice-cancel below must NEVER be the thing that
        // clears a financial hold: leave the row exactly as found (#278 r8).
        return { order: existing, reused: true };
      } else if (product.amountCents <= 0) {
        // amountCents 0 is the catalog's UNRESOLVED sentinel, not a price.
        // Reading it as "price changed" cancelled a reusable order during a
        // transient Stripe blip (three review angles flagged it; the
        // enclosing transaction happened to roll the cancel back, but
        // correctness must not lean on that). No verdict here: FALL THROUGH
        // to the unpriced guard below, which throws without touching this
        // reusable row (#278 round 8).
      } else {
        // SESSIONLESS pending order (its session creation previously failed).
        // If the price changed since it was inserted - a repoint plus pin
        // update between the failure and the retry - reusing it would build a
        // NEW session at the new price against an order row recorded at the
        // old one: the customer pays the new amount, the paid-amount check
        // flags PAYMENT_AMOUNT_MISMATCH, and a legitimate purchase heads for
        // the refund lane (#278 round 7). Nothing was ever paid on this row,
        // so cancelling it is free; a fresh order is inserted below at the
        // current price.
        if (
          existing.amount_cents === product.amountCents &&
          // The same normalizer on BOTH sides: a legacy row's padded currency
          // must not fail a comparison its paid-amount sibling passes (#278
          // round 8).
          normalizedCurrency(existing.currency, '') === normalizedCurrency(product.currency, '')
        ) {
          return { order: existing, reused: true };
        }
        await client.query(
          `UPDATE orders SET status = 'cancelled',
             last_error_code = 'PRICE_CHANGED_BEFORE_SESSION',
             last_error = $2, updated_at = NOW()
           WHERE order_id = $1 AND status = 'checkout_pending'`,
          // The PAIR. This branch is reached only from a row whose session
          // creation already failed, so last_error always holds that older,
          // unrelated message - round 12 fixed the sibling 60 lines above
          // and left this one (#278 round 13).
          [existing.order_id, 'Configured price changed before a session was opened']
        );
        await recordOrderEvent(
          client,
          existing.order_id,
          'checkout.repriced_locally',
          existing.status,
          'cancelled'
        );
      }
    }

    if (!product.priceId || product.amountCents <= 0) {
      const failure = describeUnpriced(product.productCode);
      writeDiagnostic('error', 'commerce.jit_not_priced', {
        productCode: product.productCode,
        rule: failure.rule,
        errorClass: failure.diagnosticClass
      });
      throw Object.assign(new Error('Pay & Send pricing is not configured'), {
        code: 'JIT_NOT_CONFIGURED',
        diagnosticClass: failure.diagnosticClass
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
  // After the cheap synchronous guard, not before it: with Pay & Send disabled
  // (the shipped default) the catalog work is for products this deployment
  // does not sell, on a request that is about to throw anyway (#278 r3).
  if (!isJitPurchaseEnabled()) {
    throw Object.assign(new Error('Pay & Send is not currently enabled'), {
      code: 'JIT_DISABLED'
    });
  }

  // Same placement rationale as the sends_blocked check below: refuse BEFORE
  // any charge exists. Blocking during fulfilment would strand the customer's
  // money.
  assertBetaAccess(params.userId);
  // Issue #150: refuse a restricted account BEFORE taking payment.
  //
  // The send-path block in mailSendService deliberately exempts jit_order
  // funding, because that path runs during fulfilment - after Stripe has already
  // charged the customer. Blocking there would take the money and refuse the
  // send in the same transaction, stranding funds that would then need a refund.
  // This is the correct gate for Pay & Send: no charge is created at all.
  const blocked = await query<{ sends_blocked_reason: string | null }>(
    'SELECT sends_blocked_reason FROM users WHERE user_id = $1',
    [params.userId]
  );
  const blockedReason = blocked.rows[0]?.sends_blocked_reason;
  if (blockedReason) {
    throw Object.assign(
      new Error(`Sending is disabled on this account (${blockedReason}). Contact support.`),
      { code: 'ACCOUNT_SENDS_BLOCKED' }
    );
  }

  // Which product is being bought decides which price must be verified, so
  // read the draft's mail type BEFORE the money transaction (a network await
  // must never run inside it) and ensure exactly that product - ensuring both
  // JIT products coupled a letter checkout to a hanging postcard lookup
  // (#278 round 5). USER-SCOPED and AFTER the send-block gate: an unscoped
  // peek let any authenticated caller make another user's draft id steer
  // catalog work before authorization said no (#278 round 7). Advisory only -
  // prepareJitOrder re-reads FOR UPDATE and owns the real ownership check.
  const draftPeek = await query<{ mail_type: string | null }>(
    'SELECT mail_type FROM letter_drafts WHERE draft_id = $1 AND user_id = $2',
    [params.draftId, params.userId]
  );
  const peekedMailType = (draftPeek.rows[0]?.mail_type || 'letter') as MailType;
  await ensurePriceCatalog(jitProductCode(peekedMailType));

  // Pay & Send is the one path that both charges AND mails, so both ceilings
  // apply - and both are checked HERE, before prepareJitOrder creates an order
  // and before any Stripe session exists. The send path exempts jit_order
  // funding precisely because this is where it gets capped.
  //
  // inFlight is 1: the letters row is not written until fulfilment, so today's
  // count does not yet include this send.
  await assertMailWithinDailyCaps({ query }, params.userId, 1);
  await assertChargeWithinDailyCap(
    params.userId,
    getJitProductConfig(peekedMailType).amountCents
  );

  const prepared = await prepareJitOrder(params);
  // The asymmetry with prepareJitOrder's reuse branch is DELIBERATE (#279).
  //
  // That branch accepts `stripe_checkout_session_id || checkout_url`; this one
  // keys on checkout_url alone, and #279's first suggestion is to align them.
  // Doing so was tried and reverted, because the fall-through it removes is a
  // REPAIR:
  //
  //   For a row with a session but a NULL checkout_url, the retry re-enters
  //   Stripe carrying the SAME idempotency_key. With unchanged parameters
  //   Stripe replays the original session rather than opening a second one,
  //   and attachCheckout's `checkout_url = COALESCE(checkout_url, $3)`
  //   backfills the url onto that same session. The key is what makes the
  //   repair safe; it cannot mint a duplicate.
  //
  // Closing this path instead returns success: true with
  // `checkoutUrl: order.checkout_url` still NULL - createMailCheckout emits it
  // verbatim and zodSchemas marks it optional, so nothing downstream turns the
  // absence into an error - and the draft stays blocked while
  // checkout_expires_at is in the future. Such a row has no local escape
  // either: the cancel branch and the orphan sweep both require a NULL session
  // id, so it clears only when Stripe reports the session expired.
  //
  // Not "certain harm versus latent harm": both need the same undemonstrated
  // row shape. The difference is what happens once you are in it - the current
  // code repairs the row whenever parameters are unchanged, the aligned guard
  // never does.
  //
  // #279's OTHER suggestion - give the reuse branch the price-id comparison its
  // comment assumes - is sound and still open. The reprice gate can only
  // compare amount and currency because productSnapshot persists no price id,
  // so a repoint at the same amount passes it unnoticed.
  if (prepared.order.status !== 'checkout_pending' || prepared.order.checkout_url) {
    return asCheckoutResult(prepared.order, true);
  }

  const mailType = String(prepared.order.product_snapshot.mailType || 'letter') as MailType;
  // ONE fresh derivation, as it was through round 10. Rounds 11-12 spliced
  // the row's amount together with a live price id (and then the row's price
  // id too), which round 13 showed strands a checkout on an archived Price
  // that the pre-round-11 code completed successfully. The race that
  // motivated the splice was a concurrent memo invalidation, and that
  // machinery is gone (#278 round 13).
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
    throw await failCheckoutCreation(
      prepared.order.order_id,
      checkout,
      'Failed to create Pay & Send checkout'
    );
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
  const productCode =
    session.metadata?.productCode || session.metadata?.productId || session.metadata?.product_id;
  // The STATIC table, not the resolved catalog: this session is already PAID,
  // so refusing it over the current state of a Stripe lookup can only strand
  // money (terminal-classed blips booked paying customers as permanently
  // unmatched; transient-classed ones 500-looped the webhook). The pinned
  // amount is the business agreement, and the GATE below adopts only on exact
  // agreement with it - a mismatched historical payment goes to the
  // unmatched-money lane for an operator, never into the order table (#278
  // rounds 5-7; an earlier comment here claimed downstream quarantine was
  // recoverable, which round 6 proved false: the refund sweep consumed it).
  const definition = PACK_PRODUCTS.find(candidate => candidate.productCode === productCode);
  if (!userId || !definition) {
    return null;
  }
  // THE GATE (#278 round 6). If what the customer actually paid does not
  // equal the pin, do NOT adopt: adopting would write the pinned amount onto
  // the order, the paid-amount comparison would flag PAYMENT_AMOUNT_MISMATCH
  // -> refund_pending, and the maintenance refund sweep is order-type
  // agnostic - so a legitimate months-old purchase at a historical price
  // would be AUTO-REFUNDED with no credits and no human decision. A paid
  // session we decline to adopt takes the unmatched-money path instead:
  // durable record, critical alert, operator review - origin/dev's exact
  // semantics for money we cannot vouch for.
  const paidAmount = session.amount_total ?? null;
  const paidCurrency = normalizedCurrency(session.currency ?? undefined, '');
  if (paidAmount !== definition.expectedAmountCents || paidCurrency !== packCurrency()) {
    // Level follows whether money actually moved. This gate runs for EVERY
    // legacy-metadata session, including checkout.session.expired and
    // async_payment_failed, whose amount_total is a historical price nobody
    // paid - logging those at error made an unpaid expiry indistinguishable
    // from the real paid-mismatch alarm this event name exists for, and the
    // payload carried no marker to tell them apart (#278 round 9).
    const paid = session.payment_status === 'paid';
    writeDiagnostic(paid ? 'error' : 'info', 'commerce.legacy_adoption_amount_mismatch', {
      productCode: definition.productCode,
      // Amounts here are Stripe's own public figures for this session plus a
      // constant from source control - nothing secret.
      paidAmount: paidAmount ?? 'none',
      expectedAmount: definition.expectedAmountCents,
      paidCurrency: paidCurrency || 'none',
      paymentStatus: session.payment_status ?? 'unknown'
    });
    return null;
  }
  const product = {
    productCode: definition.productCode,
    credits: definition.credits,
    amountCents: definition.expectedAmountCents,
    currency: packCurrency(),
    // Satisfies the shared CommerceProductConfig shape only; nothing in the
    // adoption path persists or reads a price id - productSnapshot serializes
    // name/description/mailType, and the INSERT uses code/credits/amount/
    // currency. Deliberately NOT an env read: this path is static-table only.
    priceId: '',
    name: definition.name,
    description: definition.description
  };
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
      // The shared normalizer, like every sibling gate: a legacy row with a
      // padded currency passed the paid-amount check and then failed HERE, so
      // the repair tool refused a grant every other gate had accepted
      // (#278 round 10 - the last copy of the two-policies split).
      normalizedCurrency(order.currency, '') !== normalizedCurrency(params.paidCurrency, '')
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
  // The same normalizer as every other currency judgment (trim + lowercase):
  // two policies judging one value let a padded currency pass one gate and
  // fail its neighbor (#278 round 7).
  const paidCurrency = normalizedCurrency(session.currency ?? undefined, '');
  if (paidAmount !== order.amount_cents || paidCurrency !== normalizedCurrency(order.currency, '')) {
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
      quantity: integerSetting('IMAGE_ENTITLEMENTS_PER_JIT_ORDER', 2)
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
  // NO price-catalog call here, deliberately. The money already moved:
  // adoption prices from the static product table (createLegacyPackOrder),
  // and the paid-amount comparison downstream verifies the charge against
  // that independent figure. Putting a live Stripe read in front of this
  // transaction spent five review rounds producing exactly the failure modes
  // you would expect - webhook 500 loops on transient faults (the schedule on
  // which Stripe disables an endpoint), paid money stranded as unmatched
  // during a key rotation, Stripe latency inside the webhook budget - all for
  // a lookup whose answer the table already knows (#278 review round 5).
  return transaction(async client => {
    if (!(await claimStripeEvent(client, eventId, eventType, session.id))) {
      return { duplicate: true };
    }
    let order = await findCheckoutOrder(client, session);
    if (!order) order = await createLegacyPackOrder(client, session);
    if (!order) {
      // A paid session we cannot bind to an order is unmatched money. Consuming
      // the event here without a durable record would charge the customer,
      // deliver nothing, return HTTP 200 so Stripe stops retrying, and leave no
      // row for any recovery path to find.
      if (session.payment_status === 'paid') {
        await client.query(
          `UPDATE stripe_webhook_events SET processing_status = 'unmatched',
             provider_payment_intent_id = $2 WHERE event_id = $1`,
          [eventId, paymentIntentId(session) || null]
        );
        await client.query(
          `INSERT INTO commerce_operational_alerts
             (source_event_id, alert_type, severity, details)
           VALUES ($1, 'stripe_money_event_unmatched', 'critical', $2)
           ON CONFLICT (source_event_id, alert_type) DO NOTHING`,
          [eventId, JSON.stringify({
            eventClass: 'checkout',
            hasPaymentIntent: Boolean(paymentIntentId(session)),
            hasCharge: false,
            hasMetadataOrder: Boolean(session.metadata?.orderId)
          })]
        );
      }
      return { duplicate: false };
    }
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
           last_error_code = CASE WHEN last_error_code = 'PAYMENT_AMOUNT_MISMATCH'
             THEN last_error_code ELSE 'UNMATCHED_MONEY_EVENT_RECOVERED' END,
           -- The PAIR, third site (#279). Setting the code without the message
           -- leaves an operator triaging stranded money reading
           -- UNMATCHED_MONEY_EVENT_RECOVERED beside whatever unrelated text was
           -- already there. The same omission was hand-fixed twice before, at
           -- the two sibling sites; a test now asserts the pairing everywhere
           -- rather than waiting for a fourth round to find the next one.
           -- Mirrors the CASE above so a PAYMENT_AMOUNT_MISMATCH quarantine
           -- keeps its own message alongside its own code.
           last_error = CASE WHEN last_error_code = 'PAYMENT_AMOUNT_MISMATCH'
             THEN last_error ELSE 'Money arrived for a session this order had not recorded' END,
           updated_at = NOW()
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

/**
 * Why a pack was revoked. Stamped into the audit row so a later compensation can
 * tell a dispute-caused revocation from a refund-caused one.
 *
 * Without this the two are byte-identical, and a compensation cannot know which
 * revocation it is answering - which would let a favourable dispute close undo a
 * legitimate refund and hand the customer both the money and the credits.
 */
type RevocationCause = 'payment_refunded' | 'payment_disputed';

async function revokePackCredits(
  client: Pick<pg.PoolClient, 'query'>,
  order: Order,
  cause: RevocationCause = 'payment_refunded',
  disputeId?: string
): Promise<void> {
  // Canonical account lock order: users -> credit_ledger -> image_entitlements.
  // Reversal must take the account lock first so it cannot deadlock against a
  // concurrent ledger deduction or grant, which lock the user row first.
  await lockAccountForBalanceChange(client, order.user_id);
  const entries = await client.query<{
    ledger_id: string;
    initial_amount: number;
    remaining_amount: number;
    source_type: string;
  }>(
    // 'adjustment' is included deliberately. A dispute compensation posts an
    // adjustment lot against this order, and without it here that lot would sit
    // outside the scope of every later claw-back: the purchase lot stays
    // 'revoked' so this query would find nothing and return, leaving a customer
    // who was later refunded holding both the money and the compensated credits.
    `SELECT ledger_id, initial_amount, remaining_amount, source_type FROM credit_ledger
     WHERE user_id = $1 AND source_type IN ('purchase', 'adjustment')
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
        // remaining_at_revocation is what a later restore must put back. The
        // revocation zeroes remaining_amount on the original row, so without
        // recording it here the pre-revocation balance is unrecoverable and a
        // won dispute could not be undone. initial_amount is the original grant,
        // not what was left.
        JSON.stringify({
          reason: cause,
          order_id: order.order_id,
          remaining_at_revocation: entry.remaining_amount,
          ...(disputeId ? { dispute_id: disputeId } : {})
        }),
        `Payment refund for ${order.order_id}`,
        entry.ledger_id
      ]
    );
  }
  // credits_purchased is lifetime spend and must be decremented once per order,
  // not once per revocation. Revoking a compensation lot is a second claw-back
  // of the same order; subtracting again understates the customer's lifetime
  // total. Only the revocation that takes the original purchase adjusts it.
  const revokedAPurchase = entries.rows.some(entry => entry.source_type === 'purchase');
  const user = await client.query<{ credits: number }>(
    `UPDATE users
     SET credits = GREATEST(credits - $1, 0),
         credits_purchased = GREATEST(credits_purchased - $2, 0),
         updated_at = NOW()
     WHERE user_id = $3
     RETURNING credits`,
    [remaining, revokedAPurchase ? order.credits || 0 : 0, order.user_id]
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

/**
 * Stripe dispute statuses that mean no money was, or will be, taken from us.
 *
 * The status enum is not two-valued. `warning_*` are card-network inquiries -
 * a bank asking a question - where funds are never withdrawn. Treating those as
 * chargebacks would confiscate a paying customer's balance because someone
 * queried a charge. `won` and `prevented` are outright favourable outcomes.
 *
 * Anything not listed here is treated as a loss and revokes, which is the
 * correct default for an unrecognised or future status.
 */
const NON_LOSS_DISPUTE_STATUSES = new Set([
  'won',
  'prevented',
  'warning_needs_response',
  'warning_under_review',
  'warning_closed'
]);

/**
 * Outcomes that positively compensate a previously revoked pack, not merely
 * decline to revoke.
 *
 * `warning_closed` is deliberately NOT here despite being a non-loss status. An
 * inquiry never revokes anything, so it has nothing of its own to compensate -
 * its only reachable effect would be to trigger a compensation for a revocation
 * that something else caused.
 */
const FAVOURABLE_DISPUTE_STATUSES = new Set(['won', 'prevented']);

/**
 * Make a customer whole after a dispute resolves in our favour.
 *
 * Posts a NEW compensating grant rather than reversing the revocation. The
 * revocation stays in history as an honest record of what happened, and the
 * compensation is a separate, linked entry - so `related_ledger_id` on the
 * original purchase row answers "was this ever revoked, and was it made good?"
 * in a single indexed lookup.
 *
 * Reversal was tried first and rejected: identifying WHICH revocation to undo
 * from audit rows that look identical for refunds and disputes let a favourable
 * dispute silently undo a legitimate refund.
 *
 * Uses source_type 'adjustment', not 'refund'. A 'refund' row linked to a
 * purchase is what the tier calculation treats as "this purchase was returned",
 * and a compensation is the opposite of that. 'adjustment' is also the only
 * suitable existing enum value - a new one cannot be added, because
 * ALTER TYPE ... ADD VALUE is illegal inside the migrator's single transaction.
 *
 * The compensating lot inherits the original lot's expiry. Credits live in lots
 * with their own expiry and are consumed FIFO by expires_at, so a fresh lot with
 * no expiry would silently extend the customer's window.
 */
async function compensateDisputedPacks(
  client: Pick<pg.PoolClient, 'query'>,
  order: Order,
  disputeId: string
): Promise<void> {
  // A refunded order must never be compensated. Stripe can deliver a delayed
  // closed(won) after a refund has already been processed; the refund's own
  // claw-back no-ops against lots the dispute already revoked, so compensating
  // afterwards would hand the customer the refund AND the credits with nothing
  // left to reverse it. The legitimate won-then-refunded order is unaffected:
  // there compensation happens first and the later refund claws it back.
  if (order.status === 'refunded' || order.status === 'refund_pending') {
    return;
  }

  await lockAccountForBalanceChange(client, order.user_id);

  // Only lots revoked BY A DISPUTE, and only where no compensation for this
  // dispute already exists. Matching on the revocation cause is what keeps a
  // refund-caused revocation out of scope.
  const entries = await client.query<{
    ledger_id: string;
    restore_amount: number;
    expires_at: Date | null;
    expiration_policy: string | null;
  }>(
    `SELECT revoked.ledger_id,
            COALESCE((audit.source_metadata->>'remaining_at_revocation')::int, 0) AS restore_amount,
            revoked.expires_at,
            revoked.expiration_policy
       FROM credit_ledger revoked
       JOIN credit_ledger audit
         ON audit.related_ledger_id = revoked.ledger_id
        AND audit.source_type = 'refund'
        AND audit.source_metadata->>'reason' = 'payment_disputed'
        -- Pinned to the dispute that actually caused this revocation. Matching
        -- any dispute-caused revocation would let a second, unrelated dispute
        -- closing favourably compensate a lot the first one took.
        AND audit.source_metadata->>'dispute_id' = $4
      WHERE revoked.user_id = $1
        -- Every lot the dispute took, not just the purchase. A dispute revokes
        -- adjustment lots too, and the customer held them: issue #151's
        -- returned Letter Pack, and any earlier dispute's own compensation.
        -- Restoring only the purchase left the customer short by exactly the
        -- part a failed send had given back (issue #192).
        AND revoked.source_type IN ('purchase', 'adjustment')
        AND revoked.status = 'revoked'
        AND (revoked.source_reference_id = $2
             OR revoked.source_metadata->>'stripe_session_id' = $3)
        -- Keyed per LOT, not per (lot, dispute). A lot can only ever be
        -- compensated once: entitlement belongs to the lot, so keying on the
        -- dispute would grant again for each new dispute touching the order.
        --
        -- The reason is part of the key. Any adjustment lot linked to this one
        -- used to read as "already compensated", and issue #151 posts one: a
        -- returned Letter Pack links to the lot it came from. Without this line
        -- a customer who won a dispute on a pack that had funded a failed send
        -- got nothing back at all.
        AND NOT EXISTS (
          SELECT 1 FROM credit_ledger compensation
           WHERE compensation.related_ledger_id = revoked.ledger_id
             AND compensation.source_type = 'adjustment'
             AND compensation.source_metadata->>'reason' = 'dispute_resolved_in_our_favour'
        )
      FOR UPDATE OF revoked`,
    [order.user_id, order.order_id, order.stripe_checkout_session_id || null, disputeId]
  );
  if (entries.rows.length === 0) return;

  let compensated = 0;
  let skippedUnknownAmount = 0;
  for (const entry of entries.rows) {
    if (entry.restore_amount <= 0) {
      // A lot revoked before remaining_at_revocation was recorded. There is no
      // way to know what it held, so guessing would be inventing money in one
      // direction or the other. Surfaced below rather than silently skipped.
      skippedUnknownAmount += 1;
      continue;
    }
    await client.query(
      `INSERT INTO credit_ledger (
         user_id, initial_amount, remaining_amount, source_type,
         source_reference_id, source_metadata, activated_at,
         expires_at, expiration_policy, status, description, related_ledger_id
       ) VALUES ($1, $2, $2, 'adjustment', $3, $4, NOW(), $5, $6, 'active', $7, $8)`,
      [
        order.user_id,
        entry.restore_amount,
        order.order_id,
        JSON.stringify({
          reason: 'dispute_resolved_in_our_favour',
          order_id: order.order_id,
          dispute_id: disputeId,
          compensates_ledger_id: entry.ledger_id
        }),
        entry.expires_at,
        entry.expiration_policy,
        `Dispute resolved in our favour for ${order.order_id}`,
        entry.ledger_id
      ]
    );
    compensated += entry.restore_amount;
  }

  if (skippedUnknownAmount > 0) {
    // Silence here would mean a customer who won a dispute quietly gets nothing.
    await client.query(
      `INSERT INTO commerce_operational_alerts
         (order_id, alert_type, severity, details)
       VALUES ($1, 'dispute_compensation_incomplete', 'warning', $2)
       ON CONFLICT DO NOTHING`,
      [
        order.order_id,
        JSON.stringify({ disputeId, lotsWithoutRecordedBalance: skippedUnknownAmount })
      ]
    );
  }

  if (compensated === 0) return;

  // credits only. credits_purchased is lifetime spend and drives tier - a
  // compensation is not a new purchase and must not inflate either.
  await client.query(
    `UPDATE users SET credits = credits + $1, updated_at = NOW() WHERE user_id = $2`,
    [compensated, order.user_id]
  );

  // Symmetry with revocation, which writes its own credit_transactions row.
  // Without this the transaction ledger shows a debit with no matching credit.
  // balance_after is read from users AFTER the update above, so the snapshot
  // matches the balance this transaction produced.
  await client.query(
    `INSERT INTO credit_transactions (
       user_id, amount, balance_after, type, reference_type, reference_id, description
     ) SELECT $1::varchar, $2::int, credits, 'refund', 'order', $3::varchar, $4::text
         FROM users WHERE user_id = $1::varchar`,
    [
      order.user_id,
      compensated,
      order.order_id,
      `Dispute ${disputeId} resolved in our favour for ${order.order_id}`
    ]
  );
}

/**
 * Lift a send block after a dispute resolves in our favour.
 *
 * Scoped deliberately: the block is only lifted when the account has no OTHER
 * dispute that would itself justify a block. Keying on the reason alone would
 * let a benign outcome on one order unlock a block a different, still-standing
 * chargeback had set.
 *
 * "Would justify a block" means exactly the statuses that revoke - the inverse
 * of NON_LOSS_DISPUTE_STATUSES. Counting inquiries here was a dead end: an open
 * inquiry never blocks anything, but it would veto the unblock, and when it
 * later closed warning_closed that status is not favourable so no further
 * unblock is attempted. A customer who won their chargeback stayed blocked
 * forever, with no tooling to clear it.
 */
async function unblockAccountSends(
  client: Pick<pg.PoolClient, 'query'>,
  userId: string,
  resolvedDisputeId: string
): Promise<void> {
  await client.query(
    `UPDATE users
     SET sends_blocked_at = NULL, sends_blocked_reason = NULL, updated_at = NOW()
     WHERE user_id = $1
       AND sends_blocked_reason = 'payment_disputed'
       AND NOT EXISTS (
         SELECT 1 FROM stripe_disputes other
          WHERE other.user_id = $1
            AND other.dispute_id <> $2
            AND NOT (other.status = ANY($3::text[]))
       )`,
    [userId, resolvedDisputeId, [...NON_LOSS_DISPUTE_STATUSES]]
  );
}

/**
 * Persist the dispute lifecycle idempotently.
 *
 * Keyed on Stripe's dispute id, so replayed, reordered or concurrently
 * delivered events converge on one row rather than accumulating duplicates.
 * Reordering is handled explicitly: a late-arriving `created` must not
 * overwrite the resolution written by a `closed` that already landed, so
 * `resolved_at` is only ever set, never cleared.
 */
async function recordDispute(
  client: Pick<pg.PoolClient, 'query'>,
  dispute: Stripe.Dispute,
  userId: string | null,
  closed: boolean
): Promise<void> {
  const chargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id;
  const paymentIntentId = typeof dispute.payment_intent === 'string'
    ? dispute.payment_intent
    : dispute.payment_intent?.id;

  await client.query(
    `INSERT INTO stripe_disputes (
       dispute_id, charge_id, payment_intent_id, user_id, amount_cents, currency,
       reason, status, evidence_due_by, stripe_created_at, resolved_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (dispute_id) DO UPDATE SET
       charge_id = EXCLUDED.charge_id,
       payment_intent_id = COALESCE(EXCLUDED.payment_intent_id, stripe_disputes.payment_intent_id),
       user_id = COALESCE(EXCLUDED.user_id, stripe_disputes.user_id),
       amount_cents = EXCLUDED.amount_cents,
       currency = EXCLUDED.currency,
       reason = COALESCE(EXCLUDED.reason, stripe_disputes.reason),
       status = EXCLUDED.status,
       evidence_due_by = COALESCE(EXCLUDED.evidence_due_by, stripe_disputes.evidence_due_by),
       stripe_created_at = COALESCE(EXCLUDED.stripe_created_at, stripe_disputes.stripe_created_at),
       -- Never clear a resolution: a replayed created event arriving after a
       -- closed one would otherwise reopen a settled dispute.
       resolved_at = COALESCE(stripe_disputes.resolved_at, EXCLUDED.resolved_at),
       updated_at = NOW()`,
    [
      dispute.id,
      chargeId || '',
      paymentIntentId || null,
      userId,
      dispute.amount,
      dispute.currency,
      dispute.reason || null,
      String(dispute.status || 'open'),
      dispute.evidence_details?.due_by ? new Date(dispute.evidence_details.due_by * 1000) : null,
      dispute.created ? new Date(dispute.created * 1000) : null,
      closed ? new Date() : null
    ]
  );
}

/**
 * Restrict an account from sending further mail.
 *
 * Approved policy for issue #150: a dispute zeroes the pack balance and blocks
 * sends pending operator review. Deliberately idempotent and non-clobbering -
 * an account already blocked for an earlier dispute keeps its original
 * timestamp and reason, so a second chargeback cannot mask the first.
 *
 * Lifted automatically only when a dispute resolves in our favour AND the
 * account has no other dispute still open or lost - see unblockAccountSends.
 * Any other route back is an operator decision, and there is no tooling for it
 * yet.
 */
async function blockAccountSends(
  client: Pick<pg.PoolClient, 'query'>,
  userId: string,
  reason: string
): Promise<void> {
  await client.query(
    `UPDATE users
     SET sends_blocked_at = COALESCE(sends_blocked_at, NOW()),
         sends_blocked_reason = COALESCE(sends_blocked_reason, $2),
         updated_at = NOW()
     WHERE user_id = $1`,
    [userId, reason]
  );
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
    // Persist before the unmatched-order branch returns. An unmatched dispute is
    // still money leaving the account, and the operator reviewing it needs the
    // record regardless of whether we could tie it to an order.
    await recordDispute(client, dispute, order?.user_id ?? null, closed);
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

      // Issue #150, approved policy. A refund absorbs packs the customer already
      // spent and leaves the account alone; a dispute is adversarial and does
      // neither. Zero the pack balance and restrict sends pending review.
      //
      // Not applied for outcomes where no money was or will be taken. That is
      // NOT just 'won': the warning_* statuses are card-network inquiries where
      // funds are never withdrawn, and treating a bank's question as a
      // chargeback would confiscate a paying customer's balance. Anything
      // unrecognised is treated as a loss, which is the safe default.
      //
      // Applied on created AND on any losing close, because Stripe can deliver
      // these out of order and a close arriving without its create must still
      // revoke rather than leave the packs quietly spendable. Both operations
      // are idempotent, so the second event is a no-op.
      const status = String(dispute.status || '');
      if (!NON_LOSS_DISPUTE_STATUSES.has(status)) {
        if (order.order_type === 'letter_pack') {
          await revokePackCredits(client, order, 'payment_disputed', dispute.id);
        }
        await blockAccountSends(client, order.user_id, 'payment_disputed');
      } else if (closed && FAVOURABLE_DISPUTE_STATUSES.has(status)) {
        // Stripe always emits created before closed, so a win arrives AFTER the
        // packs were revoked and the account blocked. Declining to revoke again
        // is not enough - without compensating, we keep the funds and the
        // customer keeps nothing, permanently.
        if (order.order_type === 'letter_pack') {
          await compensateDisputedPacks(client, order, dispute.id);
        }
        await unblockAccountSends(client, order.user_id, dispute.id);
      }

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
        quantity: integerSetting('IMAGE_ENTITLEMENTS_PER_JIT_ORDER', 2)
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

/**
 * The Stripe calls this path makes, injectable for tests.
 *
 * Issue #188. The defect below was a statement PostgreSQL refuses to plan, and
 * it survived because nothing could reach it: the refund path needs a live
 * Stripe client before it touches the database, so every test of it stopped at
 * the vendor boundary. This is the same default-parameter seam
 * `reconcileStripePayments` already uses, and it substitutes the vendor only -
 * the database, the transaction and the revocation stay real.
 */
export interface RefundOperations {
  retrieveRefund: typeof retrieveRefund;
  findPaymentRefund: typeof findPaymentRefund;
  createPaymentRefund: typeof createPaymentRefund;
}

const liveRefundOperations: RefundOperations = {
  retrieveRefund,
  findPaymentRefund,
  createPaymentRefund
};

export async function requestRefund(
  orderId: string,
  reason: string,
  stripeRefunds: RefundOperations = liveRefundOperations
): Promise<boolean> {
  const retryLimit = integerSetting('JIT_REFUND_RETRY_LIMIT', 5);
  if (retryLimit === 0) return false;
  const claimed = await query<RefundClaim>(
    `WITH candidate AS (
       SELECT order_id, refund_attempts
       FROM orders
       WHERE order_id = $1 AND status = 'refund_pending'
         -- The PAYMENT_AMOUNT_MISMATCH quarantine gate lives in the CLAIM,
         -- not only in the maintenance sweep's candidate SELECT: any future
         -- caller of this exported money-mover (an admin bulk-retry, another
         -- sweep) must hit the same wall. Operator release = clearing the
         -- marker (#278 round 8).
         AND (last_error_code IS NULL OR last_error_code <> 'PAYMENT_AMOUNT_MISMATCH')
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
        const existingRefund = await stripeRefunds.retrieveRefund(order.stripe_refund_id);
        if (!['failed', 'canceled'].includes(existingRefund.status || '')) {
          refund = existingRefund;
        }
      } catch {
        // Confirm by payment intent below before creating another refund. This
        // covers a persisted stale ID without risking a duplicate refund.
      }
    }
    refund ??= await stripeRefunds.findPaymentRefund(order.stripe_payment_intent_id, order.order_id);
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
      refund = await stripeRefunds.createPaymentRefund(
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
      // Every use of $3 is cast. Assigning it to status (a VARCHAR column)
      // deduces varchar while comparing it to an untyped literal deduces text,
      // and PostgreSQL rejects the statement outright with "inconsistent types
      // deduced for parameter $3". This threw on EVERY refund, after Stripe had
      // already sent the customer their money: the catch below recorded
      // REFUND_REQUEST_FAILED, the order stayed refund_pending, and the pack
      // revocation and entitlement revocation under it never ran. The other two
      // statements writing this column already carried the cast.
      const finalized = await client.query<{ order_id: string }>(
        `UPDATE orders
         SET stripe_refund_id = $2, status = $3::varchar,
             refunded_at = CASE WHEN $3::varchar = 'refunded' THEN NOW() ELSE refunded_at END,
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
        errorClass: carriedDiagnosticClass(error) ?? classifyDiagnosticError(error, 'provider_error')
      });
    }
  }

  // Only cancel checkout-creation orphans locally. Attached Stripe sessions
  // are cancelled above only after Stripe reports them expired; a completed
  // asynchronous payment may remain unpaid beyond its original expires_at.
  const orphaned = await query<{ order_id: string }>(
    `UPDATE orders SET status = 'cancelled', updated_at = NOW()
     WHERE status = 'checkout_pending'
       AND stripe_checkout_session_id IS NULL
       AND (
         checkout_expires_at <= NOW()
         -- Pack orders are inserted WITHOUT checkout_expires_at, and NULL <=
         -- NOW() is UNKNOWN - so a pack whose session creation failed
         -- non-terminally was a zombie this sweep could never reclaim,
         -- stranded in checkout_pending forever with no alarm (the stuck-order
         -- check watches paid statuses only). No session exists, so nothing
         -- can ever pay it; a day is ample grace (#278 review round 4).
         OR (checkout_expires_at IS NULL AND updated_at <= NOW() - INTERVAL '24 hours')
       )
     RETURNING order_id`
  );
  expiredCheckouts += orphaned.rowCount || 0;

  let refundAttempts = 0;
  const refunds = await query<{ order_id: string; last_error: string | null }>(
    `SELECT order_id, last_error FROM orders
     WHERE status = 'refund_pending'
       AND stripe_payment_intent_id IS NOT NULL
       -- A PAYMENT_AMOUNT_MISMATCH quarantine is a question for an operator,
       -- never an instruction to refund: round 6 gated the legacy-adoption
       -- PRODUCER of this state, but the sweep - the CONSUMER - would still
       -- have auto-refunded any normally-created order that a Stripe-side
       -- amount change (promo code, adaptive pricing, tax) pushed into the
       -- quarantine, mass-refunding real customers with no human decision
       -- (#278 round 7). Quarantined rows stay visible via the stuck-order
       -- alarm; an operator releases them by clearing the code or refunding
       -- deliberately. UNMATCHED_MONEY_EVENT_RECOVERED is NOT excluded: that
       -- lane recovers refund/dispute events whose Stripe-side refund already
       -- exists, and requestRefund discovers it (findPaymentRefund-first)
       -- rather than creating another.
       AND (last_error_code IS NULL OR last_error_code <> 'PAYMENT_AMOUNT_MISMATCH')
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
