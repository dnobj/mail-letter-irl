export const ADMIN_ERROR_HTTP_STATUS = {
  ADMIN_INVALID_REQUEST: 400,
  ADMIN_PRODUCTION_CONFIRMATION_REQUIRED: 403,
  ADMIN_NOT_FOUND: 404,
  ADMIN_IDEMPOTENCY_CONFLICT: 409,
  ADMIN_INVALID_CONFIGURATION: 500,
  ADMIN_LEGACY_ROUTES_DISABLED: 500,
  ADMIN_AUDIT_WRITE_FAILED: 500,
  ADMIN_ENVIRONMENT_MISMATCH: 503,
  ADMIN_DATABASE_MARKER_MISSING: 503,
  ADMIN_DATABASE_HOST_MISMATCH: 503,
  ADMIN_DATABASE_NAME_MISMATCH: 503,
  ADMIN_DATABASE_ROLE_MISMATCH: 503,
  ADMIN_INTERNAL_ERROR: 500,
} as const;

export type AdminErrorCode = keyof typeof ADMIN_ERROR_HTTP_STATUS;

const ADMIN_PUBLIC_MESSAGES: Record<AdminErrorCode, string> = {
  ADMIN_INVALID_REQUEST: "The admin request is invalid.",
  ADMIN_PRODUCTION_CONFIRMATION_REQUIRED:
    "Production access requires separate confirmation.",
  ADMIN_NOT_FOUND: "The requested admin resource was not found.",
  ADMIN_IDEMPOTENCY_CONFLICT:
    "The idempotency key is already bound to a different command.",
  ADMIN_INVALID_CONFIGURATION: "The local admin configuration is invalid.",
  ADMIN_LEGACY_ROUTES_DISABLED: "Legacy public admin routes are disabled.",
  ADMIN_AUDIT_WRITE_FAILED: "The admin audit event could not be recorded.",
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
