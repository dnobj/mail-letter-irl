import { afterEach, describe, expect, it } from 'vitest';
import {
  accountDailyChargeCents,
  accountDailyMailCap,
  assertBetaAccess,
  BETA_ACCESS_MESSAGE,
  BETA_CAP_DEFAULTS,
  BetaAccessDeniedError,
  betaCohort,
  globalDailyMailCeiling,
  isBetaAccessAllowed,
  isBetaCohortMember,
  isBetaGateEnabled,
  isMailSendingEnabled
} from '../../../src/auth/betaAccess.js';

/**
 * The limited-beta cohort gate (#179).
 *
 * Production is live with real Stripe charges and real PostGrid mail, and
 * before this the only thing between the world and a funded send was an
 * unpublished connector. These tests pin the two properties that make the gate
 * worth having: it fails CLOSED on a misconfigured flag, and the operators can
 * never lock themselves out of the surface they would use to fix it.
 */

const SUBJECT = 'auth0|beta-tester-1';
const ADMIN = 'auth0|owner';

/** Auth0 subjects contain '|', so the fixtures use the real shape. */
const env = (overrides: Record<string, string | undefined> = {}) =>
  overrides as NodeJS.ProcessEnv;

describe('the gate flag', () => {
  it('is ON when unset, so an unconfigured production is guarded', () => {
    expect(isBetaGateEnabled(env())).toBe(true);
  });

  it('turns off only for an explicit negative', () => {
    expect(isBetaGateEnabled(env({ LETTER_IRL_BETA_GATE_ENABLED: 'false' }))).toBe(false);
    expect(isBetaGateEnabled(env({ LETTER_IRL_BETA_GATE_ENABLED: 'off' }))).toBe(false);
  });

  it('STAYS ON for a typo rather than opening production', () => {
    // The single most important line in this file. With the obvious helper
    // (enabledUnlessDisabled) this returned false and admitted everyone.
    expect(isBetaGateEnabled(env({ LETTER_IRL_BETA_GATE_ENABLED: 'fasle' }))).toBe(true);
  });
});

describe('cohort membership', () => {
  it('admits a subject on the invite list', () => {
    const e = env({ LETTER_IRL_BETA_ALLOWED_SUBJECTS: SUBJECT + ',auth0|other' });
    expect(isBetaCohortMember(SUBJECT, e)).toBe(true);
    expect(isBetaAccessAllowed(SUBJECT, e)).toBe(true);
  });

  it('refuses a subject that is not', () => {
    const e = env({ LETTER_IRL_BETA_ALLOWED_SUBJECTS: 'auth0|someone-else' });
    expect(isBetaCohortMember(SUBJECT, e)).toBe(false);
    expect(isBetaAccessAllowed(SUBJECT, e)).toBe(false);
  });

  it('always admits the operators, so the gate cannot lock them out', () => {
    // /api/admin authenticates through the same validator this gate sits in.
    // Without the union, switching the gate on would remove the owner's access
    // to the surface they would use to see who is being refused.
    const e = env({
      LETTER_IRL_ADMIN_USER_IDS: ADMIN,
      LETTER_IRL_BETA_ALLOWED_SUBJECTS: 'auth0|someone-else'
    });
    expect(isBetaAccessAllowed(ADMIN, e)).toBe(true);
    expect(betaCohort(e).has(ADMIN)).toBe(true);
  });

  it('admits nobody when the list is empty and the gate is up', () => {
    // Total lockout is the CORRECT direction for a missing allowlist - the
    // failure is an outage, not an exposure. It is also why setting the
    // Railway variable is a prerequisite for turning the gate on, not a
    // follow-up.
    expect(isBetaAccessAllowed(SUBJECT, env())).toBe(false);
    expect(isBetaAccessAllowed(ADMIN, env())).toBe(false);
  });

  it('admits everyone when the gate is explicitly off', () => {
    const e = env({ LETTER_IRL_BETA_GATE_ENABLED: 'false' });
    expect(isBetaAccessAllowed(SUBJECT, e)).toBe(true);
    // Membership itself is unchanged: the two questions stay separable.
    expect(isBetaCohortMember(SUBJECT, e)).toBe(false);
  });

  it('tolerates the whitespace an operator will actually paste', () => {
    const e = env({
      LETTER_IRL_BETA_ALLOWED_SUBJECTS: '  ' + SUBJECT + ' , , auth0|second  ,'
    });
    expect(isBetaCohortMember(SUBJECT, e)).toBe(true);
    expect(isBetaCohortMember('auth0|second', e)).toBe(true);
    expect(betaCohort(e).size).toBe(2);
  });

  it('does not admit by prefix or substring', () => {
    const e = env({ LETTER_IRL_BETA_ALLOWED_SUBJECTS: 'auth0|abc' });
    expect(isBetaCohortMember('auth0|abcdef', e)).toBe(false);
    expect(isBetaCohortMember('auth0|ab', e)).toBe(false);
  });
});

