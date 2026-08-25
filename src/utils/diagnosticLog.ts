type DiagnosticLevel = "info" | "warn" | "error";

type DiagnosticValue = string | number | boolean;

const SAFE_CLASS_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const SAFE_ERROR_CODES = new Set([
  "ERR_JWT_EXPIRED",
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JOSE_ALG_NOT_ALLOWED",
  "ERR_JWKS_NO_MATCHING_KEY",
  "ERR_JWKS_MULTIPLE_MATCHING_KEYS",
  "ERR_JWKS_TIMEOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "23505",
  "28P01",
  "3D000",
  "42P01",
  // lock_timeout expiry. Surfaced verbatim so a failed deploy says "another
  // migrator holds the migration lock" instead of the useless generic
  // "database_error"; the code itself carries no user or secret data.
  "55P03",
  // Stripe's documented error-code taxonomy, same footing as the JOSE codes
  // above: a fixed public enum carrying no PII or secret. Surfaced so a failed
  // checkout says "resource_missing" (the Price ID does not exist in this
  // account/mode) instead of collapsing to a default that names the wrong
  // subsystem entirely - the exact ambiguity that cost issue #213 a full
  // investigation. See https://stripe.com/docs/error-codes.
  "resource_missing",
  "api_key_expired",
  "amount_too_small",
  "amount_too_large",
  "parameter_missing",
  "parameter_invalid_integer",
  "testmode_charges_only"
]);

// Stripe error TYPES, checked when no allowlisted `code` is present - card,
// auth, connection and rate-limit failures carry a stable `.type` even when
// `.code` is absent. Also a fixed public enum.
const SAFE_ERROR_TYPES = new Set([
  "StripeCardError",
  "StripeInvalidRequestError",
  "StripeAPIError",
  "StripeConnectionError",
  "StripeAuthenticationError",
  "StripeRateLimitError",
  "StripePermissionError",
  "StripeIdempotencyError"
]);

export type DiagnosticErrorCategory =
  | "authorization_error"
  | "configuration_error"
  | "database_error"
  | "provider_error"
  | "rate_limit_error"
  | "transport_error"
  | "validation_error"
  | "unknown_error";

/**
 * Classes a human must act on: retrying cannot clear them, however long you
 * wait. This is the vocabulary's own question, so it is answered once here
 * rather than by string comparisons scattered through the commerce layer -
 * where `=== 'configuration_error'` was inlined at five sites, each of which
 * decides something expensive (whether to cancel a customer's order, whether a
 * paid webhook retries or books unmatched money, how hard to retry Stripe).
 * Adding a class there meant finding all five; missing one cancelled a live
 * order or retried a hopeless fault forever (#278 review round 3).
 *
 * Everything absent from this set is treated as transient, which is the safe
 * default: a transient verdict retries and leaves orders pending, a terminal
 * one cancels.
 */
const TERMINAL_ERROR_CLASSES = new Set([
  "configuration_error",
  // The id points at nothing in this account or mode.
  "resource_missing",
  // Credentials: a revoked, expired, restricted or wrong-mode key. No amount
  // of retrying fixes any of them. These are TYPES, but unambiguous ones:
  // stripe-node raises them only for authentication and permission failures.
  "api_key_expired",
  "testmode_charges_only",
  "StripeAuthenticationError",
  "StripePermissionError",
  // Specific invalid-request CODES whose cause is always configuration: a
  // Price below/above Stripe's own per-currency limits, or a request our code
  // built wrong. Each keeps failing identically until a human acts.
  "amount_too_small",
  "amount_too_large",
  "parameter_missing",
  "parameter_invalid_integer"
  // The coarse "StripeInvalidRequestError" TYPE is deliberately absent. It is
  // stripe-node's constructor-name fallback for every invalid_request_error
  // without an allowlisted code - including retryable ones like expires_at
  // drifting under Stripe's 30-minute floor while a slow request is in
  // transit. Listing it here cancelled live customers' orders for faults a
  // retry would have cleared (#278 review round 4). An unrecognized invalid
  // request therefore defaults to transient, which strands nothing: pending
  // orders are swept, cancelled ones are gone.
]);

export function isTerminalDiagnosticClass(diagnosticClass: string | undefined): boolean {
  return diagnosticClass !== undefined && TERMINAL_ERROR_CLASSES.has(diagnosticClass);
}

export function classifyDiagnosticError(
  error: unknown,
  fallback: DiagnosticErrorCategory = "unknown_error"
): string {
  if (!error || typeof error !== "object") {
    return "unknown_error";
  }

  const candidate = "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
  if (candidate && SAFE_ERROR_CODES.has(candidate)) return candidate;

  // Fall back to a Stripe error's `.type` when its `.code` is absent or not
  // recognized. Both are fixed public enums; neither carries data.
  const type = "type" in error && typeof error.type === "string"
    ? error.type
    : undefined;
  if (type && SAFE_ERROR_TYPES.has(type)) return type;

  return fallback;
}

export function writeDiagnostic(
  level: DiagnosticLevel,
  event: string,
  fields: Record<string, DiagnosticValue> = {}
): void {
  const safeEvent = SAFE_CLASS_PATTERN.test(event) ? event : "diagnostic_event";
  const payload = JSON.stringify({ ...fields, event: safeEvent });
  if (level === "error") {
    console.error(payload);
  } else if (level === "warn") {
    console.warn(payload);
  } else {
    console.log(payload);
  }
}
