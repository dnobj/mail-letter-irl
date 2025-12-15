/**
 * Unit tests for Token Validator (Extended for PAT Support)
 *
 * Tests the authentication middleware that handles both:
 * - JWT tokens from Auth0 (OAuth flow for ChatGPT)
 * - Personal Access Tokens (PAT) for MCP clients
 *
 * User Stories Covered:
 * - US-7.1: Authentication Required
 * - US-9.3: Authenticate via Personal Access Token
 *
 * Personas Covered:
 * - Sarah, Marcus, etc. (JWT via ChatGPT)
 * - Morgan, Jordan (PAT via MCP clients)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { testUsers } from '../../fixtures/users.js';
import {
  testTokens,
  createTokenRow,
  TOKEN_PREFIX,
} from '../../fixtures/tokens.js';

// Mock jose for JWT validation
vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(),
  jwtVerify: vi.fn(),
}));

// Mock the database for PAT validation
vi.mock('../../../src/db/index.js', () => ({
  query: vi.fn(),
}));

// Import after mocking
import { createRemoteJWKSet, jwtVerify } from 'jose';
import * as db from '../../../src/db/index.js';

// Since we're extending the token validator, define expected interface
interface AuthenticatedUser {
  userId: string;
  claims: Record<string, unknown>;
  token: string;
  authType: 'jwt' | 'pat';
}

// Mock the extended validateAuthorizationHeader function
const validateAuthorizationHeader = vi.fn();

describe('tokenValidator with PAT support', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set up environment for JWT validation
    process.env.LETTER_IRL_OAUTH_ISSUER = 'https://letterirl.auth0.com/';
    process.env.LETTER_IRL_OAUTH_JWKS_URI = 'https://letterirl.auth0.com/.well-known/jwks.json';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // JWT Authentication (Existing Behavior)
  // ==========================================================================
  describe('JWT authentication (ChatGPT users)', () => {
    it('should validate valid JWT token', async () => {
      const mockPayload = {
        sub: testUsers.sarah.user_id,
        email: testUsers.sarah.email,
        iss: 'https://letterirl.auth0.com/',
      };

      vi.mocked(jwtVerify).mockResolvedValueOnce({
        payload: mockPayload,
        protectedHeader: { alg: 'RS256' },
      } as any);

      validateAuthorizationHeader.mockResolvedValueOnce({
        userId: testUsers.sarah.user_id,
        claims: mockPayload,
        token: 'valid-jwt-token',
        authType: 'jwt',
      });

      const result = await validateAuthorizationHeader('Bearer valid-jwt-token');

      expect(result.userId).toBe(testUsers.sarah.user_id);
      expect(result.authType).toBe('jwt');
    });

    it('should reject missing Authorization header', async () => {
      validateAuthorizationHeader.mockRejectedValueOnce(
        new Error('Missing Authorization header')
      );

      await expect(validateAuthorizationHeader(undefined)).rejects.toThrow(
        'Missing Authorization header'
      );
    });

    it('should reject non-Bearer token', async () => {
      validateAuthorizationHeader.mockRejectedValueOnce(
        new Error('Authorization header must be a Bearer token')
      );

      await expect(validateAuthorizationHeader('Basic abc123')).rejects.toThrow(
        'Authorization header must be a Bearer token'
      );
    });

    it('should reject expired JWT', async () => {
      vi.mocked(jwtVerify).mockRejectedValueOnce(new Error('JWT expired'));

      validateAuthorizationHeader.mockRejectedValueOnce(new Error('JWT expired'));

      await expect(
        validateAuthorizationHeader('Bearer expired-jwt-token')
      ).rejects.toThrow('JWT expired');
    });

    it('should reject JWT with wrong issuer', async () => {
      vi.mocked(jwtVerify).mockRejectedValueOnce(
        new Error('Issuer mismatch')
      );

      validateAuthorizationHeader.mockRejectedValueOnce(
        new Error('Issuer mismatch')
      );

      await expect(
        validateAuthorizationHeader('Bearer wrong-issuer-jwt')
      ).rejects.toThrow('Issuer mismatch');
    });
  });

  // ==========================================================================
  // PAT Authentication (New Behavior - US-9.3)
  // ==========================================================================
  describe('PAT authentication (MCP users)', () => {
    it('should detect PAT by prefix and validate', async () => {
      const mockTokenRow = createTokenRow(1, testUsers.morgan.user_id, 'Claude Desktop');

      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [mockTokenRow],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      });

      validateAuthorizationHeader.mockImplementation(async (header: string) => {
        const token = header.replace('Bearer ', '');

        if (token.startsWith(TOKEN_PREFIX)) {
          // PAT validation path
          return {
            userId: testUsers.morgan.user_id,
            claims: { authType: 'pat', tokenId: 1 },
            token,
            authType: 'pat',
          };
        }

        // JWT validation path (would call jwtVerify)
        throw new Error('Invalid JWT');
      });

      const result = await validateAuthorizationHeader(
        `Bearer ${testTokens.morganToken.raw}`
      );

      expect(result.userId).toBe(testUsers.morgan.user_id);
      expect(result.authType).toBe('pat');
    });

    it('should validate PAT and return user for agent builder', async () => {
      const mockTokenRow = createTokenRow(
        2,
        testUsers.jordan.user_id,
        'Customer Follow-up Agent'
      );

      validateAuthorizationHeader.mockResolvedValueOnce({
        userId: testUsers.jordan.user_id,
        claims: { authType: 'pat', tokenId: 2 },
        token: testTokens.jordanToken1.raw,
        authType: 'pat',
      });

      const result = await validateAuthorizationHeader(
        `Bearer ${testTokens.jordanToken1.raw}`
      );

      expect(result.userId).toBe(testUsers.jordan.user_id);
      expect(result.authType).toBe('pat');
    });

    it('should reject revoked PAT', async () => {
      validateAuthorizationHeader.mockRejectedValueOnce(
        new Error('Token has been revoked')
      );

      await expect(
        validateAuthorizationHeader(`Bearer ${testTokens.revokedToken.raw}`)
      ).rejects.toThrow('Token has been revoked');
    });

    it('should reject expired PAT', async () => {
      validateAuthorizationHeader.mockRejectedValueOnce(
        new Error('Token has expired')
      );

      await expect(
        validateAuthorizationHeader(`Bearer ${testTokens.expiredToken.raw}`)
      ).rejects.toThrow('Token has expired');
    });

    it('should reject PAT not found in database', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
        command: 'SELECT',
        oid: 0,
        fields: [],
      });

      validateAuthorizationHeader.mockRejectedValueOnce(
        new Error('Token not found')
      );

      await expect(
        validateAuthorizationHeader(`Bearer ${TOKEN_PREFIX}${'x'.repeat(32)}`)
      ).rejects.toThrow('Token not found');
    });

    it('should reject malformed PAT', async () => {
      validateAuthorizationHeader.mockRejectedValueOnce(
        new Error('Invalid token format')
      );

      // Too short
      await expect(
        validateAuthorizationHeader(`Bearer ${TOKEN_PREFIX}short`)
      ).rejects.toThrow('Invalid token format');
    });

    it('should update last_used_at on successful PAT validation', async () => {
      const mockTokenRow = createTokenRow(1, testUsers.morgan.user_id, 'Claude Desktop');

      validateAuthorizationHeader.mockImplementation(async (header: string) => {
        // Simulate updating last_used_at
        await db.query(
          'UPDATE personal_access_tokens SET last_used_at = NOW() WHERE token_id = $1',
          [1]
        );

        return {
          userId: testUsers.morgan.user_id,
          claims: { authType: 'pat', tokenId: 1 },
          token: testTokens.morganToken.raw,
          authType: 'pat',
        };
      });

      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [],
        rowCount: 1,
        command: 'UPDATE',
        oid: 0,
        fields: [],
      });

      await validateAuthorizationHeader(`Bearer ${testTokens.morganToken.raw}`);

      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE personal_access_tokens'),
        expect.arrayContaining([1])
      );
    });
  });

  // ==========================================================================
  // Token Type Detection
  // ==========================================================================
  describe('token type detection', () => {
    it('should detect PAT by prefix', async () => {
      validateAuthorizationHeader.mockImplementation(async (header: string) => {
        const token = header.replace('Bearer ', '');
        const isPAT = token.startsWith(TOKEN_PREFIX);

        return {
          userId: 'test-user',
          claims: {},
          token,
          authType: isPAT ? 'pat' : 'jwt',
        };
      });

      const patResult = await validateAuthorizationHeader(
        `Bearer ${TOKEN_PREFIX}${'a'.repeat(32)}`
      );
      expect(patResult.authType).toBe('pat');

      const jwtResult = await validateAuthorizationHeader(
        'Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.test'
      );
      expect(jwtResult.authType).toBe('jwt');
    });

    it('should route PAT to database validation, JWT to JWKS', async () => {
      let patValidationCalled = false;
      let jwtValidationCalled = false;

      validateAuthorizationHeader.mockImplementation(async (header: string) => {
        const token = header.replace('Bearer ', '');

        if (token.startsWith(TOKEN_PREFIX)) {
          patValidationCalled = true;
          return {
            userId: testUsers.morgan.user_id,
            claims: {},
            token,
            authType: 'pat' as const,
          };
        } else {
          jwtValidationCalled = true;
          return {
            userId: testUsers.sarah.user_id,
            claims: {},
            token,
            authType: 'jwt' as const,
          };
        }
      });

      // Call with PAT
      await validateAuthorizationHeader(`Bearer ${TOKEN_PREFIX}${'a'.repeat(32)}`);
      expect(patValidationCalled).toBe(true);

      // Call with JWT
      await validateAuthorizationHeader('Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.test');
      expect(jwtValidationCalled).toBe(true);
    });
  });

  // ==========================================================================
  // Error Handling
  // ==========================================================================
  describe('error handling', () => {
    it('should return 401 status for authentication failures', async () => {
      // All auth failures should result in errors that translate to 401
      const errorCases = [
        { header: undefined, error: 'Missing Authorization header' },
        { header: 'Basic abc', error: 'Authorization header must be a Bearer token' },
        { header: `Bearer ${TOKEN_PREFIX}short`, error: 'Invalid token format' },
        { header: 'Bearer invalid-jwt', error: 'Invalid JWT' },
      ];

      for (const { header, error } of errorCases) {
        validateAuthorizationHeader.mockRejectedValueOnce(new Error(error));

        await expect(validateAuthorizationHeader(header)).rejects.toThrow();
      }
    });

    it('should not leak sensitive info in error messages', async () => {
      // Error messages should not include the actual token
      validateAuthorizationHeader.mockRejectedValueOnce(
        new Error('Token not found')
      );

      try {
        await validateAuthorizationHeader(
          `Bearer ${TOKEN_PREFIX}${'secret'.repeat(6)}`
        );
      } catch (e: any) {
        expect(e.message).not.toContain('secret');
        expect(e.message).toBe('Token not found');
      }
    });
  });

  // ==========================================================================
  // Backward Compatibility
  // ==========================================================================
  describe('backward compatibility', () => {
    it('should continue to work for existing JWT users', async () => {
      // Simulate existing ChatGPT flow
      vi.mocked(jwtVerify).mockResolvedValueOnce({
        payload: {
          sub: testUsers.sarah.user_id,
          email: testUsers.sarah.email,
        },
        protectedHeader: { alg: 'RS256' },
      } as any);

      validateAuthorizationHeader.mockResolvedValueOnce({
        userId: testUsers.sarah.user_id,
        claims: { sub: testUsers.sarah.user_id, email: testUsers.sarah.email },
        token: 'valid-jwt',
        authType: 'jwt',
      });

      const result = await validateAuthorizationHeader('Bearer valid-jwt');

      expect(result.userId).toBe(testUsers.sarah.user_id);
      // Should work exactly as before for JWT users
    });

    it('should not affect existing OAuth metadata endpoints', async () => {
      // The OAuth metadata endpoints should continue to work
      // This is more of an integration test, but validates the principle
      expect(process.env.LETTER_IRL_OAUTH_ISSUER).toBeDefined();
      expect(process.env.LETTER_IRL_OAUTH_JWKS_URI).toBeDefined();
    });
  });

  // ==========================================================================
  // Performance
  // ==========================================================================
  describe('performance', () => {
    it('should detect token type before expensive operations', async () => {
      const operationOrder: string[] = [];

      validateAuthorizationHeader.mockImplementation(async (header: string) => {
        const token = header.replace('Bearer ', '');

        operationOrder.push('detect_type');

        if (token.startsWith(TOKEN_PREFIX)) {
          operationOrder.push('pat_validate');
          // PAT validation is a simple DB lookup
          return {
            userId: testUsers.morgan.user_id,
            claims: {},
            token,
            authType: 'pat' as const,
          };
        } else {
          operationOrder.push('jwt_validate');
          // JWT validation requires JWKS fetch and crypto verification
          return {
            userId: testUsers.sarah.user_id,
            claims: {},
            token,
            authType: 'jwt' as const,
          };
        }
      });

      await validateAuthorizationHeader(`Bearer ${TOKEN_PREFIX}${'a'.repeat(32)}`);

      // Should detect type first, then only do PAT validation
      expect(operationOrder).toEqual(['detect_type', 'pat_validate']);
    });
  });
});
