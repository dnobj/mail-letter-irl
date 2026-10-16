import {
  offUnlessExplicitlyEnabled,
  positiveIntegerSetting
} from '../utils/envSettings.js';

/**
 * Gift letter settings (docs/gift-letters.md).
 *
 * Nothing here reads its environment at module load, for the reason given in
 * src/auth/betaAccess.ts: tests vary it per call, and a module-level constant
 * reads as live configuration when it is not.
 */

export const GIFT_LETTER_DEFAULTS = {
  dailySendCap: 20,
  codeTtlDays: 90,
  letterTtlDays: 180,
  operatorGenerationsRemaining: 4,
  landingBaseUrl: 'https://letterirl.com'
} as const;

/**
 * Off unless explicitly on, and off on a typo: gift letters grant free mail.
 * While off, packs grant none, previews never choose a gift, sends refuse a
 * gift draft, and codes cannot be redeemed. Letters already queued still print
 * their card, because the code on them already exists.
 */
export function isGiftLettersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return offUnlessExplicitlyEnabled('LETTER_IRL_GIFT_LETTERS_ENABLED', env);
}

/**
 * Gift letters sent per UTC day, across every account: the marketing budget.
 * 0 is a kill switch, as with the mail ceilings in betaAccess.ts.
 */
export function giftDailySendCap(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntegerSetting(
    'LETTER_IRL_GIFT_DAILY_SEND_CAP',
    GIFT_LETTER_DEFAULTS.dailySendCap,
    0,
    Number.MAX_SAFE_INTEGER,
    env
  );
}

/** Days a printed chain code stays redeemable. */
export function giftCodeTtlDays(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntegerSetting(
    'LETTER_IRL_GIFT_CODE_TTL_DAYS',
    GIFT_LETTER_DEFAULTS.codeTtlDays,
    1,
    3650,
    env
  );
}

/** Days an unsent gift letter stays usable after it is granted. */
export function giftLetterTtlDays(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntegerSetting(
    'LETTER_IRL_GIFT_LETTER_TTL_DAYS',
    GIFT_LETTER_DEFAULTS.letterTtlDays,
    1,
    3650,
    env
  );
}

/** The budget an operator grant starts with when the operator names none. */
export function giftOperatorGenerationsRemaining(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntegerSetting(
    'LETTER_IRL_GIFT_OPERATOR_GENERATIONS',
    GIFT_LETTER_DEFAULTS.operatorGenerationsRemaining,
    0,
    100,
    env
  );
}

/**
 * The website the printed QR opens. Not LETTER_IRL_PUBLIC_BASE_URL, which is
 * this API's own origin: the claim page needs the website's sign-in.
 */
export function giftLandingBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.LETTER_IRL_GIFT_LANDING_BASE_URL ?? '').trim();
  const value = raw || GIFT_LETTER_DEFAULTS.landingBaseUrl;
  return value.replace(/\/+$/, '');
}

/** How the QR is embedded in print HTML. Inline SVG unless a test print says otherwise. */
export function giftQrFormat(env: NodeJS.ProcessEnv = process.env): 'svg' | 'png' {
  return (env.LETTER_IRL_GIFT_QR_FORMAT ?? '').trim().toLowerCase() === 'png' ? 'png' : 'svg';
}
