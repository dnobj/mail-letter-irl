/**
 * The resolved price catalog. Issue #275 stage A, redesigned in #278 round 5.
 *
 * Stripe charges what the Price object says; src/config/products.ts says what
 * each product is AGREED to cost (expectedAmountCents). This module's one job
 * is to verify the two agree before anything is sold: it resolves each
 * configured price id from Stripe and refuses any product whose Price is not
 * active, not one-time, or does not match its pinned amount and currency.
 *
 * The pin is what makes wrong-but-plausible configuration detectable at all.
 * Transposed STRIPE_PRICE_* env vars, an id pasted from the wrong product, a
 * repoint to some unrelated Price - each resolves to a perfectly healthy
 * Price, so no per-price rule (active, one-time, "sane range") can refuse it;
 * five review rounds proved every heuristic replacement leaked (tier-ordering
 * saw only resolved tiers, sanity bands pass any in-band figure, shared-id
 * checks need byte-identical ids). Equality against an independent second
 * source is the only deterministic answer, and it also subsumes all of those
 * heuristics: a shared Price is fine exactly when the pinned amounts agree,
 * and there is no "sane band" question left when the exact figure is known.
 *
 * Resolution is LAZY with an eager warmup. Purchase paths await
 * ensurePriceCatalog(code) themselves; quote paths fire it without awaiting
 * (their eligibility data degrades cleanly, and a quote must never block on
 * Stripe); the webhook path does not touch this module at all - adoption of
 * already-paid money prices from the static table, and the paid-amount
 * comparison downstream is the verification.
 *
 * A resolved product memoizes for the process lifetime: unit_amount and
 * currency are IMMUTABLE on an existing Price, so memoized-forever is exactly
 * as fresh as re-read - but only for the CONFIGURATION that produced it, so
 * every read validates the memo against the currently configured id, pinned
 * amount, and expected currency. Failures re-attempt past a doubling
 * cooldown: transient faults start at 2 seconds (a warmup blip must self-heal
 * on the next purchase, and /readyz's unready TTL is short) and cap at 2
 * minutes; terminal faults - a human must act - start at 30 seconds and cap
 * at 15 minutes, so a misconfigured product does not burn Stripe's read
 * allocation (reads are budgeted ~500 per TRANSACTION, floor 10k/month).
 */

import type Stripe from 'stripe';
import { getStripeClient } from './stripeClient.js';
import {
  configuredPriceIdFor,
  getConfiguredProducts,
  isConfiguredProductCode,
  normalizedCurrency,
  type ConfiguredProduct
} from '../config/products.js';
import {
  classifyDiagnosticError,
  isTerminalDiagnosticClass,
  writeDiagnostic
} from '../utils/diagnosticLog.js';

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
   * enforces (archived, recurring, amount or currency disagreeing with the
   * product table), or the Stripe error's own class for a failed lookup,
   * verbatim: `resource_missing` is the one class that tells an operator
   * exactly what is wrong with a typo'd price id, and an earlier revision
   * that overwrote it reintroduced the #213 mislabel.
   */
  readonly diagnosticClass: string;
  /**
   * Whether a human must act (isTerminalDiagnosticClass of the class above).
   * It decides whether an order is cancelled or left pending and how hard the
   * catalog retries.
   */
  readonly terminal: boolean;
}

/**
 * Cooldown ladders, doubling from base to ceiling with up to a second of
 * jitter so replicas that booted together do not retry in lockstep.
 *
 * TRANSIENT starts at two seconds: readiness holds an unready verdict for
 * about a second and a one-second Stripe blip during warmup must not refuse
 * the first purchase moments later (origin/dev never cached a failed lookup
 * at all - the ladder exists to avoid hammering Stripe in a real outage, not
 * to slow recovery). The 2-minute ceiling bounds how long a purchase can be
 * refused after Stripe recovers (#278 review round 5 measured the previous
 * 5-minute ceiling as the residual-refusal window).
 *
 * TERMINAL faults cannot clear without a human, and a human's fix repoints an
 * env var or edits the product table - both of which pruneStale detects
 * immediately, so the ladder here is purely a read-allocation bound.
 */
const TRANSIENT_COOLDOWN_BASE_MS = 2_000;
const TRANSIENT_COOLDOWN_MAX_MS = 2 * 60_000;
const TERMINAL_COOLDOWN_BASE_MS = 30_000;
const TERMINAL_COOLDOWN_MAX_MS = 15 * 60_000;
const COOLDOWN_JITTER_MS = 1_000;

