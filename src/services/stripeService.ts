/** Stripe adapter for hosted physical-goods checkout, events, and refunds. */

import type Stripe from 'stripe';
import type { MailType } from './types.js';
import {
  carriedDiagnosticClass,
  classifyDiagnosticError,
  writeDiagnostic
} from '../utils/diagnosticLog.js';
import {
  describeUnpriced,
  getResolvedPriceForProduct
} from './priceCatalog.js';
import { BACKGROUND_REQUEST_OPTIONS, getStripeClient } from './stripeClient.js';
import {
  PACK_PRODUCTS,
  getConfiguredProduct,
  jitCurrency,
  jitProductDefinition,
  packCurrency,
  type PackProductId
} from '../config/products.js';

// Re-exported because commerceService and the tool layer import them from
// here; the definitions themselves live in the leaf module
// src/config/products.ts so the manifest, the catalog, and the reconciliation
// service read one table. (getStripeClient is NOT re-exported: its two real
// consumers import it straight from ./stripeClient.js, and the comment that
// used to claim otherwise named importers that do not exist - #278 review r3.)
export { isJitPurchaseEnabled, type PackProductId } from '../config/products.js';

export interface CommerceProductConfig {
  productCode: string;
  priceId: string;
  amountCents: number;
  currency: string;
  name: string;
  description: string;
  credits?: number;
  mailType?: MailType;
}

export function getPackProductConfig(productId: PackProductId): CommerceProductConfig | null {
  const definition = PACK_PRODUCTS.find(product => product.productCode === productId);
  if (!definition) return null;
  // The amount comes from the resolved Stripe Price - there is no second copy
  // to disagree with it (#275 stage A). Resolution is lazy: every async path
  // that can reach this awaits ensurePriceCatalog() first. An unresolved
  // product yields 0, which every caller's "not configured" guard refuses, so
  // the purchase is disabled rather than transacted against a guess.
  const configured = getConfiguredProduct(productId);
  const resolved = getResolvedPriceForProduct(productId);
  return {
    productCode: productId,
    credits: definition.credits,
    // Not memo ?? env: getResolvedPriceForProduct only returns a memo that
    // ALREADY equals the configured id and expected currency, so the two
    // sources were identical by construction and the ?? read as if the memo
    // could win - a trap armed the day the memo validity rule loosens (#278
    // round 6). Only the amount genuinely depends on resolution.
    priceId: configured?.priceId ?? '',
    amountCents: resolved?.unitAmount ?? 0,
    // The row's OWN expected currency: it is packCurrency(env) by
    // construction, and re-reading the env for it made this accessor pay
    // three derivations of one row per warm quote - the per-quote cost
    // getConfiguredProduct was introduced to remove (#278 round 9).
    currency: configured?.expectedCurrency ?? packCurrency(),
    name: definition.name,
    description: definition.description
  };
}

export function getJitProductConfig(mailType: MailType): CommerceProductConfig {
  // The shared lookup, so the unknown-mail-type fallback policy is not
  // written once here and once in jitProductCode - the quote path kicks and
  // clears through one and prices through the other (#278 round 9).
  const definition = jitProductDefinition(mailType);
  const configured = getConfiguredProduct(definition.productCode);
  const resolved = getResolvedPriceForProduct(definition.productCode);
  return {
    productCode: definition.productCode,
    mailType,
    priceId: configured?.priceId ?? '',
    amountCents: resolved?.unitAmount ?? 0,
    currency: configured?.expectedCurrency ?? jitCurrency(),
    name: definition.name,
    description: definition.description
  };
}

export interface CheckoutSessionResult {
  success: boolean;
  sessionId?: string;
  sessionUrl?: string;
  expiresAt?: Date;
  error?: string;
  /** Stable, non-PII classification for configuration failures. */
  errorCode?: 'PRICE_ID_NOT_CONFIGURED' | 'PACK_AMOUNT_NOT_CONFIGURED' | 'PROVIDER_ERROR';
  /**
   * The resolved diagnostic class for the failure - for a provider error, the
   * Stripe error's own code or type (e.g. `resource_missing`), already
   * sanitized through classifyDiagnosticError; for a configuration fault,
   * `configuration_error`. Carried so the caller's own catch can log the real
   * cause rather than relabelling it. Issue #213.
   */
  diagnosticClass?: string;
}

