import { offUnlessExplicitlyEnabled, positiveIntegerSetting } from '../utils/envSettings.js';

/**
 * Address requests (#604, concept 10 in docs/letter-creator-vision.md): a
 * private link a sender shares, themselves, with someone whose address they
 * lack. That person gives a U.S. address on the website, or declines, and
 * the sender's next preview uses what they gave.
 *
 * Nothing here reads its environment at module load, for the reason given in
 * src/auth/betaAccess.ts: tests vary it per call, and a module-level constant
 * reads as live configuration when it is not.
 */

export const ADDRESS_REQUEST_DEFAULTS = {
  linkDays: 7,
  waitingCap: 10,
  dailyCap: 20
} as const;

/**
 * Off unless explicitly on: the requests hold a third party's address, and
 * production waits for the owner's retention wording (#604). While off, the
 * three tools are not listed and refuse if called.
 */
export function isAddressRequestsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return offUnlessExplicitlyEnabled('LETTER_IRL_ADDRESS_REQUESTS_ENABLED', env);
}

/** How many days a request's link works for, from when it is made. */
export function addressRequestLinkDays(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntegerSetting(
    'LETTER_IRL_ADDRESS_REQUEST_LINK_DAYS',
    ADDRESS_REQUEST_DEFAULTS.linkDays,
    1,
    30,
    env
  );
}

/** How many requests an account may have waiting at once. */
export function addressRequestWaitingCap(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntegerSetting(
    'LETTER_IRL_ADDRESS_REQUEST_WAITING_CAP',
    ADDRESS_REQUEST_DEFAULTS.waitingCap,
    1,
    100,
    env
  );
}

/** How many requests an account may make in 24 hours. */
export function addressRequestDailyCap(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntegerSetting(
    'LETTER_IRL_ADDRESS_REQUEST_DAILY_CAP',
    ADDRESS_REQUEST_DEFAULTS.dailyCap,
    1,
    500,
    env
  );
}
