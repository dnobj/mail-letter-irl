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
  getPriceCatalogFailures,
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
      rule: 'price.shared_between_pack_tiers',
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
    // the wrong subsystem in #213.
    expect(getPriceResolutionFailure('credit-pack-4')).toMatchObject({
      rule: 'price.lookup_failed',
      diagnosticClass: 'configuration_error'
    });
    expect(getPriceResolutionFailure('credit-pack-10')).toMatchObject({
      rule: 'price.lookup_failed',
      diagnosticClass: 'StripeConnectionError'
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
    expect(getPriceCatalogFailures()).toEqual([]);
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