interface HostedCheckoutParams {
  orderId: string;
  orderType: 'letter_pack' | 'jit_mail';
  userEmail?: string;
  product: CommerceProductConfig;
  successUrl: string;
  cancelUrl: string;
  expiresAt?: Date;
  idempotencyKey: string;
}

async function createHostedCheckout(params: HostedCheckoutParams): Promise<CheckoutSessionResult> {
  if (!params.product.priceId) {
    return {
      success: false,
      errorCode: 'PRICE_ID_NOT_CONFIGURED',
      diagnosticClass: 'configuration_error',
      error: `Price ID not configured for product: ${params.product.productCode}`
    };
  }
  // The amount comes from the resolved Stripe Price and nowhere else. An
  // unpriceable product refuses rather than transacting against a figure we
  // could not reconcile or refund - and the diagnosticClass carries WHY it is
  // unpriceable, because the caller's cleanup keys off it: configuration_error
  // (archived price, wrong currency, typo'd id, pack tiers sharing one id)
  // cancels the order - retrying cannot help until a human changes config -
  // while a transient lookup failure leaves it pending so a retry can succeed.
  // A Stripe blip must never cancel a customer's order (#276 review, #278
  // review).
  if (!Number.isInteger(params.product.amountCents) || params.product.amountCents <= 0) {
    // describeUnpriced owns the unattempted-means-transient policy; the ??
    // triad this replaces was the last copy of it outside the catalog (#278
    // round 7).
    const failure = describeUnpriced(params.product.productCode);
    const diagnosticClass = failure.diagnosticClass;
    writeDiagnostic('error', 'stripe.product_not_priced', {
      orderType: params.orderType,
      productCode: params.product.productCode,
      rule: failure.rule,
      errorClass: diagnosticClass
    });
    return {
      success: false,
      errorCode: 'PACK_AMOUNT_NOT_CONFIGURED',
      diagnosticClass,
      error: `Amount not configured for product: ${params.product.productCode}`
    };
  }

  try {
    const isValidEmail = Boolean(params.userEmail?.includes('@'));
    const session = await getStripeClient().checkout.sessions.create(
      {
        mode: 'payment',
        ...(isValidEmail ? { customer_email: params.userEmail } : {}),
        client_reference_id: params.orderId,
        line_items: [{ price: params.product.priceId, quantity: 1 }],
        metadata: {
          orderId: params.orderId,
          orderType: params.orderType,
          productCode: params.product.productCode
        },
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        ...(params.expiresAt ? { expires_at: Math.floor(params.expiresAt.getTime() / 1000) } : {})
      },
      { idempotencyKey: params.idempotencyKey }
    );

    return {
      success: true,
      sessionId: session.id,
      sessionUrl: session.url || undefined,
      expiresAt: session.expires_at ? new Date(session.expires_at * 1000) : params.expiresAt
    };
  } catch (error) {
    // Carried-first, like every sibling catch this PR installed: without it,
    // getStripeClient's missing-key configuration_error (a bare Error with no
    // .code/.type) degraded to transient provider_error - order pending
    // forever, log blaming Stripe for a missing credential (#278 round 7).
    const diagnosticClass =
      carriedDiagnosticClass(error) ?? classifyDiagnosticError(error, 'provider_error');
    // The parameter Stripe blamed, recorded because a rejected checkout is
    // hard to diagnose without it. `param` is a fixed public StripeError
    // field and is not caller-controlled, so it is safe to log.
    //
    // NOTE: rounds 10-12 also used this to invalidate the price memo, so an
    // archived Price would self-heal. That machinery produced a correctness
    // defect in three consecutive review rounds - a remotely triggerable
    // memo drop, two mechanisms that cancelled each other out, and an
    // unbounded Stripe re-read - and was removed. An archived Price now
    // persists in the memo until the process restarts or the price id is
    // repointed, which is the behaviour rounds 1-10 shipped and no review
    // round ever found a defect in. The cost is bounded and visible: quotes
    // keep advertising it and each purchase fails at session creation, with
    // this log line naming the price as the offending parameter (#278 r13).
    const offendingParam =
      typeof (error as { param?: unknown })?.param === 'string'
        ? (error as { param: string }).param
        : '';
    writeDiagnostic('error', 'stripe.checkout_creation_failed', {
      errorClass: diagnosticClass,
      productCode: params.product.productCode,
      offendingParam: offendingParam || 'none'
    });
    return {
      success: false,
      errorCode: 'PROVIDER_ERROR',
      diagnosticClass,
      error: 'Failed to create checkout session'
    };
  }
}

