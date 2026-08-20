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

  it('does not serve production a provider cached before the environment changed', () => {
    stubDevelopment();
    expect(getProviderByName('dummy').config.name).toBe('dummy');

    resetProvider(); // must clear the by-name cache, not only the default cache
    stubProduction();
    expect(() => getProviderByName('dummy')).toThrow(/not allowed in production/);
  });
});
