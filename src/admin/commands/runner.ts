import { randomUUID } from "node:crypto";

import type pg from "pg";

import type { AdminAuditWriter } from "../auditService.js";
import type { AdminJsonObject } from "../contracts.js";
import type { AdminSqlClient } from "../database.js";
import { withTransaction } from "../db.js";
import { AdminFoundationError, type AdminErrorCode } from "../errors.js";
import { requireElevation } from "../http/elevation.js";
import type { AdminSession } from "../http/session.js";
import type { AdminRuntimeConfig } from "../runtimeConfig.js";
import { createAdminPreviewDigest, normalizeAdminCommandInput, validateAdminCommandConfirmation } from "./foundation.js";

/**
 * The write-action model, shared by every command:
 *
 *   preview  -> normalized input + a snapshot of the target -> previewDigest,
 *               expectedVersion (the target's updated_at), a fresh
 *               idempotency key, the typed phrase the operator must enter
 *   confirm  -> the confirmation must carry that digest and version; the
 *               digest is re-derived from the CURRENT row, so a target that
 *               changed since the preview is refused as stale
 *            -> full mode, live elevation, exact phrase
 *            -> admin_command_runs row (replay returns the prior outcome)
 *            -> the domain call, with the run id as its idempotency key
 *            -> admin_audit_events row and the command's completion
 *
 * Commands that only touch the database run inside the runner's transaction
 * on the operator pool, so the mutation, the run row and the audit row commit
 * together. Commands whose service opens its own transaction run between
 * two short transactions; they are idempotent by the key the runner hands
 * them, so a crash in between is recovered by replaying the same confirmation.
 */

export interface CommandPreview {
  targetId: string;
  /** Exactly what the operator signs: the normalized input plus the snapshot. */
  summary: AdminJsonObject;
  /** The target row's updated_at as an ISO string, when it has one. */
  expectedVersion?: string;
  /** Rendered on the preview page, in order. */
  display: Array<[string, string]>;
  warnings: string[];
}

export interface CommandExecution {
  commandId: string;
  /** `admin:<commandId>`: the key every domain service receives. */
  idempotencyKey: string;
  actorId: string;
  environment: AdminRuntimeConfig["environment"];
  reason: string;
  /** Present only for transactional commands: the operator transaction. */
  client: pg.PoolClient | null;
}

export interface CommandDefinition<I> {
  /** Route name, e.g. `alert.transition`. */
  name: string;
  title: string;
  /** Audit action and command run action. */
  action: string;
  targetType: string;
  verb(input: I): string;
  parseInput(fields: ReadonlyMap<string, string>): I;
  preview(client: AdminSqlClient, targetId: string, input: I): Promise<CommandPreview>;
  execute(execution: CommandExecution, targetId: string, input: I, preview: CommandPreview): Promise<AdminJsonObject>;
  /** True when execute() writes through `execution.client` only. */
  transactional: boolean;
  /** Extra gate a command may impose (e.g. a feature flag). */
  enabled?(config: AdminRuntimeConfig): boolean;
}

export interface PreparedPreview<I> {
  input: I;
  normalizedInput: AdminJsonObject;
  preview: CommandPreview;
  previewDigest: string;
  idempotencyKey: string;
  phrase: string;
}

export interface CommandOutcome {
  commandId: string;
  status: "succeeded" | "failed" | "rejected";
  replayed: boolean;
  result: AdminJsonObject;
  errorCode: string | null;
}

export interface CommandRunnerDeps {
  config: AdminRuntimeConfig;
  reader: pg.Pool;
  operator: pg.Pool | null;
  audit: AdminAuditWriter;
  actor: { id: string; name: string; node: string };
  session: AdminSession;
  sessionIdHash: string;
  correlationId: string;
  now: () => number;
}

export function expectedPhrase(
  environment: AdminRuntimeConfig["environment"],
  verb: string,
  targetId: string,
): string {
  return environment === "production" ? `PRODUCTION ${verb} ${targetId}` : `CONFIRM ${targetId}`;
}