/** Backward-compatible pack adapter used by older callers and tests. */
export async function createPackCheckoutSession(
  params: Omit<HostedCheckoutParams, 'orderType'>
): Promise<CheckoutSessionResult> {
  return createHostedCheckout({ ...params, orderType: 'letter_pack' });
}

export async function createJitCheckoutSession(
  params: Omit<HostedCheckoutParams, 'orderType'>
): Promise<CheckoutSessionResult> {
  return createHostedCheckout({ ...params, orderType: 'jit_mail' });
}

export function verifyWebhookSignature(
  payload: string | Buffer,
  signature: string
): Stripe.Event | null {
  try {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
    if (!webhookSecret) return null;
    return getStripeClient().webhooks.constructEvent(payload, signature, webhookSecret);
  } catch (error) {
    writeDiagnostic('warn', 'stripe.webhook_signature_invalid', {
      // Carried FIRST. This try wraps getStripeClient(), whose missing-key
      // throw carries configuration_error: bare classification filed a
      // credential fault as a provider blip, so the operator chased a Stripe
      // signing problem while every webhook failed on an unset key - the
      // #213 mislabel, one function away from where round 7 fixed it
      // (#278 round 9).
      errorClass:
        carriedDiagnosticClass(error) ?? classifyDiagnosticError(error, 'provider_error')
    });
    return null;
  }
}

// The four calls below run from maintenance sweeps and webhook recovery - no
// customer is waiting, and the refund path spends a finite refund_attempts
// budget BEFORE calling Stripe, never rolling it back on a throw. On the
// shared client's interactive 10s/1 bound, a slow Stripe day burned attempts
// without refunds.create ever being reached (#278 review round 4).
export async function retrieveCheckoutSession(sessionId: string): Promise<Stripe.Checkout.Session> {
  return getStripeClient().checkout.sessions.retrieve(sessionId, undefined, BACKGROUND_REQUEST_OPTIONS);
}

export async function createPaymentRefund(
  paymentIntentId: string,
  orderId: string,
  attempt = 1
): Promise<Stripe.Refund> {
  return getStripeClient().refunds.create(
    {
      payment_intent: paymentIntentId,
      metadata: { orderId }
    },
    { ...BACKGROUND_REQUEST_OPTIONS, idempotencyKey: `jit-refund:${orderId}:attempt:${attempt}` }
  );
}

export async function retrieveRefund(refundId: string): Promise<Stripe.Refund> {
  return getStripeClient().refunds.retrieve(refundId, undefined, BACKGROUND_REQUEST_OPTIONS);
}

export async function findPaymentRefund(
  paymentIntentId: string,
  orderId: string
): Promise<Stripe.Refund | null> {
  const refunds = await getStripeClient().refunds.list(
    {
      payment_intent: paymentIntentId,
      limit: 100
    },
    BACKGROUND_REQUEST_OPTIONS
  );
  return (
    refunds.data.find(
      refund =>
        refund.metadata?.orderId === orderId &&
        !['failed', 'canceled'].includes(refund.status || '')
    ) || null
  );
}
