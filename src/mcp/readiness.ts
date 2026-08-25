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
  APPROVED_LIVE_PROVIDERS,
  isProductionEnv,
  validateDeploymentConfig
} from '../config/deploymentConfig.js';
import { listProviders } from '../services/providers/index.js';
import {
  clearDiagnosticChangeSlot,
  writeDiagnostic,
  writeDiagnosticOnChange
} from '../utils/diagnosticLog.js';
import {
  formatPriceFailureSummary,
  getUnpricedProducts,
  kickPriceCatalog
} from '../services/priceCatalog.js';

export interface ReadinessReport {
  ready: boolean;
  statusCode: 200 | 503;
  /** Pre-serialized JSON body. */
  body: string;
}

const CACHE_TTL_MS = 5_000;
/**
 * An UNREADY verdict is held for less time than a ready one. An instance that
 * has just bound its port must not pin a 503 across the whole window the
 * documented post-deploy check runs in, and the body carries only a check name
 * so a warmup is indistinguishable from a real fault. Stated generally on
 * purpose: the price catalog is not the only check with a warmup phase - the
 * pg pool opening its first connection and provider_routing settling after a
 * migration have exactly the same shape, and an earlier attempt that special-
 * cased prices covered none of them (and was dead code besides, #278 r3).
 * Still bounded, so an anonymous prober cannot drive the database checks
 * harder than once every two seconds.
 */
const UNREADY_CACHE_TTL_MS = 2_000;

let cached: { report: ReadinessReport; expiresAt: number } | null = null;

