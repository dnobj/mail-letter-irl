/**
 * The longest card a send could print in place of a preview's (#534): a
 * postcard's strip has a fixed room, and the send decides the card after the
 * preview, so the preview checks the sender's name against this one too.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { longestSendCard } from '../../../src/tools/giftSendChoice.js';
import { giftPostcardStripCopy, type GiftCardContent } from '../../../src/services/giftCardRenderer.js';
import { GiftStripOverflow, layoutPostcardBack } from '../../../src/render/index.js';

function stripFits(card: GiftCardContent, name: string): boolean {
  try {
    layoutPostcardBack('', giftPostcardStripCopy(card, name));
    return true;
  } catch (error) {
    if (error instanceof GiftStripOverflow) return false;
    throw error;
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the longest card a send could print', () => {
  it("keeps a funded card's code and links, with the longest date and a seed campaign's wording", () => {
    const sample: GiftCardContent = {
      state: 'funded', url: 'https://letterirl.com/g', displayUrl: 'letterirl.com/g', redeemBy: '2026-12-30', sample: true
    };
    expect(longestSendCard(sample)).toEqual({ ...sample, redeemBy: '2026-09-30', multiUse: true, newAccountsOnly: true });
    const seed: GiftCardContent = {
      state: 'funded', code: 'PRESS2026', url: 'https://letterirl.com/g/PRESS2026', displayUrl: 'letterirl.com/g', multiUse: true
    };
    expect(longestSendCard(seed)).toEqual({ ...seed, redeemBy: '2026-09-30', newAccountsOnly: true });
  });

  it("holds no name a card the send could print would not, whatever its wording and date", () => {
    // The widest chain code there is, as the send mints it.
    const chain: GiftCardContent = {
      state: 'funded', code: 'WWWWMMMM', url: 'https://letterirl.com/g/WWWWMMMM', displayUrl: 'letterirl.com/g'
    };
    const longest = longestSendCard({ ...chain, code: undefined, sample: true });
    let repeats = 0;
    while (stripFits(longest, 'Pat Example '.repeat(repeats + 1).trim())) repeats += 1;
    expect(repeats).toBeGreaterThanOrEqual(7);
    const name = 'Pat Example '.repeat(repeats).trim();
    const dates = Array.from({ length: 12 }, (_, month) => [1, 28].map(day =>
      `2027-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`)).flat();
    for (const wording of [{}, { multiUse: true }, { multiUse: true, newAccountsOnly: true }]) {
      for (const redeemBy of [undefined, ...dates]) {
        const card = { ...chain, ...wording, ...(redeemBy ? { redeemBy } : {}) };
        expect(stripFits(card, name), JSON.stringify(card)).toBe(true);
      }
    }
  });

  it('funds a plain card, since the send may print a funded one, with the placeholder code', () => {
    vi.stubEnv('LETTER_IRL_GIFT_LANDING_BASE_URL', 'https://letterirl.com');
    const card = longestSendCard({ state: 'unfunded', url: 'https://letterirl.com', displayUrl: 'letterirl.com' });
    expect(card).toEqual({
      state: 'funded',
      url: 'https://letterirl.com/g',
      displayUrl: 'letterirl.com/g',
      redeemBy: '2026-09-30',
      sample: true,
      multiUse: true,
      newAccountsOnly: true
    });
  });
});
