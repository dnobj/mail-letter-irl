export const ADMIN_ERROR_HTTP_STATUS = {
  ADMIN_INVALID_REQUEST: 400,
  ADMIN_UNAUTHENTICATED: 401,
  ADMIN_FORBIDDEN: 403,
  ADMIN_PRODUCTION_CONFIRMATION_REQUIRED: 403,
  ADMIN_ELEVATION_REQUIRED: 403,
  ADMIN_ELEVATION_LOCKED: 403,
  ADMIN_READ_ONLY_MODE: 403,
  ADMIN_COMMAND_DISABLED: 403,
  ADMIN_CSRF_REJECTED: 403,
  ADMIN_NOT_FOUND: 404,
  ADMIN_METHOD_NOT_ALLOWED: 405,
  ADMIN_IDEMPOTENCY_CONFLICT: 409,
  ADMIN_STALE_PREVIEW: 409,
  ADMIN_INVALID_STATE: 409,
  ADMIN_PAYLOAD_TOO_LARGE: 413,
  ADMIN_RATE_LIMITED: 429,
  ADMIN_INVALID_CONFIGURATION: 500,
  ADMIN_LEGACY_ROUTES_DISABLED: 500,
  ADMIN_AUDIT_WRITE_FAILED: 500,
  ADMIN_PUBLIC_DOMAIN_PRESENT: 500,
  ADMIN_PROVIDER_ERROR: 502,
  ADMIN_ENVIRONMENT_MISMATCH: 503,
  ADMIN_DATABASE_MARKER_MISSING: 503,
  ADMIN_DATABASE_HOST_MISMATCH: 503,
  ADMIN_DATABASE_NAME_MISMATCH: 503,
  ADMIN_DATABASE_ROLE_MISMATCH: 503,
  ADMIN_TAILSCALE_UNAVAILABLE: 503,
  ADMIN_TAILSCALE_NEEDS_LOGIN: 503,
  ADMIN_TAILSCALE_TAG_MISMATCH: 503,
  ADMIN_TAILSCALE_NAME_MISMATCH: 503,
  ADMIN_TAILSCALE_DAEMON_EXITED: 503,
  ADMIN_INTERNAL_ERROR: 500,
} as const;

export type AdminErrorCode = keyof typeof ADMIN_ERROR_HTTP_STATUS;

const ADMIN_PUBLIC_MESSAGES: Record<AdminErrorCode, string> = {
  ADMIN_INVALID_REQUEST: "The admin request is invalid.",
  ADMIN_UNAUTHENTICATED: "Authentication is required.",
  ADMIN_FORBIDDEN: "The operator is not permitted to perform this action.",
  ADMIN_PRODUCTION_CONFIRMATION_REQUIRED:
    "Production access requires separate confirmation.",
  ADMIN_ELEVATION_REQUIRED:
    "A current second-factor elevation is required for this action.",
  ADMIN_ELEVATION_LOCKED:
    "Elevation is locked for this session after repeated failures.",
  ADMIN_READ_ONLY_MODE: "This admin service runs in read-only mode.",
  ADMIN_COMMAND_DISABLED: "This command is disabled in this environment.",
  ADMIN_CSRF_REJECTED: "The request failed the browser-origin checks.",
  ADMIN_NOT_FOUND: "The requested admin resource was not found.",
  ADMIN_METHOD_NOT_ALLOWED: "The method is not allowed for this route.",
  ADMIN_IDEMPOTENCY_CONFLICT:
    "The idempotency key is already bound to a different command.",
  ADMIN_STALE_PREVIEW:
    "The target changed since the preview was rendered; preview it again.",
  ADMIN_INVALID_STATE: "The target is not in a state that permits this action.",
  ADMIN_PAYLOAD_TOO_LARGE: "The request body exceeds the configured limit.",
  ADMIN_RATE_LIMITED: "Too many requests; slow down.",
  ADMIN_INVALID_CONFIGURATION: "The admin configuration is invalid.",
  ADMIN_LEGACY_ROUTES_DISABLED: "Legacy public admin routes are disabled.",
  ADMIN_AUDIT_WRITE_FAILED: "The admin audit event could not be recorded.",
  ADMIN_PUBLIC_DOMAIN_PRESENT:
    "The admin service must not have a public domain.",
  ADMIN_PROVIDER_ERROR: "The provider call failed; the command was not applied.",
  ADMIN_ENVIRONMENT_MISMATCH:
    "The selected admin environment does not match the database marker.",
  ADMIN_DATABASE_MARKER_MISSING:
    "The database does not have an admin environment marker.",
  ADMIN_DATABASE_HOST_MISMATCH:
    "The selected database host does not match local admin configuration.",
  ADMIN_DATABASE_NAME_MISMATCH:
    "The selected database name does not match local admin configuration.",
  ADMIN_DATABASE_ROLE_MISMATCH:
    "The connected database role does not match the requested admin mode.",
  ADMIN_TAILSCALE_UNAVAILABLE: "The Tailscale daemon did not become ready.",
  ADMIN_TAILSCALE_NEEDS_LOGIN:
    "The Tailscale node needs a login and no auth key was provided.",
  ADMIN_TAILSCALE_TAG_MISMATCH:
    "The Tailscale node does not carry exactly the expected environment tag.",
  ADMIN_TAILSCALE_NAME_MISMATCH:
    "The Tailscale node name does not match the expected hostname.",
  ADMIN_TAILSCALE_DAEMON_EXITED: "The Tailscale daemon exited.",
  ADMIN_INTERNAL_ERROR: "The admin operation failed.",
};

export class AdminFoundationError extends Error {
  readonly code: AdminErrorCode;
  readonly httpStatus: number;

  constructor(code: AdminErrorCode) {
    super(ADMIN_PUBLIC_MESSAGES[code]);
    this.name = "AdminFoundationError";
    this.code = code;
    this.httpStatus = ADMIN_ERROR_HTTP_STATUS[code];
  }
}

/**
 * A configuration failure that names the offending variables. The names are
 * safe to print; the values never are, and none is carried here.
 */
export class AdminConfigurationError extends AdminFoundationError {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super("ADMIN_INVALID_CONFIGURATION");
    this.name = "AdminConfigurationError";
    this.problems = problems;
  }
}

export interface AdminErrorEnvelope {
  ok: false;
  error: {
    code: AdminErrorCode;
    message: string;
    correlationId: string;
  };
}

export function toAdminErrorEnvelope(
  error: unknown,
  correlationId: string,
): AdminErrorEnvelope {
  const publicError =
    error instanceof AdminFoundationError
      ? error
      : new AdminFoundationError("ADMIN_INTERNAL_ERROR");

  return {
    ok: false,
    error: {
      code: publicError.code,
      message: publicError.message,
      correlationId,
    },
  };
}
