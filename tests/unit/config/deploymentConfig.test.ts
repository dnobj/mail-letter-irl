import { describe, expect, it } from 'vitest';
import {
  APPROVED_LIVE_PROVIDERS,
  ENV_VAR_MANIFEST,
  assertValidDeploymentConfig,
  isProductionEnv,
  resolveDeploymentMode,
  validateDeploymentConfig
} from '../../../src/config/deploymentConfig.js';

/**
 * Issue #155. The validator is pure over an injectable env, so these are
 * plain-object table tests - no vi.stubEnv, no module resets. Every value
 * below is an unmistakable fixture; the live-shaped ones (sk_live_,
 * live_sk_, whsec_) exist to satisfy prefix rules without tripping the
 * placeholder detector.
 */

const VALID_PROD: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  LETTER_IRL_DEPLOYMENT_ENVIRONMENT: 'production',
  DATABASE_URL: 'postgresql://user:pass@fixture.example/db',
  STRIPE_SECRET_KEY: 'sk_live_unit_fixture',
  STRIPE_WEBHOOK_SECRET: 'whsec_unit_fixture',
  STRIPE_PRICE_STARTER: 'price_starter_unit_fixture',
  STRIPE_PRICE_REGULAR: 'price_regular_unit_fixture',
  STRIPE_PRICE_POWER: 'price_power_unit_fixture',
  STRIPE_CURRENCY: 'usd',
  LETTER_PROVIDER: 'postgrid',
  LETTER_PROVIDER_API_KEY: 'live_sk_unit_fixture',
  LETTER_PROVIDER_CONFIG: '{"mode":"live"}',
  TEMP_IMAGE_STORE: 'bucket',
  TEMP_IMAGE_BUCKET_NAME: 'unit-fixture-bucket',
  TEMP_IMAGE_BUCKET_ENDPOINT: 'https://bucket.fixture.example',
  TEMP_IMAGE_BUCKET_REGION: 'unit-fixture-region',
  TEMP_IMAGE_BUCKET_ACCESS_KEY_ID: 'unit-fixture-access-key',
  TEMP_IMAGE_BUCKET_SECRET_ACCESS_KEY: 'unit-fixture-secret-key',
  LETTER_IRL_OAUTH_CIMD_ENFORCEMENT: 'true'
};

const VALID_DEV: NodeJS.ProcessEnv = {
  NODE_ENV: 'production', // deployed development runs NODE_ENV=production
  LETTER_IRL_DEPLOYMENT_ENVIRONMENT: 'development',
  DATABASE_URL: 'postgresql://user:pass@fixture.example/db',
  STRIPE_SECRET_KEY: 'sk_test_unit_fixture',
  STRIPE_WEBHOOK_SECRET: 'whsec_unit_fixture'
};

