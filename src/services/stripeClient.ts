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
/** The key the memoized client was built from. */
let stripeClientKey: string | null = null;

export function getStripeClient(): Stripe {
  const apiKey = process.env.STRIPE_SECRET_KEY;
  if (!apiKey) throw new Error('STRIPE_SECRET_KEY is not configured');
  // Keyed on the VALUE, not merely its presence. Memoizing on presence meant
  // removing the key threw while REPLACING it was a silent no-op, so a rotated
  // credential kept signing with the revoked one - and in the test lane every
  // suite that stubs a different key transacted against a client built from
  // the first (#278 review round 3).
  if (!stripeClient || stripeClientKey !== apiKey) {
    stripeClient = new Stripe(apiKey, {
      apiVersion: '2025-11-17.clover',
      timeout: 10_000,
      maxNetworkRetries: 1
    });
    stripeClientKey = apiKey;
  }
  return stripeClient;
}

/**
 * Per-request budget for calls with NO customer waiting - reconciliation,
 * refunds, session retrieval in maintenance. The shared client's 10s/1 bound
 * protects the interactive paths; inheriting it here silently cut background
 * work from stripe-node's 80s/2 default, and on the refund path that spends a
 * finite refund_attempts budget irreversibly BEFORE the Stripe call, each
 * premature timeout burned an attempt - five slow sweeps stranded a paid
 * order in refund_pending for manual action (#278 review round 4).
 */
export const BACKGROUND_REQUEST_OPTIONS = {
  timeout: 60_000,
  maxNetworkRetries: 2
} as const;

/** Test hook: force the next call to construct a fresh client. */
export function resetStripeClient(): void {
  stripeClient = null;
  stripeClientKey = null;
}
