import { describe, expect, it, vi } from "vitest";

import { createRetentionCommands } from "../../../src/admin/commands/retention.js";
import type { AdminSqlClient } from "../../../src/admin/database.js";

/**
 * retention.restore (#153) over a scripted client: what the preview refuses,
 * what it signs, and that confirming only queues. The PostgreSQL suite proves
 * the queue and the restore themselves.
 */

const COPY = "8f14e45f-ceea-467a-9575-9c2d1f7c0a11";
const QUARANTINED_AT = new Date("2026-09-20T03:00:00.000Z");
const PURGE_AFTER = new Date("2026-09-27T03:00:00.000Z");

const ROW = {
  quarantine_id: COPY,
  source_table: "letters",
  source_id: "letter_1",
  quarantined_at: QUARANTINED_AT,
  purge_after: PURGE_AFTER,
  window_open: true,
  live_redacted: true,
  restore_queued: false,
};

function scripted(row: Record<string, unknown> | null = ROW): AdminSqlClient {
  const query = vi.fn(async () => ({ rows: row ? [row] : [] }));
  return { query } as unknown as AdminSqlClient;
}

const execution = (client: unknown = { query: vi.fn() }) => ({
  commandId: "22222222-2222-4222-8222-222222222222",
  idempotencyKey: "admin:22222222-2222-4222-8222-222222222222",
  actorId: "owner@example.com",
  environment: "development" as const,
  reason: "restore after a wrong sweep",
  client: client as never,
});

describe("retention.restore (#153)", () => {
  it("signs the copy's metadata and nothing of its content, and queues on confirmation", async () => {
    const enqueueAdminOperation = vi.fn().mockResolvedValue("op-7");
    const { restore } = createRetentionCommands({ enqueueAdminOperation });

    const preview = await restore.preview(scripted(), COPY, {});
    expect(preview.summary).toEqual({
      sourceTable: "letters",
      sourceId: "letter_1",
      quarantinedAt: QUARANTINED_AT.toISOString(),
      purgeAfter: PURGE_AFTER.toISOString(),
    });
    expect(preview.expectedVersion).toBe(QUARANTINED_AT.toISOString());
    expect(restore.verb({})).toBe("RESTORE");
    expect(restore.transactional).toBe(true);

    const client = { query: vi.fn() };
    expect(await restore.execute(execution(client), COPY, {}, preview)).toEqual({ operationId: "op-7", status: "queued" });
    expect(enqueueAdminOperation).toHaveBeenCalledWith(client, {
      commandId: "22222222-2222-4222-8222-222222222222",
      environment: "development",
      operationType: "retention.restore",
      payload: { quarantineId: COPY, sourceTable: "letters" },
    });
    // The command itself writes nothing but the queue row.
    expect(client.query).not.toHaveBeenCalled();
  });

  it("looks the copy up by id, and the queue for a restore already waiting", async () => {
    const client = scripted();
    await createRetentionCommands().restore.preview(client, COPY, {});
    const [sql, params] = (client.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([COPY, "retention.restore"]);
    expect(sql).toContain("WHERE q.quarantine_id = $1::uuid");
    expect(sql).toContain("o.status IN ('pending', 'processing')");
  });

  it("refuses an id that is not a copy's, before any query", async () => {
    const client = scripted();
    await expect(createRetentionCommands().restore.preview(client, "letter_1", {})).rejects.toMatchObject({
      code: "ADMIN_NOT_FOUND",
    });
    expect(client.query).not.toHaveBeenCalled();
  });

  it("refuses a copy that is gone", async () => {
    await expect(createRetentionCommands().restore.preview(scripted(null), COPY, {})).rejects.toMatchObject({
      code: "ADMIN_NOT_FOUND",
    });
  });

  it.each([
    ["the window has closed", { window_open: false }],
    ["the live row is not redacted", { live_redacted: false }],
    ["the live row is gone", { live_redacted: null }],
    ["a restore is already queued", { restore_queued: true }],
  ])("refuses when %s", async (_name, change) => {
    await expect(createRetentionCommands().restore.preview(scripted({ ...ROW, ...change }), COPY, {})).rejects.toMatchObject({
      code: "ADMIN_INVALID_STATE",
    });
  });

  it("warns that the row is due for the sweep again", async () => {
    const preview = await createRetentionCommands().restore.preview(scripted(), COPY, {});
    expect(preview.warnings.join("\n")).toMatch(/sweep again|quarantines it again/);
  });
});
