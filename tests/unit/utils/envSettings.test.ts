import { describe, expect, it } from 'vitest';
import {
  enabledUnlessDisabled,
  onUnlessExplicitlyDisabled,
  positiveIntegerSetting
} from '../../../src/utils/envSettings.js';

/**
 * These exist because the shape they replace was a live, catastrophic bug on
 * an irreversible job: `Math.max(1, Number.parseInt(raw, 10))` reads like a
 * clamp and is not one. Every case below was reachable in production
 * (#153 review round 2).
 */
describe('positiveIntegerSetting', () => {
  const env = (value: string | undefined) =>
    (value === undefined ? {} : { RETENTION: value }) as NodeJS.ProcessEnv;

  it('returns the parsed value when it is a clean integer in range', () => {
    expect(positiveIntegerSetting('RETENTION', 90, 2, 5000, env('120'))).toBe(120);
  });

  it('falls back rather than NaN on a non-numeric value', () => {
    // Math.max(1, NaN) is NaN, which then failed validation and silently
    // disabled the sweep for every subsequent night.
    expect(positiveIntegerSetting('RETENTION', 90, 2, 5000, env('ninety'))).toBe(90);
  });

  it('falls back rather than 1 on scientific notation', () => {
    // parseInt('1e3', 10) stops at the 'e' and returns 1: an operator writing
    // 1000 days would have got a ONE-day retention window.
    expect(positiveIntegerSetting('RETENTION', 90, 2, 5000, env('1e3'))).toBe(90);
  });

  it('falls back rather than the truncated value on a trailing-unit typo', () => {
    // The fallback is deliberately NOT 90 here: parseInt('90days') is 90, so a
    // fallback of 90 would pass whether or not the truncation guard exists.
    expect(positiveIntegerSetting('RETENTION', 30, 2, 5000, env('90days'))).toBe(30);
  });

  it('falls back on scientific notation even when the truncation is in range', () => {
    // parseInt('9e9', 10) is 9, which is a perfectly valid window - so only
    // the truncation guard catches it, not the minimum.
    expect(positiveIntegerSetting('RETENTION', 90, 2, 5000, env('9e9'))).toBe(90);
  });

  it.each(['0', '-1', '1'])('falls back below the minimum (%s)', raw => {
    // '0' meaning "off" previously clamped to a 1-day window and destroyed
    // every letter older than 24 hours.
    expect(positiveIntegerSetting('RETENTION', 90, 2, 5000, env(raw))).toBe(90);
  });

  it('falls back above the maximum instead of throwing downstream', () => {
    expect(positiveIntegerSetting('RETENTION', 500, 1, 5000, env('10000'))).toBe(500);
  });

  it('falls back when unset or empty', () => {
    expect(positiveIntegerSetting('RETENTION', 90, 2, 5000, env(undefined))).toBe(90);
    expect(positiveIntegerSetting('RETENTION', 90, 2, 5000, env('   '))).toBe(90);
  });
});

describe('enabledUnlessDisabled', () => {
  const env = (value: string | undefined) =>
    (value === undefined ? {} : { FLAG: value }) as NodeJS.ProcessEnv;

  it('is on when unset, so the feature works without configuration', () => {
    expect(enabledUnlessDisabled('FLAG', env(undefined))).toBe(true);
  });

  it.each(['true', 'TRUE', '1', 'yes', 'on', 'enabled', ' true '])(
    'stays on for the affirmative spelling %s',
    raw => {
      expect(enabledUnlessDisabled('FLAG', env(raw))).toBe(true);
    }
  );

  it.each(['false', 'FALSE', 'False', '0', 'no', 'off', 'disabled'])(
    'turns OFF for %s',
    raw => {
      // The previous check was `=== 'false'`, so every one of these left an
      // irreversible sweep armed while the operator believed it was stopped.
      expect(enabledUnlessDisabled('FLAG', env(raw))).toBe(false);
    }
  );

  it('turns OFF for an unrecognised value rather than staying armed', () => {
    // Fail-safe direction: for a job that removes customer content, a typo
    // must not be read as consent to keep running.
    expect(enabledUnlessDisabled('FLAG', env('mabye'))).toBe(false);
  });
});

