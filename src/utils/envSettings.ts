/**
 * Environment-variable parsing that fails to its default rather than to a
 * surprising value.
 *
 * `Math.max(1, Number.parseInt(raw, 10))` looks like a clamp and is not one:
 * `Number.parseInt('ninety', 10)` is NaN and `Math.max(1, NaN)` is NaN, while
 * `Number.parseInt('1e3', 10)` stops at the `e` and returns 1 - so an operator
 * writing 1000 gets 1. On a job that removes customer content that turned a
 * typo into a one-day retention window (#153 review round 2).
 *
 * imageGenerationLimitService and commerceService each carry a private copy of
 * this shape. New call sites should use these; folding the existing two in is
 * a follow-up rather than part of a retention change.
 */

/** Parse a positive integer setting, falling back on anything unparseable. */
export function positiveIntegerSetting(
  name: string,
  fallback: number,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
  env: NodeJS.ProcessEnv = process.env
): number {
  const parsed = Number.parseInt(env[name] || '', 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) return fallback;
  // Reject values parseInt silently truncated ('1e3' -> 1, '90days' -> 90):
  // the operator meant something this process cannot honour, and guessing is
  // how a 1000-day window became a 1-day one.
  if ((env[name] || '').trim() !== String(parsed)) return fallback;
  return parsed;
}

const AFFIRMATIVE = new Set(['true', '1', 'yes', 'on', 'enabled']);

/**
 * A flag that is ON when unset, and OFF for anything not explicitly
 * affirmative - so `false`, `0`, `no`, `off`, `FALSE` and a typo all disable
 * it. Use for a kill switch on an irreversible job, where an operator who
 * believes they have stopped it must actually have stopped it.
 */
export function enabledUnlessDisabled(
  name: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const raw = (env[name] ?? '').trim().toLowerCase();
  if (raw === '') return true;
  return AFFIRMATIVE.has(raw);
}