/**
 * Per-request bounds for a price lookup, tighter than the shared client's
 * 10s/1: a checkout may be waiting on this, and stripe-node's retry math
 * compounds - a hung lookup costs timeout x (1 + retries).
 */
const PRICE_LOOKUP_TIMEOUT_MS = 5_000;
const PRICE_LOOKUP_RETRIES = 1;

type PriceRetriever = (priceId: string) => Promise<Stripe.Price>;

/**
 * The outbound-call seam, following the RefundOperations precedent
 * (commerceService.ts): tests never mock the stripe module - they substitute
 * the boundary. Production default is the real client.
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
 * exercise defaultRetriever itself - its per-request bounds are load-bearing
 * and otherwise unobservable, because every other suite substitutes the seam.
 * Safe only where the stripe module is mocked.
 */
export function useDefaultPriceRetriever(): void {
  retrievePrice = defaultRetriever;
}

/** Injectable so the backoff tests are not at the mercy of real randomness. */
let jitter: () => number = Math.random;

interface AttemptState {
  /** Consecutive failures OF THE SAME KIND, for the backoff ladder. */
  readonly failures: number;
  readonly nextAttemptAt: number;
  /** Which ladder those failures were counted on. */
  readonly terminal: boolean;
  /**
   * The price id the failure was recorded against, so a cooldown cannot
   * outlive the configuration that earned it: an operator who FIXES the env
   * var must not wait out the old id's terminal ladder at 503 (#278 round 4).
   */
  readonly priceId: string;
}

const resolved = new Map<string, ResolvedPrice>();
const failures = new Map<string, PriceResolutionFailure>();
const attempts = new Map<string, AttemptState>();
/**
 * The lookup currently in flight for each product. Per-product, never a
 * shared batch slot: with one slot, a due product either waited out a batch
 * that never touched its price id or returned silently unresolved (#278
 * round 4). A caller awaits the flight resolving ITS product or starts one.
 */
const inFlight = new Map<string, Promise<void>>();
/**
 * Bumped by resetPriceCatalog. A lookup already in flight when the catalog is
 * reset must not write its outcome into the freshly cleared maps, nor delete
 * a flight entry that now belongs to a newer lookup.
 */
let generation = 0;

/**
 * Thrown by the retriever resetPriceCatalog installs, and deliberately NOT
 * swallowed like a provider failure: the lookup catch rethrows it, so a suite
 * that forgot setPriceRetriever fails loudly instead of recording something
 * indistinguishable from a Stripe outage (#278 review round 4).
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
 * A memo is valid only while it describes the configuration as it stands NOW:
 * the configured price id produced it, and its figures still equal the
 * product table's pin. Checking the id alone left a changed STRIPE_CURRENCY
 * or an edited table pin serving a memo the current configuration would
 * refuse (#278 review round 5).
 */
function memoMatchesConfiguration(memo: ResolvedPrice, product: ConfiguredProduct): boolean {
  return (
    memo.priceId === product.priceId &&
    memo.unitAmount === product.expectedAmountCents &&
    memo.currency === product.expectedCurrency
  );
}

const NOT_RESOLVED_RULE = 'price.not_resolved';

function notResolvedFailure(productCode: string): PriceResolutionFailure {
  return Object.freeze({
    productCode,
    rule: NOT_RESOLVED_RULE,
    // Not yet attempted, or an attempt is in flight - transient by definition.
    diagnosticClass: 'provider_error',
    terminal: false
  });
}

export function getResolvedPriceForProduct(productCode: string): ResolvedPrice | null {
  const memo = resolved.get(productCode);
  if (!memo) return null;
  const products = getConfiguredProducts();
  const product = products.find(candidate => candidate.productCode === productCode);
  if (!product || !memoMatchesConfiguration(memo, product)) return null;
  return memo;
}

/**
 * Why a product cannot currently be priced. For an unpriced-but-configured
 * product with no recorded failure (never attempted, or attempt in flight)
 * this returns the synthesized transient record rather than null, so the five
 * checkout guards read ONE policy instead of each re-deriving the default
 * with its own ?? chain (#278 review round 5). Null means: not configured
 * here, or priced and sellable.
 */
export function getPriceResolutionFailure(productCode: string): PriceResolutionFailure | null {
  const stored = failures.get(productCode);
  if (stored) return stored;
  if (!isConfiguredProductCode(productCode)) return null;
  if (getResolvedPriceForProduct(productCode)) return null;
  return notResolvedFailure(productCode);
}

