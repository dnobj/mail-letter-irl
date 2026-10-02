/**
 * The studio card's flag (#580): off unless explicitly on, listed for the
 * preflight, and carried only by the letter previews' _meta while on, beside
 * the envelope reveal's switch when both are on.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { STUDIO_CARD_META, isStudioCardEnabled } from '../../../src/config/studioCard.js';
import { ENVELOPE_REVEAL_META } from '../../../src/config/envelope.js';
import { ENV_VAR_MANIFEST } from '../../../src/config/deploymentConfig.js';
import { cardSwitches } from '../../../src/mcp/registerTools.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isStudioCardEnabled', () => {
  it('is on only for an explicit affirmative', () => {
    for (const value of ['true', '1', 'yes', 'on', 'enabled', ' TRUE ']) {
      expect(isStudioCardEnabled({ LETTER_IRL_STUDIO_CARD_ENABLED: value }), value).toBe(true);
    }
    for (const value of ['', 'false', '0', 'off', 'ture']) {
      expect(isStudioCardEnabled({ LETTER_IRL_STUDIO_CARD_ENABLED: value }), value).toBe(false);
    }
    expect(isStudioCardEnabled({})).toBe(false);
  });

  it('is listed, advisory and API only, so the preflight shows where it is set', () => {
    expect(ENV_VAR_MANIFEST.find(entry => entry.name === 'LETTER_IRL_STUDIO_CARD_ENABLED')).toEqual({
      name: 'LETTER_IRL_STUDIO_CARD_ENABLED',
      requiredIn: 'production',
      advisory: true,
      secret: false,
      services: ['api']
    });
  });
});

describe("the letter previews' studio switch", () => {
  const LETTERS = ['quote_and_preview_letter', 'quote_and_preview_letter_with_header_image', 'quote_and_preview_letter_with_image'];

  it('tells the letter card it may lay itself out as a studio while the flag is on', () => {
    vi.stubEnv('LETTER_IRL_STUDIO_CARD_ENABLED', 'true');
    vi.stubEnv('LETTER_IRL_ENVELOPE_REVEAL_ENABLED', '');
    for (const name of LETTERS) expect(cardSwitches(name), name).toEqual({ [STUDIO_CARD_META]: true });
    expect(STUDIO_CARD_META).toBe('letterirl/studioCard');
  });

  it('rides beside the envelope reveal when both are on', () => {
    vi.stubEnv('LETTER_IRL_STUDIO_CARD_ENABLED', 'true');
    vi.stubEnv('LETTER_IRL_ENVELOPE_REVEAL_ENABLED', 'true');
    for (const name of LETTERS) {
      expect(cardSwitches(name), name).toEqual({ [STUDIO_CARD_META]: true, [ENVELOPE_REVEAL_META]: true });
    }
  });

  it('tells the postcard card it may lay itself out as a postcard maker, with no envelope', () => {
    vi.stubEnv('LETTER_IRL_STUDIO_CARD_ENABLED', 'true');
    vi.stubEnv('LETTER_IRL_ENVELOPE_REVEAL_ENABLED', 'true');
    expect(cardSwitches('quote_and_preview_postcard')).toEqual({ [STUDIO_CARD_META]: true });
  });

  it('says nothing while it is off, and nothing for any other tool', () => {
    vi.stubEnv('LETTER_IRL_STUDIO_CARD_ENABLED', '');
    vi.stubEnv('LETTER_IRL_ENVELOPE_REVEAL_ENABLED', '');
    for (const name of [...LETTERS, 'quote_and_preview_postcard']) expect(cardSwitches(name), name).toEqual({});
    vi.stubEnv('LETTER_IRL_STUDIO_CARD_ENABLED', 'true');
    for (const name of ['set_stationery', 'send_letter', 'send_postcard', 'get_draft_status', 'get_started']) {
      expect(cardSwitches(name), name).toEqual({});
    }
  });
});
