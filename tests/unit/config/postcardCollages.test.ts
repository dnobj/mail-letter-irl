/**
 * The postcard collages' flag (#616): offered while it is on, whatever the
 * print path or Pay & Send, since a collage is one picture that costs nothing
 * more.
 */

import { describe, expect, it } from 'vitest';
import { isPostcardCollagesOffered, POSTCARD_COLLAGES_FLAG } from '../../../src/config/postcardCollages.js';

describe('isPostcardCollagesOffered', () => {
  it('needs the flag alone, not our renderer and not Pay & Send', () => {
    expect(POSTCARD_COLLAGES_FLAG).toBe('LETTER_IRL_POSTCARD_COLLAGES_ENABLED');
    expect(isPostcardCollagesOffered({ LETTER_IRL_POSTCARD_COLLAGES_ENABLED: 'true' })).toBe(true);
    expect(isPostcardCollagesOffered({ LETTER_IRL_POSTCARD_COLLAGES_ENABLED: 'true', LETTER_IRL_PRINT_RENDERER: 'html' })).toBe(true);
    expect(isPostcardCollagesOffered({ LETTER_IRL_POSTCARD_COLLAGES_ENABLED: 'true', LETTER_IRL_PRINT_RENDERER: 'pdf', JIT_PURCHASE_ENABLED: 'false' })).toBe(true);
    expect(isPostcardCollagesOffered({ LETTER_IRL_PRINT_RENDERER: 'pdf' })).toBe(false);
    expect(isPostcardCollagesOffered({})).toBe(false);
  });

  it('is on only for an explicit affirmative', () => {
    for (const value of ['true', '1', 'yes', 'on', ' TRUE ']) {
      expect(isPostcardCollagesOffered({ LETTER_IRL_POSTCARD_COLLAGES_ENABLED: value }), value).toBe(true);
    }
    for (const value of ['', '0', 'off', 'ture']) {
      expect(isPostcardCollagesOffered({ LETTER_IRL_POSTCARD_COLLAGES_ENABLED: value }), value).toBe(false);
    }
  });
});
