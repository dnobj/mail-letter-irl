import { createHash } from "node:crypto";

import {
  AdminCommandConfirmationSchema,
  boundedAdminJsonObjectSchema,
  type AdminJsonObject,
  type AdminJsonValue,
  ADMIN_OPERATION_PAYLOAD_MAX_BYTES,
} from "../contracts.js";
import { AdminFoundationError } from "../errors.js";

function canonicalize(value: AdminJsonValue): AdminJsonValue {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function createAdminPreviewDigest(input: unknown): string {
  const normalized = boundedAdminJsonObjectSchema(
    ADMIN_OPERATION_PAYLOAD_MAX_BYTES,
  ).parse(input);
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(normalized)))
    .digest("hex");
}

export function validateAdminCommandConfirmation(
  confirmationInput: unknown,
  expected: { previewDigest: string; expectedVersion?: string },
) {
  const confirmation = AdminCommandConfirmationSchema.parse(confirmationInput);
  if (
    confirmation.previewDigest !== expected.previewDigest ||
    confirmation.expectedVersion !== expected.expectedVersion
  ) {
    throw new AdminFoundationError("ADMIN_IDEMPOTENCY_CONFLICT");
  }
  return confirmation;
}

export function normalizeAdminCommandInput(input: unknown): AdminJsonObject {
  return boundedAdminJsonObjectSchema(ADMIN_OPERATION_PAYLOAD_MAX_BYTES).parse(
    input,
  );
}
