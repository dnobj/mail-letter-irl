import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  AdminAuditEventInputSchema,
  AdminErrorEnvelopeSchema,
  AdminPageRequestSchema,
  ADMIN_SUMMARY_MAX_BYTES,
} from "../../../src/admin/contracts.js";
import {
  createAdminPreviewDigest,
  validateAdminCommandConfirmation,
} from "../../../src/admin/commands/foundation.js";
import {
  AdminFoundationError,
  toAdminErrorEnvelope,
} from "../../../src/admin/errors.js";

describe("shared admin contracts", () => {
  it("bounds pagination and rejects unknown fields", () => {
    expect(AdminPageRequestSchema.parse({})).toEqual({ limit: 25 });
    expect(() => AdminPageRequestSchema.parse({ limit: 101 })).toThrow();
    expect(() =>
      AdminPageRequestSchema.parse({ limit: 25, extra: true }),
    ).toThrow();
  });

  it("enforces bounded audit JSON and outcome/error consistency", () => {
    const base = {
      actor: { sid: "S-1-5-21-1000", name: "operator" },
      environment: "development",
      mode: "read-only",
      sessionIdHash: "a".repeat(64),
      correlationId: randomUUID(),
      action: "users.list",
      targetType: "users",
      outcome: "succeeded",
    } as const;

    expect(AdminAuditEventInputSchema.parse(base).inputSummary).toEqual({});
    expect(() =>
      AdminAuditEventInputSchema.parse({
        ...base,
        inputSummary: { value: "x".repeat(ADMIN_SUMMARY_MAX_BYTES) },
      }),
    ).toThrow();
    expect(() =>
      AdminAuditEventInputSchema.parse({ ...base, outcome: "denied" }),
    ).toThrow();
  });

  it("creates stable canonical preview digests", () => {
    const first = createAdminPreviewDigest({
      amount: 2,
      target: { b: true, a: "x" },
    });
    const second = createAdminPreviewDigest({
      target: { a: "x", b: true },
      amount: 2,
    });

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
  });

  it("requires reason and exact preview/version confirmation", () => {
    const previewDigest = "b".repeat(64);
    expect(
      validateAdminCommandConfirmation(
        {
          previewDigest,
          reason: "Correct an approved fixture",
          idempotencyKey: "test-command-1",
          expectedVersion: "7",
        },
        { previewDigest, expectedVersion: "7" },
      ),
    ).toMatchObject({ idempotencyKey: "test-command-1" });

    expect(() =>
      validateAdminCommandConfirmation(
        {
          previewDigest: "c".repeat(64),
          reason: "Correct an approved fixture",
          idempotencyKey: "test-command-1",
          expectedVersion: "7",
        },
        { previewDigest, expectedVersion: "7" },
      ),
    ).toThrowError(
      expect.objectContaining<Partial<AdminFoundationError>>({
        code: "ADMIN_IDEMPOTENCY_CONFLICT",
      }),
    );
  });

  it("maps unexpected failures to stable public errors without raw details", () => {
    const envelope = toAdminErrorEnvelope(
      new Error("password=secret SQL syntax failure"),
      randomUUID(),
    );

    expect(envelope.error.code).toBe("ADMIN_INTERNAL_ERROR");
    expect(AdminErrorEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(JSON.stringify(envelope)).not.toContain("secret");
    expect(JSON.stringify(envelope)).not.toContain("SQL");
  });
});
