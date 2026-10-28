/**
 * The postcard layouts' flag (#594): offered only while it is on and our
 * renderer draws the postcard. A layout costs nothing more, so Pay & Send is
 * not asked.
 */

import { describe, expect, it } from 'vitest';
import { isPostcardLayoutsOffered, POSTCARD_LAYOUTS_FLAG } from '../../../src/config/postcardLayouts.js';

describe('isPostcardLayoutsOffered', () => {
  it('needs the flag and our renderer both, and not Pay & Send', () => {
    expect(POSTCARD_LAYOUTS_FLAG).toBe('LETTER_IRL_POSTCARD_LAYOUTS_ENABLED');
    expect(isPostcardLayoutsOffered({ LETTER_IRL_POSTCARD_LAYOUTS_ENABLED: 'true', LETTER_IRL_PRINT_RENDERER: 'pdf' })).toBe(true);
    expect(isPostcardLayoutsOffered({ LETTER_IRL_POSTCARD_LAYOUTS_ENABLED: 'true', LETTER_IRL_PRINT_RENDERER: 'pdf', JIT_PURCHASE_ENABLED: 'false' })).toBe(true);
    expect(isPostcardLayoutsOffered({ LETTER_IRL_POSTCARD_LAYOUTS_ENABLED: 'true', LETTER_IRL_PRINT_RENDERER: 'html' })).toBe(false);
    expect(isPostcardLayoutsOffered({ LETTER_IRL_POSTCARD_LAYOUTS_ENABLED: 'true' })).toBe(false);
    expect(isPostcardLayoutsOffered({ LETTER_IRL_PRINT_RENDERER: 'pdf' })).toBe(false);
  });

  it('is on only for an explicit affirmative', () => {
    for (const value of ['true', '1', 'yes', 'on', ' TRUE ']) {
      expect(isPostcardLayoutsOffered({ LETTER_IRL_POSTCARD_LAYOUTS_ENABLED: value, LETTER_IRL_PRINT_RENDERER: 'pdf' }), value).toBe(true);
    }
    for (const value of ['', '0', 'off', 'ture']) {
      expect(isPostcardLayoutsOffered({ LETTER_IRL_POSTCARD_LAYOUTS_ENABLED: value, LETTER_IRL_PRINT_RENDERER: 'pdf' }), value).toBe(false);
    }
  });
});
