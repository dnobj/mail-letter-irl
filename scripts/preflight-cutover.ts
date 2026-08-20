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

export interface ManifestDiff {
  /** Requirements not satisfied by any present name (own name or alias). */
  missing: EnvVarRequirement[];
  /** Names-only note per missing entry, safe to print. */
  notes: string[];
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
  const missing: EnvVarRequirement[] = [];
  const notes: string[] = [];

  for (const entry of manifest) {
    if (!entry.services.includes(options.service)) continue;
    if (entry.requiredIn === 'production' && !production) {
      // One exception: the identity label is required in every DEPLOYED
      // environment, because deployed development runs NODE_ENV=production.
      if (entry.name !== 'LETTER_IRL_DEPLOYMENT_ENVIRONMENT') continue;
    }
    if (entry.condition === 'when-jit-enabled' && !jitFlagSet) continue;
    // 'unless-admin' is ignored: deployed services are never local admin mode.

    const satisfied = [entry.name, ...(entry.aliases ?? [])].some(name => present.has(name));
    if (!satisfied) {
      missing.push(entry);
      const aliasNote = entry.aliases?.length
        ? ` (or one of: ${entry.aliases.join(', ')})`
        : '';
      const conditionNote =
        entry.condition === 'when-jit-enabled'
          ? ' [required because JIT_PURCHASE_ENABLED is set]'
          : '';
      notes.push(`${entry.name}${aliasNote}${conditionNote}`);
    }
  }

  return { missing, notes };
}

interface RailwayIds {
  environmentId: string;
  services: { api: string; maintenance: string };
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
      environments: { edges: Array<{ node: { id: string; name: string } }> };
      services: { edges: Array<{ node: { id: string; name: string } }> };
    };
  }
  const data = await railwayGraphQL<ProjectData>(
    token,
    `query project($id: String!) {
       project(id: $id) {
         environments { edges { node { id name } } }
         services { edges { node { id name } } }
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

  const serviceNodes = data.project.services.edges.map(edge => edge.node);
  const findService = (needle: string): string => {
    const matches = serviceNodes.filter(node => node.name.toLowerCase().includes(needle));
    if (matches.length !== 1) {
      // Count only - service names are Railway response text, and everything
      // this script prints stays response-free (round 2 tightened this to
      // match the GraphQL-error treatment).
      throw new Error(
        `Expected exactly one service name containing "${needle}"; found ${matches.length} of ${serviceNodes.length} services - check the project in the Railway dashboard`
      );
    }
    return matches[0].id;
  };

  return {
    environmentId: environmentNode.id,
    services: {
      // The API service is named e.g. "letter-irl-api"; "maintenance" matches
      // the maintenance cron service regardless of environment suffixes.
      api: findService('api'),
      maintenance: findService('maintenance')
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
    const names = await fetchVariableNames(token, ids.environmentId, ids.services[service]);
    const diff = diffManifest(names, { environment, service });
    if (diff.missing.length === 0) {
      console.log(`✅ ${environment}/${service}: all ${
        environment === 'production' ? 'production-required' : 'required'
      } variables are set`);
    } else {
      failures += diff.missing.length;
      console.error(`❌ ${environment}/${service}: ${diff.missing.length} required variable(s) missing:`);
      for (const note of diff.notes) console.error(`   - ${note}`);
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
