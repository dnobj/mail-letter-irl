import { query } from '../db/index.js';
import { carriedDiagnosticClass, classifyDiagnosticError } from '../utils/diagnosticLog.js';

interface MaintenanceTaskRow {
  task_name: string;
}

export interface MaintenanceTaskResult<T> {
  ran: boolean;
  result?: T;
}

export async function runMaintenanceTaskIfDue<T>(
  taskName: string,
  intervalMilliseconds: number,
  task: () => Promise<T>
): Promise<MaintenanceTaskResult<T>> {
  await query(
    `INSERT INTO maintenance_tasks (task_name, last_status)
     VALUES ($1, 'never')
     ON CONFLICT (task_name) DO NOTHING`,
    [taskName]
  );

  const cutoff = new Date(Date.now() - intervalMilliseconds);
  const claim = await query<MaintenanceTaskRow>(
    `UPDATE maintenance_tasks
     SET locked_at = NOW(), last_started_at = NOW(), last_status = 'running',
         last_error = NULL, updated_at = NOW()
     WHERE task_name = $1
       AND (last_completed_at IS NULL OR last_completed_at <= $2)
       AND (locked_at IS NULL OR locked_at < NOW() - INTERVAL '1 hour')
     RETURNING task_name`,
    [taskName, cutoff]
  );

  if (!claim.rows[0]) return { ran: false };

  try {
    const result = await task();
    await query(
      `UPDATE maintenance_tasks
       SET last_completed_at = NOW(), locked_at = NULL, last_status = 'completed',
           last_error = NULL, updated_at = NOW()
       WHERE task_name = $1`,
      [taskName]
    );
    return { ran: true, result };
  } catch (error) {
    // A class, never the message: the admin reader role can select this
    // column, and a driver message can quote a value (#394). A wrapper that
    // already resolved a class (the sweeps in runMaintenance) wins.
    const errorClass = carriedDiagnosticClass(error) ?? classifyDiagnosticError(error, 'unknown_error');
    await query(
      `UPDATE maintenance_tasks
       SET locked_at = NULL, last_status = 'failed', last_error = $2, updated_at = NOW()
       WHERE task_name = $1`,
      [taskName, errorClass]
    );
    throw error;
  }
}
