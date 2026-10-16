/**
 * The Pay & Send config for a mail option, and for the product an order
 * recorded (#578). The catalog's memo is stubbed, so no Stripe lookup runs:
 * what is under test is which product each accessor names, and that an option
 * whose flag is off has no config at all rather than a smaller option's.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resolved = vi.hoisted(() => new Map<string, { unitAmount: number }>());

vi.mock('../../../src/services/priceCatalog.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/priceCatalog.js')>()),
  getResolvedPriceForProduct: (productCode: string) => resolved.get(productCode) ?? null
}));

import { getJitProductConfig, getJitProductConfigForCode } from '../../../src/services/stripeService.js';

beforeEach(() => {
  resolved.clear();
  vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
  vi.stubEnv('STRIPE_JIT_LETTER_PRICE_ID', 'price_letter');
  vi.stubEnv('STRIPE_JIT_POSTCARD_PRICE_ID', 'price_postcard');
  vi.stubEnv('STRIPE_JIT_POSTCARD_4X6_PRICE_ID', 'price_4x6');
  vi.stubEnv('STRIPE_JIT_LETTER_TWO_PAGES_PRICE_ID', 'price_two');
  resolved.set('jit-letter', { unitAmount: 499 });
  resolved.set('jit-postcard', { unitAmount: 499 });
  resolved.set('jit-postcard-4x6', { unitAmount: 399 });
  resolved.set('jit-letter-2-pages', { unitAmount: 599 });
});

afterEach(() => vi.unstubAllEnvs());

describe('getJitProductConfig (#578)', () => {
  it('prices the products sold before as it always did', () => {
    expect(getJitProductConfig({ mailType: 'letter' })).toEqual({
      productCode: 'jit-letter',
      mailType: 'letter',
      priceId: 'price_letter',
      amountCents: 499,
      currency: 'usd',
      name: 'Pay & Send One Physical Letter',
      description: 'Payment authorizes Letter IRL to print and mail this exact letter.'
    });
    expect(getJitProductConfig({ mailType: 'postcard' })).toMatchObject({
      productCode: 'jit-postcard',
      priceId: 'price_postcard'
    });
  });

  it('has no config for an option whose flag is off, never a smaller option', () => {
    expect(getJitProductConfig({ mailType: 'postcard', postcardSize: '6x4' })).toBeNull();
    expect(getJitProductConfig({ mailType: 'letter', pages: 2 })).toBeNull();
  });

  it("prices an option by its own product while its flag is on", () => {
    vi.stubEnv('LETTER_IRL_POSTCARD_SIZES_ENABLED', 'true');
    expect(getJitProductConfig({ mailType: 'postcard', postcardSize: '6x4' })).toEqual({
      productCode: 'jit-postcard-4x6',
      mailType: 'postcard',
      priceId: 'price_4x6',
      amountCents: 399,
      currency: 'usd',
      name: 'Pay & Send One 4x6 Postcard',
      description: 'Payment authorizes Letter IRL to print and mail this exact 4x6 postcard.'
    });
    // An option sold without its Price set yet is unpriced, the sentinel the
    // quote and the checkout already refuse on.
    expect(getJitProductConfig({ mailType: 'postcard', postcardSize: '6x11' })).toMatchObject({
      productCode: 'jit-postcard-11x6',
      priceId: '',
      amountCents: 0
    });
  });
});

describe('getJitProductConfigForCode (#578)', () => {
  it("prices the product an order recorded", () => {
    vi.stubEnv('LETTER_IRL_ROOM_TO_WRITE_ENABLED', 'true');
    expect(getJitProductConfigForCode('jit-letter-2-pages')).toMatchObject({
      productCode: 'jit-letter-2-pages',
      mailType: 'letter',
      priceId: 'price_two',
      amountCents: 599
    });
    expect(getJitProductConfigForCode('jit-postcard')).toMatchObject({
      productCode: 'jit-postcard',
      mailType: 'postcard',
      amountCents: 499
    });
  });

  it('has none for a product no longer sold, or no product at all', () => {
    expect(getJitProductConfigForCode('jit-letter-2-pages')).toBeNull();
    expect(getJitProductConfigForCode('credit-pack-4')).toBeNull();
    expect(getJitProductConfigForCode('jit-anything')).toBeNull();
  });
});
