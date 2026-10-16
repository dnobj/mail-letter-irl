import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Issue #394. maintenance_tasks.last_error is readable by the admin reader
 * role, and it used to receive error.message: a driver message can quote a
 * value, a URL or a row. The failure path now stores a class, preferring one a
 * lower layer already attached (the wrapped sweeps in runMaintenance resolve
 * theirs first), and rethrows the original error untouched.
 */

const db = vi.hoisted(() => ({
  query: vi.fn()
}));

vi.mock('../../../src/db/index.js', () => ({
  query: db.query
}));

import { runMaintenanceTaskIfDue } from '../../../src/services/maintenanceTaskService.js';

const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();

/** The register and claim queries answer as a due, unlocked task. */
function dueTask(): void {
  db.query.mockReset();
  db.query.mockImplementation(async (sql: string) => {
    if (sql.includes('INSERT INTO maintenance_tasks')) return { rows: [], rowCount: 1 };
    if (sql.includes("last_status = 'running'")) return { rows: [{ task_name: 'provider-status-sync' }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
}

function failureUpdate(): [string, unknown[]] | undefined {
  return db.query.mock.calls.find(([sql]) => String(sql).includes("last_status = 'failed'")) as
    | [string, unknown[]]
    | undefined;
}

describe('runMaintenanceTaskIfDue failure recording (#394)', () => {
  beforeEach(() => {
    dueTask();
  });

  it('stores the error class, never the driver message, and rethrows the original error', async () => {
    const driverError = Object.assign(
      new Error('connect ETIMEDOUT 10.20.30.40:5432 while reading letters for user auth0|secret'),
      { code: 'ETIMEDOUT' }
    );

    await expect(
      runMaintenanceTaskIfDue('provider-status-sync', 1000, async () => {
        throw driverError;
      })
    ).rejects.toBe(driverError);

    const failure = failureUpdate();
    expect(failure).toBeDefined();
    const [sql, params] = failure!;
    expect(normalise(sql)).toBe(
      "UPDATE maintenance_tasks SET locked_at = NULL, last_status = 'failed', last_error = $2, updated_at = NOW() WHERE task_name = $1"
    );
    expect(params).toEqual(['provider-status-sync', 'ETIMEDOUT']);
    const everything = JSON.stringify(db.query.mock.calls.map(([, p]) => p));
    expect(everything).not.toContain('10.20.30.40');
    expect(everything).not.toContain('auth0|secret');
  });

  it('prefers a class the task already attached to the error', async () => {
    const wrapped = Object.assign(new Error('recent uploads sweep failed: database_error'), {
      code: 'ETIMEDOUT',
      diagnosticClass: 'database_error'
    });

    await expect(
      runMaintenanceTaskIfDue('recent-uploads-sweep', 1000, async () => {
        throw wrapped;
      })
    ).rejects.toBe(wrapped);

    expect(failureUpdate()?.[1]).toEqual(['recent-uploads-sweep', 'database_error']);
  });

  it('falls back to unknown_error for a throw that carries no class or allowlisted code', async () => {
    await expect(
      runMaintenanceTaskIfDue('provider-status-sync', 1000, async () => {
        throw new Error('something with a value: 12 Private Lane');
      })
    ).rejects.toThrow('12 Private Lane');

    expect(failureUpdate()?.[1]).toEqual(['provider-status-sync', 'unknown_error']);
  });

  it('clears last_error on success and reports the result', async () => {
    await expect(
      runMaintenanceTaskIfDue('provider-status-sync', 1000, async () => 7)
    ).resolves.toEqual({ ran: true, result: 7 });

    const completion = db.query.mock.calls.find(([sql]) => String(sql).includes("last_status = 'completed'"));
    expect(completion).toBeDefined();
    expect(normalise(String(completion![0]))).toContain('last_error = NULL');
    expect(failureUpdate()).toBeUndefined();
  });

  it('does not run the task, or write a failure, when it is not due', async () => {
    db.query.mockReset();
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const task = vi.fn(async () => 1);

    await expect(runMaintenanceTaskIfDue('provider-status-sync', 1000, task)).resolves.toEqual({ ran: false });

    expect(task).not.toHaveBeenCalled();
    expect(failureUpdate()).toBeUndefined();
  });
});
