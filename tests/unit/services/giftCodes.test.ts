import { describe, expect, it } from 'vitest';
import {
  GIFT_CODE_ALPHABET,
  formatGiftCode,
  generateGiftCode,
  isCanonicalGiftCode,
  normalizeEmail,
  normalizeGiftCode
} from '../../../src/services/giftCodes.js';
import {
  giftDailySendCap,
  giftLandingBaseUrl,
  giftQrFormat,
  isGiftLettersEnabled
} from '../../../src/config/giftLetters.js';
import { offUnlessExplicitlyEnabled } from '../../../src/utils/envSettings.js';

describe('chain codes', () => {
  it('generates 8 Crockford characters, never I, L, O or U', () => {
    for (let i = 0; i < 500; i += 1) {
      const code = generateGiftCode();
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
      expect(isCanonicalGiftCode(code)).toBe(true);
    }
    expect(GIFT_CODE_ALPHABET).toHaveLength(32);
    expect(GIFT_CODE_ALPHABET).not.toMatch(/[ILOU]/);
  });

  it('draws every character from the random source it is given', () => {
    const picks: number[] = [];
    const code = generateGiftCode(max => {
      picks.push(max);
      return 31;
    });
    expect(code).toBe('ZZZZZZZZ');
    expect(picks).toEqual(Array(8).fill(32));
  });

  it('reads back what a person types off paper', () => {
    expect(normalizeGiftCode('k7m2-qx9a')).toBe('K7M2QX9A');
    expect(normalizeGiftCode('  K7M2 QX9A ')).toBe('K7M2QX9A');
    // The reader's likely substitutes map back to the Crockford digit.
    expect(normalizeGiftCode('O1IL-0000')).toBe('01110000');
    expect(normalizeGiftCode('K7M2QX9A')).toBe('K7M2QX9A');
  });

  it('reads some promo words as chain-code shapes; the lookup, not the shape, sends them on', () => {
    // WELCOME5 has the shape of a chain code once O and L are read as digits.
    // Redemption tries gift_codes with this form, finds nothing, and falls
    // through to the campaign; minting never produces a code that a campaign
    // reads as (giftLetterService.mintChainCode).
    expect(normalizeGiftCode('WELCOME5')).toBe('WE1C0ME5');
  });

  it('answers null for anything that cannot be a chain code, so promo words fall through', () => {
    for (const raw of ['K7M2QX9', 'K7M2QX9AB', 'K7M2QX9U', '', '   ', 'JANE-SMITH', 'SPRING2026']) {
      expect(normalizeGiftCode(raw)).toBeNull();
    }
    expect(normalizeGiftCode(undefined)).toBeNull();
    expect(normalizeGiftCode(12345678)).toBeNull();
  });

  it('prints in two groups of four', () => {
    expect(formatGiftCode('K7M2QX9A')).toBe('K7M2-QX9A');
  });
});

describe('redeemer identity', () => {
  it('folds the ways one Gmail mailbox can be spelled', () => {
    expect(normalizeEmail('J.Ane.Doe+letters@Gmail.com')).toBe('janedoe@gmail.com');
    expect(normalizeEmail('janedoe@googlemail.com')).toBe('janedoe@gmail.com');
  });

  it('drops a +tag everywhere but keeps dots outside Gmail', () => {
    expect(normalizeEmail('jane.doe+x@example.com')).toBe('jane.doe@example.com');
  });

  it('refuses what is not an address', () => {
    for (const raw of [undefined, null, '', 'no-at-sign', '@example.com', 'jane@', '+tag@gmail.com']) {
      expect(normalizeEmail(raw)).toBeNull();
    }
  });
});

describe('gift letter settings', () => {
  it('is off unless explicitly on, and a typo keeps it off', () => {
    expect(isGiftLettersEnabled({})).toBe(false);
    expect(isGiftLettersEnabled({ LETTER_IRL_GIFT_LETTERS_ENABLED: 'true' })).toBe(true);
    expect(isGiftLettersEnabled({ LETTER_IRL_GIFT_LETTERS_ENABLED: ' ON ' })).toBe(true);
    for (const value of ['ture', 'false', '0', 'no', '', 'enable']) {
      expect(isGiftLettersEnabled({ LETTER_IRL_GIFT_LETTERS_ENABLED: value })).toBe(false);
    }
    expect(offUnlessExplicitlyEnabled('X', { X: 'yes' })).toBe(true);
  });

  it('treats a daily cap of 0 as a kill switch and falls back on nonsense', () => {
    expect(giftDailySendCap({})).toBe(20);
    expect(giftDailySendCap({ LETTER_IRL_GIFT_DAILY_SEND_CAP: '0' })).toBe(0);
    expect(giftDailySendCap({ LETTER_IRL_GIFT_DAILY_SEND_CAP: '5' })).toBe(5);
    expect(giftDailySendCap({ LETTER_IRL_GIFT_DAILY_SEND_CAP: '1e3' })).toBe(20);
  });

  it('points the QR at the website, not at this API', () => {
    expect(giftLandingBaseUrl({})).toBe('https://letterirl.com');
    expect(giftLandingBaseUrl({ LETTER_IRL_GIFT_LANDING_BASE_URL: 'https://dev.example.com/' })).toBe('https://dev.example.com');
    expect(giftLandingBaseUrl({ LETTER_IRL_PUBLIC_BASE_URL: 'https://api.letterirl.com' })).toBe('https://letterirl.com');
  });

  it('prints SVG unless PNG is chosen', () => {
    expect(giftQrFormat({})).toBe('svg');
    expect(giftQrFormat({ LETTER_IRL_GIFT_QR_FORMAT: 'PNG' })).toBe('png');
    expect(giftQrFormat({ LETTER_IRL_GIFT_QR_FORMAT: 'jpeg' })).toBe('svg');
  });
});
