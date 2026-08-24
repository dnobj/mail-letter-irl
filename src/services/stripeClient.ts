/**
 * The one Stripe client. A leaf module - it imports nothing from src/ - so both
 * stripeService and priceCatalog can use it without the import cycle those two
 * briefly had (priceCatalog needed the client, stripeService needed the
 * catalog).
 *
 * The bounds are deliberate and load-bearing. stripe-node's defaults are an
 * 80-second timeout with 2 retries; on the boot-time catalog load that
 * compounded to a worst case near twenty minutes with the HTTP port unbound,
 * and on the checkout path it meant a hung Stripe held a paying customer for
 * over a minute (#277, #278 review). Ten seconds is far beyond Stripe's normal
 * latency, and one retry is safe everywhere this client is used: checkout
 * sessions carry idempotency keys, and every other call is a read.
 */

import Stripe from 'stripe';

let stripeClient: Stripe | null = null;

export function getStripeClient(): Stripe {
  const apiKey = process.env.STRIPE_SECRET_KEY;
  if (!apiKey) throw new Error('STRIPE_SECRET_KEY is not configured');
  stripeClient ??= new Stripe(apiKey, {
    apiVersion: '2025-11-17.clover',
    timeout: 10_000,
    maxNetworkRetries: 1
  });
  return stripeClient;
}

/** Test hook: force the next call to construct a fresh client. */
export function resetStripeClient(): void {
  stripeClient = null;
}
