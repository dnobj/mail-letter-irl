import { isProductionEnv } from './deploymentConfig.js';
import { offUnlessExplicitlyEnabled, positiveIntegerSetting } from '../utils/envSettings.js';

/**
 * Arrive-by settings (#535, docs/letter-send-flow.md).
 *
 * Nothing here reads its environment at module load, for the reason given in
 * src/auth/betaAccess.ts: tests vary it per call, and a module-level constant
 * reads as live configuration when it is not.
 */

export const ARRIVE_BY_DEFAULTS = {
  leadDays: 7,
  horizonDays: 60
} as const;

/**
 * Off unless explicitly on: arrival dates hold paid mail in our outbox, and
 * production waits for the owner's word and for the operations that follow
 * held mail (#535). While off, the preview tools neither offer nor accept
 * `arriveBy`. Mail already held still goes out on its date: the send and the
 * outbox never read this.
 */
export function isArriveByEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return offUnlessExplicitlyEnabled('LETTER_IRL_ARRIVE_BY_ENABLED', env);
}

/**
 * Business days from the day mail goes to the printer to the day it should
 * arrive by: PostGrid prints the day after the order, USPS First-Class takes
 * one to five business days, and one more is buffer. To be calibrated from
 * production history before launch (#535). Development may set it as low as
 * 0, to schedule near dates when testing; production refuses less than 3 and
 * keeps the default.
 */
export function scheduleLeadDays(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntegerSetting(
    'LETTER_IRL_SCHEDULE_LEAD_DAYS',
    ARRIVE_BY_DEFAULTS.leadDays,
    isProductionEnv(env) ? 3 : 0,
    30,
    env
  );
}

/** How many calendar days ahead an arrival date may be. */
export function scheduleHorizonDays(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntegerSetting(
    'LETTER_IRL_SCHEDULE_HORIZON_DAYS',
    ARRIVE_BY_DEFAULTS.horizonDays,
    1,
    365,
    env
  );
}
