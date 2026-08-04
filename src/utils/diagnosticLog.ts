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
  "55P03"
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

  return candidate && SAFE_ERROR_CODES.has(candidate) ? candidate : fallback;
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
