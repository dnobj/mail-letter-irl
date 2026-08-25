/**
 * Issue #275 stage A, reworked after the #278 review. Prices resolve lazily
 * from Stripe, keyed by PRODUCT; the STRIPE_*_AMOUNT_CENTS variables are gone.
 *
 * Deleting that second copy removed a crude safety net - a mistyped price id
 * used to be caught by its amount disagreeing - so resolution has to establish
 * that each price is the RIGHT price. Several cases here are relocated from
 * deploymentConfig.test.ts (missing/zero/absurd amounts were boot errors
 * there); the intent - a purchase must never proceed without a trustworthy
 * amount - is enforced here now.
 *
 * These tests drive the loader through its injectable retriever seam, the
 * same boundary-substitution pattern the integration suite uses for refunds
 * (RefundOperations). No module mock needed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  describeUnpriced,
  ensurePriceCatalog,
  getResolvedPriceForProduct,
  getUnpricedProducts,
  resetPriceCatalog,
  setPriceRetriever,
  useDefaultPriceRetriever
} from '../../../src/services/priceCatalog.js';
import { isConfiguredProductCode } from '../../../src/config/products.js';
import { priceFixture } from '../../mocks/stripe.js';

/**
 * Test-local composition of the surfaces production actually reads
 * (describeUnpriced + getResolvedPriceForProduct). The exported helper of
 * this name was dead production surface and was deleted in #278 round 8;
 * the fixtures keep stating verdicts through the same shape.
 */
function getPriceResolutionFailure(productCode: string) {
  if (!isConfiguredProductCode(productCode)) return null;
  if (getResolvedPriceForProduct(productCode)) return null;
  return describeUnpriced(productCode);
}

const PACK_ENVS: Record<string, string> = {
  STRIPE_PRICE_STARTER: 'price_starter',
  STRIPE_PRICE_REGULAR: 'price_regular',
  STRIPE_PRICE_POWER: 'price_power'
};

const PACK_AMOUNTS: Record<string, number> = {
  price_starter: 500,
  price_regular: 1000,
  price_power: 9000
};

function stubPackEnv(): void {
  for (const [name, value] of Object.entries(PACK_ENVS)) vi.stubEnv(name, value);
  vi.stubEnv('STRIPE_CURRENCY', 'usd');
}

/** A retriever serving healthy USD pack prices; override per case. */
function healthyRetriever(overrides: Record<string, Record<string, unknown>> = {}) {
  return vi.fn(async (priceId: string) =>
    priceFixture({
      id: priceId,
      unit_amount: PACK_AMOUNTS[priceId] ?? 1000,
      ...overrides[priceId]
    })
  );
}

/**
 * True when `promise` settles within a handful of microtasks - i.e. it took a
 * synchronous decision rather than joining an outstanding network batch. Ten
 * ticks against one keeps the race unambiguous.
 */
async function settlesPromptly(promise: Promise<void>): Promise<boolean> {
  const pending = (async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    return 'pending' as const;
  })();
  const winner = await Promise.race([promise.then(() => 'settled' as const), pending]);
  return winner === 'settled';
}

