import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { AdminAuditWriter } from "../../../src/admin/auditService.js";
import { AdminFoundationError } from "../../../src/admin/errors.js";
import {
  expectedPhrase,
  prepareCommandPreview,
  runAdminCommand,
  type CommandDefinition,
  type CommandRunnerDeps,
} from "../../../src/admin/commands/runner.js";
import type { AdminJsonObject } from "../../../src/admin/contracts.js";
import { ElevationGuard } from "../../../src/admin/http/elevation.js";
import { AdminSessionStore, hashSessionId } from "../../../src/admin/http/session.js";
import { parseAdminRuntimeConfig } from "../../../src/admin/runtimeConfig.js";
import { validDevelopmentEnv } from "./runtimeConfig.test.js";

/**
 * The runner over an in-memory pg-shaped stub that understands exactly the
 * statements the audit writer issues, honours BEGIN/ROLLBACK, and remembers
 * command runs by (environment, idempotency key) so replays behave.
 */

interface Run {
  id: string;
  idempotencyKey: string;
  actorId: string;
  environment: string;
  action: string;
  targetType: string;
  targetId: string | null;
  previewDigest: string;
  expectedVersion: string | null;
  status: string;
  requestedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  correlationId: string;
  sanitizedResult: AdminJsonObject | null;
  errorCode: string | null;
}

function fakeDatabase() {
  const runs = new Map<string, Run>();
  const audits: Array<Record<string, unknown>> = [];
  let snapshot: { runs: Map<string, Run>; audits: Array<Record<string, unknown>> } | null = null;
  const query = vi.fn(async (text: string, values: unknown[] = []) => {
    if (text === "BEGIN") {
      snapshot = { runs: new Map([...runs].map(([k, v]) => [k, { ...v }])), audits: [...audits] };
      return { rows: [] };
    }
    if (text === "ROLLBACK") {
      // Restore in place: the test holds references to these collections.
      if (snapshot) {
        runs.clear();
        for (const [key, run] of snapshot.runs) runs.set(key, run);
        audits.length = 0;
        audits.push(...snapshot.audits);
      }
      snapshot = null;
      return { rows: [] };
    }
    if (text === "COMMIT" || text === "SET TRANSACTION READ ONLY") {
      snapshot = null;
      return { rows: [] };
    }
    if (text.includes("INSERT INTO admin_command_runs")) {
      const [idempotencyKey, actorId, environment, action, targetType, targetId, previewDigest, expectedVersion, correlationId] =
        values as string[];
      const composite = `${environment}|${idempotencyKey}`;
      if (runs.has(composite)) return { rows: [] };
      const run: Run = {
        id: randomUUID(),
        idempotencyKey,
        actorId,
        environment,
        action,
        targetType,
        targetId: targetId ?? null,
        previewDigest,
        expectedVersion: expectedVersion ?? null,
        status: "pending",
        requestedAt: new Date(),
        startedAt: null,
        completedAt: null,
        correlationId,
        sanitizedResult: null,
        errorCode: null,
      };
      runs.set(composite, run);
      return { rows: [{ ...run }] };
    }
    if (text.includes("WHERE environment = $1 AND idempotency_key = $2")) {
      const run = runs.get(`${values[0]}|${values[1]}`);
      return { rows: run ? [{ ...run }] : [] };
    }
    if (text.includes("SET status = 'running'")) {
      const run = [...runs.values()].find((candidate) => candidate.id === values[0]);
      if (!run || run.status !== "pending") return { rows: [] };
      run.status = "running";
      run.startedAt = new Date();
      return { rows: [{ ...run }] };
    }
    if (text.includes("completed_at = NOW()")) {
      const run = [...runs.values()].find((candidate) => candidate.id === values[0]);
      if (!run || !["pending", "running"].includes(run.status)) return { rows: [] };
      run.status = values[1] as string;
      run.completedAt = new Date();
      run.sanitizedResult = values[2] ? JSON.parse(values[2] as string) : null;
      run.errorCode = (values[3] as string | null) ?? null;
      return { rows: [{ ...run }] };
    }
    if (text.includes("INSERT INTO admin_audit_events")) {
      audits.push({ actor: values[0], action: values[6], targetId: values[8], reason: values[9], outcome: values[13], errorCode: values[14], commandId: values[15] });
      return { rows: [{ id: randomUUID(), occurredAt: new Date() }] };
    }
    return { rows: [] };
  });
  const client = { query, release: () => {} };
  const pool = { query, connect: async () => client, end: async () => {}, on: () => {} };
  return { pool: pool as never, runs, audits: () => audits, query };
}

