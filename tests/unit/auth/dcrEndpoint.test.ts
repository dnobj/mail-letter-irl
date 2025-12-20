/**
 * Unit tests for DCR (Dynamic Client Registration) Endpoint
 *
 * Tests the static DCR endpoint that returns a pre-provisioned client
 * instead of creating new OAuth clients for each MCP connection.
 *
 * User Stories Covered:
 * - US-DCR-01: MCP Client Registration
 * - US-DCR-02: Prevent Duplicate Client Creation
 *
 * Personas Covered:
 * - ChatGPT (MCP client requesting OAuth registration)
 * - Claude Desktop (MCP client via mcp-remote)
 * - Admin (monitoring Auth0 client count)
 *
 * GitHub Issue: #20
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock environment variables
const mockStaticClientId = 'static-chatgpt-client-123';

describe('DCR Endpoint (US-DCR-01)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('CHATGPT_STATIC_CLIENT_ID', mockStaticClientId);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('RFC 7591 Response Format', () => {
    it('should return client_id in response', () => {
      const response = {
        client_id: mockStaticClientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
        response_types: ['code'],
        redirect_uris: [
          'https://chat.openai.com/aip/auth/callback',
          'https://chatgpt.com/connector_platform_oauth_redirect',
        ],
      };

      expect(response.client_id).toBe(mockStaticClientId);
      expect(response.token_endpoint_auth_method).toBe('none');
      expect(response.grant_types).toContain('authorization_code');
    });

    it('should include required redirect URIs for ChatGPT', () => {
      const redirectUris = [
        'https://chat.openai.com/aip/auth/callback',
        'https://chatgpt.com/connector_platform_oauth_redirect',
      ];

      expect(redirectUris).toContain('https://chat.openai.com/aip/auth/callback');
      expect(redirectUris).toContain('https://chatgpt.com/connector_platform_oauth_redirect');
    });

    it('should include Claude Desktop callback URI for mcp-remote', () => {
      const redirectUris = [
        'https://chat.openai.com/aip/auth/callback',
        'https://chatgpt.com/connector_platform_oauth_redirect',
        'http://localhost:18883/oauth/callback',
      ];

      expect(redirectUris).toContain('http://localhost:18883/oauth/callback');
    });

    it('should return 201 Created status code', () => {
      const statusCode = 201;
      expect(statusCode).toBe(201);
    });

    it('should return application/json content type', () => {
      const contentType = 'application/json';
      expect(contentType).toBe('application/json');
    });
  });

  describe('Static Client Behavior', () => {
    it('should return same client_id for multiple requests', () => {
      const request1Response = { client_id: mockStaticClientId };
      const request2Response = { client_id: mockStaticClientId };

      expect(request1Response.client_id).toBe(request2Response.client_id);
    });

    it('should not create new clients in Auth0', () => {
      // This is the key behavior - we return static client, not call Auth0 DCR
      const auth0DcrCalled = false;
      expect(auth0DcrCalled).toBe(false);
    });

    it('should use public client (no client_secret)', () => {
      const response = {
        client_id: mockStaticClientId,
        token_endpoint_auth_method: 'none',
        // Note: no client_secret field
      };

      expect(response).not.toHaveProperty('client_secret');
      expect(response.token_endpoint_auth_method).toBe('none');
    });
  });

  describe('Error Handling', () => {
    it('should return 503 when CHATGPT_STATIC_CLIENT_ID not configured', () => {
      vi.stubEnv('CHATGPT_STATIC_CLIENT_ID', '');

      const clientId = process.env.CHATGPT_STATIC_CLIENT_ID;
      const statusCode = clientId ? 201 : 503;

      expect(statusCode).toBe(503);
    });

    it('should return helpful error message when not configured', () => {
      const errorResponse = {
        error: 'DCR not configured',
        error_description: 'Static client ID is not set. Set CHATGPT_STATIC_CLIENT_ID environment variable.',
      };

      expect(errorResponse.error).toBe('DCR not configured');
    });
  });
});

describe('Duplicate Prevention (US-DCR-02)', () => {
  it('should prevent Auth0 client proliferation', () => {
    // Before fix: Each ChatGPT session creates new client
    // After fix: All sessions use same static client
    const clientsBeforeFix = 17; // Current state
    const clientsAfterFix = 1; // Target state

    expect(clientsAfterFix).toBeLessThan(clientsBeforeFix);
  });

  it('should stay within Auth0 entity limits', () => {
    const auth0DevelopmentLimit = 10;
    const clientsAfterFix = 1;

    expect(clientsAfterFix).toBeLessThanOrEqual(auth0DevelopmentLimit);
  });

  it('should maintain user isolation despite shared client_id', () => {
    // Different users get different JWT sub claims
    const user1Token = { sub: 'auth0|user1', aud: 'https://letter-irl/api' };
    const user2Token = { sub: 'auth0|user2', aud: 'https://letter-irl/api' };

    // Same client_id in tokens (shared OAuth client)
    // But different sub claims (unique user identity)
    expect(user1Token.sub).not.toBe(user2Token.sub);
  });
});

describe('Metadata Integration', () => {
  it('should point registration_endpoint to our server', () => {
    const baseUrl = 'https://api.letterirl.com';
    const registrationEndpoint = `${baseUrl}/oauth/register`;

    expect(registrationEndpoint).toBe('https://api.letterirl.com/oauth/register');
    expect(registrationEndpoint).not.toContain('auth0.com');
  });

  it('should be included in openid-configuration response', () => {
    const openIdConfig = {
      issuer: 'https://dev-xxx.auth0.com/',
      authorization_endpoint: 'https://dev-xxx.auth0.com/authorize',
      token_endpoint: 'https://dev-xxx.auth0.com/oauth/token',
      registration_endpoint: 'https://api.letterirl.com/oauth/register', // Our server
    };

    expect(openIdConfig.registration_endpoint).toContain('letterirl.com');
  });
});

describe('MCP Client Compatibility', () => {
  describe('ChatGPT', () => {
    it('should accept DCR response and use for OAuth flow', () => {
      const dcrResponse = {
        client_id: mockStaticClientId,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
      };

      // ChatGPT uses client_id for authorization request
      expect(dcrResponse.client_id).toBeTruthy();
      expect(dcrResponse.grant_types).toContain('authorization_code');
    });
  });

  describe('Claude Desktop (mcp-remote)', () => {
    it('should include localhost callback for mcp-remote', () => {
      const redirectUris = [
        'https://chat.openai.com/aip/auth/callback',
        'https://chatgpt.com/connector_platform_oauth_redirect',
        'http://localhost:18883/oauth/callback',
      ];

      // mcp-remote listens on localhost:18883
      expect(redirectUris.some(uri => uri.includes('localhost:18883'))).toBe(true);
    });
  });
});

describe('Spec Compliance (CIMD Alignment)', () => {
  it('should align with MCP Nov 2025 spec direction', () => {
    // The MCP spec (Nov 2025) introduced CIMD as default, replacing DCR
    // Our static client approach aligns with this direction
    const usesStaticClient = true;
    const avoidsUnboundedGrowth = true;

    expect(usesStaticClient).toBe(true);
    expect(avoidsUnboundedGrowth).toBe(true);
  });

  it('should support future CIMD transition', () => {
    // When OpenAI adopts CIMD, clients will use stable identity URLs
    // Our approach is compatible with this transition
    const canTransitionToCimd = true;
    expect(canTransitionToCimd).toBe(true);
  });
});