describe('the refusal', () => {
  it('throws a typed error carrying 403, not a bare Error', () => {
    // The type is what lets every catch site answer 403-without-a-challenge.
    // Thrown as a plain Error it becomes a 401 + WWW-Authenticate, which sends
    // the user back through Auth0 to be refused again, forever.
    expect(() => assertBetaAccess(SUBJECT, env())).toThrow(BetaAccessDeniedError);
    try {
      assertBetaAccess(SUBJECT, env());
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(BetaAccessDeniedError);
      expect((error as BetaAccessDeniedError).statusCode).toBe(403);
    }
  });

  it('does not throw for an admitted subject', () => {
    const e = env({ LETTER_IRL_BETA_ALLOWED_SUBJECTS: SUBJECT });
    expect(() => assertBetaAccess(SUBJECT, e)).not.toThrow();
  });

  it('carries a fixed message that no request data can reach', () => {
    // This message is safe to put in an HTTP body precisely because nothing
    // interpolates into it. It names the support address already published in
    // the ChatGPT manifest, so a refused user is not sent somewhere new.
    expect(new BetaAccessDeniedError().message).toBe(BETA_ACCESS_MESSAGE);
    expect(BETA_ACCESS_MESSAGE).toContain('support@letterirl.com');
    expect(BETA_ACCESS_MESSAGE).not.toMatch(/\$\{|%s/);
  });
});

describe('spend ceilings', () => {
  it('uses the agreed defaults when unset', () => {
    expect(globalDailyMailCeiling(env())).toBe(BETA_CAP_DEFAULTS.globalDailyMail);
    expect(accountDailyMailCap(env())).toBe(BETA_CAP_DEFAULTS.accountDailyMail);
    expect(accountDailyChargeCents(env())).toBe(BETA_CAP_DEFAULTS.accountDailyChargeCents);
    expect(BETA_CAP_DEFAULTS).toEqual({
      globalDailyMail: 25,
      accountDailyMail: 3,
      accountDailyChargeCents: 6000
    });
  });

  it('accepts 0 as a kill switch rather than falling back', () => {
    // minimum: 0, so zero is a VALUE. If it fell below the minimum it would
    // fall back to the default and an operator zeroing a ceiling during a
    // spend incident would silently restore it.
    expect(globalDailyMailCeiling(env({ LETTER_IRL_BETA_GLOBAL_DAILY_MAIL_CEILING: '0' }))).toBe(0);
    expect(accountDailyMailCap(env({ LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP: '0' }))).toBe(0);
    expect(accountDailyChargeCents(env({ LETTER_IRL_BETA_ACCOUNT_DAILY_CHARGE_CENTS: '0' }))).toBe(0);
  });

  it('takes a clean override', () => {
    expect(globalDailyMailCeiling(env({ LETTER_IRL_BETA_GLOBAL_DAILY_MAIL_CEILING: '40' }))).toBe(40);
  });

  it('falls back to the DEFAULT on a typo - which is why it is not the stop button', () => {
    // Documented hazard, asserted so nobody mistakes a cap for an emergency
    // stop: 'O' for '0' restores 25, the very ceiling being escaped.
    expect(globalDailyMailCeiling(env({ LETTER_IRL_BETA_GLOBAL_DAILY_MAIL_CEILING: 'O' })))
      .toBe(BETA_CAP_DEFAULTS.globalDailyMail);
    expect(globalDailyMailCeiling(env({ LETTER_IRL_BETA_GLOBAL_DAILY_MAIL_CEILING: '2e1' })))
      .toBe(BETA_CAP_DEFAULTS.globalDailyMail);
  });
});

describe('the sending kill switch', () => {
  it('is on when unset', () => {
    expect(isMailSendingEnabled(env())).toBe(true);
  });

  it('stops sending for an explicit negative', () => {
    expect(isMailSendingEnabled(env({ LETTER_IRL_MAIL_SENDING_ENABLED: 'false' }))).toBe(false);
  });

  it('stops sending for a TYPO - the opposite polarity to the gate', () => {
    // The pair that justifies two helpers. Same unreadable value, same file,
    // opposite and individually correct answers: the guard stays up, the
    // irreversible job stops.
    const typo = 'fasle';
    expect(isMailSendingEnabled(env({ LETTER_IRL_MAIL_SENDING_ENABLED: typo }))).toBe(false);
    expect(isBetaGateEnabled(env({ LETTER_IRL_BETA_GATE_ENABLED: typo }))).toBe(true);
  });
});

describe('configuration is read per call', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('sees a cohort change without re-importing the module', () => {
    // adminAuth.ts captures its id list at module load. If this module ever
    // did the same, a test would need a fresh import to see a change - and an
    // operator would need a redeploy where they expected a restart.
    // tests/setup.ts defaults the gate OFF for the suite, so this case has to
    // raise it explicitly - otherwise it would assert nothing.
    process.env.LETTER_IRL_BETA_GATE_ENABLED = 'true';
    process.env.LETTER_IRL_ADMIN_USER_IDS = '';
    process.env.LETTER_IRL_BETA_ALLOWED_SUBJECTS = '';
    expect(isBetaAccessAllowed(SUBJECT)).toBe(false);

    process.env.LETTER_IRL_BETA_ALLOWED_SUBJECTS = SUBJECT;
    expect(isBetaAccessAllowed(SUBJECT)).toBe(true);
  });
});