interface EchoInput {
  amount: number;
}

function echoCommand(
  state: { version: string; executions: Array<{ key: string; reason: string; client: boolean }>; fail?: string; previewRefusal?: string },
  transactional = false,
): CommandDefinition<EchoInput> {
  return {
    name: "echo.adjust",
    title: "Echo",
    action: "echo.adjust",
    targetType: "fixture",
    transactional,
    verb: () => "ADJUST",
    parseInput(fields) {
      const amount = Number(fields.get("amount"));
      if (!Number.isInteger(amount)) throw new Error("bad input");
      return { amount };
    },
    async preview(_client, targetId, input) {
      if (state.previewRefusal) throw new AdminFoundationError(state.previewRefusal as never);
      return {
        targetId,
        summary: { amount: input.amount, before: 10 },
        expectedVersion: state.version,
        display: [["Target", targetId]],
        warnings: [],
      };
    },
    async execute(execution, _targetId, input) {
      state.executions.push({ key: execution.idempotencyKey, reason: execution.reason, client: execution.client !== null });
      if (state.fail) throw new Error(state.fail);
      return { after: 10 + input.amount };
    },
  };
}

function deps(database: ReturnType<typeof fakeDatabase>, options: { mode?: "full" | "read-only"; elevated?: boolean; environment?: "development" | "production" } = {}): CommandRunnerDeps {
  const env = {
    ...validDevelopmentEnv,
    ADMIN_MODE: options.mode ?? "full",
    DATABASE_URL: "postgres://letter_irl_admin_operator_development:pw@db.example.test/letter_irl_dev",
    ADMIN_TOTP_SECRET: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
  };
  if (options.mode === "read-only") env.DATABASE_URL = validDevelopmentEnv.DATABASE_URL as string;
  const config = parseAdminRuntimeConfig(env);
  if (options.environment) (config as { environment: string }).environment = options.environment;
  const store = new AdminSessionStore({ idleTtlMs: 60_000, absoluteTtlMs: 600_000 });
  const session = store.create({ login: "owner@example.com", name: "Owner", node: "laptop", peerAddress: "100.64.0.5" });
  const now = 1_700_000_000_000;
  if (options.elevated !== false) session.elevatedUntil = now + 60_000;
  return {
    config,
    reader: database.pool,
    operator: config.mode === "full" ? database.pool : null,
    audit: new AdminAuditWriter(),
    actor: { id: "owner@example.com", name: "Owner", node: "laptop" },
    session,
    elevation: new ElevationGuard(),
    sessionIdHash: hashSessionId(session.id),
    correlationId: randomUUID(),
    now: () => now,
  };
}

async function confirmationFields(
  command: CommandDefinition<EchoInput>,
  runner: CommandRunnerDeps,
  overrides: Record<string, string> = {},
  targetId = "fixture-1",
) {
  const prepared = await prepareCommandPreview(command, { query: async () => ({ rows: [] }) } as never, runner.config.environment, targetId, new Map([["amount", "5"]]));
  return new Map(
    Object.entries({
      amount: "5",
      previewDigest: prepared.previewDigest,
      expectedVersion: prepared.preview.expectedVersion ?? "",
      idempotencyKey: prepared.idempotencyKey,
      reason: "operator reason for the fixture",
      phrase: prepared.phrase,
      ...overrides,
    }),
  );
}