function env(
  overrides: Record<string, string | undefined>,
  base: NodeJS.ProcessEnv = VALID_PROD
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

function ruleIds(input: NodeJS.ProcessEnv, severity?: 'error' | 'warning'): string[] {
  return validateDeploymentConfig(input, 'server')
    .findings.filter(f => !severity || f.severity === severity)
    .map(f => f.rule);
}

describe('resolveDeploymentMode', () => {
  it.each([
    ['production', 'production', 'production', []],
    ['production', 'development', 'production', ['env.node_env_mismatch']],
    ['production', undefined, 'production', ['env.node_env_mismatch']],
    ['development', 'production', 'development', []],
    ['development', 'test', 'development', []],
    ['staging', 'production', 'production', ['env.deployment_environment_invalid']],
    [undefined, 'production', 'production', ['env.deployment_environment_required']],
    [undefined, 'test', 'test', []],
    [undefined, 'development', 'development', []],
    [undefined, undefined, 'development', []]
  ] as const)(
    'identity=%s NODE_ENV=%s resolves %s',
    (identity, nodeEnv, expectedMode, expectedRules) => {
      const { mode, findings } = resolveDeploymentMode({
        LETTER_IRL_DEPLOYMENT_ENVIRONMENT: identity,
        NODE_ENV: nodeEnv
      } as NodeJS.ProcessEnv);
      expect(mode).toBe(expectedMode);
      expect(findings.map(f => f.rule)).toEqual([...expectedRules]);
    }
  );

  it('isProductionEnv follows the resolved mode, not NODE_ENV', () => {
    expect(isProductionEnv(VALID_PROD)).toBe(true);
    expect(isProductionEnv(VALID_DEV)).toBe(false); // NODE_ENV=production, identity development
  });
});

describe('validateDeploymentConfig in production', () => {
  it.each([
    ['a numeric separator', '100_000'],
    ['zero', '0'],
    ['a decimal', '50.5']
  ])('flags a malformed price band value (%s) as a WARNING, never a boot error', (_label, value) => {
    // An error here throws at boot, ~650 lines before server.listen - a total
    // production outage over a band formatting slip, triggerable by the exact
    // `100_000` form the catalog docs print. The catalog logs the discarded
    // bound and falls back; the validator's job is to name it, not to refuse
    // to start (#278 review round 4). Zero is included because the old regex
    // passed it while the catalog rejected it - validator green, bound
    // silently discarded.
    const validation = validateDeploymentConfig(
      env({ STRIPE_PRICE_MAX_UNIT_AMOUNT: value }),
      'server'
    );

    const bandFindings = validation.findings.filter(f => f.rule === 'stripe.price_band');
    expect(bandFindings.length).toBeGreaterThan(0);
    expect(bandFindings.every(f => f.severity === 'warning')).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it('accepts a completely configured production environment with no findings', () => {
    const validation = validateDeploymentConfig(VALID_PROD, 'server');
    expect(validation.mode).toBe('production');
    expect(validation.errors).toEqual([]);
    expect(validation.warnings).toEqual([]);
  });

  it.each([
    // [description, overrides, expected error rule]
    ['missing DATABASE_URL', { DATABASE_URL: undefined }, 'presence.database_url'],
    ['missing STRIPE_SECRET_KEY', { STRIPE_SECRET_KEY: undefined }, 'presence.stripe_secret_key'],
    ['missing STRIPE_WEBHOOK_SECRET', { STRIPE_WEBHOOK_SECRET: undefined }, 'presence.stripe_webhook_secret'],
    ['test-mode Stripe key', { STRIPE_SECRET_KEY: 'sk_test_unit_fixture' }, 'stripe.live_key_required'],
    ['malformed webhook secret', { STRIPE_WEBHOOK_SECRET: 'not_a_webhook_secret' }, 'stripe.webhook_secret_malformed'],
    ['missing pack price', { STRIPE_PRICE_STARTER: undefined }, 'stripe.pack_price_incomplete'],
    ['pack price without price_ prefix', { STRIPE_PRICE_REGULAR: 'prod_something' }, 'stripe.pack_price_incomplete'],
    ['unset provider (implicit dummy)', { LETTER_PROVIDER: undefined }, 'provider.live_provider_required'],
    ['dummy provider', { LETTER_PROVIDER: 'dummy' }, 'provider.live_provider_required'],
    ['diy provider', { LETTER_PROVIDER: 'diy' }, 'provider.live_provider_required'],
    ['unregistered lob provider', { LETTER_PROVIDER: 'lob' }, 'provider.live_provider_required'],
    ['missing provider key', { LETTER_PROVIDER_API_KEY: undefined }, 'provider.api_key_required'],
    ['missing provider config', { LETTER_PROVIDER_CONFIG: undefined }, 'provider.live_mode_required'],
    ['test-mode provider config', { LETTER_PROVIDER_CONFIG: '{"mode":"test"}' }, 'provider.live_mode_required'],
    ['provider config without mode', { LETTER_PROVIDER_CONFIG: '{"verbose":true}' }, 'provider.live_mode_required'],
    ['malformed provider config', { LETTER_PROVIDER_CONFIG: '{mode:live}' }, 'provider.config_json_invalid'],
    ['test-prefixed provider key', { LETTER_PROVIDER_API_KEY: 'test_sk_unit_fixture' }, 'provider.test_key_in_production'],
    ['test-prefixed POSTGRID_API_KEY', { POSTGRID_API_KEY: 'test_sk_unit_fixture' }, 'provider.test_key_in_production'],
    ['memory image store', { TEMP_IMAGE_STORE: 'memory' }, 'bucket.config_required'],
    ['missing bucket name and aliases', { TEMP_IMAGE_BUCKET_NAME: undefined }, 'bucket.config_required'],
    ['missing bucket endpoint and aliases', { TEMP_IMAGE_BUCKET_ENDPOINT: undefined }, 'bucket.config_required'],
    ['missing bucket access key and aliases', { TEMP_IMAGE_BUCKET_ACCESS_KEY_ID: undefined }, 'bucket.config_required'],
    ['missing bucket secret and aliases', { TEMP_IMAGE_BUCKET_SECRET_ACCESS_KEY: undefined }, 'bucket.config_required'],
    ['placeholder Stripe key', { STRIPE_SECRET_KEY: 'sk_live_...' }, 'config.placeholder_value'],
    ['placeholder provider key', { LETTER_PROVIDER_API_KEY: 'your_live_key_here' }, 'config.placeholder_value'],
    // The send path prefers POSTGRID_API_KEY over the validated variable, so
    // a placeholder there boots clean and then fails every send (review r1).
    ['placeholder POSTGRID_API_KEY', { POSTGRID_API_KEY: 'your_live_key_here' }, 'config.placeholder_value'],
    ['changeme placeholder', { STRIPE_SECRET_KEY: 'changeme' }, 'config.placeholder_value'],
    ['placeholder literal', { LETTER_PROVIDER_API_KEY: 'placeholder' }, 'config.placeholder_value'],
    ['xxx placeholder', { TEMP_IMAGE_BUCKET_SECRET_ACCESS_KEY: 'xxx' }, 'config.placeholder_value'],
    ['test-prefixed address-verification key', { POSTGRID_ADDRESS_VERIFICATION_API_KEY: 'test_sk_unit_fixture' }, 'provider.test_key_in_production'],
    ['ADMIN_ENABLED in production', { ADMIN_ENABLED: 'true' }, 'admin.enabled_in_production']
  ])('%s is an error', (_description, overrides, expectedRule) => {
    expect(ruleIds(env(overrides), 'error')).toContain(expectedRule);
  });

  it('accepts bucket configuration through the alias chains', () => {
    const aliased = env({
      TEMP_IMAGE_BUCKET_NAME: undefined,
      AWS_S3_BUCKET_NAME: 'unit-fixture-bucket',
      TEMP_IMAGE_BUCKET_ACCESS_KEY_ID: undefined,
      AWS_ACCESS_KEY_ID: 'unit-fixture-access-key'
    });
    expect(validateDeploymentConfig(aliased, 'server').errors).toEqual([]);
  });

  it('warns on an unrecognized provider key prefix instead of failing', () => {
    const unrecognized = env({ LETTER_PROVIDER_API_KEY: 'pg_opaque_unit_fixture' });
    expect(ruleIds(unrecognized, 'error')).toEqual([]);
    expect(ruleIds(unrecognized, 'warning')).toContain('provider.key_prefix_unrecognized');
  });

  it('warns when no bucket region is configured anywhere', () => {
    const noRegion = env({ TEMP_IMAGE_BUCKET_REGION: undefined });
    expect(ruleIds(noRegion, 'error')).toEqual([]);
    expect(ruleIds(noRegion, 'warning')).toContain('bucket.region_defaulted');
  });

  it('requires the full JIT pair for both mail types when the flag is on', () => {
    const jitOn = env({
      JIT_PURCHASE_ENABLED: 'true',
      STRIPE_JIT_LETTER_PRICE_ID: 'price_jit_letter_unit_fixture',
      JIT_LETTER_AMOUNT_CENTS: '499'
      // postcard pair deliberately missing
    });
    const errors = ruleIds(jitOn, 'error');
    expect(errors).toContain('stripe.jit_config_incomplete');
    // The letter pair is complete; only the postcard pair may be reported.
    const jitMessages = validateDeploymentConfig(jitOn, 'server')
      .findings.filter(f => f.rule === 'stripe.jit_config_incomplete')
      .map(f => f.message)
      .join('\n');
    expect(jitMessages).toContain('POSTCARD');
  });

  it('warns rather than errors when production auth enforcement is staged off (server surface only)', () => {
    const enforcementOff = env({ LETTER_IRL_OAUTH_CIMD_ENFORCEMENT: undefined });
    expect(ruleIds(enforcementOff, 'error')).toEqual([]);
    expect(ruleIds(enforcementOff, 'warning')).toContain('auth.enforcement_disabled_in_production');
    expect(
      validateDeploymentConfig(enforcementOff, 'maintenance').findings.map(f => f.rule)
    ).not.toContain('auth.enforcement_disabled_in_production');
  });

  it('collects every failure instead of stopping at the first', () => {
    const wreck = env({
      STRIPE_SECRET_KEY: 'sk_test_unit_fixture',
      LETTER_PROVIDER: undefined,
      LETTER_PROVIDER_CONFIG: '{"mode":"test"}',
      STRIPE_PRICE_STARTER: undefined,
      TEMP_IMAGE_BUCKET_NAME: undefined
    });
    const errors = ruleIds(wreck, 'error');
    for (const rule of [
      'stripe.live_key_required',
      'provider.live_provider_required',
      'provider.live_mode_required',
      'stripe.pack_price_incomplete',
      'bucket.config_required'
    ]) {
      expect(errors).toContain(rule);
    }
  });
});

describe('validateDeploymentConfig outside production', () => {
  it('accepts a deployed development environment without provider or bucket config', () => {
    const validation = validateDeploymentConfig(VALID_DEV, 'server');
    expect(validation.mode).toBe('development');
    expect(validation.errors).toEqual([]);
  });

  it('rejects a live Stripe key outside production', () => {
    const liveInDev = env({ STRIPE_SECRET_KEY: 'sk_live_unit_fixture' }, VALID_DEV);
    expect(ruleIds(liveInDev, 'error')).toContain('stripe.live_key_outside_production');
  });

  it('rejects a live SEND-capable provider key outside production', () => {
    const liveInDev = env({ POSTGRID_API_KEY: 'live_sk_unit_fixture' }, VALID_DEV);
    expect(ruleIds(liveInDev, 'error')).toContain('provider.live_key_outside_production');
  });

  it('permits a live ADDRESS-VERIFICATION key outside production, with a warning', () => {
    // The first deployed boot of the validator refused dev over exactly this:
    // dev legitimately verifies against live address data, and the
    // verification key cannot send mail. Live send keys stay errors; live
    // verification keys warn about spend and boot.
    const liveVerifyInDev = env(
      { POSTGRID_ADDRESS_VERIFICATION_API_KEY: 'live_sk_unit_fixture' },
      VALID_DEV
    );
    expect(ruleIds(liveVerifyInDev, 'error')).not.toContain('provider.live_key_outside_production');
    expect(ruleIds(liveVerifyInDev, 'warning')).toContain('provider.live_key_outside_production');
  });

  it('reports incomplete pack config as a warning in development, never an error', () => {
    const validation = validateDeploymentConfig(VALID_DEV, 'server');
    expect(validation.findings.filter(f => f.rule === 'stripe.pack_price_incomplete'))
      .not.toHaveLength(0);
    expect(
      validation.findings.filter(
        f => f.rule === 'stripe.pack_price_incomplete' && f.severity === 'error'
      )
    ).toHaveLength(0);
  });

  it('downgrades malformed provider config to a warning outside production', () => {
    const malformed = env({ LETTER_PROVIDER_CONFIG: '{mode:test}' }, VALID_DEV);
    expect(ruleIds(malformed, 'error')).not.toContain('provider.config_json_invalid');
    expect(ruleIds(malformed, 'warning')).toContain('provider.config_json_invalid');
  });

  it('still rejects placeholder credentials in development', () => {
    const placeholder = env({ STRIPE_SECRET_KEY: 'sk_test_...' }, VALID_DEV);
    expect(ruleIds(placeholder, 'error')).toContain('config.placeholder_value');
  });

  it('warns about the implicit dummy provider only when the environment is unlabeled', () => {
    const unlabeled = env(
      { LETTER_IRL_DEPLOYMENT_ENVIRONMENT: undefined, NODE_ENV: 'development' },
      VALID_DEV
    );
    expect(ruleIds(unlabeled, 'warning')).toContain('provider.dummy_implicit_environment');
    expect(ruleIds(VALID_DEV, 'warning')).not.toContain('provider.dummy_implicit_environment');
  });

  it('skips pack and JIT checks entirely in test mode so unit fixtures stay minimal', () => {
    const testMode: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://user:pass@fixture.example/db',
      STRIPE_SECRET_KEY: 'sk_test_unit_fixture',
      STRIPE_WEBHOOK_SECRET: 'whsec_unit_fixture',
      JIT_PURCHASE_ENABLED: 'true' // the legacyAdminRoutes fixture does this with no JIT config
    };
    const validation = validateDeploymentConfig(testMode, 'server');
    expect(validation.mode).toBe('test');
    expect(validation.errors).toEqual([]);
    expect(validation.findings.map(f => f.rule)).not.toContain('stripe.jit_config_incomplete');
    expect(validation.findings.map(f => f.rule)).not.toContain('stripe.pack_price_incomplete');
  });

  it('keeps the local admin mode bootable without any Stripe configuration', () => {
    const adminLocal: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://user:pass@fixture.example/db',
      ADMIN_ENABLED: 'true'
    };
    expect(validateDeploymentConfig(adminLocal, 'server').errors).toEqual([]);
  });

  it('still rejects a live Stripe key in local admin mode', () => {
    // Admin mode exempts presence and pack/JIT completeness, never the
    // key-location rules: a pasted sk_live_ key in local admin tooling is
    // exactly the live-key-outside-production scenario (review round 1).
    const adminWithLiveKey: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://user:pass@fixture.example/db',
      ADMIN_ENABLED: 'true',
      STRIPE_SECRET_KEY: 'sk_live_unit_fixture'
    };
    expect(ruleIds(adminWithLiveKey, 'error')).toContain('stripe.live_key_outside_production');
  });
});

