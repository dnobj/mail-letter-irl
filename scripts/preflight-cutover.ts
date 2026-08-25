/**
 * Pre-cutover parity check: diff ENV_VAR_MANIFEST against what each Railway
 * service actually has set, before promoting. Issue #155.
 *
 * The boot validator (src/config/deploymentConfig.ts) stops a misconfigured
 * deploy at startup; this script stops the misconfiguration from ever being
 * deployed, by reading each service's variable NAMES through Railway's API
 * and reporting what the manifest requires but the environment lacks.
 *
 * Usage:
 *   RAILWAY_API_TOKEN=... npm run preflight:cutover -- --env production
 *   RAILWAY_API_TOKEN=... npm run preflight:cutover -- --env development
 *
 * Privacy contract: Railway's variables query returns values, but only
 * Object.keys of the response is ever consumed and only variable NAMES are
 * ever printed. No value touches stdout, a log, or an error message.
 *
 * Interpretation choices, deliberately conservative:
 * - JIT variables ('when-jit-enabled') are required whenever the
 *   JIT_PURCHASE_ENABLED name exists in the environment - reading its value
 *   would break the names-only contract, and a set-but-false flag is itself
 *   worth flagging before a cutover.
 * - Static-DCR variables ('when-static-dcr') follow the same rule against
 *   LETTER_IRL_OAUTH_STATIC_DCR_COMPATIBILITY (issue #270).
 * - 'development' entries are the mirror of 'production' ones: demanded only in
 *   the development environment, never in production. The environment-isolation
 *   issuer allowlists are one per environment and must not be swapped.
 * - 'unless-admin' conditions are ignored: deployed Railway services are
 *   never local admin mode, so their Stripe variables are always required.
 * - LETTER_IRL_DEPLOYMENT_ENVIRONMENT is required in BOTH deployed
 *   environments: deployed development runs NODE_ENV=production, so without
 *   the identity label the validator resolves it to production mode and the
 *   deploy fails boot on its test keys.
 */

import { pathToFileURL } from 'node:url';
import {
  ENV_VAR_MANIFEST,
  type EnvVarRequirement
} from '../src/config/deploymentConfig.js';

const RAILWAY_GRAPHQL_ENDPOINT = 'https://backboard.railway.com/graphql/v2';
const PROJECT_ID = 'b31314d8-fd09-4582-9c0d-52a36f879228';

export interface DiffOptions {
  /** Which Railway environment's rules apply. */
  environment: 'production' | 'development';
  /** Which service's manifest subset applies. */
  service: 'api' | 'maintenance';
}

export interface ManifestGap {
  entry: EnvVarRequirement;
  /** Names-only, safe to print. */
  note: string;
}

export interface ManifestDiff {
  /** Requirements not satisfied by any present name (own name or alias). */
  missing: ManifestGap[];
  /**
   * Absent entries marked `advisory`: reported so a parity gap is VISIBLE, but
   * not counted as a failure, because the code has a working default (#278
   * round 3). Entry and note travel as ONE record - the previous four
   * index-coupled parallel arrays let a count disagree with the lines printed
   * under it (#278 round 6).
   */
  advisory: ManifestGap[];
}

/**
 * Pure diff of present variable names against the manifest. No network, no
 * values - callers hand in Object.keys of whatever they fetched.
 */
