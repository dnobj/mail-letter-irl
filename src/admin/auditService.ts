import {
  AdminAuditEventInputSchema,
  AdminCommandCompletionSchema,
  AdminCommandRunInputSchema,
  AdminCommandRunSchema,
  type AdminAuditEventInput,
  type AdminCommandCompletion,
  type AdminCommandRun,
  type AdminCommandRunInput,
} from "./contracts.js";
import type { AdminSqlClient } from "./database.js";
import { AdminFoundationError, type AdminErrorCode } from "./errors.js";

interface AuditReceiptRow {
  id: string;
  occurredAt: Date;
}

const COMMAND_RUN_RETURNING = `
  id,
  idempotency_key AS "idempotencyKey",
  actor_sid AS "actorSid",
  environment,
  action,
  target_type AS "targetType",
  target_id AS "targetId",
  preview_digest AS "previewDigest",
  expected_version AS "expectedVersion",
  status,
  requested_at AS "requestedAt",
  started_at AS "startedAt",
  completed_at AS "completedAt",
  correlation_id AS "correlationId",
  sanitized_result_json AS "sanitizedResult",
  error_code AS "errorCode"
`;

async function runAdminQuery(
  client: AdminSqlClient,
  text: string,
  values: unknown[],
  errorCode: AdminErrorCode = "ADMIN_INTERNAL_ERROR",
) {
  try {
    return await client.query(text, values);
  } catch {
    throw new AdminFoundationError(errorCode);
  }
}

function commandIdentityMatches(
  existing: AdminCommandRun,
  requested: ReturnType<typeof AdminCommandRunInputSchema.parse>,
): boolean {
  return (
    existing.actorSid === requested.actorSid &&
    existing.action === requested.action &&
    existing.targetType === requested.targetType &&
    existing.targetId === (requested.targetId ?? null) &&
    existing.previewDigest === requested.previewDigest &&
    existing.expectedVersion === (requested.expectedVersion ?? null)
  );
}

export interface AdminCommandRunResult {
  commandRun: AdminCommandRun;
  replayed: boolean;
}

export class AdminAuditWriter {
  async appendEvent(client: AdminSqlClient, input: AdminAuditEventInput) {
    const event = AdminAuditEventInputSchema.parse(input);

    const result = await runAdminQuery(
      client,
      `
          INSERT INTO admin_audit_events (
            actor_sid,
            actor_name,
            environment,
            mode,
            session_id_hash,
            correlation_id,
            action,
            target_type,
            target_id,
            reason,
            input_summary_json,
            before_summary_json,
            after_summary_json,
            outcome,
            error_code,
            command_id
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8,
            $9, $10, $11::jsonb, $12::jsonb, $13::jsonb,
            $14, $15, $16
          )
          RETURNING id, occurred_at AS "occurredAt"
        `,
      [
        event.actor.sid,
        event.actor.name,
        event.environment,
        event.mode,
        event.sessionIdHash,
        event.correlationId,
        event.action,
        event.targetType,
        event.targetId ?? null,
        event.reason ?? null,
        JSON.stringify(event.inputSummary),
        JSON.stringify(event.beforeSummary),
        JSON.stringify(event.afterSummary),
        event.outcome,
        event.errorCode ?? null,
        event.commandId ?? null,
      ],
      "ADMIN_AUDIT_WRITE_FAILED",
    );

    return result.rows[0] as AuditReceiptRow;
  }

  async beginCommandRun(
    client: AdminSqlClient,
    input: AdminCommandRunInput,
  ): Promise<AdminCommandRunResult> {
    const command = AdminCommandRunInputSchema.parse(input);
    const inserted = await runAdminQuery(
      client,
      `
        INSERT INTO admin_command_runs (
          idempotency_key,
          actor_sid,
          environment,
          action,
          target_type,
          target_id,
          preview_digest,
          expected_version,
          correlation_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (environment, idempotency_key) DO NOTHING
        RETURNING ${COMMAND_RUN_RETURNING}
      `,
      [
        command.idempotencyKey,
        command.actorSid,
        command.environment,
        command.action,
        command.targetType,
        command.targetId ?? null,
        command.previewDigest,
        command.expectedVersion ?? null,
        command.correlationId,
      ],
    );

    if (inserted.rows[0]) {
      return {
        commandRun: AdminCommandRunSchema.parse(inserted.rows[0]),
        replayed: false,
      };
    }

    const existing = await runAdminQuery(
      client,
      `
        SELECT ${COMMAND_RUN_RETURNING}
        FROM admin_command_runs
        WHERE environment = $1 AND idempotency_key = $2
      `,
      [command.environment, command.idempotencyKey],
    );
    if (!existing.rows[0]) {
      throw new AdminFoundationError("ADMIN_INTERNAL_ERROR");
    }

    const commandRun = AdminCommandRunSchema.parse(existing.rows[0]);
    if (!commandIdentityMatches(commandRun, command)) {
      throw new AdminFoundationError("ADMIN_IDEMPOTENCY_CONFLICT");
    }
    return { commandRun, replayed: true };
  }

  async markCommandRunning(
    client: AdminSqlClient,
    commandId: string,
  ): Promise<AdminCommandRun> {
    const result = await runAdminQuery(
      client,
      `
        UPDATE admin_command_runs
        SET status = 'running', started_at = NOW()
        WHERE id = $1 AND status = 'pending'
        RETURNING ${COMMAND_RUN_RETURNING}
      `,
      [commandId],
    );
    if (!result.rows[0]) {
      throw new AdminFoundationError("ADMIN_IDEMPOTENCY_CONFLICT");
    }
    return AdminCommandRunSchema.parse(result.rows[0]);
  }

  async completeCommandRun(
    client: AdminSqlClient,
    input: AdminCommandCompletion,
  ): Promise<AdminCommandRun> {
    const completion = AdminCommandCompletionSchema.parse(input);
    const result = await runAdminQuery(
      client,
      `
        UPDATE admin_command_runs
        SET
          status = $2,
          completed_at = NOW(),
          sanitized_result_json = $3::jsonb,
          error_code = $4
        WHERE id = $1 AND status IN ('pending', 'running')
        RETURNING ${COMMAND_RUN_RETURNING}
      `,
      [
        completion.commandId,
        completion.status,
        completion.sanitizedResult
          ? JSON.stringify(completion.sanitizedResult)
          : null,
        completion.errorCode ?? null,
      ],
    );
    if (!result.rows[0]) {
      throw new AdminFoundationError("ADMIN_IDEMPOTENCY_CONFLICT");
    }
    return AdminCommandRunSchema.parse(result.rows[0]);
  }
}
