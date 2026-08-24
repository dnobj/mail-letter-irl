/**
 * Issue #275 stage A. Prices resolve from Stripe once at startup; the
 * STRIPE_*_AMOUNT_CENTS variables are gone.
 *
 * That deletion removed a crude but real safety net. Two copies of a figure
 * could disagree - the bug - but comparing them also caught a mistyped price
 * id, because a wrong id pointed at a different amount. With one copy there is
 * nothing to compare, so the load has to establish that a price is the RIGHT
 * price rather than re-reading the same number twice.
 *
 * Several cases here are relocated, not new: deploymentConfig.test.ts used to
 * assert that a missing, zero, or non-integer pack amount was a boot error.
 * The intent - a purchase must never proceed without a trustworthy amount -
 * is enforced here now.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockPriceRetrieve } = vi.hoisted(() => ({ mockPriceRetrieve: vi.fn() }));

vi.mock('stripe', () => ({
  default: class MockStripe {
    prices = { retrieve: mockPriceRetrieve };
    checkout = { sessions: { create: vi.fn() } };
    webhooks = { constructEvent: vi.fn() };
  }
}));

const { loadPriceCatalog, getResolvedPrice, isPriceCatalogLoaded, getPriceCatalogFailures, resetPriceCatalog } =
  await import('../../../src/services/priceCatalog.js');

const GOOD = { active: true, unit_amount: 1000, currency: 'usd', product: 'prod_regular' };

describe('price catalog (#275 stage A)', () => {
  beforeEach(() => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_dummy');
    vi.stubEnv('STRIPE_CURRENCY', 'usd');
    mockPriceRetrieve.mockReset();
    resetPriceCatalog();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('resolves the amount from the price, so there is no second copy to drift', async () => {
    mockPriceRetrieve.mockResolvedValue(GOOD);

    await loadPriceCatalog(['price_regular']);

    expect(getResolvedPrice('price_regular')).toMatchObject({
      unitAmount: 1000,
      currency: 'usd',
      productId: 'prod_regular'
    });
    expect(isPriceCatalogLoaded()).toBe(true);
  });

  it('freezes what it caches, so nothing downstream can mutate a shared figure', async () => {
    // The one real corruption path is our own code holding a reference - not
    // the memory the number sits in.
    mockPriceRetrieve.mockResolvedValue(GOOD);
    await loadPriceCatalog(['price_regular']);

    const resolved = getResolvedPrice('price_regular')!;
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(() => {
      (resolved as { unitAmount: number }).unitAmount = 1;
    }).toThrow();
    expect(getResolvedPrice('price_regular')?.unitAmount).toBe(1000);
  });

  describe('refuses a price that is not the right price', () => {
    // Each of these would have been caught before by disagreeing with
    // STRIPE_*_AMOUNT_CENTS. With that copy deleted, they have to be caught here.
    const cases: Array<[string, unknown, string]> = [
      ['archived', { ...GOOD, active: false }, 'price.inactive'],
      ['no unit amount (tiered/metered)', { ...GOOD, unit_amount: null }, 'price.no_unit_amount'],
      ['zero', { ...GOOD, unit_amount: 0 }, 'price.amount_out_of_range'],
      ['implausibly small', { ...GOOD, unit_amount: 1 }, 'price.amount_out_of_range'],
      ['implausibly large', { ...GOOD, unit_amount: 5_000_00 }, 'price.amount_out_of_range'],
      ['wrong currency', { ...GOOD, currency: 'gbp' }, 'price.currency_mismatch'],
      ['unreadable', 'not-an-object', 'price.unreadable']
    ];

    for (const [label, price, rule] of cases) {
      it(`${label} → ${rule}`, async () => {
        mockPriceRetrieve.mockResolvedValue(price);

        await loadPriceCatalog(['price_regular']);

        expect(getResolvedPrice('price_regular')).toBeNull();
        expect(getPriceCatalogFailures()).toContain(rule);
        expect(isPriceCatalogLoaded()).toBe(false);
      });
    }
  });

  it('catches the same id configured twice, which no per-price check can see', async () => {
    // Each lookup succeeds on its own; only the set is wrong.
    mockPriceRetrieve.mockResolvedValue(GOOD);

    await loadPriceCatalog(['price_regular', 'price_regular']);

    expect(getPriceCatalogFailures()).toContain('price.duplicate_id');
    expect(isPriceCatalogLoaded()).toBe(false);
  });

  it('records a lookup failure rather than throwing, so boot is never a crash loop', async () => {
    // An instance that cannot reach Stripe must still start and answer /readyz,
    // reporting itself unready. A crash loop cannot be asked what is wrong.
    mockPriceRetrieve.mockRejectedValue(
      Object.assign(new Error('No such price'), { code: 'resource_missing' })
    );

    await expect(loadPriceCatalog(['price_typo'])).resolves.toBeUndefined();

    expect(getPriceCatalogFailures()).toContain('price.lookup_failed');
    expect(getResolvedPrice('price_typo')).toBeNull();
  });

  it('reads each price once, not once per caller', async () => {
    mockPriceRetrieve.mockResolvedValue(GOOD);

    await loadPriceCatalog(['price_regular']);
    getResolvedPrice('price_regular');
    getResolvedPrice('price_regular');

    // Stripe allocates reads as an average of 500 PER TRANSACTION, and quotes
    // vastly outnumber purchases here - so reads must not scale with quoting.
    expect(mockPriceRetrieve).toHaveBeenCalledTimes(1);
  });

  it('reports nothing resolved before a load, so callers refuse rather than guess', async () => {
    expect(getResolvedPrice('price_regular')).toBeNull();
    expect(isPriceCatalogLoaded()).toBe(false);
  });

  it('keeps the good prices when one of several fails', async () => {
    mockPriceRetrieve.mockImplementation(async (id: string) =>
      id === 'price_bad' ? { ...GOOD, active: false } : GOOD
    );

    await loadPriceCatalog(['price_regular', 'price_bad']);

    // The healthy product is still priced; only the broken one is refused.
    expect(getResolvedPrice('price_regular')?.unitAmount).toBe(1000);
    expect(getResolvedPrice('price_bad')).toBeNull();
    // But the instance is not "ready" while any configured price is unresolved.
    expect(isPriceCatalogLoaded()).toBe(false);
  });
});