/**
 * Every ENABLED product that cannot currently be priced, with why. This is
 * the readiness question, and it is deliberately not "are there failures": a
 * cold catalog has no failures and nothing resolved, and an instance in that
 * state refuses every purchase - that must read as unready, never as a false
 * green (#278 review, repeatedly).
 */
export function getUnpricedProducts(env: NodeJS.ProcessEnv = process.env): PriceResolutionFailure[] {
  return getConfiguredProducts(env).flatMap(product => {
    const memo = resolved.get(product.productCode);
    if (memo && memoMatchesConfiguration(memo, product)) return [];
    const failure = failures.get(product.productCode);
    if (failure) return [failure];
    return [notResolvedFailure(product.productCode)];
  });
}

function validate(
  product: ConfiguredProduct,
  price: Stripe.Price | undefined
): ResolvedPrice | { rule: string; diagnosticClass: string } {
  // Not an object at all: a middlebox or SDK anomaly, not a statement about
  // the configuration - transient, so one bad response is not a sticky
  // refusal (origin/dev made the same call; #278 round 5 caught this being
  // classed terminal).
  if (!price || typeof price !== 'object') {
    return { rule: 'price.unreadable', diagnosticClass: 'provider_error' };
  }
  if (price.active !== true) {
    return { rule: 'price.inactive', diagnosticClass: 'configuration_error' };
  }
  // A recurring Price would pass every other rule and then fail at
  // sessions.create with mode:'payment' - AFTER the authoritative order row
  // is written. Refuse it up front (#278 review round 2).
  if (price.recurring || (price.type && price.type !== 'one_time')) {
    return { rule: 'price.not_one_time', diagnosticClass: 'configuration_error' };
  }

  const currency = normalizedCurrency(price.currency, '');
  if (!currency) {
    return { rule: 'price.no_currency', diagnosticClass: 'configuration_error' };
  }
  const unitAmount = price.unit_amount;
  // null first: tiered and metered prices report no unit amount, and the
  // check doubles as the narrowing TypeScript needs below.
  if (unitAmount === null || unitAmount === undefined || !Number.isInteger(unitAmount)) {
    return { rule: 'price.no_unit_amount', diagnosticClass: 'configuration_error' };
  }

  // THE check this module exists for: the resolved Price must say exactly
  // what the product table says. Anything else - transposed env vars, an id
  // pasted from the wrong product, a repoint to an unrelated Price - is a
  // healthy Price for the wrong product, which no per-price heuristic can
  // refuse deterministically.
  if (unitAmount !== product.expectedAmountCents) {
    return { rule: 'price.amount_mismatch', diagnosticClass: 'configuration_error' };
  }
  if (currency !== product.expectedCurrency) {
    return { rule: 'price.currency_mismatch', diagnosticClass: 'configuration_error' };
  }

  // Frozen so nothing downstream can mutate a shared figure.
  return Object.freeze({
    productCode: product.productCode,
    priceId: product.priceId,
    unitAmount,
    currency
  });
}

/**
 * Drop state for products this deployment no longer sells, and any state
 * recorded against a configuration that has changed - memos, failures and
 * cooldowns alike, so an operator's fix takes effect on the next call rather
 * than after the old configuration's cooldown (#278 round 4).
 */