export function diffManifest(
  presentNames: Iterable<string>,
  options: DiffOptions,
  manifest: readonly EnvVarRequirement[] = ENV_VAR_MANIFEST
): ManifestDiff {
  const present = new Set(presentNames);
  const production = options.environment === 'production';
  const jitFlagSet = present.has('JIT_PURCHASE_ENABLED');
  const staticDcrFlagSet = present.has('LETTER_IRL_OAUTH_STATIC_DCR_COMPATIBILITY');
  const missing: ManifestGap[] = [];
  const advisory: ManifestGap[] = [];

  for (const entry of manifest) {
    if (!entry.services.includes(options.service)) continue;
    if (entry.requiredIn === 'production' && !production) {
      // Two exceptions. The identity label is required in every DEPLOYED
      // environment, because deployed development runs NODE_ENV=production.
      // And ADVISORY entries are diffed everywhere: their entire purpose is
      // cross-environment parity VISIBILITY, and skipping them outside
      // production made that visibility one-directional - a value set in
      // production but absent in development was reported by neither run
      // (#278 review round 5).
      if (entry.name !== 'LETTER_IRL_DEPLOYMENT_ENVIRONMENT' && !entry.advisory) continue;
    }
    if (entry.requiredIn === 'development' && production) continue;
    if (entry.condition === 'when-jit-enabled' && !jitFlagSet) continue;
    if (entry.condition === 'when-static-dcr' && !staticDcrFlagSet) continue;
    // 'unless-admin' is ignored: deployed services are never local admin mode.

    const satisfied = [entry.name, ...(entry.aliases ?? [])].some(name => present.has(name));
    if (!satisfied) {
      const aliasNote = entry.aliases?.length
        ? ` (or one of: ${entry.aliases.join(', ')})`
        : '';
      const conditionNote =
        entry.condition === 'when-jit-enabled'
          ? ' [required because JIT_PURCHASE_ENABLED is set]'
          : entry.condition === 'when-static-dcr'
            ? ' [required because LETTER_IRL_OAUTH_STATIC_DCR_COMPATIBILITY is set]'
            : '';
      const gap = { entry, note: `${entry.name}${aliasNote}${conditionNote}` };
      if (entry.advisory) advisory.push(gap);
      else missing.push(gap);
    }
  }

  return { missing, advisory };
}

interface RailwayIds {
  environmentId: string;
  /** null = no matching service instance exists in this environment. */
  services: { api: string | null; maintenance: string | null };
}

async function railwayGraphQL<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  const response = await fetch(RAILWAY_GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) {
    // Never echo the response body: error payloads can quote the request.
    throw new Error(`Railway API returned ${response.status}`);
  }
  // The variables response carries name:value content, and a JSON parse
  // failure embeds a body excerpt in its SyntaxError message - which main()'s
  // catch would print. Replace it with a fixed, value-free message (review
  // round 1).
  let payload: { data?: T; errors?: Array<{ message: string }> };
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    throw new Error('Railway API returned a response that is not valid JSON');
  }
  if (payload.errors?.length) {
    // GraphQL error strings are third-party text; the names-only contract is
    // absolute, so none of it reaches stdout - the count and the dashboard
    // are enough to act on (review round 1).
    throw new Error(
      `Railway API reported ${payload.errors.length} GraphQL error(s); check the token's access to the project in the Railway dashboard`
    );
  }
  if (!payload.data) throw new Error('Railway API returned no data');
  return payload.data;
}

async function resolveIds(token: string, environment: string): Promise<RailwayIds> {
  interface ProjectData {
    project: {
      environments: {
        edges: Array<{
          node: {
            id: string;
            name: string;
            serviceInstances: { edges: Array<{ node: { serviceId: string; serviceName: string } }> };
          };
        }>;
      };
    };
  }
  // Resolve services through the environment's OWN instances, not the
  // project-level service list: the project carries per-environment service
  // twins (letter-irl-maintenance and letter-irl-maintenance-dev), so a
  // project-wide substring match is ambiguous - the first live run tripped
  // exactly there. An environment's instance list is unambiguous, and a
  // service with no instance in the target environment is itself a preflight
  // finding (production has no maintenance instance today), not a crash.
  const data = await railwayGraphQL<ProjectData>(
    token,
    `query project($id: String!) {
       project(id: $id) {
         environments {
           edges {
             node {
               id
               name
               serviceInstances { edges { node { serviceId serviceName } } }
             }
           }
         }
       }
     }`,
    { id: PROJECT_ID }
  );

  const environmentNode = data.project.environments.edges
    .map(edge => edge.node)
    .find(node => node.name.toLowerCase() === environment);
  if (!environmentNode) {
    throw new Error(`No Railway environment named "${environment}" in the project`);
  }

  const instances = environmentNode.serviceInstances.edges.map(edge => edge.node);
  const findInstance = (needle: string): string | null => {
    const matches = instances.filter(node => node.serviceName.toLowerCase().includes(needle));
    if (matches.length > 1) {
      // Count only - service names are Railway response text, and everything
      // this script prints stays response-free.
      throw new Error(
        `Expected at most one "${needle}" service instance in ${environment}; found ${matches.length} of ${instances.length} - check the project in the Railway dashboard`
      );
    }
    return matches[0]?.serviceId ?? null;
  };

  return {
    environmentId: environmentNode.id,
    services: {
      // The API service is named e.g. "letter-irl-api"; "maintenance" matches
      // the maintenance cron service regardless of environment suffixes.
      api: findInstance('api'),
      maintenance: findInstance('maintenance')
    }
  };
}

