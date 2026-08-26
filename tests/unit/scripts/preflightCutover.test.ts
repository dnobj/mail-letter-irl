import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { diffManifest } from '../../../scripts/preflight-cutover.js';
import {
  ENV_VAR_MANIFEST,
  validateDeploymentConfig
} from '../../../src/config/deploymentConfig.js';

/**
 * Issue #155. diffManifest is the pure core of the preflight parity check:
 * present variable NAMES in, missing requirements out. The network layer is
 * deliberately thin and untested here; what matters is that the manifest
 * interpretation - environment rules, service subsets, alias chains, the
 * conservative JIT condition - is exactly right, because a wrong "all clear"
 * from this script is a production incident deferred to boot time.
 */

/** Everything production requires for the API service, by primary name. */
const FULL_PRODUCTION_NAMES = [
  'DATABASE_URL',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'LETTER_IRL_DEPLOYMENT_ENVIRONMENT',
  'LETTER_PROVIDER',
  'LETTER_PROVIDER_API_KEY',
  'LETTER_PROVIDER_CONFIG',
  'STRIPE_PRICE_STARTER',
  'STRIPE_PRICE_REGULAR',
  'STRIPE_PRICE_POWER',
  // Load-bearing since #275: every Price must be denominated in it or the
  // catalog refuses to price that product. It was in no manifest entry, so the
  // preflight reported full parity while the two environments disagreed about
  // the store currency (#278 review round 2).
  'STRIPE_CURRENCY',
  'TEMP_IMAGE_BUCKET_NAME',
  'TEMP_IMAGE_BUCKET_ENDPOINT',
  'TEMP_IMAGE_BUCKET_ACCESS_KEY_ID',
  'TEMP_IMAGE_BUCKET_SECRET_ACCESS_KEY',
  // OAuth (#270). Absent from this list until production was found diverging
  // here more than anywhere else, with neither the preflight nor the boot
  // validator able to report it.
  'LETTER_IRL_OAUTH_ISSUER',
  'LETTER_IRL_OAUTH_AUTH_ENDPOINT',
  'LETTER_IRL_OAUTH_TOKEN_ENDPOINT',
  'LETTER_IRL_OAUTH_JWKS_URI',
  'LETTER_IRL_OAUTH_AUDIENCE',
  'LETTER_IRL_MCP_RESOURCE',
  'LETTER_IRL_OAUTH_PROD_ISSUER',
  'LETTER_IRL_OAUTH_CIMD_ENFORCEMENT'
];