function pruneStale(products: readonly ConfiguredProduct[]): void {
  const byCode = new Map(products.map(product => [product.productCode, product]));
  for (const [code, state] of [...attempts.entries()]) {
    if (byCode.get(code)?.priceId !== state.priceId) {
      attempts.delete(code);
      failures.delete(code);
    }
  }
  for (const code of [...failures.keys()]) {
    if (!byCode.has(code)) failures.delete(code);
  }
  for (const [code, memo] of [...resolved.entries()]) {
    const product = byCode.get(code);
    if (!product || !memoMatchesConfiguration(memo, product)) resolved.delete(code);
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
  failures.set(productCode, Object.freeze({ productCode, rule, diagnosticClass, terminal }));
  // Consecutive failures OF THE SAME KIND: sharing one counter let a long
  // outage push the first real configuration fault straight to the 15-minute
  // ceiling (#278 round 3).
  const prior = attempts.get(productCode);
  const consecutive = prior && prior.terminal === terminal ? prior.failures + 1 : 1;
  const base = terminal ? TERMINAL_COOLDOWN_BASE_MS : TRANSIENT_COOLDOWN_BASE_MS;
  const ceiling = terminal ? TERMINAL_COOLDOWN_MAX_MS : TRANSIENT_COOLDOWN_MAX_MS;
  const cooldown =
    Math.min(base * 2 ** (consecutive - 1), ceiling) + Math.floor(jitter() * COOLDOWN_JITTER_MS);
  attempts.set(productCode, { failures: consecutive, nextAttemptAt: now + cooldown, terminal, priceId });
}

/** Resolve ONE product's price and commit the outcome, staleness-guarded. */
async function resolveOne(product: ConfiguredProduct, startedGen: number): Promise<void> {
  // A commit is valid only if nothing moved underneath the lookup: not the
  // catalog generation (a reset), and not the configuration (a repoint while
  // the request was in the air - the one staleness surface round 4's guards
  // missed, #278 round 5).
  const stale = (): boolean =>
    generation !== startedGen ||
    configuredPriceIdFor(product.productCode) !== product.priceId;

  const commitFailure = (rule: string, diagnosticClass: string): void => {
    if (stale()) return;
    recordFailure(product.productCode, product.priceId, rule, diagnosticClass, Date.now());
  };

  if (!product.priceId) {
    return commitFailure('price.id_not_configured', 'configuration_error');
  }

  let outcome: ReturnType<typeof validate>;
  try {
    const price = await retrievePrice(product.priceId);
    outcome = validate(product, price);
  } catch (error) {
    if (error instanceof PriceRetrieverMissingError) throw error;
    // Carry the class VERBATIM; terminality is derived from it separately.
    return commitFailure('price.lookup_failed', classifyDiagnosticError(error, 'provider_error'));
  }

  if ('rule' in outcome) {
    return commitFailure(outcome.rule, outcome.diagnosticClass);
  }
  if (stale()) return;
  resolved.set(product.productCode, outcome);
  failures.delete(product.productCode);
  attempts.delete(product.productCode);
}

/**
 * Resolve every configured product that is not yet resolved and is due for an
 * attempt. Idempotent and cheap after full success. The only rejection this
 * can produce is PriceRetrieverMissingError, which exists in the test lane
 * only.
 *
 * Pass the productCode you actually need: a verified product answers from
 * memory, an in-flight one is awaited, a due one is looked up - and none of
 * them ever waits behind a lookup for a DIFFERENT product. An uncoded call
 * (warmup, readiness) means "everything": it fires whatever is due and waits
 * for every flight.
 */
export async function ensurePriceCatalog(productCode?: string): Promise<void> {
  // Nothing to do for a product this deployment does not sell - the answer
  // both quote paths need on every call when Pay & Send is disabled, without
  // building the product table (#278 round 5).
  if (productCode && !isConfiguredProductCode(productCode)) return;

  const products = getConfiguredProducts();

  if (productCode) {
    const memo = resolved.get(productCode);
    const product = products.find(candidate => candidate.productCode === productCode);
    if (memo && product && memoMatchesConfiguration(memo, product)) return;
  }

  pruneStale(products);

  if (productCode) {
    const flight = inFlight.get(productCode);
    if (flight) return flight;
  }

  const now = Date.now();
  const due = products.filter(product => {
    if (resolved.has(product.productCode)) return false;
    if (inFlight.has(product.productCode)) return false;
    const state = attempts.get(product.productCode);
    return !state || state.nextAttemptAt <= now;
  });

  const startedGen = generation;
  const started: Promise<void>[] = [];
  let mine: Promise<void> | undefined;
  for (const product of due) {
    const promise: Promise<void> = resolveOne(product, startedGen).finally(() => {
      if (inFlight.get(product.productCode) === promise) {
        inFlight.delete(product.productCode);
      }
    });
    // A coded caller awaits only its own lookup; give the others a handled
    // branch so a test-lane sentinel rejection is loud where it is awaited
    // and not an unhandled-rejection crash everywhere else.
    void promise.catch(() => undefined);
    inFlight.set(product.productCode, promise);
    started.push(promise);
    if (product.productCode === productCode) mine = promise;
  }

  if (started.length > 0) {
    void Promise.allSettled(started).then(() => {
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
    // just failed - nothing to wait for; the guards read the recorded failure.
    return mine;
  }

  // Uncoded: wait for everything currently running, ours or not.
  const all = new Set<Promise<void>>([...inFlight.values(), ...started]);
  if (all.size > 0) await Promise.all(all);
}
