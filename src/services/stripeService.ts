/**
 * Stripe Payment Service
 *
 * Handles Stripe Checkout sessions and webhook processing for credit purchases
 */

import Stripe from "stripe";

let stripeClient: Stripe | null = null;

export function getStripeClient(): Stripe {
  const apiKey = process.env.STRIPE_SECRET_KEY;
  if (!apiKey) throw new Error("STRIPE_SECRET_KEY is not configured");
  stripeClient ??= new Stripe(apiKey, { apiVersion: "2025-11-17.clover" });
  return stripeClient;
}
export interface CheckoutSessionParams {
  userId: string;
  userEmail: string;
  productId: "credit-pack-4" | "credit-pack-10" | "credit-pack-100";
  successUrl: string;
  cancelUrl: string;
}
export interface CheckoutSessionResult {
  success: boolean;
  sessionId?: string;
  sessionUrl?: string;
  error?: string;
}

/**
 * Product configurations matching our pricing model
 * Price IDs are from Stripe Dashboard (live mode)
 *
 * Note: Internal "credits" are kept for database/webhook compatibility.
 * User-facing names use "Letter Pack" terminology per OpenAI commerce policy.
 * 2 credits = 1 letter
 */
const PRODUCTS = {
  "credit-pack-4": {
    credits: 4, // Internal: 4 credits = 2 letters
    priceId: process.env.STRIPE_PRICE_STARTER || "",
    name: "Starter Pack - 2 Letters",
    description: "Perfect for trying out Letter IRL",
  },
  "credit-pack-10": {
    credits: 10, // Internal: 10 credits = 5 letters
    priceId: process.env.STRIPE_PRICE_REGULAR || "",
    name: "Regular Pack - 5 Letters",
    description: "Most popular choice for regular letter senders",
  },
  "credit-pack-100": {
    credits: 100, // Internal: 100 credits = 50 letters
    priceId: process.env.STRIPE_PRICE_POWER || "",
    name: "Power Pack - 50 Letters",
    description: "Best value - 10% savings for power users",
  },
};

/**
 * Create a Stripe Checkout session for purchasing credits
 */
export async function createCheckoutSession(
  params: CheckoutSessionParams,
): Promise<CheckoutSessionResult> {
  try {
    const product = PRODUCTS[params.productId];

    if (!product) {
      return {
        success: false,
        error: `Invalid product ID: ${params.productId}`,
      };
    }

    // Validate that we have a price ID configured
    if (!product.priceId) {
      return {
        success: false,
        error: `Price ID not configured for product: ${params.productId}. Set STRIPE_PRICE_* environment variables.`,
      };
    }

    // Create Checkout Session using pre-created Stripe Price ID
    // Only include customer_email if it's a valid email address
    const isValidEmail = params.userEmail && params.userEmail.includes("@");
    const session = await getStripeClient().checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      ...(isValidEmail && { customer_email: params.userEmail }),
      client_reference_id: params.userId,
      line_items: [
        {
          price: product.priceId,
          quantity: 1,
        },
      ],
      metadata: {
        userId: params.userId,
        productId: params.productId,
        credits: product.credits.toString(),
      },
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
    });

    return {
      success: true,
      sessionId: session.id,
      sessionUrl: session.url || undefined,
    };
  } catch (error: any) {
    console.error("Failed to create Stripe Checkout session");
    return {
      success: false,
      error: error.message || "Failed to create checkout session",
    };
  }
}

/**
 * Verify Stripe webhook signature
 */
export function verifyWebhookSignature(
  payload: string | Buffer,
  signature: string,
): Stripe.Event | null {
  try {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "";

    if (!webhookSecret) {
      console.error("STRIPE_WEBHOOK_SECRET not configured");
      return null;
    }

    const event = getStripeClient().webhooks.constructEvent(
      payload,
      signature,
      webhookSecret,
    );

    return event;
  } catch (error: any) {
    console.error("Webhook signature verification failed");
    return null;
  }
}

/**
 * Process a successful checkout event
 */
export interface CheckoutCompletedData {
  userId: string;
  credits: number;
  productId: string;
  sessionId: string;
  amountPaid: number;
  customerEmail: string;
}

export async function extractCheckoutData(
  session: Stripe.Checkout.Session,
): Promise<CheckoutCompletedData | null> {
  try {
    const userId = session.client_reference_id || session.metadata?.userId;
    const credits = parseInt(session.metadata?.credits || "0", 10);
    const productId = session.metadata?.productId || "";
    const amountPaid = (session.amount_total || 0) / 100; // Convert from cents
    const customerEmail =
      session.customer_email || session.customer_details?.email || "";

    if (!userId || !credits || !productId) {
      console.error("Missing required metadata in checkout session");
      return null;
    }

    return {
      userId,
      credits,
      productId,
      sessionId: session.id,
      amountPaid,
      customerEmail,
    };
  } catch (error: any) {
    console.error("Failed to extract checkout data");
    return null;
  }
}
