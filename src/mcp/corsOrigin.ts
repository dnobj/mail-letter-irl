/**
 * Which origin a CORS response names.
 *
 * Only an allowlisted origin is reflected; anything else, including no Origin
 * header at all, receives the configured fallback, which no other origin's
 * browser will accept. There is no wildcard. Until 2026-09 an `Origin: null`
 * request (a `file://` page or a sandboxed frame) was answered with `*`, a
 * leftover from a deleted local-file admin page (audit A-11); it let any such
 * page call the SSE and public promo routes with a token it already held.
 * Deleted, and pinned by corsOrigin.test.ts.
 */
export function resolveCorsOriginFor(
  incoming: string | string[] | undefined,
  allowedOrigins: readonly string[],
  fallback: string,
): string {
  const origin = Array.isArray(incoming) ? incoming[0] : incoming;
  if (!origin) return fallback;
  return allowedOrigins.includes(origin) ? origin : fallback;
}
