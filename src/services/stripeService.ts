/** Stripe adapter for hosted physical-goods checkout, events, and refunds. */

import type Stripe from 'stripe';
import type { MailType } from './types.js';
import {
  classifyDiagnosticError,
  isTerminalDiagnosticClass,
  writeDiagnostic
} from '../utils/diagnosticLog.js';
import {
  ensurePriceCatalog,
  getPriceResolutionFailure,
  getResolvedPriceForProduct
} from './priceCatalog.js';
import { BACKGROUND_REQUEST_OPTIONS, getStripeClient } from './stripeClient.js';
import {
  JIT_PRODUCTS,
  PACK_PRODUCTS,
  jitCurrency,
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
  const resolved = getResolvedPriceForProduct(productId);
  return {
    productCode: productId,
    credits: definition.credits,
    priceId: resolved?.priceId ?? (process.env[definition.priceEnv] ?? '').trim(),
    amountCents: resolved?.unitAmount ?? 0,
    currency: resolved?.currency ?? packCurrency(),
    name: definition.name,
    description: definition.description
  };
}

export function getJitProductConfig(mailType: MailType): CommerceProductConfig {
  const definition = JIT_PRODUCTS.find(product => product.mailType === mailType) ?? JIT_PRODUCTS[0];
  const resolved = getResolvedPriceForProduct(definition.productCode);
  return {
    productCode: definition.productCode,
    mailType,
    priceId: resolved?.priceId ?? (process.env[definition.priceEnv] ?? '').trim(),
    amountCents: resolved?.unitAmount ?? 0,
    currency: resolved?.currency ?? jitCurrency(),
    name: definition.name,
    description: definition.description
  };
}

export interface CheckoutSessionParams {
  userId: string;
  userEmail: string;
  productId: PackProductId;
  successUrl: string;
  cancelUrl: string;
  orderId?: string;
  idempotencyKey?: string;
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
  /**
   * Whether a human must act. Order cleanup keys off this to decide between
   * cancelling the order and leaving it pending; carried explicitly so five
   * call sites stop re-deriving it from a magic string (#278 review round 3).
   */
  terminal?: boolean;
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
      terminal: true,
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
    const failure = getPriceResolutionFailure(params.product.productCode);
    // No recorded failure means the catalog has not attempted this product yet
    // or an attempt is in flight - which priceCatalog itself classes
    // provider_error, "transient by definition". Defaulting the other way made
    // the terminal class the fallback for an unknown state, and terminal is
    // what drives markCheckoutCreationFailure's UPDATE orders SET
    // status='cancelled': the wrong default sitting directly under a header
    // promising a Stripe blip never cancels an order (#278 review round 2). A
    // genuinely unconfigured id is not affected - the catalog records that as
    // price.id_not_configured with configuration_error, so this ?? never fires
    // for it.
    const diagnosticClass = failure?.diagnosticClass ?? 'provider_error';
    writeDiagnostic('error', 'stripe.product_not_priced', {
      orderType: params.orderType,
      productCode: params.product.productCode,
      rule: failure?.rule ?? 'price.not_resolved',
      errorClass: diagnosticClass
    });
    return {
      success: false,
      errorCode: 'PACK_AMOUNT_NOT_CONFIGURED',
      diagnosticClass,
      terminal: failure?.terminal ?? false,
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
    const diagnosticClass = classifyDiagnosticError(error, 'provider_error');
    writeDiagnostic('error', 'stripe.checkout_creation_failed', {
      errorClass: diagnosticClass
    });
    return {
      success: false,
      errorCode: 'PROVIDER_ERROR',
      diagnosticClass,
      terminal: isTerminalDiagnosticClass(diagnosticClass),
      error: 'Failed to create checkout session'
    };
  }
}

/** Backward-compatible pack adapter used by older callers and tests. */
export async function createCheckoutSession(
  params: CheckoutSessionParams
): Promise<CheckoutSessionResult> {
  await ensurePriceCatalog(params.productId);
  const product = getPackProductConfig(params.productId);
  if (!product) return { success: false, error: `Invalid product ID: ${params.productId}` };
  const orderId = params.orderId || `legacy-${params.userId}-${Date.now()}`;
  return createHostedCheckout({
    orderId,
    orderType: 'letter_pack',
    userEmail: params.userEmail,
    product,
    successUrl: params.successUrl,
    cancelUrl: params.cancelUrl,
    idempotencyKey: params.idempotencyKey || `legacy-pack:${orderId}`
  });
}

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
      errorClass: classifyDiagnosticError(error, 'provider_error')
    });
    return null;
  }
}

export interface CheckoutCompletedData {
  userId: string;
  credits: number;
  productId: string;
  sessionId: string;
  amountPaid: number;
  customerEmail: string;
}

/** Legacy session metadata extraction retained for rollout compatibility. */
export async function extractCheckoutData(
  session: Stripe.Checkout.Session
): Promise<CheckoutCompletedData | null> {
  const userId = session.metadata?.userId || session.metadata?.user_id;
  const credits = Number.parseInt(session.metadata?.credits || '0', 10);
  const productId = session.metadata?.productId || session.metadata?.product_id || '';
  if (!userId || !credits || !productId) return null;
  return {
    userId,
    credits,
    productId,
    sessionId: session.id,
    amountPaid: (session.amount_total || 0) / 100,
    customerEmail: session.customer_email || session.customer_details?.email || ''
  };
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