export function previewDigestFor(name: string, targetId: string, normalizedInput: AdminJsonObject, summary: AdminJsonObject): string {
  return createAdminPreviewDigest({ command: name, targetId, input: normalizedInput, summary });
}

/** Read the target and build everything the preview page needs. */
export async function prepareCommandPreview<I>(
  definition: CommandDefinition<I>,
  client: AdminSqlClient,
  environment: AdminRuntimeConfig["environment"],
  targetId: string,
  fields: ReadonlyMap<string, string>,
  idempotencyKey: string = randomUUID(),
): Promise<PreparedPreview<I>> {
  const input = definition.parseInput(fields);
  const normalizedInput = normalizeAdminCommandInput(input as unknown as AdminJsonObject);
  const preview = await definition.preview(client, targetId, input);
  return {
    input,
    normalizedInput,
    preview,
    previewDigest: previewDigestFor(definition.name, targetId, normalizedInput, preview.summary),
    idempotencyKey,
    phrase: expectedPhrase(environment, definition.verb(input), preview.targetId),
  };
}

/** Map a domain service's string-coded error onto the admin catalogue. */
export function mapDomainError(error: unknown): AdminFoundationError {
  if (error instanceof AdminFoundationError) return error;
  const code =
    error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string"
      ? (error as { code: string }).code
      : error instanceof Error
        ? error.message
        : "";
  const mapped: Record<string, AdminErrorCode> = {
    not_found: "ADMIN_NOT_FOUND",
    invalid_state: "ADMIN_INVALID_STATE",
    invalid_request: "ADMIN_INVALID_REQUEST",
    invalid_resolution: "ADMIN_INVALID_REQUEST",
    idempotency_conflict: "ADMIN_IDEMPOTENCY_CONFLICT",
    // The proportional-refund command's refusals (src/services/packRefundService.ts).
    PACK_REFUND_DISABLED: "ADMIN_COMMAND_DISABLED",
    PACK_REFUND_ENVIRONMENT_MISMATCH: "ADMIN_INVALID_CONFIGURATION",
    PACK_REFUND_INVALID_INPUT: "ADMIN_INVALID_REQUEST",
    PACK_REFUND_NOT_FOUND: "ADMIN_NOT_FOUND",
    PACK_REFUND_NOT_A_PACK: "ADMIN_INVALID_STATE",
    PACK_REFUND_ORDER_STATE: "ADMIN_INVALID_STATE",
    PACK_REFUND_UNREFUNDABLE_ORDER: "ADMIN_INVALID_STATE",
    PACK_REFUND_ALREADY_ISSUED: "ADMIN_INVALID_STATE",
    PACK_REFUND_DISPUTED: "ADMIN_INVALID_STATE",
    PACK_REFUND_TOO_MANY_LETTERS: "ADMIN_INVALID_STATE",
    PACK_REFUND_WOULD_BE_FULL: "ADMIN_INVALID_STATE",
    PACK_REFUND_PREVIEW_STALE: "ADMIN_STALE_PREVIEW",
  };
  return new AdminFoundationError(mapped[code] ?? "ADMIN_INTERNAL_ERROR");
}

