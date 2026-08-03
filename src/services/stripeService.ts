/** Stripe adapter for hosted physical-goods checkout, events, and refunds. */

import Stripe from 'stripe';
import type { MailType } from './types.js';
import { classifyDiagnosticError, writeDiagnostic } from '../utils/diagnosticLog.js';

let stripeClient: Stripe | null = null;

export function getStripeClient(): Stripe {
  const apiKey = process.env.STRIPE_SECRET_KEY;
  if (!apiKey) throw new Error('STRIPE_SECRET_KEY is not configured');
  stripeClient ??= new Stripe(apiKey, { apiVersion: '2025-11-17.clover' });
  return stripeClient;
}

export type PackProductId = 'credit-pack-4' | 'credit-pack-10' | 'credit-pack-100';

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

interface PackProductDefinition {
  credits: number;
  priceEnv: string;
  amountEnv: string;
  name: string;
  description: string;
}

const PACK_PRODUCTS: Record<PackProductId, PackProductDefinition> = {
  'credit-pack-4': {
    credits: 4,
    priceEnv: 'STRIPE_PRICE_STARTER',
    amountEnv: 'STRIPE_STARTER_AMOUNT_CENTS',
    name: 'Starter Pack - 2 Letters',
    description: 'Two prepaid physical letters or postcards'
  },
  'credit-pack-10': {
    credits: 10,
    priceEnv: 'STRIPE_PRICE_REGULAR',
    amountEnv: 'STRIPE_REGULAR_AMOUNT_CENTS',
    name: 'Regular Pack - 5 Letters',
    description: 'Five prepaid physical letters or postcards'
  },
  'credit-pack-100': {
    credits: 100,
    priceEnv: 'STRIPE_PRICE_POWER',
    amountEnv: 'STRIPE_POWER_AMOUNT_CENTS',
    name: 'Power Pack - 50 Letters',
    description: 'Fifty prepaid physical letters or postcards'
  }
};

function positiveInteger(value: string | undefined, fallback?: number): number {
  const parsed = Number.parseInt(value || '', 10);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return fallback || 0;
}

export function getPackProductConfig(productId: PackProductId): CommerceProductConfig | null {
  const definition = PACK_PRODUCTS[productId];
  if (!definition) return null;
  return {
    productCode: productId,
    credits: definition.credits,
    priceId: process.env[definition.priceEnv] || '',
    // Never guess a financial amount from a price identifier. Missing config
    // disables checkout and reconciliation instead of refunding a legitimate
    // purchase against a stale hard-coded price.
    amountCents: positiveInteger(process.env[definition.amountEnv]),
    currency: (process.env.STRIPE_CURRENCY || 'usd').toLowerCase(),
    name: definition.name,
    description: definition.description
  };
}

export function getJitProductConfig(mailType: MailType): CommerceProductConfig {
  const isPostcard = mailType === 'postcard';
  return {
    productCode: isPostcard ? 'jit-postcard' : 'jit-letter',
    mailType,
    priceId:
      process.env[isPostcard ? 'STRIPE_JIT_POSTCARD_PRICE_ID' : 'STRIPE_JIT_LETTER_PRICE_ID'] || '',
    amountCents: positiveInteger(
      process.env[isPostcard ? 'JIT_POSTCARD_AMOUNT_CENTS' : 'JIT_LETTER_AMOUNT_CENTS']
    ),
    currency: (process.env.JIT_CURRENCY || process.env.STRIPE_CURRENCY || 'usd').toLowerCase(),
    name: isPostcard ? 'Pay & Send One Physical Postcard' : 'Pay & Send One Physical Letter',
    description: isPostcard
      ? 'Payment authorizes Letter IRL to print and mail this exact postcard.'
      : 'Payment authorizes Letter IRL to print and mail this exact letter.'
  };
}

export function isJitPurchaseEnabled(): boolean {
  return process.env.JIT_PURCHASE_ENABLED === 'true';
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
      error: `Price ID not configured for product: ${params.product.productCode}`
    };
  }
  // Amounts are never inferred from a Price ID. Without an explicit
  // STRIPE_*_AMOUNT_CENTS the purchase is disabled rather than transacted
  // against a figure we cannot reconcile or refund.
  if (!Number.isInteger(params.product.amountCents) || params.product.amountCents <= 0) {
    return {
      success: false,
      errorCode: 'PACK_AMOUNT_NOT_CONFIGURED',
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
    writeDiagnostic('error', 'stripe.checkout_creation_failed', {
      errorClass: classifyDiagnosticError(error, 'provider_error')
    });
    return {
      success: false,
      error: 'Failed to create checkout session'
    };
  }
}

/** Backward-compatible pack adapter used by older callers and tests. */
export async function createCheckoutSession(
  params: CheckoutSessionParams
): Promise<CheckoutSessionResult> {
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

export async function retrieveCheckoutSession(sessionId: string): Promise<Stripe.Checkout.Session> {
  return getStripeClient().checkout.sessions.retrieve(sessionId);
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
    { idempotencyKey: `jit-refund:${orderId}:attempt:${attempt}` }
  );
}

export async function retrieveRefund(refundId: string): Promise<Stripe.Refund> {
  return getStripeClient().refunds.retrieve(refundId);
}

export async function findPaymentRefund(
  paymentIntentId: string,
  orderId: string
): Promise<Stripe.Refund | null> {
  const refunds = await getStripeClient().refunds.list({
    payment_intent: paymentIntentId,
    limit: 100
  });
  return (
    refunds.data.find(
      refund =>
        refund.metadata?.orderId === orderId &&
        !['failed', 'canceled'].includes(refund.status || '')
    ) || null
  );
}
