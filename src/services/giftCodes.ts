import { randomInt } from 'node:crypto';

/**
 * Chain codes: 8 characters of Crockford base32 (docs/gift-letters.md).
 *
 * Crockford leaves out I, L, O and U, so a code read off paper cannot be
 * mistyped into a different valid code through the usual confusions, and the
 * reader's likely substitutes are mapped back: O is 0, I and L are 1. 32^8 is
 * about 1.1e12 codes, which with the public lookup's rate limit makes guessing
 * one hopeless.
 *
 * The canonical form (what gift_codes stores and the migration's CHECK
 * enforces) is 8 characters with no separator. People see it as XXXX-XXXX.
 */

export const GIFT_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const GIFT_CODE_LENGTH = 8;
const CANONICAL = /^[0-9A-HJKMNP-TV-Z]{8}$/;

export function generateGiftCode(random: (max: number) => number = randomInt): string {
  let code = '';
  for (let i = 0; i < GIFT_CODE_LENGTH; i += 1) {
    code += GIFT_CODE_ALPHABET[random(GIFT_CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * The canonical form of something a person typed or scanned, or null when it
 * cannot be a chain code. Null is not "invalid code": the same box accepts
 * promo campaign codes, which are words, and the caller tries those next.
 */
export function normalizeGiftCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const compact = raw
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return CANONICAL.test(compact) ? compact : null;
}

export function isCanonicalGiftCode(code: string): boolean {
  return CANONICAL.test(code);
}

/** XXXX-XXXX, for print and for people. */
export function formatGiftCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * The identity a person redeems with, so one person cannot pass as several:
 * lower case, and for Gmail no +tag and no dots, which Gmail ignores. Other
 * providers keep their dots, since for them a dot can be a different mailbox;
 * every provider loses the +tag, which by convention never is.
 */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const email = raw.trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  let local = email.slice(0, at);
  let domain = email.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus >= 0) local = local.slice(0, plus);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  if (!local) return null;
  return `${local}@${domain}`;
}

/**
 * The code in a public lookup path (/api/public/gift/<code>), or '' when the
 * segment is empty or its percent-encoding is malformed. Scanners send
 * malformed encodings; they are bad requests, not faults.
 */
export function giftCodeFromPath(pathname: string, prefix = '/api/public/gift/'): string {
  if (!pathname.startsWith(prefix)) return '';
  try {
    return decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    return '';
  }
}
