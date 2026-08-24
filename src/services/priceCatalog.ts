/**
 * The resolved price catalog. Issue #275 stage A.
 *
 * Stripe charges what the Price object says. Before this, the amount we
 * recorded came from STRIPE_*_AMOUNT_CENTS - a second copy of the same figure,
 * with nothing keeping the two honest. Stage B compared them at checkout;
 * this removes the second copy entirely, so there is only ever one number.
 *
 * Loaded once at startup rather than read per request, for two reasons:
 *
 *  - `unit_amount` and `currency` are IMMUTABLE on an existing Price.
 *    PriceUpdateParams exposes neither, so Stripe offers no way to change
 *    them; a price change means creating a new Price and repointing
 *    STRIPE_*_PRICE_ID, which is a deploy. A value read at boot is therefore
 *    exactly as current as one read a millisecond ago - caching costs nothing
 *    here because there is nothing to go stale.
 *  - Stripe allocates read requests as an average of 500 PER TRANSACTION over
 *    a rolling 30 days, with a floor of 10,000 a month, and asks integrations
 *    to "avoid unnecessary load". Quotes vastly outnumber purchases in this
 *    product - people draft and preview far more often than they buy - so
 *    reading per quote would put a large numerator over a small denominator.
 *    Stripe's own guidance is to cache the price rather than re-fetch it on
 *    every visit.
 *
 * Removing the second copy also removes the crude cross-check it provided: a
 * mistyped price id used to be caught by its amount disagreeing. So the load
 * validates that each price is the RIGHT price rather than re-reading the same
 * number twice - active, sanely bounded, in the expected currency, and not the
 * same id used twice.
 */

import Stripe from 'stripe';
import { getStripeClient } from './stripeService.js';
import { writeDiagnostic } from '../utils/diagnosticLog.js';

export interface ResolvedPrice {
  readonly priceId: string;
  /** Recorded for operator diagnosis; not used as a gate. */
  readonly productId: string;
  readonly unitAmount: number;
  readonly currency: string;
}

/**
 * A band wide enough to never argue with real pricing, narrow enough that an
 * absurd figure cannot reach a customer. Catches a price id repointed at
 * something from an entirely different catalogue.
 */
const MIN_SANE_UNIT_AMOUNT = 50;
const MAX_SANE_UNIT_AMOUNT = 100_000;

let catalog: ReadonlyMap<string, ResolvedPrice> | null = null;
let failures: readonly string[] = [];

/** Test hook: drop the loaded catalog. */
export function resetPriceCatalog(): void {
  catalog = null;
  failures = [];
}

export function isPriceCatalogLoaded(): boolean {
  return catalog !== null && failures.length === 0;
}

/** Rule ids of anything that failed to load, for the server log. Never values. */
export function getPriceCatalogFailures(): readonly string[] {
  return failures;
}

/**
 * The resolved price, or null when the catalog never loaded or rejected it.
 * Null makes every caller's existing "not configured" guard fire, so an
 * unresolved price disables the purchase rather than transacting on a guess.
 */
export function getResolvedPrice(priceId: string): ResolvedPrice | null {
  if (!priceId) return null;
  return catalog?.get(priceId) ?? null;
}

function validate(
  priceId: string,
  price: Stripe.Price | undefined,
  expectedCurrency: string
): { resolved?: ResolvedPrice; failure?: string } {
  if (!price || typeof price !== 'object') return { failure: 'price.unreadable' };
  if (price.active !== true) return { failure: 'price.inactive' };

  const unitAmount = price.unit_amount;
  // null for tiered and metered prices, which this product does not sell and
  // could not reconcile a fixed amount against.
  if (!Number.isInteger(unitAmount) || unitAmount === null) {
    return { failure: 'price.no_unit_amount' };
  }
  if (unitAmount < MIN_SANE_UNIT_AMOUNT || unitAmount > MAX_SANE_UNIT_AMOUNT) {
    return { failure: 'price.amount_out_of_range' };
  }

  const currency = (price.currency || '').trim().toLowerCase();
  if (!currency) return { failure: 'price.no_currency' };
  if (currency !== expectedCurrency) return { failure: 'price.currency_mismatch' };

  const productId =
    typeof price.product === 'string' ? price.product : (price.product?.id ?? '');

  return {
    // Frozen so nothing downstream can mutate a shared figure. The one real
    // corruption path here is our own code holding a reference, not the memory.
    resolved: Object.freeze({ priceId, productId, unitAmount, currency })
  };
}

/**
 * Resolves every configured price id. Called once during startup; safe to call
 * again (it replaces the catalog wholesale).
 *
 * Never throws. A boot that cannot reach Stripe must still start and serve
 * /readyz and /healthz - it simply reports itself unready and refuses
 * purchases, which is a far better failure than a crash loop that cannot be
 * diagnosed.
 */
export async function loadPriceCatalog(
  priceIds: readonly string[],
  expectedCurrency = (process.env.STRIPE_CURRENCY || 'usd').trim().toLowerCase()
): Promise<void> {
  const unique = [...new Set(priceIds.filter(Boolean))];
  const resolved = new Map<string, ResolvedPrice>();
  const problems: string[] = [];

  // The same id configured for two products is a copy-paste slip that no
  // per-price check can see, because each lookup succeeds on its own.
  if (unique.length !== priceIds.filter(Boolean).length) {
    problems.push('price.duplicate_id');
  }

  for (const priceId of unique) {
    try {
      const price = await getStripeClient().prices.retrieve(priceId);
      const outcome = validate(priceId, price, expectedCurrency);
      if (outcome.resolved) {
        resolved.set(priceId, outcome.resolved);
      } else if (outcome.failure) {
        problems.push(outcome.failure);
      }
    } catch {
      // Includes the most likely real fault: an id that points at nothing, or
      // at something in a different Stripe account.
      problems.push('price.lookup_failed');
    }
  }

  catalog = resolved;
  failures = Object.freeze(problems);

  // What this process believes, in the log where operators already look. The
  // /readyz body cannot carry it: that endpoint is unauthenticated and its
  // contract is check names only, never values.
  writeDiagnostic(problems.length ? 'error' : 'info', 'stripe.price_catalog_loaded', {
    resolved: resolved.size,
    requested: unique.length,
    currency: expectedCurrency,
    failures: problems.join(',') || 'none',
    prices: [...resolved.values()]
      .map(p => `${p.priceId}=${p.unitAmount}${p.currency}`)
      .join(' ')
  });
}
