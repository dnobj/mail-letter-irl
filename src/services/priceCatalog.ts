/**
 * The resolved price catalog. Issue #275 stage A.
 *
 * Stripe charges what the Price object says. Before this, the amount we
 * recorded came from STRIPE_*_AMOUNT_CENTS - a second copy of the same figure,
 * with nothing keeping the two honest. Stage B compared them at checkout; this
 * removes the second copy entirely, so there is only ever one number.
 *
 * Resolution is LAZY with an eager warmup, not a blocking boot step. Every
 * async path that needs a price awaits ensurePriceCatalog() itself, so the
 * maintenance cron, the stdio server, the flow harness, and any entrypoint not
 * yet written all work without remembering a bootstrap call - the mistake the
 * first version of this file made, which priced every product at zero in two
 * of the three deployed processes (#278 review). The HTTP server still kicks a
 * warmup, but AFTER the port binds, so a Stripe outage can never hold /healthz
 * closed.
 *
 * A resolved product memoizes for the process lifetime: unit_amount and
 * currency are IMMUTABLE on an existing Price (PriceUpdateParams exposes
 * neither), and a price change is a new Price plus a redeploy, so memoized
 * forever is exactly as fresh as re-read. Stripe also allocates reads as an
 * average of 500 per TRANSACTION (floor 10k/month), and quotes vastly
 * outnumber purchases here, so reads must not scale with quoting. An
 * UNRESOLVED product is the opposite: it re-attempts on the next ensure, past
 * a short cooldown - a transient Stripe blip at boot must not refuse purchases
 * for the life of the process.
 *
 * Deleting the env-var copy removed a crude cross-check: a mistyped price id
 * used to be caught by its amount disagreeing. So resolution validates that a
 * price is the RIGHT price instead - active, sanely bounded, in the currency
 * its own product expects, and not shared between pack tiers (which differ by
 * design; a shared id is the Power-pack-at-$5 missell). The JIT letter and
 * postcard MAY legitimately share one Price.
 */

import type Stripe from 'stripe';
import { getStripeClient } from './stripeClient.js';
import {
  getConfiguredProducts,
  type ConfiguredProduct
} from '../config/products.js';
import { classifyDiagnosticError, writeDiagnostic } from '../utils/diagnosticLog.js';

export interface ResolvedPrice {
  readonly productCode: string;
  readonly priceId: string;
  readonly unitAmount: number;
  readonly currency: string;
}

export interface PriceResolutionFailure {
  readonly productCode: string;
  readonly rule: string;
  /**
   * configuration_error means a human must change something (archived price,
   * wrong currency, absurd amount, pack tiers sharing an id, id pointing at
   * nothing). Anything else is treated as transient by callers: checkout
   * leaves the order pending for retry rather than cancelling it.
   */
  readonly diagnosticClass: string;
}

/**
 * A band wide enough to never argue with real pricing, narrow enough that an
 * absurd figure cannot reach a customer - the catch for a price id repointed
 * at something from an entirely different catalogue.
 */
const MIN_SANE_UNIT_AMOUNT = 50;
const MAX_SANE_UNIT_AMOUNT = 100_000;

/** How long a failed resolution waits before the next attempt. */
const RETRY_COOLDOWN_MS = 30_000;

type PriceRetriever = (priceId: string) => Promise<Stripe.Price>;

/**
 * The outbound-call seam, following the RefundOperations precedent
 * (commerceService.ts): integration tests never mock the stripe module - they
 * substitute the boundary. Production default is the real client.
 */
let retrievePrice: PriceRetriever = priceId => getStripeClient().prices.retrieve(priceId);

export function setPriceRetriever(retriever: PriceRetriever): void {
  retrievePrice = retriever;
}

const resolved = new Map<string, ResolvedPrice>();
const failures = new Map<string, PriceResolutionFailure>();
let lastAttemptAt = 0;
let inFlight: Promise<void> | null = null;

/** Test hook: back to a cold, never-attempted catalog and the real retriever. */
export function resetPriceCatalog(): void {
  resolved.clear();
  failures.clear();
  lastAttemptAt = 0;
  inFlight = null;
  retrievePrice = priceId => getStripeClient().prices.retrieve(priceId);
}

export function getResolvedPriceForProduct(productCode: string): ResolvedPrice | null {
  return resolved.get(productCode) ?? null;
}

export function getPriceResolutionFailure(productCode: string): PriceResolutionFailure | null {
  return failures.get(productCode) ?? null;
}

/** Product-coded failure list; names and rule ids only, never amounts. */
export function getPriceCatalogFailures(): PriceResolutionFailure[] {
  return [...failures.values()];
}

/**
 * Every ENABLED product that cannot currently be priced, with why. This is the
 * readiness question, and it is deliberately not "are there failures": a cold
 * catalog that has never attempted has no failures and nothing resolved - and
 * an instance in that state refuses every purchase, which must read as
 * unready, not as a false green (#278 review, twice).
 */
export function getUnpricedProducts(): PriceResolutionFailure[] {
  return getConfiguredProducts().flatMap(product => {
    if (resolved.has(product.productCode)) return [];
    const failure = failures.get(product.productCode);
    if (failure) return [failure];
    return [
      {
        productCode: product.productCode,
        rule: 'price.not_resolved',
        // Not yet attempted or attempt in flight - transient by definition.
        diagnosticClass: 'provider_error'
      }
    ];
  });
}