describe("admin command runner", () => {
  it("phrases the confirmation per environment", () => {
    expect(expectedPhrase("development", "REFUND", "order_1")).toBe("CONFIRM order_1");
    expect(expectedPhrase("production", "REFUND", "order_1")).toBe("PRODUCTION REFUND order_1");
  });

  it("refuses in read-only mode and without elevation before touching the database", async () => {
    const database = fakeDatabase();
    const state = { version: "v1", executions: [] };
    const command = echoCommand(state);
    await expect(
      runAdminCommand(deps(database, { mode: "read-only" }), command, "fixture-1", new Map()),
    ).rejects.toMatchObject({ code: "ADMIN_READ_ONLY_MODE" });
    await expect(
      runAdminCommand(deps(database, { elevated: false }), command, "fixture-1", new Map()),
    ).rejects.toMatchObject({ code: "ADMIN_ELEVATION_REQUIRED" });
    expect(database.query).not.toHaveBeenCalled();
    expect(state.executions).toEqual([]);
  });

  it("refuses a stale preview and a wrong phrase, auditing the phrase mismatch", async () => {
    const database = fakeDatabase();
    const state = { version: "v1", executions: [] };
    const command = echoCommand(state);
    const runner = deps(database);
    const fields = await confirmationFields(command, runner);
    state.version = "v2";
    await expect(runAdminCommand(runner, command, "fixture-1", fields)).rejects.toMatchObject({ code: "ADMIN_STALE_PREVIEW" });
    state.version = "v1";
    await expect(
      runAdminCommand(runner, command, "fixture-1", new Map([...fields, ["phrase", "CONFIRM other"]])),
    ).rejects.toMatchObject({ code: "ADMIN_INVALID_REQUEST" });
    expect(database.audits().at(-1)).toMatchObject({ action: "echo.adjust", outcome: "denied", errorCode: "ADMIN_INVALID_REQUEST" });
    expect(state.executions).toEqual([]);
    expect(database.runs.size).toBe(0);
  });

  it("runs a self-transactional command with the run id as its key, records it, and replays on a second submit", async () => {
    const database = fakeDatabase();
    const state = { version: "v1", executions: [] as Array<{ key: string; reason: string; client: boolean }> };
    const command = echoCommand(state);
    const runner = deps(database);
    const fields = await confirmationFields(command, runner);

    const first = await runAdminCommand(runner, command, "fixture-1", fields);
    expect(first).toMatchObject({ status: "succeeded", replayed: false, result: { after: 15 }, errorCode: null });
    expect(state.executions).toEqual([{ key: `admin:${first.commandId}`, reason: "operator reason for the fixture", client: false }]);
    expect(database.audits().at(-1)).toMatchObject({
      action: "echo.adjust",
      targetId: "fixture-1",
      outcome: "succeeded",
      commandId: first.commandId,
      reason: "operator reason for the fixture",
    });

    const second = await runAdminCommand(runner, command, "fixture-1", fields);
    expect(second).toMatchObject({ commandId: first.commandId, status: "succeeded", replayed: true, result: { after: 15 } });
    expect(state.executions).toHaveLength(1);
  });

  it("replays a completed command even after the target changed, and rejects a different confirmation reusing the key", async () => {
    const database = fakeDatabase();
    const state = { version: "v1", executions: [] as Array<{ key: string; reason: string; client: boolean }> };
    const command = echoCommand(state);
    const runner = deps(database);
    const fields = await confirmationFields(command, runner);
    const first = await runAdminCommand(runner, command, "fixture-1", fields);

    // The command itself changed the target; a resubmitted form must still
    // land on the recorded outcome rather than a stale-preview refusal.
    state.version = "v2";
    const replay = await runAdminCommand(runner, command, "fixture-1", fields);
    expect(replay).toMatchObject({ commandId: first.commandId, status: "succeeded", replayed: true });
    expect(state.executions).toHaveLength(1);

    const other = new Map([...fields, ["previewDigest", "e".repeat(64)]]);
    await expect(runAdminCommand(runner, command, "fixture-1", other)).rejects.toMatchObject({ code: "ADMIN_IDEMPOTENCY_CONFLICT" });
    expect(state.executions).toHaveLength(1);
  });

  it("answers a preview refusal caused by a concurrent twin with the twin's recorded outcome, and only then", async () => {
    const database = fakeDatabase();
    const state = { version: "v1", executions: [] as Array<{ key: string; reason: string; client: boolean }>, previewRefusal: "" };
    const command = echoCommand(state);
    const runner = { ...deps(database), sleep: async () => {} };
    const fields = await confirmationFields(command, runner);

    // No twin yet: the refusal stands.
    state.previewRefusal = "ADMIN_INVALID_STATE";
    await expect(runAdminCommand(runner, command, "fixture-1", fields)).rejects.toMatchObject({ code: "ADMIN_INVALID_STATE" });

    state.previewRefusal = "";
    const first = await runAdminCommand(runner, command, "fixture-1", fields);
    // The twin changed the target; this submission's preview now refuses, and
    // the recorded outcome is returned instead.
    state.previewRefusal = "ADMIN_INVALID_STATE";
    const twin = await runAdminCommand(runner, command, "fixture-1", fields);
    expect(twin).toMatchObject({ commandId: first.commandId, replayed: true, status: "succeeded" });
    expect(state.executions).toHaveLength(1);

    // A different confirmation reusing the key is still a conflict.
    await expect(
      runAdminCommand(runner, command, "fixture-1", new Map([...fields, ["previewDigest", "f".repeat(64)]])),
    ).rejects.toMatchObject({ code: "ADMIN_IDEMPOTENCY_CONFLICT" });
  });

  it("records a failed domain call with the mapped code and rethrows it", async () => {
    const database = fakeDatabase();
    const state = { version: "v1", executions: [], fail: "invalid_state" };
    const command = echoCommand(state);
    const runner = deps(database);
    const fields = await confirmationFields(command, runner);
    await expect(runAdminCommand(runner, command, "fixture-1", fields)).rejects.toMatchObject({ code: "ADMIN_INVALID_STATE" });
    const run = [...database.runs.values()][0];
    expect(run).toMatchObject({ status: "failed", errorCode: "ADMIN_INVALID_STATE" });
    expect(database.audits().at(-1)).toMatchObject({ outcome: "failed", errorCode: "ADMIN_INVALID_STATE", commandId: run.id });
  });

  it("runs a transactional command inside one transaction and leaves nothing behind when it fails", async () => {
    const database = fakeDatabase();
    const state = { version: "v1", executions: [] as Array<{ key: string; reason: string; client: boolean }>, fail: "" };
    const command = echoCommand(state, true);
    const runner = deps(database);
    const fields = await confirmationFields(command, runner);

    const outcome = await runAdminCommand(runner, command, "fixture-1", fields);
    expect(outcome.status).toBe("succeeded");
    expect(state.executions[0].client).toBe(true);
    expect([...database.runs.values()][0].status).toBe("succeeded");

    state.fail = "not_found";
    const again = await confirmationFields(command, runner, {}, "fixture-2");
    await expect(runAdminCommand(runner, command, "fixture-2", again)).rejects.toMatchObject({ code: "ADMIN_NOT_FOUND" });
    expect([...database.runs.values()].map((run) => run.status)).toEqual(["succeeded"]);
    expect(database.audits().filter((audit) => audit.outcome === "failed")).toHaveLength(0);
  });

  it("requires the production phrase in production", async () => {
    const database = fakeDatabase();
    const state = { version: "v1", executions: [] };
    const command = echoCommand(state);
    const runner = deps(database, { environment: "production" });
    const fields = await confirmationFields(command, runner, { phrase: "CONFIRM fixture-1" });
    await expect(runAdminCommand(runner, command, "fixture-1", fields)).rejects.toMatchObject({ code: "ADMIN_INVALID_REQUEST" });
    const production = await confirmationFields(command, runner);
    expect(production.get("phrase")).toBe("PRODUCTION ADJUST fixture-1");
    await expect(runAdminCommand(runner, command, "fixture-1", production)).resolves.toMatchObject({ status: "succeeded" });
  });
});
