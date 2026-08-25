/**
 * The product table's own guarantees (#278). The pins here ARE the two-source
 * check's second source, so their presence and the helpers that read them get
 * direct coverage rather than riding along inside the catalog suite.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  JIT_PRODUCTS,
  PACK_PRODUCTS,
  formatAmountForCurrency,
  isConfiguredProductCode
} from '../../../src/config/products.js';

afterEach(() => vi.unstubAllEnvs());

describe('product table pins (#278)', () => {
  it('pins an expected amount for every sellable product', () => {
    for (const product of [...PACK_PRODUCTS, ...JIT_PRODUCTS]) {
      expect(Number.isInteger(product.expectedAmountCents), product.productCode).toBe(true);
      expect(product.expectedAmountCents, product.productCode).toBeGreaterThan(0);
    }
  });

  it('pins strictly increasing pack totals, so the tiers cannot be ambiguous', () => {
    const sorted = [...PACK_PRODUCTS].sort((a, b) => a.credits - b.credits);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i].expectedAmountCents).toBeGreaterThan(sorted[i - 1].expectedAmountCents);
    }
  });
});

describe('isConfiguredProductCode', () => {
  it('answers packs without touching JIT state', () => {
    expect(isConfiguredProductCode('credit-pack-4')).toBe(true);
    expect(isConfiguredProductCode('no-such-product')).toBe(false);
  });

  it('admits JIT products only when Pay & Send is enabled', () => {
    expect(isConfiguredProductCode('jit-letter')).toBe(false);
    vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
    expect(isConfiguredProductCode('jit-letter')).toBe(true);
  });
});

describe('formatAmountForCurrency', () => {
  it.each([
    // Two-decimal: minor units are cents.
    [499, 'usd', '4.99'],
    [9000, 'USD', '90.00'],
    // Zero-decimal: unit_amount is whole yen/won - dividing by 100 rendered a
    // JPY 500 charge as "5.00" on the money-confirmation surface (#278 r5).
    [500, 'jpy', '500'],
    [126000, 'krw', '126000'],
    // Three-decimal.
    [1250, 'bhd', '1.250']
  ])('%d %s -> %s', (amount, currency, expected) => {
    expect(formatAmountForCurrency(amount, currency)).toBe(expected);
  });
});
