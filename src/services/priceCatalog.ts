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
 * a cooldown - a transient Stripe blip at boot must not refuse purchases for
 * the life of the process.
 *
 * Deleting the env-var copy removed a crude cross-check: a mistyped price id
 * used to be caught by its amount disagreeing. So resolution validates that a
 * price is the RIGHT price instead - active, one-time, sanely bounded, in the
 * currency its own product expects, and not
 * shared with another product that charges a different thing.
 */

import type Stripe from 'stripe';
import { getStripeClient } from './stripeClient.js';
import {
  getConfiguredProducts,
  normalizedCurrency,
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
   * recurring price, wrong currency, absurd amount, a price id shared with a
   * product that charges something else, an id pointing at nothing). Anything
   * else is treated as transient by callers: checkout leaves the order pending
   * for retry rather than cancelling it.
   */
  readonly diagnosticClass: string;
}

/**
 * A band wide enough to never argue with real pricing, narrow enough that an
 * absurd figure cannot reach a customer - the catch for a price id repointed
 * at something from an entirely different catalogue.
 *
 * These are MINOR units (cents), and the defaults are calibrated for a
 * two-decimal currency: $0.50 to $1,000.00. That calibration cannot be made
 * universal by arithmetic - unit_amount is minor units, so ~₩126,000 is a
 * perfectly ordinary Power-pack price whose NUMBER is three orders of
 * magnitude larger than the equivalent in cents, and closing that gap needs an
 * exchange rate, not a decimal shift. Pretending otherwise would be a fake
 * fix.
 *
 * So the band is configurable instead, which is what the review actually asked
 * for - the fault was hard-coded bounds "with no way to configure either"
 * (#278 review round 2). A deployment in a zero- or three-decimal currency, or
 * one selling a tier above the ceiling, sets these; a two-decimal deployment
 * never touches them and sees exactly the previous 50..100_000.
 */
const DEFAULT_MIN_SANE_UNIT_AMOUNT = 50;
const DEFAULT_MAX_SANE_UNIT_AMOUNT = 100_000;

function boundFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function saneBand(): { min: number; max: number } {
  const min = boundFromEnv('STRIPE_PRICE_MIN_UNIT_AMOUNT', DEFAULT_MIN_SANE_UNIT_AMOUNT);
  const max = boundFromEnv('STRIPE_PRICE_MAX_UNIT_AMOUNT', DEFAULT_MAX_SANE_UNIT_AMOUNT);
  // A mis-set pair must not silently invert into a band nothing can satisfy.
  return min <= max ? { min, max } : { min: DEFAULT_MIN_SANE_UNIT_AMOUNT, max: DEFAULT_MAX_SANE_UNIT_AMOUNT };
}

/**
 * How long a failed product waits before the next attempt.
 *
 * A TRANSIENT failure retries on a flat short cooldown: it is expected to
 * clear on its own, and /readyz kicking a re-attempt is what lets a bad warmup
 * self-heal inside the readiness TTL instead of needing a redeploy.
 *
 * A TERMINAL failure (archived price, typo'd id, wrong currency) cannot clear
 * without a human, and a human changing it redeploys anyway - so retrying it
 * on the transient cadence just burns Stripe's read allocation. The first
 * revision did exactly that: a flat 30s retry forever is ~86,400 reads a month
 * per broken product against a 10,000/month floor, spent precisely when there
 * are no transactions earning allocation (#278 review round 2). Backing off to
 * a 15-minute ceiling keeps the eventual self-heal without the bill.
 */
const TRANSIENT_COOLDOWN_MS = 30_000;
const TERMINAL_COOLDOWN_BASE_MS = 30_000;
const TERMINAL_COOLDOWN_MAX_MS = 15 * 60_000;

/**
 * Per-request bounds for a price lookup, tighter than the shared client's.
 * A checkout or a quote may be waiting on this, and stripe-node's retry math
 * compounds: a hung lookup at the client's 10s/1-retry costs ~20.5s, and the
 * batch settles only when its slowest member does (#278 review round 2).
 */
const PRICE_LOOKUP_TIMEOUT_MS = 5_000;
const PRICE_LOOKUP_RETRIES = 1;

type PriceRetriever = (priceId: string) => Promise<Stripe.Price>;

/**
 * The outbound-call seam, following the RefundOperations precedent
 * (commerceService.ts): integration tests never mock the stripe module - they
 * substitute the boundary. Production default is the real client.
 */
