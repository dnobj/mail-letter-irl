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

/**
 * Values that explicitly turn a flag OFF. The mirror of AFFIRMATIVE, and
 * deliberately a separate list: 'enabled'/'disabled' pair up, but the two sets
 * are consulted by functions with opposite failure directions and must be free
 * to diverge.
 */
const NEGATIVE = new Set(['false', '0', 'no', 'off', 'disabled']);

/**
 * A flag that is ON when unset and ON for anything not explicitly negative -
 * so only `false`, `0`, `no`, `off`, `disabled` turn it off, and a TYPO LEAVES
 * IT ON.
 *
 * This is the mirror image of enabledUnlessDisabled and is deliberately NOT a
 * generalisation of it. The two differ in exactly one case - an unreadable
 * value - and that case is the whole reason both exist. Choose by asking which
 * direction a typo should fall:
 *
 *   enabledUnlessDisabled       typo -> OFF. For a kill switch on an
 *                               irreversible job, where an operator who
 *                               believes they have stopped it must actually
 *                               have stopped it.
 *
 *   onUnlessExplicitlyDisabled  typo -> ON. For an ACCESS GATE, where "off"
 *                               means production is open to everyone.
 *                               LETTER_IRL_BETA_GATE_ENABLED=fasle must not
 *                               admit the world.
 *
 * Do not fold these two together. They are a few lines apart and opposite in
 * the only case that matters, and a single "sensible" helper would be wrong
 * half the time.
 */
export function onUnlessExplicitlyDisabled(
  name: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const raw = (env[name] ?? '').trim().toLowerCase();
  return !NEGATIVE.has(raw);
}
