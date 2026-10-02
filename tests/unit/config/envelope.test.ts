/**
 * The envelope reveal's flag (#576): off unless explicitly on, listed for the
 * preflight, and carried only by the letter previews' _meta while on.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ENVELOPE_REVEAL_META, isEnvelopeRevealEnabled } from '../../../src/config/envelope.js';
import { ENV_VAR_MANIFEST } from '../../../src/config/deploymentConfig.js';
import { cardSwitches } from '../../../src/mcp/registerTools.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isEnvelopeRevealEnabled', () => {
  it('is on only for an explicit affirmative', () => {
    for (const value of ['true', '1', 'yes', 'on', 'enabled', ' TRUE ']) {
      expect(isEnvelopeRevealEnabled({ LETTER_IRL_ENVELOPE_REVEAL_ENABLED: value }), value).toBe(true);
    }
    for (const value of ['', 'false', '0', 'off', 'ture']) {
      expect(isEnvelopeRevealEnabled({ LETTER_IRL_ENVELOPE_REVEAL_ENABLED: value }), value).toBe(false);
    }
    expect(isEnvelopeRevealEnabled({})).toBe(false);
  });

  it('is listed, advisory and API only, so the preflight shows where it is set', () => {
    expect(ENV_VAR_MANIFEST.find(entry => entry.name === 'LETTER_IRL_ENVELOPE_REVEAL_ENABLED')).toEqual({
      name: 'LETTER_IRL_ENVELOPE_REVEAL_ENABLED',
      requiredIn: 'production',
      advisory: true,
      secret: false,
      services: ['api']
    });
  });
});

describe("the letter previews' card switch", () => {
  const LETTERS = ['quote_and_preview_letter', 'quote_and_preview_letter_with_header_image', 'quote_and_preview_letter_with_image'];

  it('tells the letter card it may open the page from an envelope while the reveal is on', () => {
    vi.stubEnv('LETTER_IRL_ENVELOPE_REVEAL_ENABLED', 'true');
    for (const name of LETTERS) expect(cardSwitches(name), name).toEqual({ [ENVELOPE_REVEAL_META]: true });
    expect(ENVELOPE_REVEAL_META).toBe('letter-irl/envelopeReveal');
  });

  it('says nothing while it is off, and nothing for any other tool', () => {
    vi.stubEnv('LETTER_IRL_ENVELOPE_REVEAL_ENABLED', '');
    for (const name of LETTERS) expect(cardSwitches(name), name).toEqual({});
    vi.stubEnv('LETTER_IRL_ENVELOPE_REVEAL_ENABLED', 'true');
    for (const name of ['quote_and_preview_postcard', 'set_stationery', 'send_letter', 'get_draft_status', 'get_started']) {
      expect(cardSwitches(name), name).toEqual({});
    }
  });
});
