type DiagnosticLevel = "info" | "warn" | "error";

type DiagnosticValue = string | number | boolean;

const SAFE_CLASS_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const SAFE_ERROR_CLASSES = new Set([
  "Error",
  "TypeError",
  "SyntaxError",
  "AggregateError",
  "ERR_JWT_EXPIRED",
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JOSE_ALG_NOT_ALLOWED",
  "ERR_JWKS_NO_MATCHING_KEY",
  "ERR_JWKS_MULTIPLE_MATCHING_KEYS",
  "ERR_JWKS_TIMEOUT"
]);

export function classifyDiagnosticError(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "unknown_error";
  }

  const candidate =
    "code" in error && typeof error.code === "string"
      ? error.code
      : error instanceof Error
        ? error.name
        : "unknown_error";

  return SAFE_ERROR_CLASSES.has(candidate) ? candidate : "unknown_error";
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
