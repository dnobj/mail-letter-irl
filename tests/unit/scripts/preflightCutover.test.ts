import { describe, expect, it } from 'vitest';
import { diffManifest } from '../../../scripts/preflight-cutover.js';
import { ENV_VAR_MANIFEST } from '../../../src/config/deploymentConfig.js';

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
  'STRIPE_STARTER_AMOUNT_CENTS',
  'STRIPE_PRICE_REGULAR',
  'STRIPE_REGULAR_AMOUNT_CENTS',
  'STRIPE_PRICE_POWER',
  'STRIPE_POWER_AMOUNT_CENTS',
  'TEMP_IMAGE_BUCKET_NAME',
  'TEMP_IMAGE_BUCKET_ENDPOINT',
  'TEMP_IMAGE_BUCKET_ACCESS_KEY_ID',
  'TEMP_IMAGE_BUCKET_SECRET_ACCESS_KEY'
];

describe('diffManifest', () => {
  it('passes a fully configured production API service', () => {
    const diff = diffManifest(FULL_PRODUCTION_NAMES, {
      environment: 'production',
      service: 'api'
    });
    expect(diff.missing).toEqual([]);
  });

  it('reports the #213 gap: pack amount variables missing in production', () => {
    const withoutAmounts = FULL_PRODUCTION_NAMES.filter(
      name => !name.endsWith('_AMOUNT_CENTS')
    );
    const diff = diffManifest(withoutAmounts, {
      environment: 'production',
      service: 'api'
    });
    expect(diff.missing.map(entry => entry.name)).toEqual([
      'STRIPE_STARTER_AMOUNT_CENTS',
      'STRIPE_REGULAR_AMOUNT_CENTS',
      'STRIPE_POWER_AMOUNT_CENTS'
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
    expect(diff.missing.map(entry => entry.name).sort()).toEqual([
      'DATABASE_URL',
      // Deployed development runs NODE_ENV=production; without the identity
      // label the validator resolves it to production mode and boot fails.
      'LETTER_IRL_DEPLOYMENT_ENVIRONMENT',
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET'
    ]);
  });

  it('excludes the webhook secret from the maintenance service subset', () => {
    const diff = diffManifest([], { environment: 'development', service: 'maintenance' });
    expect(diff.missing.map(entry => entry.name)).not.toContain('STRIPE_WEBHOOK_SECRET');
    expect(diff.missing.map(entry => entry.name)).toContain('STRIPE_SECRET_KEY');
  });

  it('requires the JIT variables in production only when the flag name is present', () => {
    const withoutFlag = diffManifest(FULL_PRODUCTION_NAMES, {
      environment: 'production',
      service: 'api'
    });
    expect(withoutFlag.missing.map(entry => entry.name)).not.toContain(
      'STRIPE_JIT_LETTER_PRICE_ID'
    );

    const withFlag = diffManifest([...FULL_PRODUCTION_NAMES, 'JIT_PURCHASE_ENABLED'], {
      environment: 'production',
      service: 'api'
    });
    const missingNames = withFlag.missing.map(entry => entry.name);
    for (const name of [
      'STRIPE_JIT_LETTER_PRICE_ID',
      'JIT_LETTER_AMOUNT_CENTS',
      'STRIPE_JIT_POSTCARD_PRICE_ID',
      'JIT_POSTCARD_AMOUNT_CENTS'
    ]) {
      expect(missingNames).toContain(name);
    }
    // The note must explain WHY a conditional variable is demanded.
    expect(withFlag.notes.join('\n')).toContain('JIT_PURCHASE_ENABLED is set');
  });

  it('never requires unless-admin exemptions on deployed services', () => {
    // ADMIN_ENABLED present or not, deployed services always need Stripe.
    const diff = diffManifest(['ADMIN_ENABLED'], {
      environment: 'development',
      service: 'api'
    });
    expect(diff.missing.map(entry => entry.name)).toContain('STRIPE_SECRET_KEY');
  });

  it('emits names-only notes, aligned one-to-one with the missing entries', () => {
    const diff = diffManifest([], { environment: 'production', service: 'api' });
    expect(diff.notes).toHaveLength(diff.missing.length);
    for (const [index, entry] of diff.missing.entries()) {
      expect(diff.notes[index]).toContain(entry.name);
    }
  });

  it('consumes the real manifest by default so the two can never drift', () => {
    // A canary: if someone re-points the default manifest, this fails.
    const names = ENV_VAR_MANIFEST.map(entry => entry.name);
    expect(names).toContain('STRIPE_STARTER_AMOUNT_CENTS');
    const diff = diffManifest(names, { environment: 'production', service: 'api' });
    expect(diff.missing).toEqual([]);
  });
});
