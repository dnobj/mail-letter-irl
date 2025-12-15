/**
 * Test fixtures for Personal Access Tokens
 *
 * Based on user stories US-9.1, US-9.2, US-9.3 from docs/USER-STORIES.md
 * Used by personas Morgan and Jordan from docs/PERSONAS.md
 */

import { testUsers } from './users.js';

// Token prefix as defined in US-9.1
export const TOKEN_PREFIX = 'lirl_pat_';

// Example raw tokens (what the user sees)
export const testTokens = {
  // Morgan's active token
  morganToken: {
    raw: 'lirl_pat_abc123def456ghi789jkl012mno345',
    name: 'Claude Desktop',
    user_id: testUsers.morgan.user_id,
  },

  // Jordan's tokens (has multiple for different agents)
  jordanToken1: {
    raw: 'lirl_pat_xyz789abc123def456ghi789jkl012',
    name: 'Customer Follow-up Agent',
    user_id: testUsers.jordan.user_id,
  },

  jordanToken2: {
    raw: 'lirl_pat_pqr456stu789vwx012yza345bcd678',
    name: 'Thank You Note Agent',
    user_id: testUsers.jordan.user_id,
  },

  // Revoked token
  revokedToken: {
    raw: 'lirl_pat_revoked123abc456def789ghi012',
    name: 'Old Token',
    user_id: testUsers.morgan.user_id,
  },

  // Expired token
  expiredToken: {
    raw: 'lirl_pat_expired123abc456def789ghi012',
    name: 'Expired Token',
    user_id: testUsers.morgan.user_id,
  },

  // Invalid format token
  invalidToken: {
    raw: 'invalid_token_without_prefix',
    name: 'Invalid',
    user_id: 'invalid',
  },
};

// Database row format for personal_access_tokens table
export interface TokenRow {
  token_id: number;
  user_id: string;
  name: string;
  token_hash: string;
  token_prefix: string;  // Last 4 chars for identification
  status: 'active' | 'revoked';
  expires_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
  revoked_at: Date | null;
}

/**
 * Create a token database row
 */
export function createTokenRow(
  tokenId: number,
  userId: string,
  name: string,
  options: {
    status?: 'active' | 'revoked';
    expiresAt?: Date | null;
    lastUsedAt?: Date | null;
    createdDaysAgo?: number;
    revokedAt?: Date | null;
  } = {}
): TokenRow {
  const createdAt = options.createdDaysAgo
    ? new Date(Date.now() - options.createdDaysAgo * 24 * 60 * 60 * 1000)
    : new Date();

  return {
    token_id: tokenId,
    user_id: userId,
    name,
    token_hash: `$2b$10$mock_hash_for_token_${tokenId}`,
    token_prefix: 'o345', // Last 4 chars
    status: options.status ?? 'active',
    expires_at: options.expiresAt ?? null,
    last_used_at: options.lastUsedAt ?? null,
    created_at: createdAt,
    revoked_at: options.revokedAt ?? null,
  };
}

/**
 * Create Morgan's token rows
 */
export function createMorganTokens(): TokenRow[] {
  return [
    createTokenRow(1, testUsers.morgan.user_id, 'Claude Desktop', {
      lastUsedAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 hours ago
    }),
  ];
}

/**
 * Create Jordan's token rows (multiple tokens for different agents)
 */
export function createJordanTokens(): TokenRow[] {
  return [
    createTokenRow(2, testUsers.jordan.user_id, 'Customer Follow-up Agent', {
      lastUsedAt: new Date(Date.now() - 30 * 60 * 1000), // 30 mins ago
    }),
    createTokenRow(3, testUsers.jordan.user_id, 'Thank You Note Agent', {
      lastUsedAt: new Date(Date.now() - 24 * 60 * 60 * 1000), // 1 day ago
    }),
  ];
}

/**
 * Create a revoked token row
 */
export function createRevokedToken(): TokenRow {
  return createTokenRow(4, testUsers.morgan.user_id, 'Old Token', {
    status: 'revoked',
    revokedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // Revoked 7 days ago
    createdDaysAgo: 30,
  });
}

/**
 * Create an expired token row
 */
export function createExpiredToken(): TokenRow {
  return createTokenRow(5, testUsers.morgan.user_id, 'Expired Token', {
    expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000), // Expired 1 day ago
    createdDaysAgo: 90,
  });
}

/**
 * Helper to generate a valid token string
 */
export function generateTestToken(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let body = '';
  for (let i = 0; i < 32; i++) {
    body += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `${TOKEN_PREFIX}${body}`;
}

/**
 * Check if a string is a valid token format
 */
export function isValidTokenFormat(token: string): boolean {
  if (!token.startsWith(TOKEN_PREFIX)) return false;
  const body = token.slice(TOKEN_PREFIX.length);
  return body.length === 32 && /^[a-z0-9]+$/.test(body);
}