describe('diffManifest', () => {
  it('passes a fully configured production API service', () => {
    const diff = diffManifest(FULL_PRODUCTION_NAMES, {
      environment: 'production',
      service: 'api'
    });
    expect(diff.missing).toEqual([]);
  });

  it('reports the #213 gap in its current form: pack price ids missing in production', () => {
    // The amount variables this originally guarded were deleted in #275 stage
    // A - amounts come from the Stripe Price itself now, so there is nothing to
    // omit. The price IDS are still required, and forgetting one is the same
    // #213 shape: a deploy that boots clean and fails when a customer clicks
    // Buy Now.
    const withoutPrices = FULL_PRODUCTION_NAMES.filter(
      name => !name.startsWith('STRIPE_PRICE_')
    );
    const diff = diffManifest(withoutPrices, {
      environment: 'production',
      service: 'api'
    });
    expect(diff.missing.map(gap => gap.entry.name)).toEqual([
      'STRIPE_PRICE_STARTER',
      'STRIPE_PRICE_REGULAR',
      'STRIPE_PRICE_POWER'
    ]);
  });

  it('accepts an alias in place of the primary bucket name', () => {
    const aliased = FULL_PRODUCTION_NAMES.filter(name => name !== 'TEMP_IMAGE_BUCKET_NAME');
    aliased.push('AWS_S3_BUCKET_NAME');
    const diff = diffManifest(aliased, { environment: 'production', service: 'api' });
    expect(diff.missing).toEqual([]);
  });

  it('requires only the always-required set plus the identity label in development', () => {
    const diff = diffManifest([], { environment: 'development', service: 'api' });
    expect(diff.missing.map(gap => gap.entry.name).sort()).toEqual([
      'DATABASE_URL',
      // Deployed development runs NODE_ENV=production; without the identity
      // label the validator resolves it to production mode and boot fails.
      'LETTER_IRL_DEPLOYMENT_ENVIRONMENT',
      'LETTER_IRL_MCP_RESOURCE',
      'LETTER_IRL_OAUTH_AUDIENCE',
      'LETTER_IRL_OAUTH_AUTH_ENDPOINT',
      // The development half of the issuer allowlist - see the isolation test.
      'LETTER_IRL_OAUTH_DEV_ISSUER',
      'LETTER_IRL_OAUTH_ISSUER',
      'LETTER_IRL_OAUTH_JWKS_URI',
      'LETTER_IRL_OAUTH_TOKEN_ENDPOINT',
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET'
    ]);
  });

  it('excludes the webhook secret from the maintenance service subset', () => {
    const diff = diffManifest([], { environment: 'development', service: 'maintenance' });
    expect(diff.missing.map(gap => gap.entry.name)).not.toContain('STRIPE_WEBHOOK_SECRET');
    expect(diff.missing.map(gap => gap.entry.name)).toContain('STRIPE_SECRET_KEY');
  });

  it('requires the JIT variables in production only when the flag name is present', () => {
    const withoutFlag = diffManifest(FULL_PRODUCTION_NAMES, {
      environment: 'production',
      service: 'api'
    });
    expect(withoutFlag.missing.map(gap => gap.entry.name)).not.toContain(
      'STRIPE_JIT_LETTER_PRICE_ID'
    );

    const withFlag = diffManifest([...FULL_PRODUCTION_NAMES, 'JIT_PURCHASE_ENABLED'], {
      environment: 'production',
      service: 'api'
    });
    const missingNames = withFlag.missing.map(gap => gap.entry.name);
    for (const name of [
      'STRIPE_JIT_LETTER_PRICE_ID',
      'STRIPE_JIT_POSTCARD_PRICE_ID',
    ]) {
      expect(missingNames).toContain(name);
    }
    // The note must explain WHY a conditional variable is demanded.
    expect(withFlag.missing.map(gap => gap.note).join('\n')).toContain('JIT_PURCHASE_ENABLED is set');
  });

  it('never requires unless-admin exemptions on deployed services', () => {
    // ADMIN_ENABLED present or not, deployed services always need Stripe.
    const diff = diffManifest(['ADMIN_ENABLED'], {
      environment: 'development',
      service: 'api'
    });
    expect(diff.missing.map(gap => gap.entry.name)).toContain('STRIPE_SECRET_KEY');
  });

  it('emits names-only notes, aligned one-to-one with the missing entries', () => {
    const diff = diffManifest([], { environment: 'production', service: 'api' });
    // Entry and note travel as one record now; alignment is structural.
    expect(diff.missing.length).toBeGreaterThan(0);
    for (const gap of diff.missing) {
      expect(gap.note).toContain(gap.entry.name);
    }
  });

  it('reports an unset advisory variable without failing the gate', () => {
    // STRIPE_CURRENCY and the price band change what production will sell, so
    // they must be VISIBLE to a parity diff - but each has a working default,
    // and listing them as required turned the cutover gate red for a correctly
    // configured USD environment. `checkedBy` alone could not express that: it
    // only exempts an entry from the boot presence loop, and this script reads
    // requiredIn/condition and nothing else (#278 review round 3).
    const withoutCurrency = FULL_PRODUCTION_NAMES.filter(name => name !== 'STRIPE_CURRENCY');
    const diff = diffManifest(withoutCurrency, { environment: 'production', service: 'api' });

    expect(diff.missing.map(gap => gap.entry.name)).not.toContain('STRIPE_CURRENCY');
    expect(diff.advisory.map(gap => gap.entry.name)).toContain('STRIPE_CURRENCY');
    for (const gap of diff.advisory) expect(gap.note).toContain(gap.entry.name);
    // An advisory note NEVER claims the variable is required: these print
    // under "optional (defaults apply)", and JIT_CURRENCY - advisory AND
    // carrying the when-jit-enabled condition - told the operator on a
    // normal production run that one variable was both (#278 round 9).
    for (const gap of diff.advisory) expect(gap.note).not.toContain('required because');
    // The gate itself stays green.
    expect(diff.missing).toEqual([]);
  });

  it('diffs an advisory variable even when its CONDITION flag is absent', () => {
    // Round 5 freed advisory entries from the requiredIn gate for parity
    // visibility; the condition gate still dropped them entirely. With Pay &
    // Send unrolled in production (flag name absent) and enabled in
    // development, JIT_CURRENCY landed in neither list in either run, so
    // nothing reported that the two environments disagree about the Pay &
    // Send currency - the one-directional blindness the mechanism exists to
    // end, and which the docs already claim is solved (#278 round 10).
    const withoutJitFlag = FULL_PRODUCTION_NAMES.filter(
      name => name !== 'JIT_PURCHASE_ENABLED' && name !== 'JIT_CURRENCY'
    );

    const diff = diffManifest(withoutJitFlag, { environment: 'production', service: 'api' });

    expect(diff.advisory.map(gap => gap.entry.name)).toContain('JIT_CURRENCY');
    // ...and the note states the REAL state. Round 11's note asserted
    // "because JIT_PURCHASE_ENABLED is set" in exactly this case, where the
    // flag is absent - the false-note class round 9 fixed on the required
    // branch, reintroduced on the advisory one (#278 round 12).
    const note = diff.advisory.find(gap => gap.entry.name === 'JIT_CURRENCY')?.note ?? '';
    expect(note).toContain('not set here');
    // Visibility only - the gate itself stays green.
    expect(diff.missing.map(gap => gap.entry.name)).not.toContain('JIT_CURRENCY');
  });

  it('never tells the operator an OPTIONAL variable is required', () => {
    // The reproduction is a normal production cutover: Railway sets
    // JIT_PURCHASE_ENABLED (the shipped config sets it to 'false', and the
    // diff keys on the NAME being present) and leaves JIT_CURRENCY unset -
    // correct, since jitCurrency() falls back to STRIPE_CURRENCY. The gate
    // exits 0 and prints JIT_CURRENCY under "optional (defaults apply)"
    // carrying "[required because JIT_PURCHASE_ENABLED is set]": the only
    // per-variable explanation the gate emits, and it said both at once
    // (#278 round 9).
    const withJitFlag = [...FULL_PRODUCTION_NAMES, 'JIT_PURCHASE_ENABLED'].filter(
      name => name !== 'JIT_CURRENCY'
    );

    const diff = diffManifest(withJitFlag, { environment: 'production', service: 'api' });

    const jitCurrency = diff.advisory.find(gap => gap.entry.name === 'JIT_CURRENCY');
    expect(jitCurrency, 'JIT_CURRENCY is advisory and condition-carrying').toBeDefined();
    expect(jitCurrency?.note).not.toContain('required because');
    expect(jitCurrency?.note).toContain('JIT_PURCHASE_ENABLED');
    // And the gate itself is unaffected.
    expect(diff.missing.map(gap => gap.entry.name)).not.toContain('JIT_CURRENCY');
  });

  it('lists advisory variables when diffing DEVELOPMENT too', () => {
    // Their entire purpose is cross-environment parity visibility. Skipping
    // production-only entries in the development run made that visibility
    // one-directional: a value set in production but absent in development
    // was reported by neither run (#278 review round 5).
    const diff = diffManifest([], { environment: 'development', service: 'api' });

    expect(diff.advisory.map(gap => gap.entry.name)).toContain('STRIPE_CURRENCY');
    expect(diff.missing.map(gap => gap.entry.name)).not.toContain('STRIPE_CURRENCY');
  });

  it('consumes the real manifest by default so the two can never drift', () => {
    // A canary: if someone re-points the default manifest, this fails.
    const names = ENV_VAR_MANIFEST.map(entry => entry.name);
    expect(names).toContain('STRIPE_PRICE_STARTER');
    // The amounts were deliberately removed in #275 stage A; they come from
    // the Stripe Price now. Asserting their ABSENCE keeps the deletion from
    // being quietly undone.
    expect(names).not.toContain('STRIPE_STARTER_AMOUNT_CENTS');
    const diff = diffManifest(names, { environment: 'production', service: 'api' });
    expect(diff.missing).toEqual([]);
  });
});

