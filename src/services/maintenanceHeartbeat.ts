import { classifyDiagnosticError, writeDiagnostic } from '../utils/diagnosticLog.js';

/**
 * A dead man's switch for the hourly maintenance cron (#408).
 *
 * The durable alerts cover failures inside a run; nothing noticed a run that
 * never happened - a cron that stopped firing, a service that never started.
 * After a run finishes, maintenance calls MAINTENANCE_HEARTBEAT_URL: a check
 * at an external monitor (such as healthchecks.io) that alerts when the calls
 * stop. A run that fails does not call it, so the same alert covers a run
 * that keeps failing.
 *
 * Unset, it does nothing. It never throws: a monitor that is down must not
 * fail the maintenance it watches. The URL is a capability - anyone holding
 * it can report the job alive - so it is never logged.
 */

export type HeartbeatOutcome = 'sent' | 'skipped' | 'failed';

const HEARTBEAT_TIMEOUT_MS = 10_000;

/** The heartbeat URL when it is set to an https address, else null. */
export function maintenanceHeartbeatUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.MAINTENANCE_HEARTBEAT_URL ?? '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

/** True when MAINTENANCE_HEARTBEAT_URL is set to something that is not an https address. */
export function maintenanceHeartbeatUrlInvalid(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.MAINTENANCE_HEARTBEAT_URL ?? '').trim() !== '' && maintenanceHeartbeatUrl(env) === null;
}

export async function sendMaintenanceHeartbeat(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch
): Promise<HeartbeatOutcome> {
  const url = maintenanceHeartbeatUrl(env);
  if (!url) return 'skipped';
  try {
    const response = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS) });
    if (!response.ok) {
      writeDiagnostic('warn', 'maintenance.heartbeat_failed', { status: response.status });
      return 'failed';
    }
    return 'sent';
  } catch (error) {
    writeDiagnostic('warn', 'maintenance.heartbeat_failed', {
      errorClass: classifyDiagnosticError(error, 'provider_error')
    });
    return 'failed';
  }
}
