/**
 * The mail options' Pay & Send prices (#578): two- and three-page letters and
 * the 4x6 and 11x6 postcards, each sold only while its flag is on, and never
 * priced as another option.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CERTIFIED_MAIL_FLAG,
  JIT_OPTION_PRICE_ENV_VARS,
  JIT_PRICE_ENV_VARS,
  JIT_PRODUCTS,
  POSTCARD_SIZES_FLAG,
  ROOM_TO_WRITE_FLAG,
  draftMailOption,
  getConfiguredProduct,
  getConfiguredProducts,
  isConfiguredProductCode,
  isJitProductSold,
  isPackPayable,
  jitProductFor,
  jitProductMatching
} from '../../../src/config/products.js';

afterEach(() => vi.unstubAllEnvs());

const OPTION_CODES = [
  'jit-letter-2-pages',
  'jit-letter-3-pages',
  'jit-postcard-4x6',
  'jit-postcard-11x6',
  'jit-letter-certified',
  'jit-letter-certified-receipt'
];

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
      ['jit-postcard-11x6', 599],
      // Certified mail (#625): the proposal on the issue, the owner's call.
      ['jit-letter-certified', 1199],
      ['jit-letter-certified-receipt', 1499]
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
      ['Pay & Send One 11x6 Postcard', POSTCARD_SIZES_FLAG, 'STRIPE_JIT_POSTCARD_11X6_PRICE_ID'],
      ['Pay & Send One Certified Mail Letter', CERTIFIED_MAIL_FLAG, 'STRIPE_JIT_LETTER_CERTIFIED_PRICE_ID'],
      [
        'Pay & Send One Certified Mail Letter with Return Receipt',
        CERTIFIED_MAIL_FLAG,
        'STRIPE_JIT_LETTER_CERTIFIED_RECEIPT_PRICE_ID'
      ]
    ]);
    expect(ROOM_TO_WRITE_FLAG).toBe('LETTER_IRL_ROOM_TO_WRITE_ENABLED');
    expect(POSTCARD_SIZES_FLAG).toBe('LETTER_IRL_POSTCARD_SIZES_ENABLED');
    expect(CERTIFIED_MAIL_FLAG).toBe('LETTER_IRL_CERTIFIED_MAIL_ENABLED');
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
      { priceEnv: 'STRIPE_JIT_POSTCARD_11X6_PRICE_ID', flag: POSTCARD_SIZES_FLAG },
      { priceEnv: 'STRIPE_JIT_LETTER_CERTIFIED_PRICE_ID', flag: CERTIFIED_MAIL_FLAG },
      { priceEnv: 'STRIPE_JIT_LETTER_CERTIFIED_RECEIPT_PRICE_ID', flag: CERTIFIED_MAIL_FLAG }
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

describe('what a pack or a gift letter pays for (#579)', () => {
  it.each([
    [{ mailType: 'letter' as const }, true],
    [{ mailType: 'letter' as const, pages: 1 }, true],
    [{ mailType: 'letter' as const, pages: 2 }, false],
    [{ mailType: 'letter' as const, pages: 3 }, false],
    [{ mailType: 'postcard' as const }, true],
    [{ mailType: 'postcard' as const, postcardSize: '6x9' as const }, true],
    [{ mailType: 'postcard' as const, postcardSize: '6x4' as const }, false],
    [{ mailType: 'postcard' as const, postcardSize: '6x11' as const }, false],
    // A letter's size and a postcard's pages mean nothing.
    [{ mailType: 'letter' as const, postcardSize: '6x4' as const }, true],
    [{ mailType: 'postcard' as const, pages: 3 }, true]
  ])('%o: %s', (option, pays) => {
    expect(isPackPayable(option)).toBe(pays);
  });
});

describe('certified mail (#625)', () => {
  const CERTIFIED = { mailType: 'letter' as const, mailService: 'certified' as const };
  const RECEIPT = { mailType: 'letter' as const, mailService: 'certified_return_receipt' as const };

  it('prices a certified letter by its service, whatever its pages', () => {
    for (const pages of [undefined, 1, 2, 3]) {
      const extra = pages === undefined ? {} : { pages };
      expect(jitProductMatching({ ...CERTIFIED, ...extra })?.productCode, `certified, ${pages} pages`).toBe('jit-letter-certified');
      expect(jitProductMatching({ ...RECEIPT, ...extra })?.productCode, `receipt, ${pages} pages`).toBe(
        'jit-letter-certified-receipt'
      );
    }
  });

  it('prices a letter that says standard by its pages, as before', () => {
    expect(jitProductMatching({ mailType: 'letter', mailService: 'standard' })?.productCode).toBe('jit-letter');
    expect(jitProductMatching({ mailType: 'letter', mailService: 'standard', pages: 2 })?.productCode).toBe('jit-letter-2-pages');
  });

  it('never prices a standard letter as a certified one', () => {
    for (const pages of [1, 2, 3]) {
      expect(jitProductMatching({ mailType: 'letter', pages })?.mailService, `${pages} pages`).toBeUndefined();
    }
  });

  it("has no price for a certified postcard, rather than a plain postcard's", () => {
    for (const mailService of ['certified', 'certified_return_receipt'] as const) {
      for (const postcardSize of [undefined, '6x4', '6x9', '6x11'] as const) {
        const size = postcardSize === undefined ? {} : { postcardSize };
        expect(jitProductMatching({ mailType: 'postcard', mailService, ...size }), `${mailService} ${postcardSize}`).toBeNull();
      }
    }
  });

  it('sells certified mail only while its own flag is on, and no other flag sells it', () => {
    expect(jitProductFor(CERTIFIED)).toBeNull();
    expect(jitProductFor(RECEIPT)).toBeNull();

    vi.stubEnv(ROOM_TO_WRITE_FLAG, 'true');
    vi.stubEnv(POSTCARD_SIZES_FLAG, 'true');
    expect(jitProductFor(CERTIFIED)).toBeNull();
    expect(jitProductFor(RECEIPT)).toBeNull();

    vi.stubEnv(CERTIFIED_MAIL_FLAG, 'true');
    expect(jitProductFor(CERTIFIED)?.productCode).toBe('jit-letter-certified');
    expect(jitProductFor(RECEIPT)?.productCode).toBe('jit-letter-certified-receipt');
  });

  it('is the only thing the certified flag sells', () => {
    vi.stubEnv(CERTIFIED_MAIL_FLAG, 'true');
    expect(jitProductFor({ mailType: 'letter', pages: 2 })).toBeNull();
    expect(jitProductFor({ mailType: 'postcard', postcardSize: '6x4' })).toBeNull();
    expect(jitProductFor({ mailType: 'letter' })?.productCode).toBe('jit-letter');
  });

  it('is never paid for by a pack or a gift letter, whatever the pages', () => {
    for (const option of [CERTIFIED, RECEIPT, { ...CERTIFIED, pages: 3 }, { ...RECEIPT, pages: 2 }]) {
      expect(isPackPayable(option), JSON.stringify(option)).toBe(false);
    }
    // Standard, spelled out, is the pack's as before.
    expect(isPackPayable({ mailType: 'letter', mailService: 'standard' })).toBe(true);
    expect(isPackPayable({ mailType: 'letter', mailService: 'standard', pages: 2 })).toBe(false);
  });

  it.each(['registered', 'express', 'Certified', ' certified', 'certified ', 'constructor', 'toString', '__proto__'])(
    'gives a service it does not know no product and no pack: %s',
    service => {
      const option = { mailType: 'letter' as const, mailService: service as never };
      expect(jitProductMatching(option)).toBeNull();
      expect(jitProductMatching({ ...option, pages: 2 })).toBeNull();
      expect(jitProductFor(option, { [CERTIFIED_MAIL_FLAG]: 'true' })).toBeNull();
      expect(isPackPayable(option)).toBe(false);
      expect(isPackPayable({ ...option, mailType: 'postcard' })).toBe(false);
    }
  );

  it('reads a null service as standard everywhere, as the column does', () => {
    const option = { mailType: 'letter' as const, mailService: null as never };
    expect(isPackPayable(option)).toBe(true);
    expect(jitProductMatching(option)?.productCode).toBe('jit-letter');
    expect(jitProductMatching({ ...option, pages: 3 })?.productCode).toBe('jit-letter-3-pages');
  });

  it('is configured as a product only while Pay & Send and its flag are on', () => {
    const base = { JIT_PURCHASE_ENABLED: 'true' };
    expect(isConfiguredProductCode('jit-letter-certified', base)).toBe(false);
    expect(isConfiguredProductCode('jit-letter-certified', { [CERTIFIED_MAIL_FLAG]: 'true' })).toBe(false);
    const on = { ...base, [CERTIFIED_MAIL_FLAG]: 'true' };
    expect(isConfiguredProductCode('jit-letter-certified', on)).toBe(true);
    expect(isConfiguredProductCode('jit-letter-certified-receipt', on)).toBe(true);
    expect(getConfiguredProduct('jit-letter-certified', { ...on, STRIPE_JIT_LETTER_CERTIFIED_PRICE_ID: ' price_c ' })).toMatchObject({
      priceId: 'price_c',
      expectedAmountCents: 1199,
      group: 'jit'
    });
    const receiptEnv = { ...on, STRIPE_JIT_LETTER_CERTIFIED_RECEIPT_PRICE_ID: 'price_r' };
    expect(getConfiguredProduct('jit-letter-certified-receipt', receiptEnv)).toMatchObject({
      priceId: 'price_r',
      expectedAmountCents: 1499
    });
  });
});

describe('draftMailOption reads the service (#625)', () => {
  it.each([
    [{ mail_type: 'letter', mail_service: 'certified' }, { mailType: 'letter', mailService: 'certified' }],
    [
      { mail_type: 'letter', mail_service: 'certified_return_receipt', pages: 3 },
      { mailType: 'letter', pages: 3, mailService: 'certified_return_receipt' }
    ],
    [{ mail_type: 'letter', mail_service: 'standard' }, { mailType: 'letter' }],
    [{ mail_type: 'letter', mail_service: null }, { mailType: 'letter' }],
    [{ mail_type: 'letter' }, { mailType: 'letter' }],
    [{}, { mailType: 'letter' }],
    // Empty is standard. Text this code does not know is kept as it is, so it fails closed
    // downstream (no product, no pack): the column's CHECK keeps one from existing.
    [{ mail_type: 'letter', mail_service: '' }, { mailType: 'letter' }],
    [{ mail_type: 'letter', mail_service: 'express' }, { mailType: 'letter', mailService: 'express' }],
    [{ mail_type: 'letter', mail_service: 'Certified' }, { mailType: 'letter', mailService: 'Certified' }],
    [{ mail_type: 'letter', mail_service: ' certified' }, { mailType: 'letter', mailService: ' certified' }],
    // A postcard is never certified, whatever a row says.
    [
      { mail_type: 'postcard', postcard_size: '6x4', mail_service: 'certified' },
      { mailType: 'postcard', postcardSize: '6x4' }
    ]
  ])('%o is %o', (row, option) => {
    expect(draftMailOption(row)).toEqual(option);
  });
});
