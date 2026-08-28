import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getProviderByName,
  resetProvider
} from '../../../src/services/providers/index.js';

/**
 * Issue #155. getProviderByName used to catch a provider construction failure
 * and silently fall back to the default provider - which defaults to dummy.
 * In production that meant a missing PostGrid key dispatched real letters to
 * a provider that fabricates success and tracking IDs. These pin the split:
 * production surfaces the failure (the job system retries a failed send; a
 * fake successful send is unrecoverable), development keeps the fallback.
 */

function stubProduction(): void {
  vi.stubEnv('LETTER_IRL_DEPLOYMENT_ENVIRONMENT', 'production');
  vi.stubEnv('NODE_ENV', 'production');
}

function stubDevelopment(): void {
  vi.stubEnv('LETTER_IRL_DEPLOYMENT_ENVIRONMENT', 'development');
}

describe('provider production guards', () => {
  beforeEach(() => {
    resetProvider();
    // No key configured anywhere: PostGrid construction must fail.
    vi.stubEnv('POSTGRID_API_KEY', '');
    vi.stubEnv('LETTER_PROVIDER_API_KEY', '');
    vi.stubEnv('LETTER_PROVIDER', '');
    vi.stubEnv('LETTER_PROVIDER_CONFIG', '');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetProvider();
  });

  it('surfaces a provider construction failure in production instead of falling back', () => {
    stubProduction();
    expect(() => getProviderByName('postgrid')).toThrow(/PostGrid API key is required/);
  });

  it('keeps the development fallback to the default provider', () => {
    stubDevelopment();
    const provider = getProviderByName('postgrid');
    expect(provider.config.name).toBe('dummy');
  });

  it('refuses the dummy provider outright in production, even when routing asks for it', () => {
    stubProduction();
    // This is the provider_routing path: a database row naming 'dummy' is
    // invisible to boot-time env validation and lands here.
    expect(() => getProviderByName('dummy')).toThrow(/dummy provider is not allowed in production/);
  });

  it('still hands development the dummy provider on request', () => {
    stubDevelopment();
    expect(getProviderByName('dummy').config.name).toBe('dummy');
  });

  it('refuses the dummy provider in an UNLABELED production environment', () => {
    // Only NODE_ENV says production; the identity var is EXPLICITLY unset
    // (hermetic against ambient env - round 2). Mode resolution fails closed
    // to production, and the guard must follow it - a guard reading the
    // identity var alone would miss this (mutation gap from review round 1).
    vi.stubEnv('LETTER_IRL_DEPLOYMENT_ENVIRONMENT', '');
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => getProviderByName('dummy')).toThrow(/not allowed in production/);
  });

  it('refuses the dummy provider when only the identity label says production', () => {
    // NODE_ENV stays "test" (vitest); identity alone must be enough - a guard
    // reading NODE_ENV alone would miss this (the other half of the same
    // mutation gap).
    vi.stubEnv('LETTER_IRL_DEPLOYMENT_ENVIRONMENT', 'production');
    expect(() => getProviderByName('dummy')).toThrow(/not allowed in production/);
  });

  it('really clears the by-name cache on reset, not just the default cache', () => {
    // Review round 1: the previous version of this test passed through the
    // dummy guard's short-circuit, which runs before the cache lookup, so
    // deleting the clear() survived it. This version pins the cache itself:
    // postgrid built while a key existed must not survive a reset into an
    // environment without one.
    stubDevelopment();
    vi.stubEnv('POSTGRID_API_KEY', 'test_sk_unit_fixture');
    expect(getProviderByName('postgrid').config.name).toBe('postgrid');

    resetProvider();
    vi.stubEnv('POSTGRID_API_KEY', '');
    // Fresh construction now fails (no key) and development falls back to the
    // default provider - proof the cached postgrid instance is gone.
    expect(getProviderByName('postgrid').config.name).toBe('dummy');
  });
});
