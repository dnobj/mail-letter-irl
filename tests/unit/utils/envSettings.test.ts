import { describe, expect, it } from 'vitest';
import { enabledUnlessDisabled, positiveIntegerSetting } from '../../../src/utils/envSettings.js';

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

  it('falls back rather than 1 on a trailing-unit typo', () => {
    expect(positiveIntegerSetting('RETENTION', 90, 2, 5000, env('90days'))).toBe(90);
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