describe('price catalog (#275 stage A)', () => {
  beforeEach(() => {
    resetPriceCatalog();
    stubPackEnv();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    resetPriceCatalog();
  });

  it('resolves each product from its own Stripe price', async () => {
    setPriceRetriever(healthyRetriever());

    await ensurePriceCatalog();

    expect(getResolvedPriceForProduct('credit-pack-4')).toMatchObject({
      priceId: 'price_starter',
      unitAmount: 500,
      currency: 'usd'
    });
    expect(getResolvedPriceForProduct('credit-pack-100')?.unitAmount).toBe(9000);
    expect(getUnpricedProducts()).toEqual([]);
  });

  it('freezes what it caches, so nothing downstream can mutate a shared figure', async () => {
    setPriceRetriever(healthyRetriever());
    await ensurePriceCatalog();

    const price = getResolvedPriceForProduct('credit-pack-10')!;
    expect(Object.isFrozen(price)).toBe(true);
    expect(() => {
      (price as { unitAmount: number }).unitAmount = 1;
    }).toThrow();
    expect(getResolvedPriceForProduct('credit-pack-10')?.unitAmount).toBe(1000);
  });

  it('memoizes a resolved product for the process lifetime', async () => {
    const retriever = healthyRetriever();
    setPriceRetriever(retriever);

    await ensurePriceCatalog();
    await ensurePriceCatalog();
    await ensurePriceCatalog();

    // Stripe allocates reads per TRANSACTION and quotes vastly outnumber
    // purchases; reads must not scale with quoting.
    expect(retriever).toHaveBeenCalledTimes(3); // one per product, once ever
  });

  describe('refuses a price that is not the right price', () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['archived', { active: false }, 'price.inactive'],
      ['no unit amount (tiered/metered)', { unit_amount: null }, 'price.no_unit_amount'],
      ['a cent off the pinned amount', { unit_amount: 999 }, 'price.amount_mismatch'],
      ['an order of magnitude off', { unit_amount: 100_000 }, 'price.amount_mismatch'],
      ['wrong currency', { currency: 'gbp' }, 'price.currency_mismatch']
    ];

    for (const [label, override, rule] of cases) {
      it(`${label} → ${rule}, as a configuration fault`, async () => {
        setPriceRetriever(healthyRetriever({ price_regular: override }));

        await ensurePriceCatalog();

        expect(getResolvedPriceForProduct('credit-pack-10')).toBeNull();
        expect(getPriceResolutionFailure('credit-pack-10')).toMatchObject({
          rule,
          diagnosticClass: 'configuration_error'
        });
        // The other products still price - one broken product must not
        // unprice the store.
        expect(getResolvedPriceForProduct('credit-pack-4')?.unitAmount).toBe(500);
      });
    }
  });

  it('refuses the missold side of a shared price id and keeps selling the right one', async () => {
    // The Power-at-Starter's-price missell: each lookup succeeds on its own.
    // The pin decides per PRODUCT: the tier whose amount agrees keeps selling,
    // the tier the shared id misprices is refused - which is strictly better
    // than the old shared-id heuristic that refused both, and unlike it needs
    // no notion of which pairings are "legitimate" (#278 round 5).
    vi.stubEnv('STRIPE_PRICE_POWER', 'price_starter');
    setPriceRetriever(healthyRetriever());

    await ensurePriceCatalog();

    // The Starter, whose id this genuinely is, sells at its pinned 500.
    expect(getResolvedPriceForProduct('credit-pack-4')?.unitAmount).toBe(500);
    // The Power tier resolved 500 against a 9000 pin: refused.
    expect(getResolvedPriceForProduct('credit-pack-100')).toBeNull();
    expect(getPriceResolutionFailure('credit-pack-100')).toMatchObject({
      rule: 'price.amount_mismatch',
      diagnosticClass: 'configuration_error',
      terminal: true
    });
    expect(getResolvedPriceForProduct('credit-pack-10')?.unitAmount).toBe(1000);
  });

  it('validates each product against ITS OWN currency, so JIT may differ from packs', async () => {
    vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
    vi.stubEnv('JIT_CURRENCY', 'gbp');
    vi.stubEnv('STRIPE_JIT_LETTER_PRICE_ID', 'price_jit_letter');
    vi.stubEnv('STRIPE_JIT_POSTCARD_PRICE_ID', 'price_jit_postcard');
    setPriceRetriever(
      healthyRetriever({
        price_jit_letter: { unit_amount: 499, currency: 'gbp' },
        price_jit_postcard: { unit_amount: 499, currency: 'gbp' }
      })
    );

    await ensurePriceCatalog();

    // A GBP Pay & Send beside USD packs is a supported configuration, not a
    // fault (#278 review: the first version validated everything against
    // STRIPE_CURRENCY and bricked exactly this deployment).
    expect(getResolvedPriceForProduct('jit-letter')).toMatchObject({
      unitAmount: 499,
      currency: 'gbp'
    });
    expect(getResolvedPriceForProduct('credit-pack-4')?.currency).toBe('usd');
    expect(getUnpricedProducts()).toEqual([]);
  });

  it('lets the JIT letter and postcard legitimately share one price', async () => {
    vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
    vi.stubEnv('STRIPE_JIT_LETTER_PRICE_ID', 'price_jit_shared');
    vi.stubEnv('STRIPE_JIT_POSTCARD_PRICE_ID', 'price_jit_shared');
    setPriceRetriever(healthyRetriever({ price_jit_shared: { unit_amount: 499 } }));

    await ensurePriceCatalog();

    expect(getResolvedPriceForProduct('jit-letter')?.unitAmount).toBe(499);
    expect(getResolvedPriceForProduct('jit-postcard')?.unitAmount).toBe(499);
    expect(getUnpricedProducts()).toEqual([]);
  });

  it('never resolves JIT products while Pay & Send is disabled', async () => {
    // The shipped .env.example carries a "price_..." placeholder with JIT off.
    // Resolving it would fail forever and pin readiness on a product nothing
    // sells (#278 review).
    vi.stubEnv('STRIPE_JIT_LETTER_PRICE_ID', 'price_placeholder');
    const retriever = healthyRetriever();
    setPriceRetriever(retriever);

    await ensurePriceCatalog();

    expect(retriever).not.toHaveBeenCalledWith('price_placeholder');
    expect(getUnpricedProducts()).toEqual([]);
  });

  it('classifies a typo id as configuration and an outage as transient', async () => {
    setPriceRetriever(
      vi.fn(async (priceId: string) => {
        if (priceId === 'price_starter') {
          throw Object.assign(new Error('No such price'), { code: 'resource_missing' });
        }
        if (priceId === 'price_regular') {
          throw Object.assign(new Error('down'), { type: 'StripeConnectionError' });
        }
        return priceFixture({ id: priceId, unit_amount: 9000 });
      })
    );

    await ensurePriceCatalog();

    // A typo'd id needs a human; conflating it with a blip sent operators to
    // the wrong subsystem in #213. The class stays VERBATIM - an earlier
    // revision overwrote resource_missing with configuration_error, throwing
    // away the one thing that names what is actually wrong - and terminality
    // is carried alongside it instead (#278 review round 3).
    expect(getPriceResolutionFailure('credit-pack-4')).toMatchObject({
      rule: 'price.lookup_failed',
      diagnosticClass: 'resource_missing',
      terminal: true
    });
    expect(getPriceResolutionFailure('credit-pack-10')).toMatchObject({
      rule: 'price.lookup_failed',
      diagnosticClass: 'StripeConnectionError',
      terminal: false
    });
  });

  it('re-attempts a failed product after the cooldown, so a blip is not sticky', async () => {
    vi.useFakeTimers();
    let failing = true;
    const retriever = vi.fn(async (priceId: string) => {
      if (failing) throw new Error('transient');
      return priceFixture({ id: priceId, unit_amount: PACK_AMOUNTS[priceId] });
    });
    setPriceRetriever(retriever);

    await ensurePriceCatalog();
    expect(getResolvedPriceForProduct('credit-pack-4')).toBeNull();

    // Within the cooldown: no hammering Stripe during an outage.
    failing = false;
    await ensurePriceCatalog();
    expect(getResolvedPriceForProduct('credit-pack-4')).toBeNull();

    vi.advanceTimersByTime(31_000);
    await ensurePriceCatalog();
    expect(getResolvedPriceForProduct('credit-pack-4')?.unitAmount).toBe(500);
    expect(getUnpricedProducts()).toEqual([]);
  });

  it('reports every enabled product unpriced on a cold catalog', async () => {
    // The readiness question. "No failures" must not read as healthy when
    // nothing has resolved - that was the false-green the review caught twice.
    expect(getUnpricedProducts().map(f => f.productCode).sort()).toEqual([
      'credit-pack-10',
      'credit-pack-100',
      'credit-pack-4'
    ]);
    expect(getUnpricedProducts()[0]).toMatchObject({ rule: 'price.not_resolved' });
  });

  it('reports an unconfigured price id as a configuration fault', async () => {
    vi.stubEnv('STRIPE_PRICE_POWER', '');
    setPriceRetriever(healthyRetriever());

    await ensurePriceCatalog();

    expect(getPriceResolutionFailure('credit-pack-100')).toMatchObject({
      rule: 'price.id_not_configured',
      diagnosticClass: 'configuration_error'
    });
  });

  it('refuses Pay & Send pointed at a pack price - the $90.00 letter (#278 r2)', async () => {
    // STRIPE_JIT_LETTER_PRICE_ID pasted with the Power pack's price id: the
    // lookup succeeds and the Price is perfectly healthy, but 9000 does not
    // equal the letter's 499 pin. Round 2's shared-id heuristic caught this
    // only for byte-identical configured ids; the pin catches ANY id that
    // resolves to the wrong figure.
    vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
    vi.stubEnv('STRIPE_JIT_LETTER_PRICE_ID', 'price_power');
    vi.stubEnv('STRIPE_JIT_POSTCARD_PRICE_ID', 'price_jit_postcard');
    setPriceRetriever(healthyRetriever({ price_jit_postcard: { unit_amount: 499 } }));

    await ensurePriceCatalog();

    expect(getResolvedPriceForProduct('jit-letter')).toBeNull();
    expect(getPriceResolutionFailure('jit-letter')).toMatchObject({
      rule: 'price.amount_mismatch',
      terminal: true
    });
    // Uninvolved products still price - one bad pairing must not close the store.
    expect(getResolvedPriceForProduct('credit-pack-4')?.unitAmount).toBe(500);
    expect(getResolvedPriceForProduct('credit-pack-100')?.unitAmount).toBe(9000);
    expect(getResolvedPriceForProduct('jit-postcard')?.unitAmount).toBe(499);
  });

  it('refuses a recurring price, which checkout would only reject after the order exists', async () => {
    // mode:'payment' cannot use a subscription Price. Stripe says so at
    // sessions.create - AFTER the authoritative order row is written - so
    // without this rule the product reports priced, readiness reports green,
    // and every order strands in checkout_creation_failed (#278 review r2).
    setPriceRetriever(
      healthyRetriever({
        price_power: { recurring: { interval: 'month' }, type: 'recurring' }
      })
    );

    await ensurePriceCatalog();

    expect(getPriceResolutionFailure('credit-pack-100')).toMatchObject({
      rule: 'price.not_one_time',
      diagnosticClass: 'configuration_error'
    });
    expect(getResolvedPriceForProduct('credit-pack-100')).toBeNull();
  });

  it('normalizes the CONFIGURED currency, not just the one Stripe returns', async () => {
    // The producer is the only trimmer: validate() compares
    // `currency !== product.expectedCurrency` with no further normalization, so
    // a Railway field holding a trailing space would fail every pack with
    // price.currency_mismatch, back off to 15 minutes, and refuse every
    // purchase. The deleted stage-B suite was the only thing pinning this, and
    // its replacement pinned the Stripe side only (#278 review round 3).
    vi.stubEnv('STRIPE_CURRENCY', '  USD  ');
    setPriceRetriever(healthyRetriever());

    await ensurePriceCatalog();

    expect(getResolvedPriceForProduct('credit-pack-4')?.currency).toBe('usd');
    expect(getUnpricedProducts()).toEqual([]);
  });

  it('normalizes a padded, upper-cased currency before comparing it', async () => {
    // The trim/lowercase gates every purchase, and the deleted stage-B suite
    // was the only thing pinning it (#278 review round 2).
    setPriceRetriever(healthyRetriever({ price_power: { currency: '  USD  ' } }));

    await ensurePriceCatalog();

    expect(getResolvedPriceForProduct('credit-pack-100')).toMatchObject({
      unitAmount: 9000,
      currency: 'usd'
    });
  });

  it('backs a terminal failure off instead of re-reading a broken price forever', async () => {
    vi.useFakeTimers();
    const retriever = vi.fn(async (priceId: string) => {
      if (priceId === 'price_power') {
        throw Object.assign(new Error('No such price'), { code: 'resource_missing' });
      }
      return priceFixture({ id: priceId, unit_amount: PACK_AMOUNTS[priceId] });
    });
    setPriceRetriever(retriever);
    const powerReads = () => retriever.mock.calls.filter(call => call[0] === 'price_power').length;

    await ensurePriceCatalog();
    expect(powerReads()).toBe(1);

    vi.advanceTimersByTime(31_000);
    await ensurePriceCatalog();
    expect(powerReads()).toBe(2);

    // A flat 30s cooldown would read a third time here. Only a human can fix a
    // typo'd id, and 2 reads/minute forever is ~86,400 a month against a
    // 10,000/month floor - spent when there are no transactions earning it.
    vi.advanceTimersByTime(31_000);
    await ensurePriceCatalog();
    expect(powerReads()).toBe(2);
  });

  it('retries a TRANSIENT failure within seconds, backing off as it persists', async () => {
    // A blip must self-heal fast - readiness holds an unready verdict for one
    // second, and a 30s first cooldown made its "self-heals within the TTL"
    // docblock arithmetically false while refusing every purchase of the
    // affected product for the duration (#278 review round 4). But flat-fast
    // is only safe if every permanent fault is classed terminal, and a
    // revoked key is not - so the ladder still doubles toward its ceiling.
    vi.useFakeTimers();
    const retriever = vi.fn(async (priceId: string) => {
      if (priceId === 'price_power') {
        throw Object.assign(new Error('down'), { type: 'StripeConnectionError' });
      }
      return priceFixture({ id: priceId, unit_amount: PACK_AMOUNTS[priceId] });
    });
    setPriceRetriever(retriever);
    const powerReads = () => retriever.mock.calls.filter(call => call[0] === 'price_power').length;

    await ensurePriceCatalog();
    expect(powerReads()).toBe(1);

    // First retry after ~2s, not 30.
    vi.advanceTimersByTime(2_100);
    await ensurePriceCatalog();
    expect(powerReads()).toBe(2);

    // The ladder doubled to 4s, so another 2.1s is not enough...
    vi.advanceTimersByTime(2_100);
    await ensurePriceCatalog();
    expect(powerReads()).toBe(2);

    // ...but it comes back, unlike a terminal fault at this point.
    vi.advanceTimersByTime(2_100);
    await ensurePriceCatalog();
    expect(powerReads()).toBe(3);
  });

  it('lets a one-blip warmup self-heal on the first purchase seconds later', async () => {
    // The concrete customer story behind the ladder base: Stripe hiccups for
    // one second during the post-listen warmup, and the first customer
    // arrives three seconds later. With the old 30s cooldown their purchase
    // was refused; origin/dev (which never cached a failed lookup) would have
    // served them, so this pins the regression closed (#278 review round 4).
    vi.useFakeTimers();
    let blip = true;
    setPriceRetriever(
      vi.fn(async (priceId: string) => {
        if (blip) throw Object.assign(new Error('down'), { type: 'StripeConnectionError' });
        return priceFixture({ id: priceId, unit_amount: PACK_AMOUNTS[priceId] });
      })
    );

    await ensurePriceCatalog(); // the warmup, mid blip
    expect(getResolvedPriceForProduct('credit-pack-4')).toBeNull();

    blip = false;
    vi.advanceTimersByTime(3_000);
    await ensurePriceCatalog('credit-pack-4'); // the customer

    expect(getResolvedPriceForProduct('credit-pack-4')?.unitAmount).toBe(500);
  });

  it('restarts the ladder when a fault changes kind', async () => {
    // Transient and terminal failures shared one counter, so a five-minute
    // outage could leave it at ~10 and the FIRST terminal fault after it
    // started at the 15-minute ceiling - an operator who then un-archives the
    // Price in Stripe (no redeploy) waits that out with production refusing
    // every purchase (#278 review round 3).
    vi.useFakeTimers();
    let mode: 'blip' | 'archived' = 'blip';
    const retriever = vi.fn(async (priceId: string) => {
      if (priceId !== 'price_power') {
        return priceFixture({ id: priceId, unit_amount: PACK_AMOUNTS[priceId] });
      }
      if (mode === 'blip') throw Object.assign(new Error('down'), { type: 'StripeConnectionError' });
      return priceFixture({ id: priceId, unit_amount: 9000, active: false });
    });
    setPriceRetriever(retriever);
    const powerReads = () => retriever.mock.calls.filter(call => call[0] === 'price_power').length;

    // Four transient failures: the ladder is well up (2s, 4s, 8s, 16s).
    for (const wait of [0, 2_100, 4_100, 8_100]) {
      vi.advanceTimersByTime(wait);
      await ensurePriceCatalog();
    }
    expect(powerReads()).toBe(4);

    // The outage clears and the real fault appears: a different kind, so the
    // ladder starts over at the terminal base (30s) rather than inheriting a
    // 4-deep transient count.
    vi.advanceTimersByTime(16_100);
    mode = 'archived';
    await ensurePriceCatalog();
    expect(getPriceResolutionFailure('credit-pack-100')).toMatchObject({
      rule: 'price.inactive',
      terminal: true
    });

    vi.advanceTimersByTime(31_000);
    await ensurePriceCatalog();
    expect(powerReads()).toBe(6);
  });

  it('a late repoint onto an already-sold price id cannot missell either side', async () => {
    // Sequencing variant of the shared-id case: credit-pack-4 resolves
    // healthily FIRST, then the Power tier is mistyped onto the same id. The
    // pin's verdict is per-product and order-free: the Starter's memo still
    // matches its own pin and keeps selling; the Power tier resolves 500
    // against 9000 and is refused. No revocation machinery required - round
    // 4's revocation was order-dependent, and its sticky variant deadlocked a
    // partially-fixed config (#278 rounds 4-5).
    setPriceRetriever(healthyRetriever());

    await ensurePriceCatalog();
    expect(getResolvedPriceForProduct('credit-pack-4')?.unitAmount).toBe(500);

    vi.stubEnv('STRIPE_PRICE_POWER', 'price_starter');
    await ensurePriceCatalog();

    expect(getResolvedPriceForProduct('credit-pack-4')?.unitAmount).toBe(500);
    expect(getResolvedPriceForProduct('credit-pack-100')).toBeNull();
    expect(getPriceResolutionFailure('credit-pack-100')).toMatchObject({
      rule: 'price.amount_mismatch',
      terminal: true
    });
  });

  it('drops a memo whose price id has been repointed', async () => {
    // unit_amount and currency are immutable on a Price, so memoizing forever
    // is sound - but only for the id that produced it. Prune cleaned failures
    // and attempts and left `resolved` alone, so a repointed env var kept
    // charging the old amount with readiness green (#278 review round 3).
    setPriceRetriever(healthyRetriever({ price_starter: { unit_amount: 500 } }));
    await ensurePriceCatalog();
    expect(getResolvedPriceForProduct('credit-pack-4')?.unitAmount).toBe(500);

    vi.stubEnv('STRIPE_PRICE_STARTER', 'price_starter_v2');
    setPriceRetriever(healthyRetriever({ price_starter_v2: { unit_amount: 500 } }));
    await ensurePriceCatalog('credit-pack-4');

    expect(getResolvedPriceForProduct('credit-pack-4')).toMatchObject({
      priceId: 'price_starter_v2',
      unitAmount: 500
    });
  });

  it('does no work for a product this deployment does not sell', async () => {
    // Pay & Send is disabled by default, so both quote paths name a product
    // that is not in the table. Such a product can never be in `resolved`, so
    // without an early return every quote took the full slow path and could
    // block on a pack lookup it has no use for (#278 review round 3).
    const retriever = healthyRetriever();
    setPriceRetriever(retriever);

    await ensurePriceCatalog('jit-letter');

    expect(retriever).not.toHaveBeenCalled();
  });

  it('does not make an already-priced product wait on another product hanging', async () => {
    // ensurePriceCatalog checked inFlight before looking at anything, so one
    // hung Pay & Send lookup stalled every pack checkout and every quote for
    // the length of the batch - which the readiness probe can start, from an
    // unauthenticated route (#278 review round 2).
    setPriceRetriever(healthyRetriever());
    await ensurePriceCatalog();
    expect(getResolvedPriceForProduct('credit-pack-4')?.unitAmount).toBe(500);

    vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
    vi.stubEnv('STRIPE_JIT_LETTER_PRICE_ID', 'price_jit_letter');
    vi.stubEnv('STRIPE_JIT_POSTCARD_PRICE_ID', 'price_jit_postcard');
    // Never settles.
    setPriceRetriever(vi.fn(() => new Promise<never>(() => {})));

    const stalled = ensurePriceCatalog();
    void stalled.catch(() => undefined);

    expect(await settlesPromptly(ensurePriceCatalog('credit-pack-4'))).toBe(true);
    // And a caller that genuinely needs the hanging product still waits for it.
    expect(await settlesPromptly(ensurePriceCatalog('jit-letter'))).toBe(false);
  });

  it('refuses BOTH transposed tiers, independently of resolution order', async () => {
    // The round-4/5 headline. Transposed STRIPE_PRICE_* env vars are each a
    // healthy, active, one-time, plausible Price, so no per-price heuristic
    // can refuse them - and the round-4 tier-ordering replacement leaked
    // whenever the partner tiers were unresolved, because it could only
    // compare tiers that had already resolved. The pin needs no partner:
    // each tier checks its OWN resolved amount against its OWN table entry,
    // so the verdict cannot depend on what else has resolved (#278 round 5).
    setPriceRetriever(
      healthyRetriever({
        price_starter: { unit_amount: 9000 }, // the Power price
        price_power: { unit_amount: 500 } // the Starter price
      })
    );

    await ensurePriceCatalog();

    for (const productCode of ['credit-pack-4', 'credit-pack-100']) {
      expect(getResolvedPriceForProduct(productCode), productCode).toBeNull();
      expect(getPriceResolutionFailure(productCode), productCode).toMatchObject({
        rule: 'price.amount_mismatch',
        diagnosticClass: 'configuration_error',
        terminal: true
      });
    }
    // The untransposed middle tier is genuinely fine and keeps selling.
    expect(getResolvedPriceForProduct('credit-pack-10')?.unitAmount).toBe(1000);
    // And readiness sees exactly the two.
    expect(
      getUnpricedProducts().map(f => `${f.productCode}:${f.rule}`).sort()
    ).toEqual([
      'credit-pack-100:price.amount_mismatch',
      'credit-pack-4:price.amount_mismatch'
    ]);
  });

  it('refuses a transposed tier even when its partners are unresolved', async () => {
    // The exact leak that killed the ordering heuristic: partners blip during
    // warmup, the transposed tier resolves ALONE - and used to sell at the
    // wrong price because there was no pair to compare. The pin refuses it
    // with zero knowledge of the other tiers (#278 round 5, reproduced).
    setPriceRetriever(
      vi.fn(async (priceId: string) => {
        if (priceId !== 'price_power') {
          throw Object.assign(new Error('blip'), { type: 'StripeConnectionError' });
        }
        // Transposed: the Power id points at the real $5.00 starter Price.
        return priceFixture({ id: priceId, unit_amount: 500 });
      })
    );

    await ensurePriceCatalog();

    expect(getResolvedPriceForProduct('credit-pack-100')).toBeNull();
    expect(getPriceResolutionFailure('credit-pack-100')).toMatchObject({
      rule: 'price.amount_mismatch',
      terminal: true
    });
  });

  it('refuses an in-band repoint that every heuristic accepted', async () => {
    // Round 5's quantified hole: STRIPE_PRICE_REGULAR repointed to an
    // unrelated $12.00 Price - active, one-time, inside any sane band, and
    // ordering correctly between the $5 and $90 tiers. The ordering check
    // bounded the middle tier to roughly [900..1250] and this sailed through;
    // the pin refuses anything but exactly 1000.
    setPriceRetriever(healthyRetriever({ price_regular: { unit_amount: 1200 } }));

    await ensurePriceCatalog();

    expect(getResolvedPriceForProduct('credit-pack-10')).toBeNull();
    expect(getPriceResolutionFailure('credit-pack-10')).toMatchObject({
      rule: 'price.amount_mismatch',
      terminal: true
    });
    expect(getResolvedPriceForProduct('credit-pack-4')?.unitAmount).toBe(500);
  });

  it('refuses swapped Pay & Send ids the moment their pins differ', async () => {
    // The JIT gap round 5 opened with: letter and postcard swapped. Today
    // both pin at 499 so a swap is harmless BY THE PIN'S OWN LOGIC - the
    // amounts agree, nothing is missold, and that is also exactly why the
    // two may share one Price. This case pins the mechanism with divergent
    // amounts served by the retriever instead.
    vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
    vi.stubEnv('STRIPE_JIT_LETTER_PRICE_ID', 'price_jit_letter');
    vi.stubEnv('STRIPE_JIT_POSTCARD_PRICE_ID', 'price_jit_postcard');
    setPriceRetriever(
      healthyRetriever({
        price_jit_letter: { unit_amount: 299 }, // not the letter's 499 pin
        price_jit_postcard: { unit_amount: 499 }
      })
    );

    await ensurePriceCatalog();

    expect(getResolvedPriceForProduct('jit-letter')).toBeNull();
    expect(getPriceResolutionFailure('jit-letter')).toMatchObject({
      rule: 'price.amount_mismatch',
      terminal: true
    });
    expect(getResolvedPriceForProduct('jit-postcard')?.unitAmount).toBe(499);
  });

  it('reports a repointed price id as unpriced WITHOUT waiting for a resolver pass', async () => {
    // getUnpricedProducts checked bare memo membership, so after a repoint
    // /readyz reported ok - and because its re-attempt kick is gated on
    // !pricesOk, the false green also suppressed the self-heal (#278 r4).
    setPriceRetriever(healthyRetriever());
    await ensurePriceCatalog();
    expect(getUnpricedProducts()).toEqual([]);

    vi.stubEnv('STRIPE_PRICE_POWER', 'price_power_v2');

    expect(getUnpricedProducts().map(f => f.productCode)).toEqual(['credit-pack-100']);
  });

  it('re-attempts immediately after a repoint, not after the old id cooldown', async () => {
    // Failures and cooldowns now carry the price id they were recorded
    // against. Without that, an operator who FIXED the configuration still
    // waited out up to 15 minutes of 503 on the old id's terminal cooldown
    // (#278 review round 4).
    setPriceRetriever(
      vi.fn(async (priceId: string) => {
        if (priceId === 'price_power') return priceFixture({ id: priceId, active: false });
        return priceFixture({ id: priceId, unit_amount: PACK_AMOUNTS[priceId] });
      })
    );
    await ensurePriceCatalog();
    expect(getPriceResolutionFailure('credit-pack-100')).toMatchObject({
      rule: 'price.inactive',
      terminal: true
    });

    // Operator repoints to a healthy Price. No timers advance: the stale
    // cooldown must not gate the fixed configuration.
    vi.stubEnv('STRIPE_PRICE_POWER', 'price_power_v2');
    setPriceRetriever(healthyRetriever({ price_power_v2: { unit_amount: 9000 } }));
    await ensurePriceCatalog('credit-pack-100');

    expect(getResolvedPriceForProduct('credit-pack-100')).toMatchObject({
      priceId: 'price_power_v2',
      unitAmount: 9000
    });
  });

  it('looks a due product up immediately even while an unrelated lookup hangs', async () => {
    // The single-slot batch made a due-but-unresolved product either wait out
    // a foreign batch or - after bounded waits - return silently unresolved
    // with no failure recorded, refusing a correctly configured purchase.
    // Per-product flights: a caller awaits the flight resolving ITS product
    // or starts one (#278 review round 4).
    vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
    vi.stubEnv('STRIPE_JIT_LETTER_PRICE_ID', 'price_jit_letter');
    vi.stubEnv('STRIPE_JIT_POSTCARD_PRICE_ID', 'price_jit_letter');
    let hangJit = false;
    setPriceRetriever(
      vi.fn((priceId: string) => {
        if (priceId === 'price_jit_letter' && hangJit) return new Promise<never>(() => {});
        if (priceId === 'price_jit_letter') {
          return Promise.reject(Object.assign(new Error('down'), { type: 'StripeConnectionError' }));
        }
        return Promise.resolve(priceFixture({ id: priceId, unit_amount: PACK_AMOUNTS[priceId] }) as never);
      })
    );
    vi.useFakeTimers();

    // Round one: packs resolve, JIT blips. Then the JIT lookup starts hanging.
    await ensurePriceCatalog();
    expect(getResolvedPriceForProduct('credit-pack-4')?.unitAmount).toBe(500);
    hangJit = true;
    vi.advanceTimersByTime(2_100);
    const hungFlight = ensurePriceCatalog('jit-letter');
    void hungFlight.catch(() => undefined);

    // A repointed pack is due NOW; its lookup must not queue behind the hang.
    vi.stubEnv('STRIPE_PRICE_STARTER', 'price_starter_v2');
    setPriceRetriever(
      vi.fn((priceId: string) => {
        if (priceId === 'price_jit_letter') return new Promise<never>(() => {});
        return Promise.resolve(
          priceFixture({
            id: priceId,
            unit_amount: priceId === 'price_starter_v2' ? 500 : PACK_AMOUNTS[priceId]
          }) as never
        );
      })
    );
    await ensurePriceCatalog('credit-pack-4');

    expect(getResolvedPriceForProduct('credit-pack-4')).toMatchObject({
      priceId: 'price_starter_v2',
      unitAmount: 500
    });
  });

  it('fails LOUDLY when reset left no retriever, instead of faking an outage', async () => {
    // The previous "fail loudly" retriever threw inside the per-product try,
    // landed in the same catch as a network error, and was recorded as a
    // transient provider_error - byte-for-byte indistinguishable from a real
    // Stripe outage, the safer-looking of the two verdicts (#278 round 4).
    resetPriceCatalog();

    await expect(ensurePriceCatalog()).rejects.toThrow(/no retriever injected/);
    // And crucially: nothing was RECORDED as if Stripe had failed - the
    // accessor synthesizes the transient never-attempted record for any
    // configured-but-unpriced product, so assert the rule, not null.
    expect(getPriceResolutionFailure('credit-pack-4')).toMatchObject({
      rule: 'price.not_resolved'
    });
  });

  it('stops serving a memo when STRIPE_CURRENCY changes out from under it', async () => {
    // Memo staleness used to be keyed on the price id alone, so an in-process
    // currency change kept serving a memo the current configuration would
    // refuse (#278 review round 5). Validity is now the full triple: id,
    // pinned amount, expected currency.
    setPriceRetriever(healthyRetriever());
    await ensurePriceCatalog();
    expect(getResolvedPriceForProduct('credit-pack-4')?.currency).toBe('usd');

    vi.stubEnv('STRIPE_CURRENCY', 'gbp');

    expect(getResolvedPriceForProduct('credit-pack-4')).toBeNull();
    expect(getUnpricedProducts().map(f => f.productCode)).toContain('credit-pack-4');
  });

  it('discards an in-flight lookup outrun by a repoint instead of committing it', async () => {
    // The fourth staleness surface: a lookup started for price_OLD, the env
    // repointed mid-flight, and the commit re-installed a memo for the old id
    // that the awaiting checkout then transacted against (#278 round 5,
    // reproduced). The commit now re-checks the configured id.
    let releaseOld: (value: never) => void = () => undefined;
    const oldLookup = new Promise<never>(resolve => {
      releaseOld = resolve as never;
    });
    setPriceRetriever(
      vi.fn((priceId: string) => {
        if (priceId === 'price_starter') return oldLookup;
        return Promise.resolve(
          priceFixture({ id: priceId, unit_amount: PACK_AMOUNTS[priceId] ?? 500 }) as never
        );
      })
    );

    const flight = ensurePriceCatalog('credit-pack-4');
    void flight.catch(() => undefined);

    vi.stubEnv('STRIPE_PRICE_STARTER', 'price_starter_v2');
    releaseOld(priceFixture({ id: 'price_starter', unit_amount: 500 }) as never);
    await flight;

    // The stale flight committed nothing; the next ensure resolves the NEW id.
    expect(getResolvedPriceForProduct('credit-pack-4')).toBeNull();
    await ensurePriceCatalog('credit-pack-4');
    expect(getResolvedPriceForProduct('credit-pack-4')).toMatchObject({
      priceId: 'price_starter_v2',
      unitAmount: 500
    });
  });

  it('clears a terminal cooldown the moment STRIPE_CURRENCY is fixed', async () => {
    // Round 6's reproduced asymmetry: memos keyed staleness on the full
    // configuration triple but cooldowns keyed on the price id alone, so
    // fixing the currency cleared the memo side and left the terminal ladder
    // standing - /readyz at 503 for up to 15 minutes AFTER the config was
    // correct, with zero Stripe calls. Staleness is one signature now.
    vi.stubEnv('STRIPE_CURRENCY', 'gbp'); // wrong: the Prices are USD
    setPriceRetriever(healthyRetriever());
    await ensurePriceCatalog();
    expect(getPriceResolutionFailure('credit-pack-4')).toMatchObject({
      rule: 'price.currency_mismatch',
      terminal: true
    });

    // Operator fixes the currency. No timers advance: the stale cooldown must
    // not gate the corrected configuration.
    vi.stubEnv('STRIPE_CURRENCY', 'usd');
    await ensurePriceCatalog('credit-pack-4');

    expect(getResolvedPriceForProduct('credit-pack-4')?.unitAmount).toBe(500);
  });

  it('starts a fresh lookup instead of handing back a flight the repoint doomed', async () => {
    // Round 6, reproduced: a coded ensure returned the in-flight lookup
    // started for the OLD id; its commit was staleness-suppressed, so the
    // awaiting checkout resumed with neither memo nor failure - the first
    // purchase after a repoint spuriously refused. A flight is only worth
    // awaiting if it was started for the CURRENT configuration.
    let releaseOld: (value: never) => void = () => undefined;
    const oldLookup = new Promise<never>(resolve => {
      releaseOld = resolve as never;
    });
    const served: string[] = [];
    setPriceRetriever(
      vi.fn((priceId: string) => {
        served.push(priceId);
        if (priceId === 'price_starter') return oldLookup;
        return Promise.resolve(
          priceFixture({ id: priceId, unit_amount: PACK_AMOUNTS[priceId] ?? 500 }) as never
        );
      })
    );

    const doomed = ensurePriceCatalog('credit-pack-4');
    void doomed.catch(() => undefined);

    vi.stubEnv('STRIPE_PRICE_STARTER', 'price_starter_v2');
    // A purchase arrives AFTER the repoint, while the old flight still hangs.
    const purchase = ensurePriceCatalog('credit-pack-4');
    releaseOld(priceFixture({ id: 'price_starter', unit_amount: 500 }) as never);
    await purchase;

    // The NEW id was looked up end-to-end within the purchase's own await.
    expect(served).toContain('price_starter_v2');
    expect(getResolvedPriceForProduct('credit-pack-4')).toMatchObject({
      priceId: 'price_starter_v2',
      unitAmount: 500
    });
  });

  it('clears leftover state for a product the deployment stops selling', async () => {
    // Round 6: cooldowns recorded before Pay & Send was toggled off survived
    // un-prunable (the hot paths never prune while packs are green) and
    // resurfaced verbatim on re-enable - refusing quotes for the residual
    // terminal ladder even though Stripe would now validate cleanly. The
    // unsold-product gate clears that state on the first quote after the
    // toggle.
    vi.useFakeTimers();
    vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
    vi.stubEnv('STRIPE_JIT_LETTER_PRICE_ID', 'price_jit_letter');
    vi.stubEnv('STRIPE_JIT_POSTCARD_PRICE_ID', 'price_jit_letter');
    setPriceRetriever(
      vi.fn(async (priceId: string) => {
        if (priceId === 'price_jit_letter') {
          return priceFixture({ id: priceId, unit_amount: 499, active: false });
        }
        return priceFixture({ id: priceId, unit_amount: PACK_AMOUNTS[priceId] });
      })
    );
    await ensurePriceCatalog();
    expect(getPriceResolutionFailure('jit-letter')).toMatchObject({ rule: 'price.inactive' });

    // Toggle off; the next quote's ensure hits the unsold gate and clears.
    vi.stubEnv('JIT_PURCHASE_ENABLED', 'false');
    await ensurePriceCatalog('jit-letter');

    // Operator un-archives the Price in Stripe (active IS mutable - no env
    // change) and re-enables. The first quote must look Stripe up NOW, not
    // after the residual terminal cooldown.
    vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
    setPriceRetriever(
      vi.fn(async (priceId: string) =>
        priceFixture({ id: priceId, unit_amount: priceId === 'price_jit_letter' ? 499 : PACK_AMOUNTS[priceId] })
      )
    );
    await ensurePriceCatalog('jit-letter');

    expect(getResolvedPriceForProduct('jit-letter')?.unitAmount).toBe(499);
  });

  it('classifies a missing STRIPE_SECRET_KEY as configuration, not a Stripe outage', async () => {
    // Round 6: getStripeClient's bare throw classified provider_error, so a
    // human-only credential fault retried on the transient ladder forever
    // with the log pointing at Stripe. The throw now carries its class and
    // the lookup catch prefers a carried class.
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    useDefaultPriceRetriever();

    await ensurePriceCatalog();

    expect(getPriceResolutionFailure('credit-pack-4')).toMatchObject({
      rule: 'price.lookup_failed',
      diagnosticClass: 'configuration_error',
      terminal: true
    });
  });

  it('keeps BOTH ladders climbing under alternating fault kinds', async () => {
    // One shared counter reset on every kind flip, so a typo'd id plus
    // intermittent network faults held both ladders at base forever - ~2,700
    // reads/day/product instead of the ceiling's ~96 (#278 round 7).
    vi.useFakeTimers();
    let flip = false;
    const retriever = vi.fn(async (priceId: string) => {
      if (priceId !== 'price_power') {
        return priceFixture({ id: priceId, unit_amount: PACK_AMOUNTS[priceId] });
      }
      flip = !flip;
      if (flip) throw Object.assign(new Error('down'), { type: 'StripeConnectionError' });
      throw Object.assign(new Error('gone'), { code: 'resource_missing' });
    });
    setPriceRetriever(retriever);
    const powerReads = () => retriever.mock.calls.filter(call => call[0] === 'price_power').length;

    // t1 transient (cooldown 2s) -> t2 terminal (30s) -> transient again.
    await ensurePriceCatalog(); // transient #1
    vi.advanceTimersByTime(2_100);
    await ensurePriceCatalog(); // terminal #1 -> 30s
    vi.advanceTimersByTime(30_100);
    await ensurePriceCatalog(); // transient #2 -> ladder says 4s, NOT re-based 2s
    expect(powerReads()).toBe(3);

    vi.advanceTimersByTime(2_100); // < 4s: a re-based ladder would fire here
    await ensurePriceCatalog();
    expect(powerReads()).toBe(3);

    vi.advanceTimersByTime(2_100); // 4.2s total: the climbed ladder fires
    await ensurePriceCatalog();
    expect(powerReads()).toBe(4);
  });

  it('never serves a stored failure recorded under a dead configuration', async () => {
    // The failures map was the one catalog state read WITHOUT signature
    // validation, so readiness - which computes its verdict BEFORE it kicks -
    // reported the already-fixed fault for one more probe cycle (#278 r7).
    setPriceRetriever(healthyRetriever({ price_power: { unit_amount: 500 } })); // wrong: pin is 9000
    await ensurePriceCatalog();
    expect(getPriceResolutionFailure('credit-pack-100')).toMatchObject({
      rule: 'price.amount_mismatch'
    });

    // Operator repoints. NO ensure runs - the read itself must notice.
    vi.stubEnv('STRIPE_PRICE_POWER', 'price_power_v2');

    expect(getPriceResolutionFailure('credit-pack-100')).toMatchObject({
      rule: 'price.not_resolved'
    });
    expect(
      getUnpricedProducts().find(f => f.productCode === 'credit-pack-100')
    ).toMatchObject({ rule: 'price.not_resolved' });
  });

  it('drops the MEMO too when Pay & Send is toggled off', async () => {
    // The unsold gate cleared cooldowns but spared memos, and in the steady
    // state nothing else prunes: warm pack quotes take the fast path and
    // readiness only kicks while failing. A Price archived during the
    // disabled window kept its stale memo through re-enable - quotes served
    // it, every purchase failed at session create, readiness green (#278 r8).
    vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
    vi.stubEnv('STRIPE_JIT_LETTER_PRICE_ID', 'price_jit_letter');
    vi.stubEnv('STRIPE_JIT_POSTCARD_PRICE_ID', 'price_jit_letter');
    setPriceRetriever(healthyRetriever({ price_jit_letter: { unit_amount: 499 } }));
    await ensurePriceCatalog();
    expect(getResolvedPriceForProduct('jit-letter')?.unitAmount).toBe(499);

    vi.stubEnv('JIT_PURCHASE_ENABLED', 'false');
    await ensurePriceCatalog('jit-letter'); // the unsold gate

    vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
    // Same env, same signature - but the Price was archived meanwhile.
    setPriceRetriever(
      healthyRetriever({ price_jit_letter: { unit_amount: 499, active: false } })
    );
    await ensurePriceCatalog();

    expect(getResolvedPriceForProduct('jit-letter')).toBeNull();
    expect(getUnpricedProducts().find(f => f.productCode === 'jit-letter')).toMatchObject({
      rule: 'price.inactive'
    });
  });

  it('clears the SIBLING mail type from the unsold gate, not only the quoted one', async () => {
    // Toggle-off residue was cleared per quoted code, so a postcard cooldown
    // survived a disabled window in which only letters were quoted (#278 r8).
    vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
    vi.stubEnv('STRIPE_JIT_LETTER_PRICE_ID', 'price_jit_letter');
    vi.stubEnv('STRIPE_JIT_POSTCARD_PRICE_ID', 'price_jit_postcard');
    setPriceRetriever(
      vi.fn(async (priceId: string) => {
        if (priceId === 'price_jit_postcard') {
          throw Object.assign(new Error('gone'), { code: 'resource_missing' });
        }
        return priceFixture({
          id: priceId,
          unit_amount: priceId === 'price_jit_letter' ? 499 : PACK_AMOUNTS[priceId]
        });
      })
    );
    await ensurePriceCatalog(); // postcard now under a 30s terminal cooldown

    vi.stubEnv('JIT_PURCHASE_ENABLED', 'false');
    await ensurePriceCatalog('jit-letter'); // gate hit with the OTHER code

    vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
    setPriceRetriever(
      healthyRetriever({
        price_jit_letter: { unit_amount: 499 },
        price_jit_postcard: { unit_amount: 499 }
      })
    );
    await ensurePriceCatalog('jit-postcard');

    // No residual cooldown: the fixed Price resolves immediately.
    expect(getResolvedPriceForProduct('jit-postcard')?.unitAmount).toBe(499);
  });

  it('validates a stored failure against the CALLER environment, not process.env', async () => {
    // getUnpricedProducts(env) checked memos under the threaded env but
    // stored failures under ambient - one verdict stitched from two
    // environments (#278 round 8, four angles).
    setPriceRetriever(healthyRetriever({ price_power: { unit_amount: 500 } })); // pin is 9000
    await ensurePriceCatalog();

    // Threaded env repoints: under THAT env the fault was never attempted.
    const repointed = { ...process.env, STRIPE_PRICE_POWER: 'price_power_v2' };
    expect(
      getUnpricedProducts(repointed).find(f => f.productCode === 'credit-pack-100')
    ).toMatchObject({ rule: 'price.not_resolved' });

    // Inverse: ambient repoints, the threaded env still matches the failure.
    const original = { ...process.env };
    vi.stubEnv('STRIPE_PRICE_POWER', 'price_power_v3');
    expect(
      getUnpricedProducts(original).find(f => f.productCode === 'credit-pack-100')
    ).toMatchObject({ rule: 'price.amount_mismatch' });
  });

  it('starts a fresh ladder when a flight lands across an A-B-A config flip', async () => {
    // recordFailure inherited counters from whatever attempts entry stood,
    // even one recorded under a DIFFERENT configuration - so a flight
    // landing after a flip-back started the new ladder mid-rung and refused
    // purchases longer than its own history warranted (#278 round 8).
    vi.useFakeTimers();
    let rejectOld: (error: unknown) => void = () => undefined;
    const oldLookup = new Promise<never>((_resolve, reject) => {
      rejectOld = reject;
    });
    let starterServed = 0;
    let oldHanded = false;
    setPriceRetriever(
      vi.fn((priceId: string): Promise<never> => {
        if (priceId === 'price_starter') {
          starterServed += 1;
          if (!oldHanded) {
            oldHanded = true;
            return oldLookup;
          }
          return Promise.reject(
            Object.assign(new Error('down'), { type: 'StripeConnectionError' })
          );
        }
        if (priceId === 'price_starter_v2') {
          return Promise.reject(
            Object.assign(new Error('down'), { type: 'StripeConnectionError' })
          );
        }
        return Promise.resolve(
          priceFixture({ id: priceId, unit_amount: PACK_AMOUNTS[priceId] ?? 500 }) as never
        );
      })
    );

    const doomed = ensurePriceCatalog('credit-pack-4'); // flight under A
    void doomed.catch(() => undefined);
    vi.stubEnv('STRIPE_PRICE_STARTER', 'price_starter_v2'); // B
    await ensurePriceCatalog('credit-pack-4'); // fails under B: B's rung 1
    vi.stubEnv('STRIPE_PRICE_STARTER', 'price_starter'); // back to A
    rejectOld(Object.assign(new Error('down'), { type: 'StripeConnectionError' }));
    await doomed; // lands under current==A, beside B's attempts entry

    // A's rung 1 cools 2s. An inherited rung 2 would still be cooling at 2.1s.
    vi.advanceTimersByTime(2_100);
    const before = starterServed;
    await ensurePriceCatalog('credit-pack-4');
    expect(starterServed).toBe(before + 1);
  });

  it('drops a stale failure when its product stops being configured', async () => {
    vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
    vi.stubEnv('STRIPE_JIT_LETTER_PRICE_ID', 'price_gone');
    vi.stubEnv('STRIPE_JIT_POSTCARD_PRICE_ID', 'price_gone');
    setPriceRetriever(
      vi.fn(async (priceId: string) => {
        if (priceId === 'price_gone') {
          throw Object.assign(new Error('nope'), { code: 'resource_missing' });
        }
        return priceFixture({ id: priceId, unit_amount: PACK_AMOUNTS[priceId] });
      })
    );
    await ensurePriceCatalog();
    expect(getPriceResolutionFailure('jit-letter')).not.toBeNull();

    // Operator switches Pay & Send off; its failure must not pin readiness.
    vi.stubEnv('JIT_PURCHASE_ENABLED', 'false');
    await ensurePriceCatalog();

    expect(getPriceResolutionFailure('jit-letter')).toBeNull();
    expect(getUnpricedProducts()).toEqual([]);
  });
});
