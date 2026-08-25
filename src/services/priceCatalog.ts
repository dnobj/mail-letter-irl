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
 * currency its own product expects, and not shared with another product that
 * charges a different thing.
 */

import type Stripe from 'stripe';
import { getStripeClient } from './stripeClient.js';
import {
  PACK_CREDITS_BY_PRODUCT,
  configuredPriceIdFor,
  getConfiguredProducts,
  normalizedCurrency,
  type ConfiguredProduct
} from '../config/products.js';
import {
  classifyDiagnosticError,
  isTerminalDiagnosticClass,
  writeDiagnostic
} from '../utils/diagnosticLog.js';

/** Injectable so the backoff tests are not at the mercy of real randomness. */
let jitter: () => number = Math.random;

export function setCooldownJitter(source: () => number): void {
  jitter = source;
}

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
   * The TRUE class of the fault - `configuration_error` for a rule this module
   * enforces (archived, recurring, wrong currency, absurd amount, a shared
   * price id), or the Stripe error's own class for a failed lookup. An earlier
   * revision overwrote `resource_missing` with `configuration_error` on the
   * grounds that both need a human, which threw away the single most useful
   * thing an operator could be told about a typo'd price id - the #213 mislabel
   * reintroduced by the mechanism written to prevent it (#278 review round 3).
   */
  readonly diagnosticClass: string;
  /**
   * Whether a human must act. Carried as its own fact rather than re-derived
   * from the class by every consumer: it decides whether an order is cancelled
   * or left pending, whether a paid webhook retries or books unmatched money,
   * and how hard to retry Stripe.
   */
  readonly terminal: boolean;
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

/**
 * Strict: the WHOLE value must be a positive integer. `Number.parseInt` stops
 * at the first non-digit, so it reads the very form this file's own comment
 * prints - `100_000` - as 100, which would collapse the band and fail every
 * real price as a terminal configuration fault (#278 review round 3).
 * Anything rejected is logged, because a silently discarded bound leaves an
 * operator staring at `price.amount_out_of_range` for an amount that is inside
 * the bounds they set.
 */
function boundFromEnv(name: string, fallback: number, env: NodeJS.ProcessEnv): number | null {
  const raw = (env[name] ?? '').trim();
  if (!raw) return null;
  if (!/^[0-9]+$/.test(raw)) {
    writeDiagnostic('error', 'stripe.price_band_ignored', { name, reason: 'not_an_integer' });
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    writeDiagnostic('error', 'stripe.price_band_ignored', { name, reason: 'not_positive' });
    return fallback;
  }
  return parsed;
}

export function saneBand(env: NodeJS.ProcessEnv = process.env): { min: number; max: number } {
  const configuredMin = boundFromEnv('STRIPE_PRICE_MIN_UNIT_AMOUNT', DEFAULT_MIN_SANE_UNIT_AMOUNT, env);
  const configuredMax = boundFromEnv('STRIPE_PRICE_MAX_UNIT_AMOUNT', DEFAULT_MAX_SANE_UNIT_AMOUNT, env);
  const min = configuredMin ?? DEFAULT_MIN_SANE_UNIT_AMOUNT;
  const max = configuredMax ?? DEFAULT_MAX_SANE_UNIT_AMOUNT;
  if (min <= max) return { min, max };

  // The bounds invert. Which one wins depends on where the contradiction came
  // from: a CONFIGURED bound colliding with the OTHER SIDE'S DEFAULT is not an
  // operator error - the defaults are calibrated for a two-decimal currency,
  // and the entire reason the knobs exist is deployments where that
  // calibration is wrong. The previous shape reverted BOTH bounds, i.e. it
  // discarded the operator's only configured value in favour of the default it
  // conflicted with, and enforced nothing they asked for (#278 review r4).
  if (configuredMin === null && configuredMax !== null) {
    // Only the ceiling was configured, below the default floor (a zero-decimal
    // ceiling like JPY 40). Honor the ceiling; the floor falls away to 1.
    writeDiagnostic('warn', 'stripe.price_band_ignored', {
      name: 'STRIPE_PRICE_MIN_UNIT_AMOUNT',
      reason: 'default_floor_above_configured_ceiling'
    });
    return { min: 1, max };
  }
  if (configuredMax === null && configuredMin !== null) {
    writeDiagnostic('warn', 'stripe.price_band_ignored', {
      name: 'STRIPE_PRICE_MAX_UNIT_AMOUNT',
      reason: 'default_ceiling_below_configured_floor'
    });
    return { min, max: Number.MAX_SAFE_INTEGER };
  }
  // BOTH were configured and they contradict each other: no way to know which
  // is the typo, so revert both - loudly.
  writeDiagnostic('error', 'stripe.price_band_ignored', { name: 'both', reason: 'min_above_max' });
  return { min: DEFAULT_MIN_SANE_UNIT_AMOUNT, max: DEFAULT_MAX_SANE_UNIT_AMOUNT };
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
const TERMINAL_COOLDOWN_BASE_MS = 30_000;
/**
 * Transient failures start their ladder at TWO seconds, not thirty. Readiness
 * holds an unready verdict for one second and the docblock there promises a
 * failed warmup "self-heals within the readiness TTL" - with a 30s first
 * cooldown that promise was arithmetically false, and a one-second Stripe blip
 * during warmup refused every purchase of the affected products for ~30s
 * (origin/dev never cached a failed lookup at all). Two seconds keeps the
 * fast self-heal; the ladder doubling toward the 5-minute ceiling keeps a
 * real outage from being hammered (#278 review round 4).
 */
const TRANSIENT_COOLDOWN_BASE_MS = 2_000;
/**
 * Transient failures back off too, just not as far. The previous revision gave
 * them a FLAT 30s forever, which is only safe if every permanent fault is
 * classed terminal - and only `resource_missing` was, so a revoked key or a
 * wrong-account price id (both permanent, neither `resource_missing`) retried
 * twice a minute indefinitely: ~86,400 reads a month per product, the exact
 * bill the terminal backoff was added to prevent (#278 review round 3). A
 * 5-minute ceiling still self-heals a real blip quickly.
 */
const TRANSIENT_COOLDOWN_MAX_MS = 5 * 60_000;
const TERMINAL_COOLDOWN_MAX_MS = 15 * 60_000;
/**
 * Up to a second of spread, following letterJobService's retry policy. Without
 * it every replica that booted together re-hits Stripe for the same broken
 * price in lockstep - a synchronised burst against the read floor.
 */
const COOLDOWN_JITTER_MS = 1_000;

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

/**
 * Opt back in to the real retriever after a reset. Exists so ONE suite can
 * exercise defaultRetriever itself - its per-request timeout and retry bounds
 * are load-bearing and otherwise unobservable, because every other suite
 * substitutes the seam. Safe only where the stripe module is mocked.
 */
export function useDefaultPriceRetriever(): void {
  retrievePrice = defaultRetriever;
}

interface AttemptState {
  /** Consecutive failures OF THE SAME KIND, for the backoff ladder. */
  readonly failures: number;
  readonly nextAttemptAt: number;
  /** Which ladder those failures were counted on. */
  readonly terminal: boolean;
  /**
   * The price id the failure was recorded against. Cooldowns used to survive a
   * repoint: an operator who fixed the configuration still waited out up to 15
   * minutes of 503 on a verdict computed from the OLD id, because neither
   * failures nor attempts carried enough to detect their own staleness (#278
   * review round 4).
   */
  readonly priceId: string;
}

const resolved = new Map<string, ResolvedPrice>();
const failures = new Map<string, PriceResolutionFailure>();
const attempts = new Map<string, AttemptState>();
/**
 * The lookup currently in flight for each product. Replaces the single shared
 * batch slot: with one slot, a due product not covered by the running batch
 * either waited out a batch that never touched its price id, or - after a
 * bounded number of waits - returned silently unresolved with no failure
 * recorded, refusing a correctly configured purchase (#278 review round 4).
 * Per-product flights mean a caller either awaits the flight that IS resolving
 * its product or starts one; there is no foreign batch to wait behind.
 */
const inFlight = new Map<string, Promise<void>>();
/**
 * Bumped by resetPriceCatalog. A lookup already in flight when the catalog is
 * reset must not write its outcome into the freshly cleared maps, nor delete a
 * flight entry that now belongs to a newer lookup.
 */
let generation = 0;

/**
 * Thrown by the retriever resetPriceCatalog installs. Deliberately NOT
 * swallowed like a provider failure: the lookup catch rethrows it, so a suite
 * that forgot setPriceRetriever fails loudly instead of recording something
 * byte-for-byte indistinguishable from a Stripe outage - which is what the
 * previous "fail loudly" attempt actually produced, because its throw landed
 * in the same catch as a network error (#278 review round 4).
 */
export class PriceRetrieverMissingError extends Error {
  constructor() {
    super(
      'priceCatalog: no retriever injected after resetPriceCatalog(). ' +
        'Call setPriceRetriever() - tests must never reach the real Stripe API.'
    );
    this.name = 'PriceRetrieverMissingError';
  }
}

/** Test hook: back to a cold, never-attempted catalog with no live retriever. */
export function resetPriceCatalog(): void {
  resolved.clear();
  failures.clear();
  attempts.clear();
  inFlight.clear();
  generation += 1;
  jitter = () => 0;
  retrievePrice = () => {
    throw new PriceRetrieverMissingError();
  };
}

/**
 * The two-source agreement test the deleted STRIPE_*_AMOUNT_CENTS variables
 * used to provide, rebuilt from data that never leaves the repo. A transposed
 * pair of price env vars (STRIPE_PRICE_STARTER <-> STRIPE_PRICE_POWER) passes
 * every per-price rule - both ids are distinct, active, one-time and in band -
 * and since order.amount_cents is now WRITTEN from the resolved price, the
 * paid-amount comparison and reconciliation compare the price against itself
 * and can never fire for it. Result: 100 credits sold for $5.00 with /readyz
 * green (#278 review round 4, the headline finding).
 *
 * Credits are the second source: they live in the static product table. Two
 * invariants any sane tier pricing satisfies and any transposition violates:
 * more credits must cost strictly more in total, and never more PER credit
 * (bulk never gets worse). Both members of a violating pair are refused - the
 * data cannot say which side is the wrong one.
 *
 * Derived at READ time over the full resolved set, never enforced by revoking
 * memos at commit time. Commit-time revocation was order-dependent: with
 * transposed env vars the Power tier could settle LAST - alone, its ordering
 * partners already revoked - see no pair to violate, and survive at the
 * Starter's $5.00 for 100 credits; and making the revocation sticky instead
 * deadlocked a PARTIALLY-fixed configuration, because the untouched tiers'
 * failure records never pruned. A derived verdict is order-independent and
 * heals the instant re-resolution replaces the offending memo (#278 round 4).
 */
function packOrderingOffenders(): Set<string> {
  const tiers = [...resolved.values()]
    .filter(memo => PACK_CREDITS_BY_PRODUCT[memo.productCode] !== undefined)
    .sort(
      (a, b) => PACK_CREDITS_BY_PRODUCT[a.productCode] - PACK_CREDITS_BY_PRODUCT[b.productCode]
    );

  const offenders = new Set<string>();
  for (let i = 1; i < tiers.length; i += 1) {
    const small = tiers[i - 1];
    const large = tiers[i];
    if (small.currency !== large.currency) continue; // packs share one currency by rule
    const creditsSmall = PACK_CREDITS_BY_PRODUCT[small.productCode];
    const creditsLarge = PACK_CREDITS_BY_PRODUCT[large.productCode];
    const totalOrdered = small.unitAmount < large.unitAmount;
    // small/creditsSmall >= large/creditsLarge, cross-multiplied to stay integral.
    const perCreditOrdered = small.unitAmount * creditsLarge >= large.unitAmount * creditsSmall;
    if (!totalOrdered || !perCreditOrdered) {
      offenders.add(small.productCode);
      offenders.add(large.productCode);
    }
  }
  return offenders;
}

function orderingFailure(productCode: string): PriceResolutionFailure {
  return Object.freeze({
    productCode,
    rule: 'price.pack_tier_ordering',
    diagnosticClass: 'configuration_error',
    terminal: true
  });
}

export function getResolvedPriceForProduct(productCode: string): ResolvedPrice | null {
  const memo = resolved.get(productCode);
  if (!memo) return null;
  if (packOrderingOffenders().has(productCode)) return null;
  return memo;
}

export function getPriceResolutionFailure(productCode: string): PriceResolutionFailure | null {
  // A resolved-but-inconsistent tier has no stored failure; synthesize the
  // ordering verdict so the checkout guards see WHY it is refused (terminal:
  // a human must repoint an env var; retrying cannot reorder the table).
  if (resolved.has(productCode) && packOrderingOffenders().has(productCode)) {
    return orderingFailure(productCode);
  }
  return failures.get(productCode) ?? null;
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
    const memo = resolved.get(product.productCode);
    // A memo counts only if it describes the price id configured NOW. Bare
    // membership let a repointed id read as priced: /readyz reported ok AND,
    // because the kick there is gated on !pricesOk, suppressed the very
    // re-attempt that would have detected the repoint (#278 review round 4).
    if (memo && memo.priceId === product.priceId) {
      // Resolved, current - but a tier in an inconsistent pack table is still
      // unsellable, and readiness must say so.
      if (packOrderingOffenders().has(product.productCode)) {
        return [orderingFailure(product.productCode)];
      }
      return [];
    }
    const failure = failures.get(product.productCode);
    if (failure) return [failure];
    return [
      {
        productCode: product.productCode,
        rule: 'price.not_resolved',
        // Not yet attempted or attempt in flight - transient by definition.
        diagnosticClass: 'provider_error',
        terminal: false
      }
    ];
  });
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
  price: Stripe.Price | undefined,
  band: { min: number; max: number }
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
  // The band arrives as a parameter, computed once per trigger: calling
  // saneBand() per price re-read the env three to five times per batch and
  // re-logged any discarded bound each time (#278 review round 4).
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

/**
 * Drop state for products this deployment no longer sells, and any state
 * recorded against a price id that is no longer the configured one - memos,
 * failures and cooldowns alike. `resolved` used to be the only map checked
 * for staleness, so an operator who FIXED the configuration still waited out
 * the old id's cooldown, up to the 15-minute terminal ceiling, with /readyz
 * at 503 the whole time (#278 review round 4).
 */
function pruneStale(products: readonly ConfiguredProduct[]): void {
  const configured = new Map(products.map(product => [product.productCode, product.priceId]));
  for (const [code, state] of [...attempts.entries()]) {
    if (configured.get(code) !== state.priceId) {
      attempts.delete(code);
      failures.delete(code);
    }
  }
  for (const code of [...failures.keys()]) {
    if (!configured.has(code)) failures.delete(code);
  }
  for (const [code, memo] of [...resolved.entries()]) {
    if (configured.get(code) !== memo.priceId) resolved.delete(code);
  }
}

function recordFailure(
  productCode: string,
  priceId: string,
  rule: string,
  diagnosticClass: string,
  now: number
): void {
  const terminal = isTerminalDiagnosticClass(diagnosticClass);
  failures.set(
    productCode,
    Object.freeze({ productCode, rule, diagnosticClass, terminal })
  );
  // Count consecutive failures of the SAME kind. Sharing one counter meant a
  // five-minute Stripe outage could leave it at ~10, so the FIRST terminal
  // fault after it started at the 15-minute ceiling - and an operator who then
  // un-archives the Price in Stripe (no redeploy) waits out that ceiling with
  // production refusing every purchase (#278 review round 3).
  const prior = attempts.get(productCode);
  const consecutive = prior && prior.terminal === terminal ? prior.failures + 1 : 1;
  const base = terminal ? TERMINAL_COOLDOWN_BASE_MS : TRANSIENT_COOLDOWN_BASE_MS;
  const ceiling = terminal ? TERMINAL_COOLDOWN_MAX_MS : TRANSIENT_COOLDOWN_MAX_MS;
  const cooldown =
    Math.min(base * 2 ** (consecutive - 1), ceiling) +
    Math.floor(jitter() * COOLDOWN_JITTER_MS);
  attempts.set(productCode, { failures: consecutive, nextAttemptAt: now + cooldown, terminal, priceId });
}

/** Resolve ONE product's price and commit the outcome, generation-guarded. */
async function resolveOne(
  product: ConfiguredProduct,
  isOffender: boolean,
  band: { min: number; max: number },
  startedGen: number
): Promise<void> {
  const commitFailure = (rule: string, diagnosticClass: string): void => {
    if (generation !== startedGen) return;
    recordFailure(product.productCode, product.priceId, rule, diagnosticClass, Date.now());
  };

  if (!product.priceId) {
    return commitFailure('price.id_not_configured', 'configuration_error');
  }
  if (isOffender) {
    return commitFailure('price.shared_between_products', 'configuration_error');
  }

  let price: Stripe.Price;
  try {
    price = await retrievePrice(product.priceId);
  } catch (error) {
    if (error instanceof PriceRetrieverMissingError) throw error;
    // Carry the class VERBATIM. Whether a human must act is answered
    // separately by isTerminalDiagnosticClass, so there is no reason to
    // overwrite `resource_missing` - the one class that tells an operator
    // exactly what is wrong with a typo'd price id.
    return commitFailure('price.lookup_failed', classifyDiagnosticError(error, 'provider_error'));
  }

  if (generation !== startedGen) return;
  const outcome = validate(product, price, band);
  if (typeof outcome === 'string') {
    return commitFailure(outcome, 'configuration_error');
  }
  resolved.set(product.productCode, outcome);
  failures.delete(product.productCode);
  attempts.delete(product.productCode);
}

/**
 * Resolve every configured product that is not yet resolved and is due for an
 * attempt. Idempotent and cheap after full success; failed products re-attempt
 * past their cooldown. Callers read the outcome through the accessors, and an
 * unpriceable product refuses its purchase through the existing guards. The
 * only rejection this can produce is PriceRetrieverMissingError, which exists
 * only in the test lane.
 *
 * Pass the productCode you actually need: a priced product answers from
 * memory, an in-flight one is awaited, a due one is looked up - and none of
 * them ever waits behind a lookup for a DIFFERENT product. An uncoded call
 * (warmup, readiness) means "everything": it fires whatever is due and waits
 * for every flight, including ones other callers started.
 */
export async function ensurePriceCatalog(productCode?: string): Promise<void> {
  // A priced product answers from memory and never waits - the fast path for
  // the warm case (every quote, every checkout). The memo is only valid for
  // the id that produced it: unit_amount and currency are immutable on a
  // Price, but the env var can be REPOINTED, and serving the old memo charged
  // the old amount with readiness green (#278 review round 3).
  if (productCode) {
    const memo = resolved.get(productCode);
    if (memo) {
      // Returning here is correct even for a tier the ordering verdict
      // refuses: amounts are immutable on a Price, so no re-lookup can change
      // the verdict - only a config change can, and that path invalidates the
      // memo below.
      if (memo.priceId === configuredPriceIdFor(productCode)) return;
      resolved.delete(productCode);
    }
  }

  const products = getConfiguredProducts();

  // Nothing to do for a product this deployment does not sell. Pay & Send is
  // disabled by default, so both quote paths ask for a product that is not in
  // the table at all; without this they took the full slow path on every
  // quote (#278 review round 3).
  if (productCode && !products.some(product => product.productCode === productCode)) return;

  pruneStale(products);

  if (productCode) {
    const flight = inFlight.get(productCode);
    if (flight) return flight;
  }

  const offenders = sharedPriceOffenders(products);
  // Revoke a product that ALREADY resolved and only later turned out to share
  // its price id - the sharers may land in different batches, and "refused for
  // EVERY product involved" has to include already-priced ones (#278 r3).
  for (const code of offenders) {
    const memo = resolved.get(code);
    if (memo) {
      resolved.delete(code);
      recordFailure(code, memo.priceId, 'price.shared_between_products', 'configuration_error', Date.now());
    }
  }

  const now = Date.now();
  const due = products.filter(product => {
    if (resolved.has(product.productCode)) return false;
    if (inFlight.has(product.productCode)) return false;
    const state = attempts.get(product.productCode);
    return !state || state.nextAttemptAt <= now;
  });

  const startedGen = generation;
  const band = saneBand();
  const started = new Map<string, Promise<void>>();
  for (const product of due) {
    const promise: Promise<void> = resolveOne(
      product,
      offenders.has(product.productCode),
      band,
      startedGen
    ).finally(() => {
      if (generation === startedGen && inFlight.get(product.productCode) === promise) {
        inFlight.delete(product.productCode);
      }
    });
    // A coded caller awaits only its own lookup; give the others a handled
    // branch so a test-lane sentinel rejection is loud where it is awaited
    // and not an unhandled-rejection crash everywhere else.
    void promise.catch(() => undefined);
    inFlight.set(product.productCode, promise);
    started.set(product.productCode, promise);
  }

  if (started.size > 0) {
    void Promise.allSettled([...started.values()]).then(() => {
      if (generation !== startedGen) return;
      writeDiagnostic(failures.size ? 'error' : 'info', 'stripe.price_catalog_resolved', {
        resolved: resolved.size,
        requested: products.length,
        failures:
          [...failures.values()].map(f => `${f.productCode}:${f.rule}`).join(' ') || 'none',
        prices: [...resolved.values()]
          .map(p => `${p.productCode}=${p.unitAmount}${p.currency}`)
          .join(' ')
      });
    });
  }

  if (productCode) {
    // Either we just started this product's lookup, or it is cooling down /
    // just failed - in which case there is nothing to wait for and the guards
    // read the recorded failure.
    return started.get(productCode);
  }

  // Uncoded: wait for everything currently running, ours or not.
  const all = new Set<Promise<void>>([...inFlight.values(), ...started.values()]);
  if (all.size > 0) await Promise.all(all);
}