/**
 * The retention mode gate. This is the single most important property of the
 * report-only rollout: if the default were 'enforce', shipping it would start
 * removing customer content on the next cron run.
 */
describe('retentionEnforces', () => {
  const env = (value: string | undefined) =>
    (value === undefined ? {} : { CONTENT_RETENTION_MODE: value }) as NodeJS.ProcessEnv;

  it('REPORTS by default, so shipping this removes nothing', async () => {
    const { retentionEnforces } = await import('../../../src/cli/runMaintenance.js');
    expect(retentionEnforces(env(undefined))).toBe(false);
  });

  it('enforces only when the word is spelled out', async () => {
    const { retentionEnforces } = await import('../../../src/cli/runMaintenance.js');
    expect(retentionEnforces(env('enforce'))).toBe(true);
    expect(retentionEnforces(env(' ENFORCE '))).toBe(true);
  });

  it.each(['report', 'true', '1', 'yes', 'on', 'enabled', 'enforced', 'enforc', ''])(
    'reports for %s - anything not exactly the word',
    async raw => {
      // Deliberately NOT a boolean: 'true'/'1'/'yes' all read as enable in this
      // repo's other flags, and any of them silently arming an irreversible
      // sweep is the failure this shape exists to prevent.
      const { retentionEnforces } = await import('../../../src/cli/runMaintenance.js');
      expect(retentionEnforces(env(raw))).toBe(false);
    }
  );
});

/**
 * The access-gate polarity (#179).
 *
 * enabledUnlessDisabled was the obvious helper to reach for and is the wrong
 * one: it returns false for anything it does not recognise, so
 * LETTER_IRL_BETA_GATE_ENABLED=fasle would have DISABLED the beta gate and
 * opened production to everyone. Correct for a kill switch, backwards for a
 * guard.
 */
describe('onUnlessExplicitlyDisabled', () => {
  const env = (value: string | undefined) =>
    (value === undefined ? {} : { FLAG: value }) as NodeJS.ProcessEnv;

  it('is on when unset, so an unconfigured deployment is guarded, not open', () => {
    expect(onUnlessExplicitlyDisabled('FLAG', env(undefined))).toBe(true);
  });

  it.each(['false', 'FALSE', 'False', '0', 'no', 'off', 'disabled', ' off ', 'ofF '])(
    'turns off only for the explicit negative %s',
    raw => {
      expect(onUnlessExplicitlyDisabled('FLAG', env(raw))).toBe(false);
    }
  );

  it.each(['true', '1', 'yes', 'on', 'enabled'])('stays on for %s', raw => {
    expect(onUnlessExplicitlyDisabled('FLAG', env(raw))).toBe(true);
  });

  it('STAYS ON for a typo rather than opening the gate', () => {
    // The reason this function exists. Every one of these is a plausible
    // mis-keying of "false", and each would have admitted the world.
    for (const typo of ['fasle', 'flase', 'fales', 'nope', 'disable', 'noo']) {
      expect(onUnlessExplicitlyDisabled('FLAG', env(typo)), typo).toBe(true);
    }
  });

  it('disagrees with enabledUnlessDisabled on exactly the case that matters', () => {
    // Pinned as a PAIR so the two cannot be quietly unified. They agree when
    // the value is readable and diverge when it is not, and that divergence is
    // the entire design: a typo must leave a guard UP and a kill switch DOWN.
    for (const readable of ['true', 'on', '1', 'false', 'off', '0', undefined]) {
      expect(
        onUnlessExplicitlyDisabled('FLAG', env(readable)),
        `readable value ${String(readable)} should agree`
      ).toBe(enabledUnlessDisabled('FLAG', env(readable)));
    }
    expect(onUnlessExplicitlyDisabled('FLAG', env('fasle'))).toBe(true);
    expect(enabledUnlessDisabled('FLAG', env('fasle'))).toBe(false);
  });
});
