import {
  enabledUnlessDisabled,
  onUnlessExplicitlyDisabled,
  positiveIntegerSetting
} from '../utils/envSettings.js';

/**
 * Limited-beta access control and spend ceilings (#179).
 *
 * Letter IRL is live in production with real Stripe charges and real PostGrid
 * mail, and until this existed the only thing standing between the world and
 * a funded send was the ChatGPT connector being unpublished - obscurity, not a
 * control. This module is the cohort gate and the ceilings that bound what the
 * cohort can spend.
 *
 * NOTHING HERE READS ITS ENVIRONMENT AT MODULE LOAD. Every function resolves
 * process.env on the call, so a test can vary the cohort without re-importing
 * and a reader cannot mistake a stale module-level constant for live
 * configuration. src/api/middleware/adminAuth.ts does capture its list at load
 * time; do not copy that here.
 *
 * The two boolean flags in this file use DIFFERENT helpers on purpose. See the
 * table in src/utils/envSettings.ts: the access gate must stay up when its
 * value is unreadable, and the sending kill switch must go down. Using one
 * helper for both would be wrong in one of the two places, and which one is
 * not a matter of taste.
 */

/**
 * What a refused caller is told, everywhere. One constant because it reaches
 * the MCP transports, the REST surface and the tool layer, and three
 * paraphrases would be three chances to leak something request-shaped.
 *
 * Fixed text with no interpolation: this string is safe to put in an HTTP body
 * and an error message precisely because nothing from the request can reach
 * it. support@letterirl.com is the address already published in manifest.json
 * and src/mcp/manifest.ts, so a refused user is not sent somewhere new.
 */
export const BETA_ACCESS_MESSAGE =
  'Letter IRL is in limited beta and this account is not on the invite list. ' +
  'If you believe that is a mistake, email support@letterirl.com.';

/**
 * Refusal by cohort, distinct from any authentication failure.
 *
 * The distinction is load-bearing rather than cosmetic. Every catch site
 * around validateAuthorizationHeader maps a thrown error to 401 with a
 * WWW-Authenticate challenge, which tells an MCP client "your credentials are
 * bad, authorize again" - so a refusal thrown as a plain Error would send the
 * user back through Auth0, succeed, be refused again, and loop forever. Call
 * sites branch on this type to answer 403 with NO challenge instead:
 * authenticated fine, not permitted, do not retry.
 */
export class BetaAccessDeniedError extends Error {
  readonly statusCode = 403;

  constructor() {
    super(BETA_ACCESS_MESSAGE);
    this.name = 'BetaAccessDeniedError';
  }
}

/** Default ceilings. Every one is env-overridable without a deploy. */
export const BETA_CAP_DEFAULTS = {
  globalDailyMail: 25,
  accountDailyMail: 3,
  accountDailyChargeCents: 6000
} as const;

/**
 * Split a comma-separated id list. Matches the shape adminAuth.ts already
 * uses, including the format Auth0 subjects arrive in: auth0|123,auth0|456.
 * Subjects contain '|' but never ',', so comma is a safe separator.
 */
function parseIdList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map(id => id.trim())
    .filter(id => id.length > 0);
}

/** Whether the cohort gate is being enforced at all. */
export function isBetaGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return onUnlessExplicitlyDisabled('LETTER_IRL_BETA_GATE_ENABLED', env);
}

/**
 * The admitted subjects: the invite list, plus the operators.
 *
 * Admins are unioned in because /api/admin authenticates through the very same
 * validator this gate sits in. Without it, switching the gate on locks the
 * owner out of the admin surface at exactly the moment they would need it to
 * see who is being refused.
 */
export function betaCohort(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  return new Set([
    ...parseIdList(env.LETTER_IRL_BETA_ALLOWED_SUBJECTS),
    ...parseIdList(env.LETTER_IRL_ADMIN_USER_IDS)
  ]);
}

/**
 * Pure membership, ignoring whether the gate is switched on. Exported so an
 * operator-facing surface can report "this subject is not on the list" without
 * that answer changing when the gate is toggled.
 */
export function isBetaCohortMember(
  userId: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return betaCohort(env).has(userId.trim());
}

/** Whether this subject may proceed: the gate flag AND membership. */
export function isBetaAccessAllowed(
  userId: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!isBetaGateEnabled(env)) return true;
  return isBetaCohortMember(userId, env);
}

/** Throwing form, for use at the authentication chokepoints. */
export function assertBetaAccess(
  userId: string,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (!isBetaAccessAllowed(userId, env)) {
    throw new BetaAccessDeniedError();
  }
}

/**
 * The ceilings. 0 is a KILL SWITCH (refuse everything), not "unlimited" - an
 * operator zeroing a ceiling during a spend incident must stop spend, not open
 * it. Same rule as dailyCeiling() in src/tools/generateImageForMail.ts.
 *
 * These are the wrong thing to reach for in an emergency, though.
 * positiveIntegerSetting falls back to its DEFAULT on an unparseable value, so
 * a mistyped ceiling silently restores the number the operator was trying to
 * escape. isMailSendingEnabled below is the stop button, because it fails the
 * other way.
 */
export function globalDailyMailCeiling(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntegerSetting(
    'LETTER_IRL_BETA_GLOBAL_DAILY_MAIL_CEILING',
    BETA_CAP_DEFAULTS.globalDailyMail,
    0,
    Number.MAX_SAFE_INTEGER,
    env
  );
}

export function accountDailyMailCap(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntegerSetting(
    'LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP',
    BETA_CAP_DEFAULTS.accountDailyMail,
    0,
    Number.MAX_SAFE_INTEGER,
    env
  );
}

export function accountDailyChargeCents(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntegerSetting(
    'LETTER_IRL_BETA_ACCOUNT_DAILY_CHARGE_CENTS',
    BETA_CAP_DEFAULTS.accountDailyChargeCents,
    0,
    Number.MAX_SAFE_INTEGER,
    env
  );
}

/**
 * The emergency stop for outbound mail.
 *
 * enabledUnlessDisabled, NOT onUnlessExplicitlyDisabled: mailing a letter is
 * the "irreversible job" that helper's docblock names, and an operator who
 * types something unreadable into this variable must end up with sending
 * STOPPED. That is the opposite of what the access gate needs, which is why
 * this file uses both helpers.
 */
export function isMailSendingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return enabledUnlessDisabled('LETTER_IRL_MAIL_SENDING_ENABLED', env);
}
