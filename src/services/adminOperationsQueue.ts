import { transaction } from '../db/index.js';
import { classifyDiagnosticError, writeDiagnostic } from '../utils/diagnosticLog.js';

/**
 * The deployed worker for admin_operations (migration 022).
 *
 * Some commands ask for work the admin panel's own database role must not be
 * able to do: erasing an account (#289), putting quarantined content back
 * (#153). Each such command only QUEUES an operation, behind its preview,
 * elevation, typed phrase and audit row; the hourly maintenance run performs it
 * as the database owner. This is the queue's one runner, so the claim, the
 * attempt counting and the outcome recording are written once.
 *
 * One transaction per operation. The operation row is claimed with SKIP LOCKED
 * and held until commit, so two runs cannot perform the same operation twice,
 * and the outcome is written in the same transaction as the work: an operation
 * marked done is work that is done, and the reverse. The work runs under a
 * savepoint, so a failure halfway rolls back every write it made and still
 * leaves the transaction able to record the attempt.
 *
 * Only this database's own environment is claimed, by its admin marker. A
 * database the panel was never provisioned on has no marker and no queue.
 *
 * Results are counts, codes and classes only: admin_operations is readable by
 * the reader role, and the maintenance log keeps what it is given.
 */

export interface SqlClient {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

/** What a handler reports: the work is done, or it was refused and why. */
export type OperationResult =
  | { outcome: 'done'; result: Record<string, unknown> }
  | { outcome: 'refused'; code: string; result: Record<string, unknown> };

export interface OperationRunSummary {
  done: number;
  refused: number;
  retrying: number;
  failed: number;
}

/**
 * An unexpected failure is retried on the next runs, up to this many attempts
 * in all, an hour apart. A refusal is not retried: it is an answer, and the
 * operator queues again once whatever caused it has changed.
 */
export const MAX_OPERATION_ATTEMPTS = 3;

export interface OperationKind {
  /** admin_operations.operation_type, which is also the command's action. */
  operationType: string;
  /** error_code recorded when every attempt failed. */
  errorCode: string;
  /** Prefix of the diagnostics this kind writes, e.g. `account_erasure`. */
  event: string;
  /** The work, inside the operation's transaction, as the database owner. */
  handle(client: SqlClient, payload: unknown): Promise<OperationResult>;
}

/**
 * Queue one operation: a command's whole write, inside the runner's
 * transaction on the operator role. command_id is UNIQUE and references the
 * run row the runner has just written, so one confirmation queues exactly one
 * operation.
 */
export async function enqueueAdminOperation(
  client: SqlClient,
  params: { commandId: string; environment: string; operationType: string; payload: Record<string, unknown> }
): Promise<string> {
  const inserted = await client.query(
    `INSERT INTO admin_operations (command_id, operation_type, environment, payload_json)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING id`,
    [params.commandId, params.operationType, params.environment, JSON.stringify(params.payload)]
  );
  return String(inserted.rows[0].id);
}

/** Carry out the queued operations of one kind, up to a batch. */
export async function processAdminOperations(
  kind: OperationKind,
  batchLimit: number
): Promise<OperationRunSummary> {
  const summary: OperationRunSummary = { done: 0, refused: 0, retrying: 0, failed: 0 };
  for (let handled = 0; handled < batchLimit; handled += 1) {
    const outcome = await transaction(async (client) => handleNextOperation(client, kind));
    if (outcome === null) break;
    summary[outcome] += 1;
  }
  return summary;
}

async function handleNextOperation(
  client: SqlClient,
  kind: OperationKind
): Promise<keyof OperationRunSummary | null> {
  const claimed = await client.query(
    `SELECT o.id, o.payload_json, o.attempts
       FROM admin_operations o
      WHERE o.operation_type = $1
        AND o.status = 'pending'
        AND o.available_at <= NOW()
        AND o.environment = (SELECT m.environment FROM admin_environment_marker m)
      ORDER BY o.available_at, o.id
      LIMIT 1
      FOR UPDATE OF o SKIP LOCKED`,
    [kind.operationType]
  );
  const operation = claimed.rows[0];
  if (!operation) return null;

  await client.query('SAVEPOINT admin_operation');
  let result: OperationResult;
  try {
    result = await kind.handle(client, operation.payload_json);
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT admin_operation');
    const errorClass = classifyDiagnosticError(error, 'database_error');
    const exhausted = Number(operation.attempts) + 1 >= MAX_OPERATION_ATTEMPTS;
    if (exhausted) {
      await client.query(
        `UPDATE admin_operations
            SET status = 'failed', attempts = attempts + 1, completed_at = NOW(),
                error_code = $2, sanitized_result_json = $3::jsonb
          WHERE id = $1`,
        [operation.id, kind.errorCode, JSON.stringify({ errorClass })]
      );
    } else {
      await client.query(
        `UPDATE admin_operations
            SET attempts = attempts + 1, available_at = NOW() + INTERVAL '1 hour',
                sanitized_result_json = $2::jsonb
          WHERE id = $1`,
        [operation.id, JSON.stringify({ lastErrorClass: errorClass })]
      );
    }
    writeDiagnostic('error', `${kind.event}.attempt_failed`, { errorClass, final: exhausted });
    return exhausted ? 'failed' : 'retrying';
  }

  if (result.outcome === 'done') {
    await client.query(
      `UPDATE admin_operations
          SET status = 'succeeded', attempts = attempts + 1, completed_at = NOW(),
              error_code = NULL, sanitized_result_json = $2::jsonb
        WHERE id = $1`,
      [operation.id, JSON.stringify(result.result)]
    );
    writeDiagnostic('info', `${kind.event}.completed`);
    return 'done';
  }

  await client.query(
    `UPDATE admin_operations
        SET status = 'failed', attempts = attempts + 1, completed_at = NOW(),
            error_code = $2, sanitized_result_json = $3::jsonb
      WHERE id = $1`,
    [operation.id, result.code, JSON.stringify(result.result)]
  );
  writeDiagnostic('warn', `${kind.event}.refused`, { errorCode: result.code });
  return 'refused';
}