export async function runAdminCommand<I>(
  deps: CommandRunnerDeps,
  definition: CommandDefinition<I>,
  targetId: string,
  fields: ReadonlyMap<string, string>,
): Promise<CommandOutcome> {
  const now = deps.now();
  if (deps.config.mode !== "full" || !deps.operator) {
    throw new AdminFoundationError("ADMIN_READ_ONLY_MODE");
  }
  if (definition.enabled && !definition.enabled(deps.config)) {
    throw new AdminFoundationError("ADMIN_COMMAND_DISABLED");
  }
  requireElevation(deps.session, now);

  // A confirmation that already ran returns its first outcome, before the
  // preview is re-derived: the target has legitimately changed by then (the
  // command changed it), so re-previewing would refuse a valid replay. The
  // presented digest must match the stored one, so a different confirmation
  // that reuses the key is a conflict, not a replay.
  const presentedKey = fields.get("idempotencyKey") ?? "";
  if (presentedKey) {
    const existing = await deps.audit.findCommandRun(deps.operator, deps.config.environment, presentedKey);
    if (existing && existing.status !== "pending" && existing.status !== "running") {
      if (
        existing.actorId !== deps.actor.id ||
        existing.action !== definition.action ||
        existing.previewDigest !== (fields.get("previewDigest") ?? "")
      ) {
        throw new AdminFoundationError("ADMIN_IDEMPOTENCY_CONFLICT");
      }
      return priorOutcome(existing);
    }
  }

  // Re-derive the digest from the current row; a stale preview is refused
  // before anything is written.
  const prepared = await withReadOnlyPreview(deps.reader, (client) =>
    prepareCommandPreview(definition, client, deps.config.environment, targetId, fields, fields.get("idempotencyKey")),
  );
  let confirmation;
  try {
    confirmation = validateAdminCommandConfirmation(
      {
        previewDigest: fields.get("previewDigest") ?? "",
        reason: fields.get("reason") ?? "",
        idempotencyKey: fields.get("idempotencyKey") ?? "",
        expectedVersion: fields.get("expectedVersion") || undefined,
      },
      { previewDigest: prepared.previewDigest, expectedVersion: prepared.preview.expectedVersion },
    );
  } catch (error) {
    if (error instanceof AdminFoundationError && error.code === "ADMIN_IDEMPOTENCY_CONFLICT") {
      throw new AdminFoundationError("ADMIN_STALE_PREVIEW");
    }
    throw new AdminFoundationError("ADMIN_INVALID_REQUEST");
  }
  if ((fields.get("phrase") ?? "").trim() !== prepared.phrase) {
    await deps.audit.appendEvent(deps.reader, {
      actor: deps.actor,
      environment: deps.config.environment,
      mode: deps.config.mode,
      sessionIdHash: deps.sessionIdHash,
      correlationId: deps.correlationId,
      action: definition.action,
      targetType: definition.targetType,
      targetId: prepared.preview.targetId,
      inputSummary: { reason: "confirmation_phrase_mismatch" },
      outcome: "denied",
      errorCode: "ADMIN_INVALID_REQUEST",
    });
    throw new AdminFoundationError("ADMIN_INVALID_REQUEST");
  }

  const runInput = {
    idempotencyKey: confirmation.idempotencyKey,
    actorId: deps.actor.id,
    environment: deps.config.environment,
    action: definition.action,
    targetType: definition.targetType,
    targetId: prepared.preview.targetId,
    previewDigest: prepared.previewDigest,
    expectedVersion: prepared.preview.expectedVersion,
    correlationId: deps.correlationId,
  };
  const operator = deps.operator;

  if (definition.transactional) {
    return withTransaction(operator, async (client) => {
      const begun = await deps.audit.beginCommandRun(client, runInput);
      if (begun.replayed && begun.commandRun.status !== "pending" && begun.commandRun.status !== "running") {
        return priorOutcome(begun.commandRun);
      }
      await deps.audit.markCommandRunning(client, begun.commandRun.id);
      const execution: CommandExecution = {
        commandId: begun.commandRun.id,
        idempotencyKey: `admin:${begun.commandRun.id}`,
        actorId: deps.actor.id,
        environment: deps.config.environment,
        reason: confirmation.reason,
        client,
      };
      let result: AdminJsonObject;
      try {
        result = await definition.execute(execution, prepared.preview.targetId, prepared.input, prepared.preview);
      } catch (error) {
        // The whole transaction rolls back: no run row, no audit row, no
        // partial mutation. The failure is still logged by the caller.
        throw mapDomainError(error);
      }
      await deps.audit.completeCommandRun(client, {
        commandId: begun.commandRun.id,
        status: "succeeded",
        sanitizedResult: result,
      });
      await deps.audit.appendEvent(client, {
        actor: deps.actor,
        environment: deps.config.environment,
        mode: deps.config.mode,
        sessionIdHash: deps.sessionIdHash,
        correlationId: deps.correlationId,
        action: definition.action,
        targetType: definition.targetType,
        targetId: prepared.preview.targetId,
        reason: confirmation.reason,
        inputSummary: prepared.normalizedInput,
        beforeSummary: prepared.preview.summary,
        afterSummary: result,
        outcome: "succeeded",
        commandId: begun.commandRun.id,
      });
      return { commandId: begun.commandRun.id, status: "succeeded", replayed: false, result, errorCode: null };
    });
  }

  // Provider-backed or self-transactional services: claim the run, commit,
  // call, then complete. The domain call is idempotent by `admin:<run id>`.
  const begun = await withTransaction(operator, async (client) => {
    const started = await deps.audit.beginCommandRun(client, runInput);
    if (!started.replayed || started.commandRun.status === "pending") {
      await deps.audit.markCommandRunning(client, started.commandRun.id);
    }
    return started;
  });
  if (begun.replayed && begun.commandRun.status !== "pending" && begun.commandRun.status !== "running") {
    return priorOutcome(begun.commandRun);
  }
  const execution: CommandExecution = {
    commandId: begun.commandRun.id,
    idempotencyKey: `admin:${begun.commandRun.id}`,
    actorId: deps.actor.id,
    environment: deps.config.environment,
    reason: confirmation.reason,
    client: null,
  };
  let result: AdminJsonObject | null = null;
  let failure: AdminFoundationError | null = null;
  try {
    result = await definition.execute(execution, prepared.preview.targetId, prepared.input, prepared.preview);
  } catch (error) {
    failure = mapDomainError(error);
  }
  const outcome = await withTransaction(operator, async (client) => {
    try {
      const completed = await deps.audit.completeCommandRun(client, {
        commandId: begun.commandRun.id,
        status: failure ? "failed" : "succeeded",
        sanitizedResult: result ?? undefined,
        errorCode: failure ? failure.code : undefined,
      });
      await deps.audit.appendEvent(client, {
        actor: deps.actor,
        environment: deps.config.environment,
        mode: deps.config.mode,
        sessionIdHash: deps.sessionIdHash,
        correlationId: deps.correlationId,
        action: definition.action,
        targetType: definition.targetType,
        targetId: prepared.preview.targetId,
        reason: confirmation.reason,
        inputSummary: prepared.normalizedInput,
        beforeSummary: prepared.preview.summary,
        afterSummary: result ?? {},
        outcome: failure ? "failed" : "succeeded",
        errorCode: failure ? failure.code : undefined,
        commandId: begun.commandRun.id,
      });
      return priorOutcome(completed, false);
    } catch (error) {
      // A concurrent confirmation with the same key completed the run first;
      // its outcome is the truth for both callers.
      if (error instanceof AdminFoundationError && error.code === "ADMIN_IDEMPOTENCY_CONFLICT") {
        const rows = await client.query(
          `SELECT id, status, sanitized_result_json AS "sanitizedResult", error_code AS "errorCode"
           FROM admin_command_runs WHERE id = $1`,
          [begun.commandRun.id],
        );
        const row = rows.rows[0] as { id: string; status: string; sanitizedResult: AdminJsonObject | null; errorCode: string | null } | undefined;
        if (row && row.status !== "pending" && row.status !== "running") {
          return {
            commandId: row.id,
            status: row.status as CommandOutcome["status"],
            replayed: true,
            result: row.sanitizedResult ?? {},
            errorCode: row.errorCode,
          };
        }
      }
      throw error;
    }
  });
  if (failure) throw failure;
  return outcome;
}

function priorOutcome(
  run: { id: string; status: string; sanitizedResult: AdminJsonObject | null; errorCode: string | null },
  replayed = true,
): CommandOutcome {
  return {
    commandId: run.id,
    status: (run.status === "succeeded" || run.status === "failed" || run.status === "rejected"
      ? run.status
      : "failed") as CommandOutcome["status"],
    replayed,
    result: run.sanitizedResult ?? {},
    errorCode: run.errorCode,
  };
}

async function withReadOnlyPreview<T>(pool: pg.Pool, callback: (client: AdminSqlClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET TRANSACTION READ ONLY");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // released below
    }
    throw error;
  } finally {
    client.release();
  }
}
