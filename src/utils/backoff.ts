/**
 * The one bounded-exponential-backoff-with-jitter formula. letterJobService
 * and priceCatalog each carried an identical private copy with its own
 * injectable-randomness seam; a tuning change to one silently missed the
 * other (#278 review round 6).
 */
export function boundedExponentialDelayMs(
  baseMs: number,
  ceilingMs: number,
  attempt: number,
  random: () => number,
  jitterMs = 1_000
): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(baseMs * 2 ** exponent, ceilingMs) + Math.floor(random() * jitterMs);
}