describe('parity with the boot validator', () => {
  /**
   * Review round 1's central finding: the preflight said a maintenance
   * service without STRIPE_WEBHOOK_SECRET was complete while the validator
   * failed every cron boot demanding it. This pins the two against each
   * other: an environment the preflight passes must produce ZERO presence
   * errors from the validator on the same surface. (Shape rules - prefixes,
   * integers, mode:"live" - are boot-only by design; presence is the shared
   * contract.)
   */
  function validValueFor(name: string, environment: 'production' | 'development'): string {
    const production = environment === 'production';
    if (name === 'DATABASE_URL') return 'postgresql://user:pass@fixture.example/db';
    // Round 2 caught the identity value hardcoded to 'production', which made
    // the development rows validate the wrong mode. Every mode-sensitive
    // value now follows the row's environment.
    if (name === 'LETTER_IRL_DEPLOYMENT_ENVIRONMENT') return environment;
    if (name === 'STRIPE_SECRET_KEY') return production ? 'sk_live_parity_fixture' : 'sk_test_parity_fixture';
    if (name === 'STRIPE_WEBHOOK_SECRET') return 'whsec_parity_fixture';
    if (name === 'LETTER_PROVIDER') return 'postgrid';
    if (name === 'LETTER_PROVIDER_API_KEY') return production ? 'live_sk_parity_fixture' : 'test_sk_parity_fixture';
    if (name === 'LETTER_PROVIDER_CONFIG') return production ? '{"mode":"live"}' : '{"mode":"test"}';
    if (name.startsWith('STRIPE_PRICE_') || name.endsWith('_PRICE_ID')) return `price_${name.toLowerCase()}`;
    return `parity-fixture-${name.toLowerCase()}`;
  }

  it.each([
    ['production', 'api'],
    ['production', 'maintenance'],
    ['development', 'api'],
    ['development', 'maintenance']
  ] as const)('a preflight-complete %s/%s environment boots with no presence errors', (environment, service) => {
    // Build exactly the environment the preflight considers complete...
    const complete = ENV_VAR_MANIFEST.filter(
      entry => diffManifest([], { environment, service }).missing.some(m => m.entry.name === entry.name)
    );
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'production', // both Railway environments run this
      LETTER_IRL_DEPLOYMENT_ENVIRONMENT: environment
    };
    for (const entry of complete) env[entry.name] = validValueFor(entry.name, environment);
    // ...add the shape-owned production requirements the preflight cannot see
    // (it checks names; the validator checks values), so only PRESENCE parity
    // is under test here.
    if (environment === 'production') {
      for (const entry of ENV_VAR_MANIFEST) {
        if (entry.services.includes(service === 'api' ? 'api' : 'maintenance') && !env[entry.name] && !entry.condition) {
          env[entry.name] = validValueFor(entry.name, environment);
        }
      }
      env.TEMP_IMAGE_STORE = 'bucket';
      env.LETTER_IRL_OAUTH_CIMD_ENFORCEMENT = 'true';
    }

    const surface = service === 'api' ? 'server' : 'maintenance';
    const validation = validateDeploymentConfig(env, surface);
    // The row must validate in ITS OWN mode - round 2 caught the development
    // rows silently running in production mode.
    expect(validation.mode).toBe(environment);
    const presenceErrors = validation.findings.filter(
      f => f.severity === 'error' && f.rule.startsWith('presence.')
    );
    expect(presenceErrors).toEqual([]);
  });

  it('the maintenance surface accepts exactly what the preflight demands of it - the round-1 divergence', () => {
    // No webhook secret anywhere: preflight says the maintenance service is
    // complete, and the validator must agree.
    const maintenanceNames = diffManifest([], {
      environment: 'development',
      service: 'maintenance'
    }).missing.map(gap => gap.entry.name);
    expect(maintenanceNames).not.toContain('STRIPE_WEBHOOK_SECRET');

    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      LETTER_IRL_DEPLOYMENT_ENVIRONMENT: 'development'
    };
    for (const name of maintenanceNames) env[name] = validValueFor(name, 'development');
    // Development identity var comes from the diff itself.
    env.LETTER_IRL_DEPLOYMENT_ENVIRONMENT = 'development';
    env.STRIPE_SECRET_KEY = 'sk_test_parity_fixture'; // dev holds a test key

    expect(validateDeploymentConfig(env, 'maintenance').errors).toEqual([]);
  });
});

