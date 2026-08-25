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
  getConfiguredProduct,
  getConfiguredProducts,
  isConfiguredProductCode,
  normalizedCurrency,
  type ConfiguredProduct
} from '../config/products.js';
import {
  carriedDiagnosticClass,
  classifyDiagnosticError,
  clearDiagnosticChangeSlot,
  isTerminalDiagnosticClass,
  writeDiagnostic,
  writeDiagnosticOnChange
} from '../utils/diagnosticLog.js';
import { boundedExponentialDelayMs } from '../utils/backoff.js';

export interface ResolvedPrice {
  readonly productCode: string;
  readonly priceId: string;
  readonly unitAmount: number;
  readonly currency: string;
  /**
   * Digest of the credential this was resolved under, copied from the
   * ConfiguredProduct row (products.ts owns the digest).
   */
  readonly credential: string;
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
   * What disagreed, in Stripe's own public figures plus a constant from
   * source control - never a secret. The deleted price_config_mismatch event
   * carried the configured and live amounts; nothing in the replacement did,
   * so every operator-reachable line for a repointed price read
   * `credit-pack-10:price.amount_mismatch:configuration_error` and diagnosing
   * it meant opening the Stripe dashboard - in the PR whose whole purpose is
   * catching that drift (#278 round 10).
   */
  readonly detail?: string;
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
  /**
   * Per-KIND consecutive counters. One shared counter that reset on a kind
   * flip meant sustained alternation (typo'd id + intermittent network) held
   * BOTH ladders at their base forever - ~2,700 reads/day/product instead of
   * the ceiling's ~96, defeating the read-allocation bound the ladders exist
   * for (#278 round 7).
   */
  readonly transientFailures: number;
  readonly terminalFailures: number;
  readonly nextAttemptAt: number;
  /**
   * The FULL configuration signature the failure was recorded against, so a
   * cooldown cannot outlive the configuration that earned it - whichever part
   * of it changes. Round 4 keyed this on the price id alone; round 6 proved a
   * currency fix then left the cooldown standing (#278).
   */
  readonly signature: string;
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
const inFlight = new Map<string, { promise: Promise<void>; signature: string }>();
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
  resolutionEpochs.clear();
  lastInvalidatedAt.clear();
  invalidations.clear();
  clearDiagnosticChangeSlot('stripe.price_catalog_resolved');
  generation += 1;
  jitter = () => 0;
  retrievePrice = () => {
    throw new PriceRetrieverMissingError();
  };
}

/**
 * The configuration a piece of catalog state was derived from, as one
 * comparable value. EVERY staleness decision keys on this - memos, failures,
 * cooldowns, and in-flight lookups alike. Round 6 found the asymmetry that
 * motivates it: memos validated the full triple while cooldowns validated
 * only the price id, so fixing STRIPE_CURRENCY cleared the memo side but
 * left the terminal cooldown standing - /readyz held 503 for up to 15
 * minutes after the configuration was already correct (reproduced).
 */
/**
 * Count of successful resolutions per product, monotonic per process. Quote
 * surfaces fold this into their change-only diagnostic signatures so a fault
 * recurring after an UNOBSERVED recovery still logs (#278 round 8).
 */
const resolutionEpochs = new Map<string, number>();

export function getResolutionEpoch(productCode: string): number {
  return resolutionEpochs.get(productCode) ?? 0;
}

/**
 * The ONE encoding of a failure set for a change-only diagnostic signature.
 * Two hand-kept copies of this format (here and readiness) drifted inside
 * this PR: round 7 added the diagnosticClass to one, round 8 had to add it
 * to the other after the class-blind signature suppressed exactly the
 * transient->terminal transition the class vocabulary exists to surface.
 * The resolution epoch is folded in on the same principle at the recovery
 * axis - a fault recurring after a recovery no reader observed otherwise
 * hashes identically and the second outage logs nothing (#278 rounds 7-9).
 */
export function formatPriceFailureSummary(
  failures: readonly PriceResolutionFailure[]
): string {
  // SORTED: these maps iterate in insertion order, which is network
  // completion order, so a recovery-then-refail reordered the string with no
  // change in the failure set and re-emitted an error line for an
  // already-reported steady state - the heap-order flip readiness sorts away
  // for its own inputs (#278 rounds 6, 10).
  return [...failures]
    .map(
      failure =>
        `${failure.productCode}:${failure.rule}:${failure.diagnosticClass}` +
        `:e${getResolutionEpoch(failure.productCode)}` +
        (failure.detail ? `(${failure.detail})` : '')
    )
    .sort()
    .join(',');
}


function configSignature(product: ConfiguredProduct): string {
  // Every term comes from the ROW, so the signature describes exactly one
  // environment - including the credential, which used to be read from
  // ambient process.env and stitched a caller-threaded verdict out of two
  // (#278 round 11).
  return (
    `${product.priceId}|${product.expectedAmountCents}|${product.expectedCurrency}` +
    `|${product.credential}`
  );
}

function memoMatchesConfiguration(memo: ResolvedPrice, product: ConfiguredProduct): boolean {
  // THE signature, not a parallel field-wise enumeration: two encodings of
  // the config triple four lines apart is exactly how the next added field
  // recreates the round-6 asymmetry, on whichever side gets missed (#278 r7).
  return (
    `${memo.priceId}|${memo.unitAmount}|${memo.currency}|${memo.credential}` ===
    configSignature(product)
  );
}

const NOT_RESOLVED_RULE = 'price.not_resolved';

function notResolvedFailure(productCode: string): PriceResolutionFailure {
  return Object.freeze({
    productCode,
    rule: NOT_RESOLVED_RULE,
    // Not yet attempted, or an attempt is in flight - transient by definition.
    diagnosticClass: 'provider_error'
  });
}

export function getResolvedPriceForProduct(productCode: string): ResolvedPrice | null {
  const memo = resolved.get(productCode);
  if (!memo) return null;
  // Single-product accessor: the full-table build here cost ~9 env reads per
  // warm quote - the exact cost getConfiguredProduct was added to remove,
  // wired into ensure but not into this hotter read (#278 round 7).
  const product = getConfiguredProduct(productCode);
  if (!product || !memoMatchesConfiguration(memo, product)) return null;
  return memo;
}

/**
 * The non-null form for checkout guards standing at a configured-but-unpriced
 * product: stored failure, else the synthesized transient record. Exists so
 * the "unattempted means transient" policy is written ONCE instead of as a
 * ?? triad at every guard (#278 rounds 5-6).
 *
 * A stored failure counts only if it was recorded against the CURRENT
 * configuration - the failures map was the one catalog state read without
 * signature validation, so a reader racing ahead of the next prune (readiness
 * computes its verdict BEFORE it kicks) served a verdict from dead
 * configuration (#278 round 7). The lockstep attempts entry carries the
 * signature; a mismatch reads as never-attempted, and the next ensure prunes.
 */
function storedFailureIfCurrent(
  productCode: string,
  product: ConfiguredProduct | null
): PriceResolutionFailure | null {
  const stored = failures.get(productCode);
  if (!stored || !product) return null;
  const state = attempts.get(productCode);
  if (state && state.signature !== configSignature(product)) return null;
  return stored;
}

/**
 * Drop a product's memo so the next ensure re-reads it from Stripe.
 *
 * `active` is the ONE field validate() enforces that Stripe lets change under
 * us, and it is deliberately not in the signature (it is not a configuration
 * input). So an archived Price stayed memoized for the process lifetime:
 * /readyz answered 200 with prices ok, quotes kept advertising the price, and
 * every purchase inserted an authoritative order row and then failed at
 * session creation with a non-terminal class - stranding a checkout_pending
 * row per attempt, forever, with nothing in the log to say why. Three round-10
 * angles found it and one reproduced it end to end.
 *
 * The checkout path calls this when Stripe rejects the request itself, which
 * is the only moment anything in this process learns the memo is a lie. The
 * re-read then either rebuilds the memo (the fault was elsewhere) or records
 * price.inactive - at which point readiness goes red, quotes stop offering it,
 * and further purchases are refused BEFORE an order row exists (#278 r10).
 */
const INVALIDATION_FLOOR_MS = 60_000;
const lastInvalidatedAt = new Map<string, number>();
/**
 * Per-product invalidation counter, checked by resolveOne's staleness guard.
 * Without it an invalidation raised while a lookup was already in the air was
 * a silent no-op: the flight had read Stripe BEFORE the archival and its
 * commit re-installed the very memo the invalidation existed to drop, putting
 * the process straight back into readiness-green-while-every-purchase-fails
 * (#278 round 11).
 */
const invalidations = new Map<string, number>();

function invalidationCount(productCode: string): number {
  return invalidations.get(productCode) ?? 0;
}

export function invalidateResolvedPrice(productCode: string, reason: string): void {
  // Rate-limited, because the trigger is necessarily coarse: the class that
  // reports an archived Price is stripe-node's catch-all for any
  // invalid_request without an allowlisted code, so a rejection caused by
  // some OTHER parameter (an expires_at drift, a malformed url, an email
  // Stripe dislikes) also lands here. There the re-read SUCCEEDS, no failure
  // is recorded, nothing throttles, and the next attempt invalidates again -
  // measured at one extra Stripe read per failing checkout, unbounded, plus
  // a warn line each time. One invalidation is all the archived-Price case
  // ever needs: its re-read records price.inactive and the terminal ladder
  // takes over from there (#278 round 11).
  // ALWAYS authoritative, and in this order. Round 11 put a rate-limit early
  // return ABOVE these lines, so a throttled call dropped no memo AND never
  // moved the counter that resolveOne's stale() reads - the two mechanisms
  // added in that same commit to make invalidation authoritative cancelled
  // each other out, and retries cluster inside the floor, so the throttled
  // call was the common path. Four round-12 angles reproduced it (#278 r12).
  invalidations.set(productCode, invalidationCount(productCode) + 1);
  resolved.delete(productCode);
  // The in-flight lookup goes too. Both flight guards key on configSignature,
  // which an invalidation deliberately does not change, so the next ensure
  // would otherwise JOIN a flight whose commit stale() is about to discard -
  // re-reading nothing and leaving the caller with neither memo nor failure
  // (#278 round 12).
  inFlight.delete(productCode);
  // Clear the ladder too: this is new evidence, not a repeat failure, so the
  // re-read happens on the next call rather than after a cooldown.
  failures.delete(productCode);
  attempts.delete(productCode);
  // Only the LOG is throttled. Throttling the invalidation itself was the
  // defect above; the read it triggers is bounded by the trigger instead -
  // Stripe must name the price as the offending parameter, and a genuinely
  // bad price records a failure on the re-read, at which point the terminal
  // ladder owns the retry rate.
  const now = Date.now();
  const last = lastInvalidatedAt.get(productCode);
  if (last === undefined || now - last >= INVALIDATION_FLOOR_MS) {
    lastInvalidatedAt.set(productCode, now);
    writeDiagnostic('warn', 'stripe.price_memo_invalidated', { productCode, reason });
  }
}

export function describeUnpriced(
  productCode: string,
  env: NodeJS.ProcessEnv = process.env
): PriceResolutionFailure {
  // The row is derived ONCE, here, from the caller's env and handed down.
  // Threading `env` through every helper as an optional trailing parameter
  // is how the round-8 stitched verdict happened in the first place: a
  // missed pass-through compiles silently and falls back to ambient
  // (#278 round 9).
  return (
    storedFailureIfCurrent(productCode, getConfiguredProduct(productCode, env)) ??
    notResolvedFailure(productCode)
  );
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
    // The row this loop already built, from the caller's env, handed down:
    // what makes the two-environment verdict unrepresentable rather than
    // merely unlikely, and it drops the second derivation per product per
    // probe (#278 round 9).
    return [
      storedFailureIfCurrent(product.productCode, product) ??
        notResolvedFailure(product.productCode)
    ];
  });
}