describe('validation surfaces', () => {
  it('does not demand the webhook secret of the maintenance surface, matching the manifest', () => {
    // Review round 1: the preflight honored the manifest's services field
    // while the validator ignored it, so a maintenance service provisioned
    // exactly per a green preflight failed every cron run. The surface now
    // maps to the manifest's services, keeping the two in parity.
    const noWebhook = env({ STRIPE_WEBHOOK_SECRET: undefined }, VALID_DEV);
    expect(
      validateDeploymentConfig(noWebhook, 'maintenance').errors
    ).toEqual([]);
    expect(
      validateDeploymentConfig(noWebhook, 'server').findings.map(f => f.rule)
    ).toContain('presence.stripe_webhook_secret');
  });
});

describe('assertValidDeploymentConfig', () => {
  it('returns the validation when clean', () => {
    expect(assertValidDeploymentConfig(VALID_PROD, 'server').mode).toBe('production');
  });

  it('throws one error naming every problem', () => {
    const broken = env({
      STRIPE_SECRET_KEY: 'sk_test_unit_fixture',
      LETTER_PROVIDER: undefined
    });
    const message = (() => {
      try {
        assertValidDeploymentConfig(broken, 'server');
        return '';
      } catch (error) {
        return String(error);
      }
    })();
    expect(message).toContain('Invalid deployment configuration:');
    expect(message).toContain('STRIPE_SECRET_KEY');
    expect(message).toContain('LETTER_PROVIDER');
  });

  it('never leaks configured values into the thrown message', () => {
    const broken = env({ STRIPE_SECRET_KEY: 'sk_test_super_secret_value_9x7' });
    try {
      assertValidDeploymentConfig(broken, 'server');
      expect.unreachable('expected assert to throw');
    } catch (error) {
      expect(String(error)).not.toContain('super_secret_value_9x7');
    }
  });
});

