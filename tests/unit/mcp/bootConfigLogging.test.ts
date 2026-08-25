import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Issue #155, review round 1. The deployment validator's message is built to
 * be value-free precisely so it CAN be logged - but nothing logged it: the
 * entry catches write only an error class (correct for arbitrary runtime
 * errors, which may carry sensitive detail), so a failed production boot told
 * the operator "configuration_error" and nothing else. These pin the
 * operator-visible surface: a config failure names its variables on stderr,
 * and validator warnings reach stderr with the [config] prefix outside test
 * mode.
 */

describe('boot configuration logging', () => {
  // Every variable any validator rule reads. All are cleared in beforeEach so
  // a developer's ambient shell or .env (dotenv runs on the dynamic import)
  // cannot satisfy a rule these tests assert as failing - round 2 flagged the
  // hermeticity gap.
  const OWNED_KEYS = [
    'NODE_ENV',
    'LETTER_IRL_DEPLOYMENT_ENVIRONMENT',
    'LETTER_IRL_REQUIRE_AUTH',
    'DATABASE_URL',
    'ADMIN_ENABLED',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
  // Read by the stripe.currency_unset and stripe.price_band rules (#275/#278).
  'STRIPE_CURRENCY',
  'JIT_CURRENCY',
    'STRIPE_PRICE_STARTER',
    'STRIPE_PRICE_REGULAR',
    'STRIPE_PRICE_POWER',
    'LETTER_PROVIDER',
    'LETTER_PROVIDER_API_KEY',
    'LETTER_PROVIDER_CONFIG',
    'POSTGRID_API_KEY',
    'POSTGRID_ADDRESS_VERIFICATION_API_KEY',
    'JIT_PURCHASE_ENABLED',
    'IMAGE_TRIAL_ENABLED',
    'TEMP_IMAGE_STORE',
    'TEMP_IMAGE_BUCKET_NAME',
    'TEMP_IMAGE_BUCKET_ENDPOINT',
    'TEMP_IMAGE_BUCKET_REGION',
    'TEMP_IMAGE_BUCKET_ACCESS_KEY_ID',
    'TEMP_IMAGE_BUCKET_SECRET_ACCESS_KEY',
    'AWS_S3_BUCKET_NAME',
    'AWS_ENDPOINT_URL_S3',
    'AWS_ENDPOINT_URL',
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'BUCKET',
    'ENDPOINT',
    'REGION',
    'ACCESS_KEY_ID',
    'SECRET_ACCESS_KEY',
    'LETTER_IRL_OAUTH_CIMD_ENFORCEMENT'
  ] as const;

  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(OWNED_KEYS.map(key => [key, process.env[key]]));
    for (const key of OWNED_KEYS) delete process.env[key];
    // Module-level constants capture env at import time (same constraint the
    // boot-validation suite documents), so set before the dynamic import.
    process.env.LETTER_IRL_REQUIRE_AUTH = 'false';
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function loadValidateEnvironment() {
    vi.resetModules();
    const module = await import('../../../src/mcp/httpServer.js');
    return module.validateEnvironment;
  }

  it('a failed production boot names the failing variables on stderr', async () => {
    process.env.NODE_ENV = 'production';
    process.env.LETTER_IRL_DEPLOYMENT_ENVIRONMENT = 'production';
    process.env.DATABASE_URL = 'postgresql://user:pass@fixture.example/db';
    // Deliberately nothing else: Stripe, provider, and bucket rules all fail.

    const validateEnvironment = await loadValidateEnvironment();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => validateEnvironment()).toThrow('Invalid deployment configuration');

    const logged = errorSpy.mock.calls.flat().map(String).join('\n');
    // The operator must be able to read WHICH variables failed, not just that
    // configuration did.
    expect(logged).toContain('STRIPE_SECRET_KEY');
    expect(logged).toContain('LETTER_PROVIDER');
    expect(logged).toContain('TEMP_IMAGE_BUCKET_NAME');
  });

  it('prints validator warnings with the [config] prefix outside test mode', async () => {
    process.env.NODE_ENV = 'production'; // deployed development runs this
    process.env.LETTER_IRL_DEPLOYMENT_ENVIRONMENT = 'development';
    process.env.DATABASE_URL = 'postgresql://user:pass@fixture.example/db';
    process.env.STRIPE_SECRET_KEY = 'sk_test_boot_logging_fixture';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_boot_logging_fixture';
    process.env.LETTER_PROVIDER_CONFIG = '{not json'; // warning in development

    const validateEnvironment = await loadValidateEnvironment();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(() => validateEnvironment()).not.toThrow();

    const warned = warnSpy.mock.calls.flat().map(String).join('\n');
    expect(warned).toContain('[config]');
    expect(warned).toContain('LETTER_PROVIDER_CONFIG');
  });
});