async function fetchVariableNames(
  token: string,
  environmentId: string,
  serviceId: string
): Promise<string[]> {
  const data = await railwayGraphQL<{ variables: Record<string, unknown> }>(
    token,
    `query variables($projectId: String!, $environmentId: String!, $serviceId: String!) {
       variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
     }`,
    { projectId: PROJECT_ID, environmentId, serviceId }
  );
  // Values arrive in this response. Only the keys ever leave this function.
  return Object.keys(data.variables ?? {});
}

async function main(): Promise<void> {
  const envFlagIndex = process.argv.indexOf('--env');
  const environment = envFlagIndex > -1 ? process.argv[envFlagIndex + 1] : undefined;
  if (environment !== 'production' && environment !== 'development') {
    console.error('Usage: npm run preflight:cutover -- --env production|development');
    process.exitCode = 2;
    return;
  }

  const token = process.env.RAILWAY_API_TOKEN;
  if (!token) {
    console.error('RAILWAY_API_TOKEN is required (create one in Railway account settings).');
    process.exitCode = 2;
    return;
  }

  const ids = await resolveIds(token, environment);
  let failures = 0;

  for (const service of ['api', 'maintenance'] as const) {
    const serviceId = ids.services[service];
    if (!serviceId) {
      // A service that does not exist in the environment cannot hold any
      // variables - the gap is the whole service. Production has no
      // maintenance instance today; the cutover must create it.
      failures += 1;
      console.error(
        `❌ ${environment}/${service}: no ${service} service instance exists in this environment - create and configure it before cutover`
      );
      continue;
    }
    const names = await fetchVariableNames(token, ids.environmentId, serviceId);
    const diff = diffManifest(names, { environment, service });
    if (diff.missing.length === 0) {
      console.log(`✅ ${environment}/${service}: all ${
        environment === 'production' ? 'production-required' : 'required'
      } variables are set`);
    } else {
      failures += diff.missing.length;
      console.error(`❌ ${environment}/${service}: ${diff.missing.length} required variable(s) missing:`);
      for (const gap of diff.missing) console.error(`   - ${gap.note}`);
    }
    // Not a gate: these have working defaults. Printed because the whole point
    // of listing them is that an operator can SEE the two environments
    // disagree before promotion, which is what nothing could do before.
    if (diff.advisory.length > 0) {
      console.log(
        `ℹ️  ${environment}/${service}: ${diff.advisory.length} optional variable(s) unset (defaults apply):`
      );
      for (const gap of diff.advisory) console.log(`   - ${gap.note}`);
    }
  }

  if (failures > 0) {
    console.error(
      `\nPreflight failed: ${failures} gap(s). Set the variables above in Railway, ` +
        'then REDEPLOY each service - committed variables do not reach a running instance ' +
        'until an explicit redeploy (learned on #213).'
    );
    process.exitCode = 1;
  }
}

// Entry guard mirrors src/cli/runMaintenance.ts, so importing this module
// (the unit tests import diffManifest) never fires a network call.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
