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
  ensurePriceCatalog,
  getPriceResolutionFailure,
  getResolvedPriceForProduct,
  getUnpricedProducts,
  resetPriceCatalog,
  setPriceRetriever
} from '../../../src/services/priceCatalog.js';
import { priceFixture } from '../../mocks/stripe.js';

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
      ['implausibly small', { unit_amount: 1 }, 'price.amount_out_of_range'],
      ['implausibly large', { unit_amount: 500_000 }, 'price.amount_out_of_range'],
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

  it('refuses BOTH pack tiers when they share one price id', async () => {
    // The Power-at-Starter's-price missell: each lookup succeeds on its own,
    // only the set is wrong, and before #275 the amount cross-check caught it.
    vi.stubEnv('STRIPE_PRICE_POWER', 'price_starter');
    setPriceRetriever(healthyRetriever());

    await ensurePriceCatalog();

    expect(getResolvedPriceForProduct('credit-pack-4')).toBeNull();
    expect(getResolvedPriceForProduct('credit-pack-100')).toBeNull();
    expect(getPriceResolutionFailure('credit-pack-100')).toMatchObject({
      rule: 'price.shared_between_products',
      diagnosticClass: 'configuration_error'
    });
    // The uninvolved tier still prices.
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

  it('refuses a pack AND a Pay & Send product that share one price id', async () => {
    // The missell the round-2 review found: the first rework counted only
    // pack-to-pack sharing, so pointing STRIPE_JIT_LETTER_PRICE_ID at the
    // Power pack's price passed every check - both products resolved, one
    // letter was charged $90.00, the webhook's paid-amount comparison agreed
    // because Stripe really had charged that, and /readyz stayed green.
    vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
    vi.stubEnv('STRIPE_JIT_LETTER_PRICE_ID', 'price_power');
    vi.stubEnv('STRIPE_JIT_POSTCARD_PRICE_ID', 'price_jit_postcard');
    setPriceRetriever(healthyRetriever({ price_jit_postcard: { unit_amount: 499 } }));

    await ensurePriceCatalog();

    expect(getResolvedPriceForProduct('jit-letter')).toBeNull();
    expect(getResolvedPriceForProduct('credit-pack-100')).toBeNull();
    for (const productCode of ['jit-letter', 'credit-pack-100']) {
      expect(getPriceResolutionFailure(productCode), productCode).toMatchObject({
        rule: 'price.shared_between_products',
        diagnosticClass: 'configuration_error'
      });
    }
    // Uninvolved products still price - one bad pairing must not close the store.
    expect(getResolvedPriceForProduct('credit-pack-4')?.unitAmount).toBe(500);
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

  it('refuses a zero-decimal-currency price under the two-decimal default band', async () => {
    // ~₩126,000 is an ordinary Power-pack price and unit_amount is whole won,
    // so the number sails past a ceiling calibrated in cents. The band cannot
    // be made currency-universal by arithmetic - that needs an exchange rate -
    // so the honest behaviour is to refuse loudly and be configurable, not to
    // pretend (#278 review round 2).
    vi.stubEnv('STRIPE_CURRENCY', 'krw');
    setPriceRetriever(healthyRetriever({ price_power: { unit_amount: 126_000, currency: 'krw' } }));

    await ensurePriceCatalog();

    expect(getPriceResolutionFailure('credit-pack-100')).toMatchObject({
      rule: 'price.amount_out_of_range',
      diagnosticClass: 'configuration_error'
    });
  });

  it('accepts it once the deployment configures the band for its currency', async () => {
    vi.stubEnv('STRIPE_CURRENCY', 'krw');
    vi.stubEnv('STRIPE_PRICE_MIN_UNIT_AMOUNT', '100');
    vi.stubEnv('STRIPE_PRICE_MAX_UNIT_AMOUNT', '10000000');
    setPriceRetriever(
      healthyRetriever({
        price_starter: { unit_amount: 7_000, currency: 'krw' },
        price_regular: { unit_amount: 14_000, currency: 'krw' },
        price_power: { unit_amount: 126_000, currency: 'krw' }
      })
    );

    await ensurePriceCatalog();

    expect(getResolvedPriceForProduct('credit-pack-100')).toMatchObject({
      unitAmount: 126_000,
      currency: 'krw'
    });
    expect(getUnpricedProducts()).toEqual([]);
  });

  it('refuses a band value with a numeric separator instead of silently truncating it', async () => {
    // `Number.parseInt('100_000')` is 100. That is the exact form this file's
    // own comment prints, so an operator copying it would have collapsed the
    // ceiling to $1.00 and failed every real price as a terminal configuration
    // fault, with nothing naming the discarded value (#278 review round 3).
    vi.stubEnv('STRIPE_PRICE_MAX_UNIT_AMOUNT', '100_000');
    setPriceRetriever(healthyRetriever());

    await ensurePriceCatalog();

    // Falls back to the default ceiling, so the healthy fixture still prices.
    expect(getResolvedPriceForProduct('credit-pack-100')?.unitAmount).toBe(9000);
    expect(getUnpricedProducts()).toEqual([]);
  });

  it('ignores an inverted band rather than making every price unsellable', async () => {
    vi.stubEnv('STRIPE_PRICE_MIN_UNIT_AMOUNT', '90000');
    vi.stubEnv('STRIPE_PRICE_MAX_UNIT_AMOUNT', '100');
    setPriceRetriever(healthyRetriever());

    await ensurePriceCatalog();

    // Falls back to the defaults, which the healthy fixture satisfies.
    expect(getUnpricedProducts()).toEqual([]);
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

  it('retries a TRANSIENT failure sooner than a terminal one, but still backs off', async () => {
    // A blip must self-heal quickly or /readyz kicking a re-attempt stops
    // meaning anything - but a FLAT transient cooldown is only safe if every
    // permanent fault is classed terminal, and a revoked key is not. So
    // transient backs off too, to a much lower ceiling (#278 review round 3).
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

    // First retry is still fast: 30s.
    vi.advanceTimersByTime(31_000);
    await ensurePriceCatalog();
    expect(powerReads()).toBe(2);

    // Second waits 60s, so 31s more is not enough...
    vi.advanceTimersByTime(31_000);
    await ensurePriceCatalog();
    expect(powerReads()).toBe(2);

    // ...but it does come back, unlike a terminal fault at this point.
    vi.advanceTimersByTime(31_000);
    await ensurePriceCatalog();
    expect(powerReads()).toBe(3);
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

    // Four transient failures: the ladder is well up (30s, 60s, 120s, 240s).
    for (const wait of [0, 31_000, 61_000, 121_000]) {
      vi.advanceTimersByTime(wait);
      await ensurePriceCatalog();
    }
    expect(powerReads()).toBe(4);

    // The outage clears and the real fault appears: a different kind, so the
    // ladder starts over at 30s rather than inheriting a 4-deep transient one.
    vi.advanceTimersByTime(241_000);
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

  it('revokes an already-priced product that turns out to share its price id', async () => {
    // The missell surviving through a different door: the offender set is
    // computed over every configured product, but was consulted only for
    // members of the current batch, and the due filter excludes anything
    // resolved. So when the two sharers landed in different batches, the first
    // kept its memo and went on selling at the other's price for the life of
    // the process (#278 review round 3).
    setPriceRetriever(healthyRetriever());

    // Batch one: a healthy configuration. Both tiers resolve to their own
    // Price, and credit-pack-4 is memoized at $5.00.
    await ensurePriceCatalog();
    expect(getResolvedPriceForProduct('credit-pack-4')?.unitAmount).toBe(500);

    // An operator now mistypes the Power tier onto the Starter's price id. The
    // sharing did not exist when credit-pack-4 resolved, so its memo predates
    // the fault entirely.
    vi.stubEnv('STRIPE_PRICE_POWER', 'price_starter');
    await ensurePriceCatalog();

    // BOTH must be refused. Before this, only the tier that happened to be in
    // the batch was, and credit-pack-4 went on selling 4 credits at whatever
    // the shared Price says for the life of the process.
    for (const productCode of ['credit-pack-4', 'credit-pack-100']) {
      expect(getResolvedPriceForProduct(productCode), productCode).toBeNull();
      expect(getPriceResolutionFailure(productCode), productCode).toMatchObject({
        rule: 'price.shared_between_products',
        terminal: true
      });
    }
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
    setPriceRetriever(healthyRetriever({ price_starter_v2: { unit_amount: 700 } }));
    await ensurePriceCatalog('credit-pack-4');

    expect(getResolvedPriceForProduct('credit-pack-4')).toMatchObject({
      priceId: 'price_starter_v2',
      unitAmount: 700
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
