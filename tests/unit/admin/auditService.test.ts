import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { AdminAuditWriter } from "../../../src/admin/auditService.js";
import type { AdminSqlClient } from "../../../src/admin/database.js";
import { AdminFoundationError } from "../../../src/admin/errors.js";

function commandRow(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    idempotencyKey: "command-key-1",
    actorSid: "S-1-5-21-1000",
    environment: "development",
    action: "balance.adjust",
    targetType: "user",
    targetId: "user-1",
    previewDigest: "a".repeat(64),
    expectedVersion: "4",
    status: "pending",
    requestedAt: new Date(),
    startedAt: null,
    completedAt: null,
    correlationId: randomUUID(),
    sanitizedResult: null,
    errorCode: null,
    ...overrides,
  };
}

function commandInput(row: ReturnType<typeof commandRow>) {
  return {
    idempotencyKey: row.idempotencyKey,
    actorSid: row.actorSid,
    environment: row.environment as "development",
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    previewDigest: row.previewDigest,
    expectedVersion: row.expectedVersion,
    correlationId: row.correlationId,
  };
}

describe("AdminAuditWriter", () => {
  it("exposes only an append audit write and returns a receipt", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ id: randomUUID(), occurredAt: new Date() }],
    });
    const writer = new AdminAuditWriter();

    const receipt = await writer.appendEvent(
      { query } as unknown as AdminSqlClient,
      {
        actor: { sid: "S-1-5-21-1000", name: "operator" },
        environment: "development",
        mode: "read-only",
        sessionIdHash: "b".repeat(64),
        correlationId: randomUUID(),
        action: "users.list",
        targetType: "users",
        outcome: "succeeded",
      },
    );

    expect(receipt.id).toBeTruthy();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toMatch(
      /^\s*INSERT INTO admin_audit_events/,
    );
    expect(query.mock.calls[0][0]).not.toMatch(/UPDATE|DELETE/);
  });

  it("redacts database failures behind a stable audit error", async () => {
    const query = vi
      .fn()
      .mockRejectedValue(new Error("password=secret raw SQL failure"));
    const writer = new AdminAuditWriter();

    await expect(
      writer.appendEvent({ query } as unknown as AdminSqlClient, {
        actor: { sid: "S-1-5-21-1000", name: "operator" },
        environment: "development",
        mode: "read-only",
        sessionIdHash: "b".repeat(64),
        correlationId: randomUUID(),
        action: "users.list",
        targetType: "users",
        outcome: "succeeded",
      }),
    ).rejects.toMatchObject({
      code: "ADMIN_AUDIT_WRITE_FAILED",
      message: "The admin audit event could not be recorded.",
    });
  });

  it("returns the original command run for a matching idempotency replay", async () => {
    const row = commandRow();
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row] });
    const writer = new AdminAuditWriter();

    const result = await writer.beginCommandRun(
      { query } as unknown as AdminSqlClient,
      commandInput(row),
    );

    expect(result.replayed).toBe(true);
    expect(result.commandRun.id).toBe(row.id);
  });

  it("rejects reuse of an idempotency key for a different command", async () => {
    const row = commandRow({ action: "routing.update" });
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row] });
    const writer = new AdminAuditWriter();

    await expect(
      writer.beginCommandRun(
        { query } as unknown as AdminSqlClient,
        commandInput(commandRow({ correlationId: row.correlationId })),
      ),
    ).rejects.toThrowError(
      expect.objectContaining<Partial<AdminFoundationError>>({
        code: "ADMIN_IDEMPOTENCY_CONFLICT",
      }),
    );
  });
});