/** Test hook: drop the memoized report and this file's change-only slots. */
export function resetReadinessCache(): void {
  cached = null;
  // Both readiness slots, named exactly - the helper's prefix form splits on
  // ':' (per-product slots), not '.' - replacing two bespoke memo variables
  // whose hand-kept re-arm logic this same PR built the helper to end
  // (#278 rounds 7-8).
  clearDiagnosticChangeSlot('readiness.prices_unresolved');
  clearDiagnosticChangeSlot('readiness.failed');
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
 * must route every mail type to an APPROVED live provider - not just
 * non-dummy: DIY is manual print, an explicit operator act the runtime does
 * not refuse, but an environment routing production mail to it is not "ready"
 * and must say so here (review round 1). This is the check boot validation
 * cannot do: provider_routing lives in the database and overrides the
 * environment.
 */
async function checkRouting(
  env: NodeJS.ProcessEnv
): Promise<{ ok: boolean; offenders: string[] }> {
  try {
    const registered = new Set(listProviders());
    const approved = new Set<string>(APPROVED_LIVE_PROVIDERS);
    const result = await query<{ mail_type: string; provider: string }>(
      'SELECT mail_type, provider FROM provider_routing WHERE enabled = true'
    );
    const production = isProductionEnv(env);
    const offenders = result.rows
      .filter(row => {
        const provider = String(row.provider).toLowerCase();
        return !registered.has(provider) || (production && !approved.has(provider));
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

  // Prices resolve lazily from Stripe (#275 stage A). The check means exactly
  // "some ENABLED product cannot be priced" - such an instance refuses those
  // purchases, so unready and refuses line up. Disabled Pay & Send cannot fail
  // it (its products are not configured), a legitimately shared Pay & Send
  // price cannot fail it, and an empty or never-attempted catalog is NOT a
  // false green. On a problem, kick a re-attempt: a transiently failed warmup
  // self-heals within the readiness TTL instead of needing a redeploy.
  // Fire-and-forget - a health probe must stay fast.
  //
  // Only PRODUCTION turns that into a 503, mirroring the gate the config
  // validator already applies to the very same variables: STRIPE_PRICE_* are
  // requiredIn 'production', and validateStripe downgrades them to a warning
  // outside it and skips test/admin entirely. The first revision gated on
  // nothing, so a development or admin deploy - where those variables are
  // legitimately unset - answered 503 forever and could never complete the
  // documented post-deploy check (#278 review round 2). Outside production the
  // truth still reaches the body as `degraded` and the detail still reaches
  // the log; it just is not a failure.
  // No adminMode term here, unlike validateStripe: ADMIN_ENABLED=true in
  // production is itself a config ERROR (admin.enabled_in_production), so such
  // a deploy is already 503 on `config` and a second gate would be dead code.
  const pricesEnforced = validation.mode === 'production';
  // Threaded env: every other check in this report reads the caller's env,
  // and a verdict stitched from two environments describes neither (#278 r5).
  const priceFailures = getUnpricedProducts(env);
  const pricesOk = priceFailures.length === 0;

  // Unconditional: the catalog's own cooldown ladder rate-limits real
  // lookups, so the kick is a cheap synchronous no-op between attempts - and
  // suppressing it for "static" faults gated the self-heal off exactly the
  // staleness it would have fixed (an id_not_configured recorded before the
  // var was set kept suppressing the kick after it was, #278 review round 5).
  // Gated on the ambient env: the verdict above describes the CALLER's env,
  // but ensurePriceCatalog can only heal process.env's catalog - kicking for
  // a custom-env caller would "heal" a different environment than the one the
  // report described (#278 round 6; production always passes the default).
  if (!pricesOk && env === process.env) {
    kickPriceCatalog(undefined, 'readiness');
  }

  const failing: string[] = [];
  if (!configOk) failing.push('config');
  if (!databaseOk) failing.push('database');
  if (!routing.ok) failing.push('routing');
  if (!pricesOk && pricesEnforced) failing.push('prices');

  // Logged whichever branch we take: outside production this is the ONLY
  // place an unpriced product is reported at all, and the 200 branch below
  // does not write a diagnostic. Product codes and rule ids only - the loader
  // never puts an amount in a failure.
  // ONE encoding, owned by the catalog beside the record it describes. The
  // hand-kept copy that stood here was class-blind until round 8 - the same
  // omission round 7 had already fixed in the catalog's own copy, which is
  // exactly how two copies of one format behave. Its epoch component also
  // gives this surface the recovery-awareness round 8 gave only the quote
  // slot (#278 round 9).
  const priceFailureSummary = formatPriceFailureSummary(priceFailures);
  // On CHANGE only, via the ONE shared throttle. A non-production deploy
  // legitimately has no prices, so pricesOk is false forever there; an
  // unconditional line meant ~17,000 identical entries a day per instance
  // for a steady, already-reported state (#278 review round 3).
  if (pricesOk) {
    // Recovery re-arms the slot so an identical later fault is news again.
    clearDiagnosticChangeSlot('readiness.prices_unresolved');
  } else {
    writeDiagnosticOnChange(
      'readiness.prices_unresolved',
      priceFailureSummary,
      pricesEnforced ? 'error' : 'warn',
      'readiness.prices_unresolved',
      {
        enforced: String(pricesEnforced),
        priceFailures: priceFailureSummary
      }
    );
  }

  let report: ReadinessReport;
  if (failing.length === 0) {
    // The #155 requirement that a development deploy's dummy behavior be
    // explicit and visible: name the mode and the default provider, and
    // nothing else about the configuration. Reflect only a KNOWN provider
    // name - this route is unauthenticated, and echoing an arbitrary env
    // value would serve anything accidentally pasted into LETTER_PROVIDER
    // to anonymous callers (review round 1).
    // Recovery re-arms the slot so the NEXT unready episode logs even if its
    // signature matches the last one (#278 round 7).
    clearDiagnosticChangeSlot('readiness.failed');
    const configured = (env.LETTER_PROVIDER || 'dummy').toLowerCase();
    const provider = new Set(listProviders()).has(configured) ? configured : 'unrecognized';
    report = {
      ready: true,
      statusCode: 200,
      body: JSON.stringify({
        ready: true,
        mode: validation.mode,
        provider,
        checks: {
          config: 'ok',
          database: 'ok',
          routing: 'ok',
          // Ready but not everything is sellable: outside production an
          // unpriced product is not a failure, and saying 'ok' would be a
          // lie an operator reads on the deploy check.
          prices: pricesOk ? 'ok' : 'degraded'
        }
      })
    };
  } else {
    // Detail goes to the log, not the wire: rule ids and routing offenders
    // are for the operator, and the body must not teach an anonymous caller
    // which variable to attack.
    // On CHANGE only: at the short unready TTL an unconditional line here was
    // up to ~43,000 identical entries a day on a steadily-unready probed
    // instance - the flood shape every other diagnostic in this file already
    // dedupes (#278 review round 5).
    // Every input sorted: routing offenders come from an ORDER BY-less query,
    // so a heap-order flip re-emitted the very line this dedupe suppresses
    // (#278 round 6).
    const failingSignature = [
      failing.join(','),
      priceFailureSummary,
      [...routing.offenders].sort().join(','),
      validation.findings.filter(f => f.severity === 'error').map(f => f.rule).sort().join(',')
    ].join('|');
    writeDiagnosticOnChange('readiness.failed', failingSignature, 'error', 'readiness.failed', {
      failing: failing.join(','),
      // Product codes and rule ids only; the loader never puts an amount in
      // a failure.
      priceFailures: priceFailureSummary || 'none',
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

  cached = {
    report,
    // From the CURRENT clock, not the pre-await `now`: the database and
    // routing checks above can take seconds (the pool's connect timeout is 5s
    // and a Neon wake retries), and an expiry computed from the entry
    // timestamp was often already in the past by the time it was written -
    // the memo dead on arrival, /readyz re-running its checks on every probe
    // in exactly the slow-database failure mode it exists to bound (#278
    // review round 4).
    expiresAt: Date.now() + (report.ready ? CACHE_TTL_MS : UNREADY_CACHE_TTL_MS)
  };
  return report;
}