/**
 * Issue #270. The preflight could not see a single OAuth variable, which is
 * exactly the category where production diverged most: it advertised no product
 * scopes at all, and nothing reported it. The preflight was blind because the
 * names were absent from ENV_VAR_MANIFEST; the boot validator was silent
 * because assertValidOAuthConfig only runs under LETTER_IRL_OAUTH_CIMD_ENFORCEMENT,
 * which production does not set.
 *
 * The root cause is drift between two lists that must agree and had nothing
 * comparing them - the same shape as the grant_types_supported vs /oauth/register
 * contradiction in #160. The last test here is the one that stops it recurring.
 */
describe('OAuth coverage (issue #270)', () => {
  it('reports missing OAuth variables in production instead of passing them', () => {
    const withoutOAuth = FULL_PRODUCTION_NAMES.filter(name => !/OAUTH|MCP_RESOURCE/.test(name));
    const diff = diffManifest(withoutOAuth, { environment: 'production', service: 'api' });
    const missing = diff.missing.map(gap => gap.entry.name);

    for (const name of [
      'LETTER_IRL_OAUTH_ISSUER',
      'LETTER_IRL_OAUTH_AUTH_ENDPOINT',
      'LETTER_IRL_OAUTH_TOKEN_ENDPOINT',
      'LETTER_IRL_OAUTH_JWKS_URI',
      'LETTER_IRL_OAUTH_AUDIENCE',
      'LETTER_IRL_MCP_RESOURCE',
      'LETTER_IRL_OAUTH_PROD_ISSUER',
      'LETTER_IRL_OAUTH_CIMD_ENFORCEMENT'
    ]) {
      expect(missing, `preflight cannot see ${name}`).toContain(name);
    }
  });

  it('accepts the public base URL in place of an explicit MCP resource', () => {
    // getOAuthConfig falls back to baseUrl + mcpPath, and production relies on
    // that fallback. Demanding the explicit name would report a false gap.
    const aliased = FULL_PRODUCTION_NAMES.filter(name => name !== 'LETTER_IRL_MCP_RESOURCE');
    aliased.push('LETTER_IRL_PUBLIC_BASE_URL');
    const diff = diffManifest(aliased, { environment: 'production', service: 'api' });
    expect(diff.missing).toEqual([]);
  });

  it('never swaps the two environment-isolation issuers', () => {
    // One allowlist per environment. Demanding the wrong one would push an
    // operator toward pointing production at the development tenant.
    const prod = diffManifest([], { environment: 'production', service: 'api' })
      .missing.map(gap => gap.entry.name);
    expect(prod).toContain('LETTER_IRL_OAUTH_PROD_ISSUER');
    expect(prod).not.toContain('LETTER_IRL_OAUTH_DEV_ISSUER');

    const dev = diffManifest([], { environment: 'development', service: 'api' })
      .missing.map(gap => gap.entry.name);
    expect(dev).toContain('LETTER_IRL_OAUTH_DEV_ISSUER');
    expect(dev).not.toContain('LETTER_IRL_OAUTH_PROD_ISSUER');
  });

  it('demands the static-DCR client variables only when that mode is in play', () => {
    const off = diffManifest(FULL_PRODUCTION_NAMES, {
      environment: 'production',
      service: 'api'
    }).missing.map(gap => gap.entry.name);
    expect(off).not.toContain('CHATGPT_STATIC_CLIENT_ID');
    expect(off).not.toContain('CHATGPT_STATIC_REDIRECT_URIS');

    const on = diffManifest(
      [...FULL_PRODUCTION_NAMES, 'LETTER_IRL_OAUTH_STATIC_DCR_COMPATIBILITY'],
      { environment: 'production', service: 'api' }
    );
    expect(on.missing.map(gap => gap.entry.name)).toEqual([
      'CHATGPT_STATIC_CLIENT_ID',
      'CHATGPT_STATIC_REDIRECT_URIS'
    ]);
    // The note has to say WHY, or the gap reads as an unexplained new demand.
    expect(on.missing.map(gap => gap.note).join(' ')).toContain('LETTER_IRL_OAUTH_STATIC_DCR_COMPATIBILITY is set');
  });

  it('adding OAuth entries did not change what fails at boot', () => {
    // Every new entry carries checkedBy, so the generic presence pass skips it
    // and validateOAuthConfig stays the sole owner of these errors. If one ever
    // loses its owner, a production deploy starts failing boot on a variable
    // that used to be validated elsewhere - a surprise worth catching here.
    const owned = ENV_VAR_MANIFEST.filter(entry =>
      /OAUTH|MCP_RESOURCE|CHATGPT_STATIC/.test(entry.name)
    );
    expect(owned.length).toBeGreaterThan(0);
    for (const entry of owned) {
      expect(entry.checkedBy, `${entry.name} would now fail boot generically`).toBe(
        'oauth.config_required'
      );
      // None of these are credentials, so none belong in the placeholder scan.
      expect(entry.secret, `${entry.name} is not a credential`).toBe(false);
    }
  });

  it('covers every OAuth input getOAuthConfig actually reads', () => {
    // The drift guard. ENV_VAR_MANIFEST and getOAuthConfig are two lists that
    // must agree, and nothing compared them - which is why the gap existed at
    // all. Read the real source rather than restating a list here, so adding an
    // env lookup to getOAuthConfig without a manifest entry fails.
    const source = readFileSync(
      new URL('../../../src/auth/oauthConfig.ts', import.meta.url),
      'utf8'
    );
    const read = new Set(
      [...source.matchAll(/env\.([A-Z0-9_]+)/g)].map(match => match[1])
    );
    const covered = new Set(
      ENV_VAR_MANIFEST.flatMap(entry => [entry.name, ...(entry.aliases ?? [])])
    );

    // Deliberate exclusions, each for a reason rather than convenience.
    const exempt = new Set([
      // Optional with a safe default; absence is correct, so presence cannot be
      // required. A wrong VALUE here is what broke production, and only the
      // validator can catch that - names-only checking never will.
      'LETTER_IRL_OAUTH_SCOPES',
      'LETTER_IRL_OAUTH_ALLOWED_ALGORITHMS',
      'LETTER_IRL_MCP_PATH',
      'LETTER_IRL_OAUTH_LEGACY_AUDIENCES',
      // Mode switches, not configuration: they select which rules apply.
      'LETTER_IRL_OAUTH_STATIC_DCR_COMPATIBILITY',
      'LETTER_IRL_OAUTH_CIMD_ENFORCEMENT',
      'LETTER_IRL_DEPLOYMENT_ENVIRONMENT'
    ]);

    const uncovered = [...read].filter(name => !covered.has(name) && !exempt.has(name));
    expect(
      uncovered,
      `getOAuthConfig reads these, and the preflight cannot see them: ${uncovered.join(', ')}`
    ).toEqual([]);
  });
});