function validate(
  product: ConfiguredProduct,
  price: Stripe.Price | undefined
): ResolvedPrice | string {
  if (!price || typeof price !== 'object') return 'price.unreadable';
  if (price.active !== true) return 'price.inactive';

  const unitAmount = price.unit_amount;
  // null first: tiered and metered prices report no unit amount, and the check
  // doubles as the narrowing TypeScript needs below.
  if (unitAmount === null || unitAmount === undefined || !Number.isInteger(unitAmount)) {
    return 'price.no_unit_amount';
  }
  if (unitAmount < MIN_SANE_UNIT_AMOUNT || unitAmount > MAX_SANE_UNIT_AMOUNT) {
    return 'price.amount_out_of_range';
  }

  const currency = (price.currency || '').trim().toLowerCase();
  if (!currency) return 'price.no_currency';
  // Each product validates against ITS OWN expected currency - packs against
  // STRIPE_CURRENCY, Pay & Send against JIT_CURRENCY - so a deployment selling
  // the two in different currencies is a supported configuration, not a fault
  // (#278 review).
  if (currency !== product.expectedCurrency) return 'price.currency_mismatch';

  // Frozen so nothing downstream can mutate a shared figure. The realistic
  // corruption path is our own code holding a reference, not the memory.
  return Object.freeze({
    productCode: product.productCode,
    priceId: product.priceId,
    unitAmount,
    currency
  });
}

async function attemptResolution(): Promise<void> {
  const products = getConfiguredProducts();
  const pending = products.filter(product => !resolved.has(product.productCode));
  // A product that stopped being configured (JIT switched off) must not keep a
  // stale failure pinning readiness.
  const activeCodes = new Set(products.map(product => product.productCode));
  for (const code of [...failures.keys()]) {
    if (!activeCodes.has(code)) failures.delete(code);
  }
  if (pending.length === 0) return;

  // Pack tiers sharing one price id is a copy-paste slip that would missell -
  // Power at Starter's price. Refuse to price BOTH so the mistake cannot reach
  // a customer. (Per-price validation cannot see this: each lookup succeeds.)
  const packIdCounts = new Map<string, number>();
  for (const product of products) {
    if (product.group === 'pack' && product.priceId) {
      packIdCounts.set(product.priceId, (packIdCounts.get(product.priceId) ?? 0) + 1);
    }
  }

  const outcomes = await Promise.allSettled(
    pending.map(async product => {
      if (!product.priceId) {
        return { product, failure: 'price.id_not_configured', diagnosticClass: 'configuration_error' };
      }
      if (product.group === 'pack' && (packIdCounts.get(product.priceId) ?? 0) > 1) {
        return { product, failure: 'price.shared_between_pack_tiers', diagnosticClass: 'configuration_error' };
      }
      try {
        const price = await retrievePrice(product.priceId);
        const outcome = validate(product, price);
        if (typeof outcome === 'string') {
          return { product, failure: outcome, diagnosticClass: 'configuration_error' };
        }
        return { product, price: outcome };
      } catch (error) {
        // resource_missing (a typo'd id) needs a human; a connection error
        // retries. Collapsing them sent operators to the wrong subsystem in
        // #213, so carry the class.
        const diagnosticClass = classifyDiagnosticError(error, 'provider_error');
        const terminal = diagnosticClass === 'resource_missing';
        return {
          product,
          failure: 'price.lookup_failed',
          diagnosticClass: terminal ? 'configuration_error' : diagnosticClass
        };
      }
    })
  );

  for (const settled of outcomes) {
    // allSettled never rejects here - the map callback catches - but the type
    // demands the check.
    if (settled.status !== 'fulfilled') continue;
    const outcome = settled.value;
    if ('price' in outcome && outcome.price) {
      resolved.set(outcome.product.productCode, outcome.price);
      failures.delete(outcome.product.productCode);
    } else if ('failure' in outcome && outcome.failure) {
      failures.set(
        outcome.product.productCode,
        Object.freeze({
          productCode: outcome.product.productCode,
          rule: outcome.failure,
          diagnosticClass: outcome.diagnosticClass ?? 'provider_error'
        })
      );
    }
  }

  writeDiagnostic(failures.size ? 'error' : 'info', 'stripe.price_catalog_resolved', {
    resolved: resolved.size,
    requested: products.length,
    failures:
      [...failures.values()].map(f => `${f.productCode}:${f.rule}`).join(' ') || 'none',
    prices: [...resolved.values()]
      .map(p => `${p.productCode}=${p.unitAmount}${p.currency}`)
      .join(' ')
  });
}

/**
 * Resolve every configured product that is not yet resolved. Idempotent and
 * cheap after full success; failed products re-attempt past the cooldown.
 * Never throws - callers read the outcome through the accessors, and an
 * unpriceable product refuses its purchase through the existing guards.
 */
export async function ensurePriceCatalog(): Promise<void> {
  if (inFlight) return inFlight;

  const products = getConfiguredProducts();
  const unresolvedExists = products.some(product => !resolved.has(product.productCode));
  if (!unresolvedExists) {
    // Still prune failures for products no longer configured.
    const activeCodes = new Set(products.map(product => product.productCode));
    for (const code of [...failures.keys()]) {
      if (!activeCodes.has(code)) failures.delete(code);
    }
    return;
  }
  if (Date.now() - lastAttemptAt < RETRY_COOLDOWN_MS) return;

  lastAttemptAt = Date.now();
  inFlight = attemptResolution()
    .catch(() => undefined)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