function validate(
  product: ConfiguredProduct,
  price: Stripe.Price | undefined
): ResolvedPrice | { rule: string; diagnosticClass: string; detail?: string } {
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
    return {
      rule: 'price.amount_mismatch',
      diagnosticClass: 'configuration_error',
      detail: `expected ${product.expectedAmountCents} / stripe ${unitAmount}`
    };
  }
  if (currency !== product.expectedCurrency) {
    return {
      rule: 'price.currency_mismatch',
      diagnosticClass: 'configuration_error',
      detail: `expected ${product.expectedCurrency} / stripe ${currency}`
    };
  }

  // Frozen so nothing downstream can mutate a shared figure.
  return Object.freeze({
    productCode: product.productCode,
    priceId: product.priceId,
    unitAmount,
    currency,
    credential: product.credential
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
    const product = byCode.get(code);
    if (!product || configSignature(product) !== state.signature) {
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
  // The log floor is configuration-scoped like everything else here: a
  // timestamp earned under a dead configuration survived a repoint and
  // suppressed the first report under the new one (#278 round 12).
  for (const code of [...lastInvalidatedAt.keys()]) {
    if (!byCode.has(code)) lastInvalidatedAt.delete(code);
  }
}

function recordFailure(
  productCode: string,
  signature: string,
  rule: string,
  diagnosticClass: string,
  now: number,
  detail?: string
): void {
  const terminal = isTerminalDiagnosticClass(diagnosticClass);
  // Only the class is stored. Terminality is DERIVED at each decision point
  // (isTerminalDiagnosticClass), because a carried pair can be minted
  // mismatched - the same reason it was removed from the carried error shapes
  // in round 6, applied to this later-added record (#278 round 10).
  failures.set(productCode, Object.freeze({ productCode, rule, diagnosticClass, detail }));
  // Counters carry over only within ONE configuration: a flight that started
  // under config A landing after a B->A flip must not inherit rungs earned
  // under B, or A's first failure starts mid-ladder and refuses purchases
  // longer than A's own history warrants (#278 round 8).
  const priorEntry = attempts.get(productCode);
  const prior = priorEntry?.signature === signature ? priorEntry : undefined;
  const transientFailures = (prior?.transientFailures ?? 0) + (terminal ? 0 : 1);
  const terminalFailures = (prior?.terminalFailures ?? 0) + (terminal ? 1 : 0);
  const consecutive = terminal ? terminalFailures : transientFailures;
  const base = terminal ? TERMINAL_COOLDOWN_BASE_MS : TRANSIENT_COOLDOWN_BASE_MS;
  const ceiling = terminal ? TERMINAL_COOLDOWN_MAX_MS : TRANSIENT_COOLDOWN_MAX_MS;
  const cooldown = boundedExponentialDelayMs(base, ceiling, consecutive, jitter, COOLDOWN_JITTER_MS);
  attempts.set(productCode, {
    transientFailures,
    terminalFailures,
    nextAttemptAt: now + cooldown,
    signature
  });
}

/** Resolve ONE product's price and commit the outcome, staleness-guarded. */
async function resolveOne(product: ConfiguredProduct, startedGen: number): Promise<void> {
  const startedInvalidations = invalidationCount(product.productCode);
  const signature = configSignature(product);
  // A commit is valid only if nothing moved underneath the lookup: not the
  // catalog generation (a reset), and not ANY part of the configuration - a
  // repoint, a currency change, or an edited pin while the request was in
  // the air (#278 rounds 5-6; round 5's guard checked the id only, so a
  // mid-flight currency fix could be poisoned by a verdict computed against
  // the dead snapshot).
  const stale = (forSuccess = true): boolean => {
    if (generation !== startedGen) return true;
    // An invalidation raised mid-flight discards a SUCCESS: it was read
    // before the event that disproved it. Failures are exempt - see
    // commitFailure, which passes `false` - because a recorded fault is
    // evidence in its own right, and discarding it downgraded a correct
    // terminal price.inactive to the synthesized transient record, telling
    // the customer to retry a permanently archived Price (#278 rounds 11-12).
    if (
      forSuccess &&
      invalidationCount(product.productCode) !== startedInvalidations
    ) {
      return true;
    }
    const current = getConfiguredProduct(product.productCode);
    return !current || configSignature(current) !== signature;
  };

  const commitFailure = (rule: string, diagnosticClass: string, detail?: string): void => {
    if (stale(false)) return;
    recordFailure(product.productCode, signature, rule, diagnosticClass, Date.now(), detail);
  };

  if (!product.priceId) {
    return commitFailure('price.id_not_configured', 'configuration_error');
  }

  let outcome: ReturnType<typeof validate>;
  try {
    const price = await retrievePrice(product.priceId);
    outcome = validate(product, price);
  } catch (error) {
    // By name as well as identity: the shared Stripe mock raises this
    // sentinel for an unwired priceRetrieve, and it cannot import this class
    // (the suites that use it often replace this very module), while a test
    // registry can hold two copies of one class - under either, `instanceof`
    // quietly fails and the loud failure degrades into the fake outage the
    // sentinel exists to prevent (#278 round 9).
    if (
      error instanceof PriceRetrieverMissingError ||
      (error instanceof Error && error.name === 'PriceRetrieverMissingError')
    ) {
      throw error;
    }
    // Prefer a class the failing layer attached (getStripeClient's missing-key
    // throw carries configuration_error - a bare classify read it as a
    // transient provider fault and retried a human-only problem forever,
    // #278 round 6), else classify the Stripe error verbatim.
    return commitFailure(
      'price.lookup_failed',
      carriedDiagnosticClass(error) ?? classifyDiagnosticError(error, 'provider_error')
    );
  }

  if ('rule' in outcome) {
    return commitFailure(outcome.rule, outcome.diagnosticClass, outcome.detail);
  }
  if (stale()) return;
  resolved.set(product.productCode, outcome);
  failures.delete(product.productCode);
  attempts.delete(product.productCode);
  // Each successful resolution opens a new logging epoch: change-only slots
  // keyed on rule:class alone stayed silent when the SAME fault recurred
  // after a recovery no quote happened to observe (#278 round 8).
  resolutionEpochs.set(product.productCode, (resolutionEpochs.get(product.productCode) ?? 0) + 1);
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
  // Nothing to do for a product this deployment does not sell - and any state
  // it left behind is cleared HERE, because the hot paths never prune while
  // the packs are green: without this, cooldowns recorded before Pay & Send
  // was toggled off survived un-prunable and resurfaced verbatim on
  // re-enable, refusing quotes for up to the residual terminal ladder even
  // though Stripe would validate cleanly (#278 round 6).
  if (productCode && !isConfiguredProductCode(productCode)) {
    // The FULL prune, not a two-map delete for this one code. Two leaks hid
    // in the narrow version: the sibling product's cooldown survived if only
    // one mail type was quoted while disabled, and memos were never touched -
    // so a Price archived during the disabled window kept serving its stale
    // memo on re-enable (signature-valid: `active` is not in the signature),
    // quoting a price every purchase then failed against, with readiness
    // green. pruneStale drops attempts, failures AND memos for every code
    // the current configuration no longer sells (#278 round 8).
    //
    // Behind a cheap precondition: this branch runs on EVERY quote in the
    // shipped default (Pay & Send off, so the eligibility kick always passes
    // an unsold code), and building the full table plus walking three maps to
    // prune nothing cost more per quote than the enabled warm path two rounds
    // went to trim. The maps hold at most five keys and the membership check
    // is a static array scan plus one env read (#278 round 9).
    const holdsUnsoldState = [
      ...resolved.keys(),
      ...failures.keys(),
      ...attempts.keys()
    ].some(code => !isConfiguredProductCode(code));
    if (holdsUnsoldState) pruneStale(getConfiguredProducts());
    return;
  }

  // Warm fast paths from ONE single-product fetch: the memo check, the
  // cooling-down early exit, and the flight check all reuse it. Building the
  // full table (and running pruneStale) per steady-fault quote cost ~3x the
  // early-exit path, on the module's own quotes-vastly-outnumber-purchases
  // premise (#278 rounds 6-7). Cross-product pruning still happens on every
  // slow-path and uncoded call.
  const codedProduct = productCode ? getConfiguredProduct(productCode) : null;
  if (productCode && codedProduct) {
    const memo = resolved.get(productCode);
    if (memo && memoMatchesConfiguration(memo, codedProduct)) return;
    const state = attempts.get(productCode);
    if (
      state &&
      state.signature === configSignature(codedProduct) &&
      state.nextAttemptAt > Date.now() &&
      !inFlight.has(productCode)
    ) {
      // Cooling down under the current configuration: nothing to do, and the
      // guards read the recorded failure.
      return;
    }
  }

  const products = getConfiguredProducts();
  pruneStale(products);

  if (productCode) {
    const flight = inFlight.get(productCode);
    const product = codedProduct;
    // Only a flight started for the CURRENT configuration is worth awaiting.
    // Handing back a flight begun before a repoint left the caller with
    // neither memo nor failure - its commit is staleness-suppressed - so the
    // first purchase after a repoint was spuriously refused (#278 round 6,
    // reproduced). A stale flight is simply ignored; its finally only deletes
    // its own entry, so overwriting below is safe.
    if (flight && product && flight.signature === configSignature(product)) {
      return flight.promise;
    }
  }

  const now = Date.now();
  const due = products.filter(product => {
    if (resolved.has(product.productCode)) return false;
    const flight = inFlight.get(product.productCode);
    if (flight && flight.signature === configSignature(product)) return false;
    const state = attempts.get(product.productCode);
    return !state || state.nextAttemptAt <= now;
  });

  const startedGen = generation;
  const started: Promise<void>[] = [];
  let mine: Promise<void> | undefined;
  for (const product of due) {
    const signature = configSignature(product);
    const promise: Promise<void> = resolveOne(product, startedGen).finally(() => {
      if (inFlight.get(product.productCode)?.promise === promise) {
        inFlight.delete(product.productCode);
      }
    });
    // A coded caller awaits only its own lookup; give the others a handled
    // branch so a test-lane sentinel rejection is loud where it is awaited
    // and not an unhandled-rejection crash everywhere else.
    void promise.catch(() => undefined);
    inFlight.set(product.productCode, { promise, signature });
    started.push(promise);
    if (product.productCode === productCode) mine = promise;
  }

  if (started.length > 0) {
    void Promise.allSettled(started).then(() => {
      if (generation !== startedGen) return;
      // Class included: price.lookup_failed can flip transient<->terminal
      // under the SAME rule, and a class-blind signature suppressed exactly
      // the transition the classes exist to surface (#278 round 7).
      const failureSummary = formatPriceFailureSummary([...failures.values()]) || 'none';
      // What we are SELLING, not how many rows we hold: the signature used
      // resolved.size, so a repoint that changed an amount while leaving the
      // count and the failure set alone was suppressed - and this line is
      // the only audit record of live sell prices (#278 round 9).
      const priceSummary = [...resolved.values()]
        .map(p => `${p.productCode}=${p.unitAmount}${p.currency}`)
        .sort()
        .join(' ');
      // On CHANGE only: a dev deploy with prices legitimately unset re-logged
      // an identical error-level line every terminal-ladder expiry, ~720/day,
      // for an already-reported steady state (#278 round 6).
      writeDiagnosticOnChange(
        'stripe.price_catalog_resolved',
        `${priceSummary}|${failureSummary}`,
        failures.size ? 'error' : 'info',
        'stripe.price_catalog_resolved',
        {
          resolved: resolved.size,
          // Computed FRESH: a batch begun before a repoint otherwise logs its
          // dead product list against the live maps (#278 round 7).
          requested: getConfiguredProducts().length,
          failures: failureSummary,
          prices: priceSummary
        }
      );
    });
  }

  if (productCode) {
    // Either we just started this product's lookup, or it is cooling down /
    // just failed - nothing to wait for; the guards read the recorded failure.
    return mine;
  }

  // Uncoded: wait for everything currently running, ours or not.
  const all = new Set<Promise<void>>([...[...inFlight.values()].map(f => f.promise), ...started]);
  if (all.size > 0) await Promise.all(all);
}

/**
 * Fire-and-forget warmup. Owns the swallow-and-log policy in ONE place: four
 * call sites used to hand-roll `void ensure().catch(...)` and had already
 * drifted into two behaviors, two logging a rejection and two silently
 * swallowing it (#278 round 6). Only the test-lane sentinel can reject.
 */
export function kickPriceCatalog(productCode?: string, context = 'warmup'): void {
  void ensurePriceCatalog(productCode).catch(error => {
    writeDiagnostic('warn', 'stripe.price_kick_rejected', {
      context,
      // The error NAME, so the test-lane sentinel does not collapse into an
      // anonymous unknown_error with no setPriceRetriever hint (#278 r7).
      errorName: error instanceof Error ? error.name : 'unknown',
      errorClass: carriedDiagnosticClass(error) ?? classifyDiagnosticError(error, 'unknown_error')
    });
  });
}
