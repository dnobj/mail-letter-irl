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
  dailyCap: 20,
  retentionDays: 7
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

/**
 * The most a closed request may be kept (#701, decision D6): the privacy
 * policy states this upper limit, so no setting may keep a request longer.
 */
export const ADDRESS_REQUEST_MAX_RETENTION_DAYS = 30;

/**
 * How many days a closed request is kept, with any address given with it:
 * from when it was answered, declined or cancelled, and from its link's
 * expiry for one never answered. The value is the owner's, with the privacy
 * policy's wording (#604); 7 matches unsent drafts' content. At most
 * ADDRESS_REQUEST_MAX_RETENTION_DAYS, the limit the policy states. The
 * recipient's page says the number the API reads, so the API and the
 * maintenance service, which sweeps, must have the same value.
 */
export function addressRequestRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntegerSetting(
    'LETTER_IRL_ADDRESS_REQUEST_RETENTION_DAYS',
    ADDRESS_REQUEST_DEFAULTS.retentionDays,
    1,
    ADDRESS_REQUEST_MAX_RETENTION_DAYS,
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
