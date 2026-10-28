/**
 * The 4x6 and 11x6 postcards (#594): offered only while their flag is on, our
 * renderer draws the postcard, and Pay & Send, which alone pays for them, is on.
 */

import { describe, expect, it } from 'vitest';
import { isPostcardSizesOffered, offeredPostcardSizes } from '../../../src/config/postcardSizes.js';

const ALL_ON = { LETTER_IRL_POSTCARD_SIZES_ENABLED: 'true', LETTER_IRL_PRINT_RENDERER: 'pdf', JIT_PURCHASE_ENABLED: 'true' };

describe('isPostcardSizesOffered', () => {
  it('needs the flag, our renderer and Pay & Send, all three', () => {
    expect(isPostcardSizesOffered(ALL_ON)).toBe(true);
    expect(isPostcardSizesOffered({ ...ALL_ON, LETTER_IRL_POSTCARD_SIZES_ENABLED: 'false' })).toBe(false);
    expect(isPostcardSizesOffered({ ...ALL_ON, LETTER_IRL_PRINT_RENDERER: 'html' })).toBe(false);
    expect(isPostcardSizesOffered({ ...ALL_ON, JIT_PURCHASE_ENABLED: 'false' })).toBe(false);
    expect(isPostcardSizesOffered({})).toBe(false);
  });

  it('is on only for an explicit affirmative', () => {
    for (const value of ['true', '1', 'yes', 'on', ' TRUE ']) {
      expect(isPostcardSizesOffered({ ...ALL_ON, LETTER_IRL_POSTCARD_SIZES_ENABLED: value }), value).toBe(true);
    }
    for (const value of ['', '0', 'off', 'ture']) {
      expect(isPostcardSizesOffered({ ...ALL_ON, LETTER_IRL_POSTCARD_SIZES_ENABLED: value }), value).toBe(false);
    }
  });
});

describe('offeredPostcardSizes', () => {
  it('is the three sizes while offered, the 6x9 first, and otherwise the 6x9 alone', () => {
    expect(offeredPostcardSizes(ALL_ON)).toEqual(['6x9', '6x4', '6x11']);
    expect(offeredPostcardSizes({ ...ALL_ON, LETTER_IRL_PRINT_RENDERER: 'html' })).toEqual(['6x9']);
    expect(offeredPostcardSizes({})).toEqual(['6x9']);
  });
});
