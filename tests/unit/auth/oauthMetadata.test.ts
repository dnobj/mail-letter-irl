/**
 * Unit tests for OAuth Metadata Endpoints
 *
 * Tests the Protected Resource Metadata (RFC 9470) and
 * OAuth Authorization Server Metadata for spec compliance.
 *
 * Related: OpenAI Apps SDK submission requirements
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockIssuer = 'https://dev-test.auth0.com/';
const mockAuthEndpoint = 'https://dev-test.auth0.com/authorize';
const mockTokenEndpoint = 'https://dev-test.auth0.com/oauth/token';
const mockJwksUri = 'https://dev-test.auth0.com/.well-known/jwks.json';
const mockRegistrationEndpoint = 'https://dev-test.auth0.com/oidc/register';
const mockScopes = 'openid email profile';
const mockBaseUrl = 'https://api.letterirl.com';

describe('Protected Resource Metadata (RFC 9470)', () => {
  beforeEach(() => {
    vi.stubEnv('LETTER_IRL_OAUTH_ISSUER', mockIssuer);
    vi.stubEnv('LETTER_IRL_OAUTH_AUTH_ENDPOINT', mockAuthEndpoint);
    vi.stubEnv('LETTER_IRL_OAUTH_TOKEN_ENDPOINT', mockTokenEndpoint);
    vi.stubEnv('LETTER_IRL_OAUTH_JWKS_URI', mockJwksUri);
    vi.stubEnv('LETTER_IRL_OAUTH_REGISTRATION_ENDPOINT', mockRegistrationEndpoint);
    vi.stubEnv('LETTER_IRL_OAUTH_SCOPES', mockScopes);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('should return resource field matching baseUrl', async () => {
    const { getProtectedResourceMetadata } = await import('../../../src/auth/metadata.js');
    const metadata = getProtectedResourceMetadata(mockBaseUrl);

    expect(metadata.resource).toBe(mockBaseUrl);
  });

  it('should return authorization_servers array containing issuer', async () => {
    const { getProtectedResourceMetadata } = await import('../../../src/auth/metadata.js');
    const metadata = getProtectedResourceMetadata(mockBaseUrl);

    expect(metadata.authorization_servers).toBeInstanceOf(Array);
    expect(metadata.authorization_servers).toContain(mockIssuer);
  });

  it('should return scopes_supported array', async () => {
    const { getProtectedResourceMetadata } = await import('../../../src/auth/metadata.js');
    const metadata = getProtectedResourceMetadata(mockBaseUrl);

    expect(metadata.scopes_supported).toBeInstanceOf(Array);
    expect(metadata.scopes_supported).toContain('openid');
    expect(metadata.scopes_supported).toContain('email');
    expect(metadata.scopes_supported).toContain('profile');
  });

  it('should return jwks_uri', async () => {
    const { getProtectedResourceMetadata } = await import('../../../src/auth/metadata.js');
    const metadata = getProtectedResourceMetadata(mockBaseUrl);

    expect(metadata.jwks_uri).toBe(mockJwksUri);
  });

  it('should NOT return legacy fields (issuer, resource_documentation)', async () => {
    const { getProtectedResourceMetadata } = await import('../../../src/auth/metadata.js');
    const metadata = getProtectedResourceMetadata(mockBaseUrl) as Record<string, unknown>;

    expect(metadata).not.toHaveProperty('issuer');
    expect(metadata).not.toHaveProperty('resource_documentation');
  });
});

describe('OAuth Authorization Server Metadata', () => {
  beforeEach(() => {
    vi.stubEnv('LETTER_IRL_OAUTH_ISSUER', mockIssuer);
    vi.stubEnv('LETTER_IRL_OAUTH_AUTH_ENDPOINT', mockAuthEndpoint);
    vi.stubEnv('LETTER_IRL_OAUTH_TOKEN_ENDPOINT', mockTokenEndpoint);
    vi.stubEnv('LETTER_IRL_OAUTH_JWKS_URI', mockJwksUri);
    vi.stubEnv('LETTER_IRL_OAUTH_REGISTRATION_ENDPOINT', mockRegistrationEndpoint);
    vi.stubEnv('LETTER_IRL_OAUTH_SCOPES', mockScopes);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('should include S256 in code_challenge_methods_supported', async () => {
    const { getOpenIdConfiguration } = await import('../../../src/auth/metadata.js');
    const metadata = getOpenIdConfiguration(mockBaseUrl);

    expect(metadata.code_challenge_methods_supported).toContain('S256');
  });

  it('should include "none" in token_endpoint_auth_methods_supported', async () => {
    const { getOpenIdConfiguration } = await import('../../../src/auth/metadata.js');
    const metadata = getOpenIdConfiguration(mockBaseUrl);

    expect(metadata.token_endpoint_auth_methods_supported).toContain('none');
  });

  it('should include "refresh_token" in grant_types_supported', async () => {
    const { getOpenIdConfiguration } = await import('../../../src/auth/metadata.js');
    const metadata = getOpenIdConfiguration(mockBaseUrl);

    expect(metadata.grant_types_supported).toContain('refresh_token');
    expect(metadata.grant_types_supported).toContain('authorization_code');
  });

  it('should include registration_endpoint pointing to server /oauth/register', async () => {
    const { getOpenIdConfiguration } = await import('../../../src/auth/metadata.js');
    const metadata = getOpenIdConfiguration(mockBaseUrl);

    expect(metadata.registration_endpoint).toBe(`${mockBaseUrl}/oauth/register`);
  });

  it('should include all required redirect URIs', async () => {
    const { getOpenIdConfiguration } = await import('../../../src/auth/metadata.js');
    const metadata = getOpenIdConfiguration(mockBaseUrl);

    expect(metadata.redirect_uris_supported).toContain('https://chat.openai.com/aip/auth/callback');
    expect(metadata.redirect_uris_supported).toContain('https://chatgpt.com/connector_platform_oauth_redirect');
    expect(metadata.redirect_uris_supported).toContain('https://platform.openai.com/apps-manage/oauth');
    expect(metadata.redirect_uris_supported).toContain('http://localhost:18883/oauth/callback');
  });
});

describe('Discovery Metadata Consistency', () => {
  beforeEach(() => {
    vi.stubEnv('LETTER_IRL_OAUTH_ISSUER', mockIssuer);
    vi.stubEnv('LETTER_IRL_OAUTH_AUTH_ENDPOINT', mockAuthEndpoint);
    vi.stubEnv('LETTER_IRL_OAUTH_TOKEN_ENDPOINT', mockTokenEndpoint);
    vi.stubEnv('LETTER_IRL_OAUTH_JWKS_URI', mockJwksUri);
    vi.stubEnv('LETTER_IRL_OAUTH_REGISTRATION_ENDPOINT', mockRegistrationEndpoint);
    vi.stubEnv('LETTER_IRL_OAUTH_SCOPES', mockScopes);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('should have grant_types that match DCR response grant_types', async () => {
    const { getOpenIdConfiguration } = await import('../../../src/auth/metadata.js');
    const metadata = getOpenIdConfiguration(mockBaseUrl);

    // DCR response returns grant_types: ["authorization_code", "refresh_token"]
    const dcrGrantTypes = ['authorization_code', 'refresh_token'];

    for (const grantType of dcrGrantTypes) {
      expect(metadata.grant_types_supported).toContain(grantType);
    }
  });

  it('should have auth methods that include DCR client method ("none")', async () => {
    const { getOpenIdConfiguration } = await import('../../../src/auth/metadata.js');
    const metadata = getOpenIdConfiguration(mockBaseUrl);

    // DCR response returns token_endpoint_auth_method: "none"
    expect(metadata.token_endpoint_auth_methods_supported).toContain('none');
  });
});
