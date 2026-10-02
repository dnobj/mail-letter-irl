/**
 * The mail options' Pay & Send prices (#578): two- and three-page letters and
 * the 4x6 and 11x6 postcards, each sold only while its flag is on, and never
 * priced as another option.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  JIT_OPTION_PRICE_ENV_VARS,
  JIT_PRICE_ENV_VARS,
  JIT_PRODUCTS,
  POSTCARD_SIZES_FLAG,
  ROOM_TO_WRITE_FLAG,
  getConfiguredProduct,
  getConfiguredProducts,
  isConfiguredProductCode,
  isJitProductSold,
  jitProductFor,
  jitProductMatching
} from '../../../src/config/products.js';

afterEach(() => vi.unstubAllEnvs());

const OPTION_CODES = ['jit-letter-2-pages', 'jit-letter-3-pages', 'jit-postcard-4x6', 'jit-postcard-11x6'];

function product(code: string) {
  const found = JIT_PRODUCTS.find(candidate => candidate.productCode === code);
  if (!found) throw new Error(`no product ${code}`);
  return found;
}

describe('the price table (#578)', () => {
  it('pins the proposed prices: a dollar a page more, a dollar less for 4x6, a dollar more for 11x6', () => {
    expect(
      JIT_PRODUCTS.map(candidate => [candidate.productCode, candidate.expectedAmountCents])
    ).toEqual([
      ['jit-letter', 499],
      ['jit-postcard', 499],
      ['jit-letter-2-pages', 599],
      ['jit-letter-3-pages', 699],
      ['jit-postcard-4x6', 399],
      ['jit-postcard-11x6', 599]
    ]);
  });

  it('names each option for the receipt, and sells each behind its own flag', () => {
    expect(
      OPTION_CODES.map(code => {
        const option = product(code);
        return [option.name, option.enabledBy, option.priceEnv];
      })
    ).toEqual([
      ['Pay & Send One Two-Page Letter', ROOM_TO_WRITE_FLAG, 'STRIPE_JIT_LETTER_TWO_PAGES_PRICE_ID'],
      ['Pay & Send One Three-Page Letter', ROOM_TO_WRITE_FLAG, 'STRIPE_JIT_LETTER_THREE_PAGES_PRICE_ID'],
      ['Pay & Send One 4x6 Postcard', POSTCARD_SIZES_FLAG, 'STRIPE_JIT_POSTCARD_4X6_PRICE_ID'],
      ['Pay & Send One 11x6 Postcard', POSTCARD_SIZES_FLAG, 'STRIPE_JIT_POSTCARD_11X6_PRICE_ID']
    ]);
    expect(ROOM_TO_WRITE_FLAG).toBe('LETTER_IRL_ROOM_TO_WRITE_ENABLED');
    expect(POSTCARD_SIZES_FLAG).toBe('LETTER_IRL_POSTCARD_SIZES_ENABLED');
    // The products sold before have no flag.
    expect(product('jit-letter').enabledBy).toBeUndefined();
    expect(product('jit-postcard').enabledBy).toBeUndefined();
  });

  it('keeps the options out of the prices every Pay & Send deployment needs', () => {
    expect(JIT_PRICE_ENV_VARS).toEqual(['STRIPE_JIT_LETTER_PRICE_ID', 'STRIPE_JIT_POSTCARD_PRICE_ID']);
    expect(JIT_OPTION_PRICE_ENV_VARS).toEqual([
      { priceEnv: 'STRIPE_JIT_LETTER_TWO_PAGES_PRICE_ID', flag: ROOM_TO_WRITE_FLAG },
      { priceEnv: 'STRIPE_JIT_LETTER_THREE_PAGES_PRICE_ID', flag: ROOM_TO_WRITE_FLAG },
      { priceEnv: 'STRIPE_JIT_POSTCARD_4X6_PRICE_ID', flag: POSTCARD_SIZES_FLAG },
      { priceEnv: 'STRIPE_JIT_POSTCARD_11X6_PRICE_ID', flag: POSTCARD_SIZES_FLAG }
    ]);
  });
});

describe('jitProductMatching', () => {
  it.each([
    [{ mailType: 'letter' as const }, 'jit-letter'],
    [{ mailType: 'letter' as const, pages: 1 }, 'jit-letter'],
    [{ mailType: 'letter' as const, pages: 2 }, 'jit-letter-2-pages'],
    [{ mailType: 'letter' as const, pages: 3 }, 'jit-letter-3-pages'],
    [{ mailType: 'postcard' as const }, 'jit-postcard'],
    [{ mailType: 'postcard' as const, postcardSize: '6x9' as const }, 'jit-postcard'],
    [{ mailType: 'postcard' as const, postcardSize: '6x4' as const }, 'jit-postcard-4x6'],
    [{ mailType: 'postcard' as const, postcardSize: '6x11' as const }, 'jit-postcard-11x6'],
    // A postcard's pages and a letter's size mean nothing.
    [{ mailType: 'postcard' as const, pages: 3 }, 'jit-postcard'],
    [{ mailType: 'letter' as const, postcardSize: '6x4' as const }, 'jit-letter'],
    // An unknown mail type is priced as a letter, the fallback it always had.
    [{ mailType: 'parcel' as never }, 'jit-letter']
  ])('%o is %s', (option, code) => {
    expect(jitProductMatching(option)?.productCode).toBe(code);
  });

  it('matches nothing for a page count no product sells', () => {
    expect(jitProductMatching({ mailType: 'letter', pages: 4 })).toBeNull();
    expect(jitProductMatching({ mailType: 'letter', pages: 0 })).toBeNull();
  });
});

describe('jitProductFor: sold only while the flag is on', () => {
  it('never answers an option with a smaller option while its flag is off', () => {
    for (const option of [
      { mailType: 'letter' as const, pages: 2 },
      { mailType: 'letter' as const, pages: 3 },
      { mailType: 'postcard' as const, postcardSize: '6x4' as const },
      { mailType: 'postcard' as const, postcardSize: '6x11' as const }
    ]) {
      expect(jitProductFor(option)).toBeNull();
    }
    // The products sold before are always sold.
    expect(jitProductFor({ mailType: 'letter' })?.productCode).toBe('jit-letter');
    expect(jitProductFor({ mailType: 'postcard' })?.productCode).toBe('jit-postcard');
  });

  it("sells each option while its own flag is on, and only that flag's", () => {
    vi.stubEnv(ROOM_TO_WRITE_FLAG, 'true');
    expect(jitProductFor({ mailType: 'letter', pages: 2 })?.productCode).toBe('jit-letter-2-pages');
    expect(jitProductFor({ mailType: 'letter', pages: 3 })?.productCode).toBe('jit-letter-3-pages');
    expect(jitProductFor({ mailType: 'postcard', postcardSize: '6x4' })).toBeNull();

    vi.stubEnv(POSTCARD_SIZES_FLAG, 'on');
    expect(jitProductFor({ mailType: 'postcard', postcardSize: '6x4' })?.productCode).toBe('jit-postcard-4x6');
    expect(jitProductFor({ mailType: 'postcard', postcardSize: '6x11' })?.productCode).toBe('jit-postcard-11x6');
  });

  it('reads an explicit env, and an explicit off', () => {
    const env = { [ROOM_TO_WRITE_FLAG]: 'true' };
    expect(jitProductFor({ mailType: 'letter', pages: 2 }, env)?.productCode).toBe('jit-letter-2-pages');
    expect(jitProductFor({ mailType: 'letter', pages: 2 }, { [ROOM_TO_WRITE_FLAG]: 'false' })).toBeNull();
    expect(isJitProductSold(product('jit-letter-2-pages'), env)).toBe(true);
    expect(isJitProductSold(product('jit-letter-2-pages'), {})).toBe(false);
    expect(isJitProductSold(product('jit-letter'), {})).toBe(true);
  });
});

describe('the catalog sells an option only with Pay & Send and its flag on', () => {
  const codes = () => getConfiguredProducts().filter(row => row.group === 'jit').map(row => row.productCode);

  it('lists the products sold before, and no option, while the flags are off', () => {
    vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
    expect(codes()).toEqual(['jit-letter', 'jit-postcard']);
    for (const code of OPTION_CODES) {
      expect(isConfiguredProductCode(code), code).toBe(false);
      expect(getConfiguredProduct(code), code).toBeNull();
    }
  });

  it("adds each option's row while its flag is on, with its own price id", () => {
    vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
    vi.stubEnv(POSTCARD_SIZES_FLAG, 'true');
    vi.stubEnv('STRIPE_JIT_POSTCARD_4X6_PRICE_ID', ' price_4x6 ');
    expect(codes()).toEqual(['jit-letter', 'jit-postcard', 'jit-postcard-4x6', 'jit-postcard-11x6']);
    expect(isConfiguredProductCode('jit-postcard-4x6')).toBe(true);
    expect(isConfiguredProductCode('jit-letter-2-pages')).toBe(false);
    expect(getConfiguredProduct('jit-postcard-4x6')).toMatchObject({
      group: 'jit',
      priceId: 'price_4x6',
      expectedAmountCents: 399
    });
    expect(getConfiguredProduct('jit-letter-2-pages')).toBeNull();
  });

  it('sells no option while Pay & Send is off, whatever its flag', () => {
    vi.stubEnv(ROOM_TO_WRITE_FLAG, 'true');
    expect(codes()).toEqual([]);
    expect(isConfiguredProductCode('jit-letter-2-pages')).toBe(false);
    expect(getConfiguredProduct('jit-letter-2-pages')).toBeNull();
  });
});
