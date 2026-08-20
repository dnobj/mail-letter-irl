/**
 * Readiness, as distinct from liveness. Issue #155.
 *
 * /healthz answers "is the process up" and its body is contractually pinned
 * to exactly "ok" (docs/manual-tests.md, the Railway healthcheck, and the
 * browser-test agent all consume it), so it can never learn to say more.
 * /readyz answers the question an operator actually has after a deploy: is
 * this instance configured, can it reach its database, and is mail routing
 * pointed at real providers?
 *
 * The body is safe for an unauthenticated caller: check names and the
 * resolved mode/provider name only - never a rule detail, never a value.
 * Failing rule ids go to the server log through writeDiagnostic, where the
 * operator already looks.
 */

import { query } from '../db/index.js';
import {
  isProductionEnv,
  validateDeploymentConfig
} from '../config/deploymentConfig.js';
import { listProviders } from '../services/providers/index.js';
import { writeDiagnostic } from '../utils/diagnosticLog.js';

export interface ReadinessReport {
  ready: boolean;
  statusCode: 200 | 503;
  /** Pre-serialized JSON body. */
  body: string;
}

const CACHE_TTL_MS = 5_000;

let cached: { report: ReadinessReport; expiresAt: number } | null = null;

/** Test hook: drop the memoized report. */
export function resetReadinessCache(): void {
  cached = null;
}

async function checkDatabase(): Promise<boolean> {
  try {
    await query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/**
 * Every enabled routing row must name a registered provider, and production
 * must not route any mail type to the dummy provider. This is the check boot
 * validation cannot do: provider_routing lives in the database and overrides
 * the environment.
 */
async function checkRouting(
  env: NodeJS.ProcessEnv
): Promise<{ ok: boolean; offenders: string[] }> {
  try {
    const registered = new Set(listProviders());
    const result = await query<{ mail_type: string; provider: string }>(
      'SELECT mail_type, provider FROM provider_routing WHERE enabled = true'
    );
    const production = isProductionEnv(env);
    const offenders = result.rows
      .filter(row => {
        const provider = String(row.provider).toLowerCase();
        return !registered.has(provider) || (production && provider === 'dummy');
      })
      .map(row => String(row.mail_type));
    return { ok: offenders.length === 0, offenders };
  } catch {
    return { ok: false, offenders: ['routing_query_failed'] };
  }
}

export async function getReadiness(
  env: NodeJS.ProcessEnv = process.env
): Promise<ReadinessReport> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.report;
  }

  const validation = validateDeploymentConfig(env, 'server');
  const configOk = validation.errors.length === 0;
  const databaseOk = await checkDatabase();
  const routing = databaseOk
    ? await checkRouting(env)
    : { ok: false, offenders: ['database_unreachable'] };

  const failing: string[] = [];
  if (!configOk) failing.push('config');
  if (!databaseOk) failing.push('database');
  if (!routing.ok) failing.push('routing');

  let report: ReadinessReport;
  if (failing.length === 0) {
    report = {
      ready: true,
      statusCode: 200,
      body: JSON.stringify({
        ready: true,
        // The #155 requirement that a development deploy's dummy behavior be
        // explicit and visible: name the mode and the default provider, and
        // nothing else about the configuration.
        mode: validation.mode,
        provider: (env.LETTER_PROVIDER || 'dummy').toLowerCase(),
        checks: { config: 'ok', database: 'ok', routing: 'ok' }
      })
    };
  } else {
    // Detail goes to the log, not the wire: rule ids and routing offenders
    // are for the operator, and the body must not teach an anonymous caller
    // which variable to attack.
    writeDiagnostic('error', 'readiness.failed', {
      failing: failing.join(','),
      rules: validation.findings
        .filter(f => f.severity === 'error')
        .map(f => f.rule)
        .join(',') || 'none',
      routingOffenders: routing.offenders.join(',') || 'none'
    });
    report = {
      ready: false,
      statusCode: 503,
      body: JSON.stringify({ ready: false, failing })
    };
  }

  cached = { report, expiresAt: now + CACHE_TTL_MS };
  return report;
}