describe('ENV_VAR_MANIFEST', () => {
  it('covers every variable the #213 incident and the pack path depend on', () => {
    const names = ENV_VAR_MANIFEST.map(entry => entry.name);
    for (const required of [
      'DATABASE_URL',
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'LETTER_IRL_DEPLOYMENT_ENVIRONMENT',
      'LETTER_PROVIDER',
      'LETTER_PROVIDER_API_KEY',
      'STRIPE_PRICE_STARTER',
      'STRIPE_PRICE_REGULAR',
      'STRIPE_PRICE_POWER',
      'TEMP_IMAGE_BUCKET_NAME'
    ]) {
      expect(names).toContain(required);
    }

    // Deleted in #275 stage A: amounts come from the Stripe Price itself, so a
    // second copy in the environment can no longer drift from it. Asserted
    // absent so the deletion cannot be quietly undone by a future edit that
    // "restores" them for symmetry with the price ids.
    for (const removed of [
      'STRIPE_STARTER_AMOUNT_CENTS',
      'STRIPE_REGULAR_AMOUNT_CENTS',
      'STRIPE_POWER_AMOUNT_CENTS',
      'JIT_LETTER_AMOUNT_CENTS',
      'JIT_POSTCARD_AMOUNT_CENTS'
    ]) {
      expect(names).not.toContain(removed);
    }
  });

  it('marks every credential as secret so tooling never prints one', () => {
    for (const name of [
      'DATABASE_URL',
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'LETTER_PROVIDER_API_KEY',
      'TEMP_IMAGE_BUCKET_SECRET_ACCESS_KEY'
    ]) {
      const entry = ENV_VAR_MANIFEST.find(candidate => candidate.name === name);
      expect(entry?.secret, name).toBe(true);
    }
  });

  it('approves exactly the providers production may run on', () => {
    expect(APPROVED_LIVE_PROVIDERS).toEqual(['postgrid']);
  });
});
