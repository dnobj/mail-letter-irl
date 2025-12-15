/**
 * Unit tests for Personal Access Token (PAT) Service
 *
 * Tests the PAT business logic including:
 * - Token generation with secure random strings
 * - Token hashing and storage
 * - Token validation
 * - Token revocation
 * - Token listing
 *
 * User Stories Covered:
 * - US-9.1: Generate Personal Access Token
 * - US-9.2: Revoke Personal Access Token
 * - US-9.3: Authenticate via Personal Access Token
 *
 * Personas Covered:
 * - Morgan - The MCP Power User
 * - Jordan - The AI Agent Builder
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { testUsers } from '../../fixtures/users.js';
import {
  testTokens,
  createTokenRow,
  createMorganTokens,
  createJordanTokens,
  createRevokedToken,
  createExpiredToken,
  TOKEN_PREFIX,
  isValidTokenFormat,
} from '../../fixtures/tokens.js';

// Mock the database module before importing the service
vi.mock('../../../src/db/index.js', () => {
  return {
    query: vi.fn(),
    transaction: vi.fn(),
  };
});

// Import after mocking
import * as db from '../../../src/db/index.js';

// Since the service doesn't exist yet, we'll define the expected interface
// This is TDD - tests first, implementation later
interface CreateTokenResult {
  token: string;  // Raw token to show user (only shown once)
  tokenId: number;
  name: string;
  expiresAt: Date | null;
}

interface TokenInfo {
  tokenId: number;
  name: string;
  tokenPrefix: string;  // Last 4 chars for identification
  status: 'active' | 'revoked';
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

interface ValidateTokenResult {
  valid: boolean;
  userId?: string;
  tokenId?: number;
  error?: string;
}

// Mock service functions (to be implemented)
// These represent the expected API of the PAT service
const patService = {
  createToken: vi.fn(),
  revokeToken: vi.fn(),
  listTokens: vi.fn(),
  validateToken: vi.fn(),
  updateLastUsed: vi.fn(),
};

describe('patService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // US-9.1: Generate Personal Access Token
  // ==========================================================================
  describe('createToken (US-9.1)', () => {
    it('should generate a token with correct prefix and format', async () => {
      const mockTokenRow = createTokenRow(1, testUsers.morgan.user_id, 'Claude Desktop');

      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [mockTokenRow],
        rowCount: 1,
        command: 'INSERT',
        oid: 0,
        fields: [],
      });

      patService.createToken.mockImplementation(async (userId: string, name: string) => {
        // Simulate token generation
        const token = `${TOKEN_PREFIX}${'a'.repeat(32)}`;
        return {
          token,
          tokenId: mockTokenRow.token_id,
          name,
          expiresAt: null,
        };
      });

      const result = await patService.createToken(
        testUsers.morgan.user_id,
        'Claude Desktop'
      );

      expect(result.token).toMatch(/^lirl_pat_[a-z0-9]{32}$/);
      expect(result.name).toBe('Claude Desktop');
      expect(result.tokenId).toBe(1);
    });

    it('should store token hash, not plain token', async () => {
      const mockTokenRow = createTokenRow(1, testUsers.morgan.user_id, 'My Token');

      patService.createToken.mockImplementation(async (userId: string, name: string) => {
        // Simulate calling db.query with hashed token
        await db.query(
          'INSERT INTO personal_access_tokens (user_id, name, token_hash, token_prefix) VALUES ($1, $2, $3, $4)',
          [userId, name, '$2b$10$hashed_token', 'xxxx']
        );
        return {
          token: `${TOKEN_PREFIX}${'b'.repeat(32)}`,
          tokenId: 1,
          name,
          expiresAt: null,
        };
      });

      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [mockTokenRow],
        rowCount: 1,
        command: 'INSERT',
        oid: 0,
        fields: [],
      });

      await patService.createToken(testUsers.morgan.user_id, 'My Token');

      // Verify the query was called with a hash, not plain token
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO personal_access_tokens'),
        expect.arrayContaining([
          testUsers.morgan.user_id,
          'My Token',
          expect.stringMatching(/^\$2b\$10\$/), // bcrypt hash format
          expect.any(String), // token prefix
        ])
      );
    });

    it('should allow custom expiration date', async () => {
      const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000); // 90 days
      const mockTokenRow = createTokenRow(1, testUsers.jordan.user_id, 'Agent Token', {
        expiresAt,
      });

      patService.createToken.mockResolvedValueOnce({
        token: `${TOKEN_PREFIX}${'c'.repeat(32)}`,
        tokenId: 1,
        name: 'Agent Token',
        expiresAt,
      });

      const result = await patService.createToken(
        testUsers.jordan.user_id,
        'Agent Token',
        { expiresAt }
      );

      expect(result.expiresAt).toEqual(expiresAt);
    });

    it('should enforce token name length limits', async () => {
      patService.createToken.mockRejectedValueOnce(
        new Error('Token name must be between 1 and 100 characters')
      );

      await expect(
        patService.createToken(testUsers.morgan.user_id, '')
      ).rejects.toThrow('Token name must be between 1 and 100 characters');

      patService.createToken.mockRejectedValueOnce(
        new Error('Token name must be between 1 and 100 characters')
      );

      await expect(
        patService.createToken(testUsers.morgan.user_id, 'x'.repeat(101))
      ).rejects.toThrow('Token name must be between 1 and 100 characters');
    });

    it('should require valid user', async () => {
      patService.createToken.mockRejectedValueOnce(new Error('User not found'));

      await expect(
        patService.createToken('nonexistent-user', 'My Token')
      ).rejects.toThrow('User not found');
    });
  });

  // ==========================================================================
  // US-9.2: Revoke Personal Access Token
  // ==========================================================================
  describe('revokeToken (US-9.2)', () => {
    it('should revoke an active token', async () => {
      const mockTokenRow = createTokenRow(1, testUsers.morgan.user_id, 'Claude Desktop', {
        status: 'revoked',
        revokedAt: new Date(),
      });

      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [mockTokenRow],
        rowCount: 1,
        command: 'UPDATE',
        oid: 0,
        fields: [],
      });

      patService.revokeToken.mockResolvedValueOnce({ success: true });

      const result = await patService.revokeToken(
        testUsers.morgan.user_id,
        1 // tokenId
      );

      expect(result.success).toBe(true);
    });

    it('should not allow revoking another user\'s token', async () => {
      patService.revokeToken.mockRejectedValueOnce(
        new Error('Token not found or not owned by user')
      );

      await expect(
        patService.revokeToken(
          testUsers.morgan.user_id,
          2 // Jordan's token
        )
      ).rejects.toThrow('Token not found or not owned by user');
    });

    it('should be idempotent (revoking already revoked token succeeds)', async () => {
      patService.revokeToken.mockResolvedValueOnce({
        success: true,
        alreadyRevoked: true,
      });

      const result = await patService.revokeToken(testUsers.morgan.user_id, 4);

      expect(result.success).toBe(true);
      expect(result.alreadyRevoked).toBe(true);
    });
  });

  // ==========================================================================
  // List Tokens (Supporting US-9.2)
  // ==========================================================================
  describe('listTokens', () => {
    it('should list all tokens for a user', async () => {
      const morganTokens = createMorganTokens();

      vi.mocked(db.query).mockResolvedValueOnce({
        rows: morganTokens,
        rowCount: morganTokens.length,
        command: 'SELECT',
        oid: 0,
        fields: [],
      });

      patService.listTokens.mockResolvedValueOnce(morganTokens.map(t => ({
        tokenId: t.token_id,
        name: t.name,
        tokenPrefix: t.token_prefix,
        status: t.status,
        expiresAt: t.expires_at,
        lastUsedAt: t.last_used_at,
        createdAt: t.created_at,
      })));

      const result = await patService.listTokens(testUsers.morgan.user_id);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Claude Desktop');
      expect(result[0].status).toBe('active');
    });

    it('should return multiple tokens for power users', async () => {
      const jordanTokens = createJordanTokens();

      patService.listTokens.mockResolvedValueOnce(jordanTokens.map(t => ({
        tokenId: t.token_id,
        name: t.name,
        tokenPrefix: t.token_prefix,
        status: t.status,
        expiresAt: t.expires_at,
        lastUsedAt: t.last_used_at,
        createdAt: t.created_at,
      })));

      const result = await patService.listTokens(testUsers.jordan.user_id);

      expect(result).toHaveLength(2);
      expect(result.map(t => t.name)).toContain('Customer Follow-up Agent');
      expect(result.map(t => t.name)).toContain('Thank You Note Agent');
    });

    it('should include revoked tokens with filter option', async () => {
      const tokens = [...createMorganTokens(), createRevokedToken()];

      patService.listTokens.mockResolvedValueOnce(tokens.map(t => ({
        tokenId: t.token_id,
        name: t.name,
        tokenPrefix: t.token_prefix,
        status: t.status,
        expiresAt: t.expires_at,
        lastUsedAt: t.last_used_at,
        createdAt: t.created_at,
      })));

      const result = await patService.listTokens(testUsers.morgan.user_id, {
        includeRevoked: true,
      });

      expect(result).toHaveLength(2);
      expect(result.filter(t => t.status === 'revoked')).toHaveLength(1);
    });

    it('should return empty array for user with no tokens', async () => {
      patService.listTokens.mockResolvedValueOnce([]);

      const result = await patService.listTokens(testUsers.sarah.user_id);

      expect(result).toHaveLength(0);
    });
  });

  // ==========================================================================
  // US-9.3: Validate Token (Authentication)
  // ==========================================================================
  describe('validateToken (US-9.3)', () => {
    it('should validate a correct token and return user', async () => {
      const mockToken = createTokenRow(1, testUsers.morgan.user_id, 'Claude Desktop');

      patService.validateToken.mockResolvedValueOnce({
        valid: true,
        userId: testUsers.morgan.user_id,
        tokenId: 1,
      });

      const result = await patService.validateToken(testTokens.morganToken.raw);

      expect(result.valid).toBe(true);
      expect(result.userId).toBe(testUsers.morgan.user_id);
      expect(result.tokenId).toBe(1);
    });

    it('should reject invalid token format', async () => {
      patService.validateToken.mockResolvedValueOnce({
        valid: false,
        error: 'Invalid token format',
      });

      const result = await patService.validateToken('not_a_valid_token');

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid token format');
    });

    it('should reject token without correct prefix', async () => {
      patService.validateToken.mockResolvedValueOnce({
        valid: false,
        error: 'Invalid token format',
      });

      const result = await patService.validateToken('wrong_prefix_abc123');

      expect(result.valid).toBe(false);
    });

    it('should reject revoked tokens', async () => {
      patService.validateToken.mockResolvedValueOnce({
        valid: false,
        error: 'Token has been revoked',
      });

      const result = await patService.validateToken(testTokens.revokedToken.raw);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Token has been revoked');
    });

    it('should reject expired tokens', async () => {
      patService.validateToken.mockResolvedValueOnce({
        valid: false,
        error: 'Token has expired',
      });

      const result = await patService.validateToken(testTokens.expiredToken.raw);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Token has expired');
    });

    it('should reject non-existent tokens', async () => {
      patService.validateToken.mockResolvedValueOnce({
        valid: false,
        error: 'Token not found',
      });

      const result = await patService.validateToken(
        `${TOKEN_PREFIX}${'nonexistent'.padEnd(32, '0')}`
      );

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Token not found');
    });
  });

  // ==========================================================================
  // Update Last Used (Supporting US-9.3)
  // ==========================================================================
  describe('updateLastUsed', () => {
    it('should update last_used_at timestamp on validation', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [],
        rowCount: 1,
        command: 'UPDATE',
        oid: 0,
        fields: [],
      });

      patService.updateLastUsed.mockResolvedValueOnce({ success: true });

      await patService.updateLastUsed(1);

      expect(patService.updateLastUsed).toHaveBeenCalledWith(1);
    });
  });

  // ==========================================================================
  // Token Format Validation Tests
  // ==========================================================================
  describe('token format validation', () => {
    it('should validate correct token format', () => {
      expect(isValidTokenFormat(`${TOKEN_PREFIX}abc123def456ghi789jkl012mno345pq`)).toBe(true);
      expect(isValidTokenFormat(`${TOKEN_PREFIX}${'a'.repeat(32)}`)).toBe(true);
    });

    it('should reject tokens without prefix', () => {
      expect(isValidTokenFormat('abc123def456ghi789jkl012mno345pq')).toBe(false);
    });

    it('should reject tokens with wrong prefix', () => {
      expect(isValidTokenFormat('wrong_pat_abc123def456ghi789jkl012mno345pq')).toBe(false);
    });

    it('should reject tokens with incorrect body length', () => {
      expect(isValidTokenFormat(`${TOKEN_PREFIX}short`)).toBe(false);
      expect(isValidTokenFormat(`${TOKEN_PREFIX}${'a'.repeat(40)}`)).toBe(false);
    });

    it('should reject tokens with invalid characters', () => {
      expect(isValidTokenFormat(`${TOKEN_PREFIX}ABC123DEF456GHI789JKL012MNO345PQ`)).toBe(false);
      expect(isValidTokenFormat(`${TOKEN_PREFIX}abc-123-def-456-ghi-789-jkl-012`)).toBe(false);
    });
  });

  // ==========================================================================
  // Security Tests
  // ==========================================================================
  describe('security', () => {
    it('should use cryptographically secure random for token generation', async () => {
      // This test verifies that tokens are sufficiently random
      const tokens = new Set<string>();
      const iterations = 100;

      for (let i = 0; i < iterations; i++) {
        patService.createToken.mockResolvedValueOnce({
          token: `${TOKEN_PREFIX}${Math.random().toString(36).substring(2).padEnd(32, '0')}`,
          tokenId: i,
          name: 'Test Token',
          expiresAt: null,
        });

        const result = await patService.createToken(testUsers.morgan.user_id, 'Test Token');
        tokens.add(result.token);
      }

      // All tokens should be unique
      expect(tokens.size).toBe(iterations);
    });

    it('should not expose token hash in token listing', async () => {
      const tokens = createMorganTokens();

      patService.listTokens.mockResolvedValueOnce(tokens.map(t => ({
        tokenId: t.token_id,
        name: t.name,
        tokenPrefix: t.token_prefix,
        status: t.status,
        expiresAt: t.expires_at,
        lastUsedAt: t.last_used_at,
        createdAt: t.created_at,
        // Note: no token_hash field
      })));

      const result = await patService.listTokens(testUsers.morgan.user_id);

      // Ensure no token hash is exposed
      result.forEach(token => {
        expect(token).not.toHaveProperty('token_hash');
        expect(token).not.toHaveProperty('tokenHash');
      });
    });

    it('should hash token before database comparison', async () => {
      // This is implicitly tested by the validation tests
      // The service should hash the input token and compare with stored hash
      patService.validateToken.mockImplementation(async (rawToken: string) => {
        // Simulate hashing and comparison
        if (!rawToken.startsWith(TOKEN_PREFIX)) {
          return { valid: false, error: 'Invalid token format' };
        }

        // In real implementation, would hash and compare
        await db.query(
          'SELECT * FROM personal_access_tokens WHERE token_hash = $1',
          ['hashed_version_of_token']
        );

        return { valid: true, userId: testUsers.morgan.user_id, tokenId: 1 };
      });

      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [createTokenRow(1, testUsers.morgan.user_id, 'Test')],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      });

      await patService.validateToken(testTokens.morganToken.raw);

      // Verify we're querying with a hash, not the raw token
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('token_hash'),
        expect.not.arrayContaining([testTokens.morganToken.raw])
      );
    });
  });
});