function defaultRetriever(priceId: string): Promise<Stripe.Price> {
  return getStripeClient().prices.retrieve(
    priceId,
    {},
    { timeout: PRICE_LOOKUP_TIMEOUT_MS, maxNetworkRetries: PRICE_LOOKUP_RETRIES }
  );
}

let retrievePrice: PriceRetriever = defaultRetriever;

export function setPriceRetriever(retriever: PriceRetriever): void {
  retrievePrice = retriever;
}

interface AttemptState {
  /** Consecutive failed attempts, for the terminal backoff. */
  readonly failures: number;
  readonly nextAttemptAt: number;
}

const resolved = new Map<string, ResolvedPrice>();
const failures = new Map<string, PriceResolutionFailure>();
const attempts = new Map<string, AttemptState>();
/** The running batch and which products it covers. */
let inFlight: { promise: Promise<void>; codes: Set<string> } | null = null;

/** Test hook: back to a cold, never-attempted catalog and the real retriever. */
export function resetPriceCatalog(): void {
  resolved.clear();
  failures.clear();
  attempts.clear();
  inFlight = null;
  retrievePrice = defaultRetriever;
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

/**
 * True when nothing has been attempted yet for any enabled product - the
 * moments between the port binding and the warmup landing. Readiness treats
 * that differently from a real fault: it is not yet news (#278 review).
 */
export function isPriceCatalogCold(): boolean {
  return getConfiguredProducts().every(product => !attempts.has(product.productCode));
}

/**
 * Product codes whose price id is shared with a product that charges something
 * different. Per-price validation cannot see this: every lookup succeeds and
 * every field is valid - the fault is the PAIRING.
 *
 * The one legitimate overlap is Pay & Send letter and postcard on a single
 * Price. Everything else misprices at least one side: two pack tiers sharing
 * an id sells Power at Starter's price, and a pack sharing with Pay & Send
 * sells one letter for the price of fifty. The first revision only counted
 * pack-to-pack and so passed the second, charging $90.00 for one letter with
 * readiness green (#278 review round 2).
 */
function sharedPriceOffenders(products: readonly ConfiguredProduct[]): Set<string> {
  const byPriceId = new Map<string, ConfiguredProduct[]>();
  for (const product of products) {
    if (!product.priceId) continue;
    const sharers = byPriceId.get(product.priceId);
    if (sharers) sharers.push(product);
    else byPriceId.set(product.priceId, [product]);
  }

  const offenders = new Set<string>();
  for (const sharers of byPriceId.values()) {
    if (sharers.length < 2) continue;
    if (sharers.every(product => product.group === 'jit')) continue;
    for (const product of sharers) offenders.add(product.productCode);
  }
  return offenders;
}

function validate(
  product: ConfiguredProduct,
  price: Stripe.Price | undefined
): ResolvedPrice | string {
  if (!price || typeof price !== 'object') return 'price.unreadable';
  if (price.active !== true) return 'price.inactive';

  // A recurring Price passes every other rule here and then fails at the far
  // end: checkout.sessions.create with mode:'payment' rejects it, but only
  // AFTER the authoritative order row is written - so the order strands in
  // checkout_creation_failed while readiness reports green. That is exactly
  // the false green this check exists to prevent (#278 review round 2).
  if (price.recurring || (price.type && price.type !== 'one_time')) {
    return 'price.not_one_time';
  }

  const currency = normalizedCurrency(price.currency, '');
  if (!currency) return 'price.no_currency';

  const unitAmount = price.unit_amount;
  // null first: tiered and metered prices report no unit amount, and the check
  // doubles as the narrowing TypeScript needs below.
  if (unitAmount === null || unitAmount === undefined || !Number.isInteger(unitAmount)) {
    return 'price.no_unit_amount';
  }
  const band = saneBand();
  if (unitAmount < band.min || unitAmount > band.max) {
    return 'price.amount_out_of_range';
  }

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

/** Drop failure and attempt state for products this deployment no longer sells. */
function pruneUnconfigured(products: readonly ConfiguredProduct[]): void {
  const activeCodes = new Set(products.map(product => product.productCode));
  for (const code of [...failures.keys()]) {
    if (!activeCodes.has(code)) failures.delete(code);
  }
  for (const code of [...attempts.keys()]) {
    if (!activeCodes.has(code)) attempts.delete(code);
  }
}

function recordFailure(productCode: string, rule: string, diagnosticClass: string, now: number): void {
  failures.set(
    productCode,
    Object.freeze({ productCode, rule, diagnosticClass })
  );
  const priorFailures = attempts.get(productCode)?.failures ?? 0;
  const consecutive = priorFailures + 1;
  const cooldown =
    diagnosticClass === 'configuration_error'
      ? Math.min(TERMINAL_COOLDOWN_BASE_MS * 2 ** (consecutive - 1), TERMINAL_COOLDOWN_MAX_MS)
      : TRANSIENT_COOLDOWN_MS;
  attempts.set(productCode, { failures: consecutive, nextAttemptAt: now + cooldown });
}

async function attemptResolution(due: readonly ConfiguredProduct[]): Promise<void> {
  const products = getConfiguredProducts();
  const offenders = sharedPriceOffenders(products);
  const now = Date.now();
  // Stamp the attempt BEFORE awaiting, so a concurrent caller arriving mid
  // batch sees the product as not-due rather than starting a second lookup.
  for (const product of due) {
    attempts.set(product.productCode, {
      failures: attempts.get(product.productCode)?.failures ?? 0,
      nextAttemptAt: now + TRANSIENT_COOLDOWN_MS
    });
  }

  const outcomes = await Promise.allSettled(
    due.map(async product => {
      if (!product.priceId) {
        return { product, failure: 'price.id_not_configured', diagnosticClass: 'configuration_error' };
      }
      if (offenders.has(product.productCode)) {
        return { product, failure: 'price.shared_between_products', diagnosticClass: 'configuration_error' };
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

  const settledAt = Date.now();
  for (const settled of outcomes) {
    // allSettled never rejects here - the map callback catches - but the type
    // demands the check.
    if (settled.status !== 'fulfilled') continue;
    const outcome = settled.value;
    if ('price' in outcome && outcome.price) {
      resolved.set(outcome.product.productCode, outcome.price);
      failures.delete(outcome.product.productCode);
      attempts.delete(outcome.product.productCode);
    } else if ('failure' in outcome && outcome.failure) {
      recordFailure(
        outcome.product.productCode,
        outcome.failure,
        outcome.diagnosticClass ?? 'provider_error',
        settledAt
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
 * Resolve every configured product that is not yet resolved and is due for an
 * attempt. Idempotent and cheap after full success; failed products re-attempt
 * past their cooldown. Never throws - callers read the outcome through the
 * accessors, and an unpriceable product refuses its purchase through the
 * existing guards.
 *
 * Pass the productCode you actually need. A caller whose own product is
 * already priced returns immediately instead of joining a batch that is
 * blocked on somebody else's hanging lookup - the first revision checked
 * inFlight before looking at anything, so one hung Pay & Send price stalled
 * every pack checkout and every quote for the length of the batch (#278
 * review round 2).
 */
export async function ensurePriceCatalog(productCode?: string): Promise<void> {
  // A priced product answers from memory and never waits - this is the line
  // that fixes the reviewed stall, and it doubles as the fast path for the
  // common warm case (every quote, every checkout) since it skips rebuilding
  // the product list.
  if (productCode && resolved.has(productCode)) return;

  // A running batch already covers what this caller needs, so wait for it.
  // This must be checked BEFORE the due-list: attemptResolution stamps its
  // members' next-attempt time up front to keep a concurrent caller from
  // starting a duplicate lookup, which also makes them look not-due - so
  // testing dueness first would hand the very first customer after boot an
  // instant refusal while the warmup that would have priced their product was
  // still in flight.
  //
  // Scoped to the batch's members: joining a batch that will not resolve YOUR
  // product buys nothing but its latency. (For the reviewed case - a priced
  // product stalled behind someone else's hanging lookup - the check above
  // already suffices; the two overlap deliberately.)
  if (inFlight && (!productCode || inFlight.codes.has(productCode))) {
    return inFlight.promise;
  }

  const products = getConfiguredProducts();
  pruneUnconfigured(products);

  const now = Date.now();
  const due = products.filter(product => {
    if (resolved.has(product.productCode)) return false;
    const state = attempts.get(product.productCode);
    return !state || state.nextAttemptAt <= now;
  });
  if (due.length === 0) return;

  // Something is due that the running batch does not cover. Joining it is
  // still better than starting a second concurrent batch against Stripe; the
  // next call picks the stragglers up.
  if (inFlight) return inFlight.promise;

  const promise = attemptResolution(due)
    .catch(() => undefined)
    .finally(() => {
      inFlight = null;
    });
  inFlight = { promise, codes: new Set(due.map(product => product.productCode)) };
  return promise;
}
