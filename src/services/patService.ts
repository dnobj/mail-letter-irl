/**
 * Personal Access Token (PAT) Service
 *
 * Manages Personal Access Tokens for MCP client authentication.
 * Tokens allow non-ChatGPT MCP clients to authenticate without OAuth flows.
 *
 * User Stories:
 * - US-MCP-01: Generate Personal Access Token
 * - US-MCP-02: Revoke Personal Access Token
 * - US-MCP-03: Authenticate via Personal Access Token
 *
 * Security:
 * - Tokens are bcrypt hashed before storage
 * - Raw tokens are shown once at creation, never stored
 * - Token prefix (last 4 chars) stored for UI identification
 * - Every new token expires: 90 days by default, 365 at most
 */

import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { query } from '../db/index.js';
import { writeDiagnostic } from '../utils/diagnosticLog.js';
import type {
  PersonalAccessToken,
  CreateTokenResult,
  TokenInfo,
  ValidateTokenResult,
  RevokeTokenResult,
} from './types.js';

// ============================================================================
// Constants
// ============================================================================

export const TOKEN_PREFIX = 'lirl_pat_';
const TOKEN_BODY_LENGTH = 32;
const BCRYPT_ROUNDS = 10;

/** Lifetime of a token created without an explicit expiry. */
export const DEFAULT_TOKEN_LIFETIME_DAYS = 90;
/** The longest lifetime a caller may ask for. */
export const MAX_TOKEN_LIFETIME_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

// ============================================================================
// Token Format Validation
// ============================================================================

/**
 * Check if a token string has valid format (without DB lookup)
 */
export function isValidTokenFormat(token: string): boolean {
  if (!token.startsWith(TOKEN_PREFIX)) {
    return false;
  }
  const body = token.slice(TOKEN_PREFIX.length);
  return body.length === TOKEN_BODY_LENGTH && /^[a-z0-9]+$/.test(body);
}

// ============================================================================
// Token Generation (Private)
// ============================================================================

/**
 * Generate cryptographically secure token body
 * Uses only lowercase alphanumeric for URL-safe tokens
 */
function generateTokenBody(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(TOKEN_BODY_LENGTH);
  let result = '';
  for (let i = 0; i < TOKEN_BODY_LENGTH; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

// ============================================================================
// Token Expiry
// ============================================================================

/**
 * A requested expiry the service refuses. The message names the rule the
 * request broke, so it is safe to return to the caller.
 */
export class TokenExpiryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenExpiryError';
  }
}

/**
 * The expiry to store for a new token (audit A-02). A token that never expires
 * stays valid long after the client it was made for is gone, so none is issued
 * any more: no requested expiry means the default, and a requested one must be
 * in the future and within the maximum. Tokens created before this rule keep
 * whatever expiry they were stored with, which may be none.
 */
export function resolveTokenExpiry(requested: Date | undefined, now: Date = new Date()): Date {
  if (requested === undefined) {
    return new Date(now.getTime() + DEFAULT_TOKEN_LIFETIME_DAYS * DAY_MS);
  }
  if (Number.isNaN(requested.getTime())) {
    throw new TokenExpiryError('Token expiry is not a valid date');
  }
  if (requested.getTime() <= now.getTime()) {
    throw new TokenExpiryError('Token expiry must be in the future');
  }
  if (requested.getTime() > now.getTime() + MAX_TOKEN_LIFETIME_DAYS * DAY_MS) {
    throw new TokenExpiryError(`Token expiry must be within ${MAX_TOKEN_LIFETIME_DAYS} days`);
  }
  return requested;
}

// ============================================================================
// US-MCP-01: Create Token
// ============================================================================

/**
 * Create a new Personal Access Token for a user
 *
 * @param userId - The user ID to create token for
 * @param name - Human-readable name for the token (1-100 chars)
 * @param options - Optional expiration date; see resolveTokenExpiry
 * @returns The raw token (shown once), token ID, name, and expiration
 * @throws TokenExpiryError when the requested expiry is refused
 */
export async function createToken(
  userId: string,
  name: string,
  options?: { expiresAt?: Date }
): Promise<CreateTokenResult> {
  // Validate name length
  if (!name || name.length < 1 || name.length > 100) {
    throw new Error('Token name must be between 1 and 100 characters');
  }

  // Refuse a bad expiry before touching the database
  const expiresAt = resolveTokenExpiry(options?.expiresAt);

  // Verify user exists
  const userCheck = await query<{ user_id: string }>(
    'SELECT user_id FROM users WHERE user_id = $1',
    [userId]
  );
  if (userCheck.rows.length === 0) {
    throw new Error('User not found');
  }

  // Generate token
  const tokenBody = generateTokenBody();
  const rawToken = `${TOKEN_PREFIX}${tokenBody}`;
  const tokenPrefix = tokenBody.slice(-4); // Last 4 chars for display

  // Hash token for storage
  const tokenHash = await bcrypt.hash(rawToken, BCRYPT_ROUNDS);

  // Insert into database
  const result = await query<PersonalAccessToken>(
    `INSERT INTO personal_access_tokens (user_id, name, token_hash, token_prefix, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING token_id, name, expires_at`,
    [userId, name, tokenHash, tokenPrefix, expiresAt]
  );

  const row = result.rows[0];

  writeDiagnostic('info', 'auth.pat_created');

  return {
    token: rawToken,
    tokenId: row.token_id,
    name: row.name,
    expiresAt: row.expires_at,
  };
}

// ============================================================================
// US-MCP-02: Revoke Token
// ============================================================================

/**
 * Revoke a Personal Access Token
 *
 * @param userId - The user ID (must own the token)
 * @param tokenId - The token ID to revoke
 * @returns Success status and whether it was already revoked
 */
export async function revokeToken(
  userId: string,
  tokenId: number
): Promise<RevokeTokenResult> {
  // First check if token exists and belongs to user
  const checkResult = await query<PersonalAccessToken>(
    'SELECT token_id, status FROM personal_access_tokens WHERE token_id = $1 AND user_id = $2',
    [tokenId, userId]
  );

  if (checkResult.rows.length === 0) {
    throw new Error('Token not found or not owned by user');
  }

  const token = checkResult.rows[0];

  // Idempotent: if already revoked, return success
  if (token.status === 'revoked') {
    writeDiagnostic('info', 'auth.pat_already_revoked');
    return { success: true, alreadyRevoked: true };
  }

  // Revoke the token
  await query(
    `UPDATE personal_access_tokens
     SET status = 'revoked', revoked_at = NOW()
     WHERE token_id = $1`,
    [tokenId]
  );

  writeDiagnostic('info', 'auth.pat_revoked');

  return { success: true, alreadyRevoked: false };
}

// ============================================================================
// List Tokens (Supporting US-MCP-02)
// ============================================================================

/**
 * List all tokens for a user
 *
 * @param userId - The user ID
 * @param options - Optional: include revoked tokens
 * @returns Array of token info (without sensitive hash)
 */
export async function listTokens(
  userId: string,
  options?: { includeRevoked?: boolean }
): Promise<TokenInfo[]> {
  const whereClause = options?.includeRevoked
    ? 'WHERE user_id = $1'
    : "WHERE user_id = $1 AND status = 'active'";

  const result = await query<PersonalAccessToken>(
    `SELECT token_id, name, token_prefix, status, expires_at, last_used_at, created_at
     FROM personal_access_tokens
     ${whereClause}
     ORDER BY created_at DESC`,
    [userId]
  );

  return result.rows.map((row) => ({
    tokenId: row.token_id,
    name: row.name,
    tokenPrefix: row.token_prefix,
    status: row.status,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  }));
}

// ============================================================================
// US-MCP-03: Validate Token
// ============================================================================

/**
 * Validate a raw token and return user info
 *
 * @param rawToken - The full raw token string
 * @returns Validation result with userId if valid
 */
export async function validateToken(rawToken: string): Promise<ValidateTokenResult> {
  // Check format first (fast rejection)
  if (!isValidTokenFormat(rawToken)) {
    return { valid: false, error: 'Invalid token format' };
  }

  // Extract prefix for efficient lookup
  const tokenBody = rawToken.slice(TOKEN_PREFIX.length);
  const tokenPrefix = tokenBody.slice(-4);

  // Find active tokens with matching prefix
  const result = await query<PersonalAccessToken>(
    `SELECT token_id, user_id, token_hash, status, expires_at
     FROM personal_access_tokens
     WHERE token_prefix = $1 AND status = 'active'`,
    [tokenPrefix]
  );

  if (result.rows.length === 0) {
    return { valid: false, error: 'Token not found' };
  }

  // Check each matching token (usually just one, but prefix could theoretically collide)
  for (const token of result.rows) {
    // Check expiration
    if (token.expires_at && new Date(token.expires_at) < new Date()) {
      continue; // Try next token if expired
    }

    // Verify hash
    const isMatch = await bcrypt.compare(rawToken, token.token_hash);
    if (isMatch) {
      return {
        valid: true,
        userId: token.user_id,
        tokenId: token.token_id,
      };
    }
  }

  // Check if any tokens with this prefix are revoked
  const revokedCheck = await query<PersonalAccessToken>(
    `SELECT token_id FROM personal_access_tokens
     WHERE token_prefix = $1 AND status = 'revoked'`,
    [tokenPrefix]
  );

  if (revokedCheck.rows.length > 0) {
    return { valid: false, error: 'Token has been revoked' };
  }

  // Check if any tokens with this prefix are expired
  const expiredCheck = await query<PersonalAccessToken>(
    `SELECT token_id FROM personal_access_tokens
     WHERE token_prefix = $1 AND expires_at IS NOT NULL AND expires_at < NOW()`,
    [tokenPrefix]
  );

  if (expiredCheck.rows.length > 0) {
    return { valid: false, error: 'Token has expired' };
  }

  return { valid: false, error: 'Token not found' };
}

// ============================================================================
// Update Last Used (Supporting US-MCP-03)
// ============================================================================

/**
 * Update the last_used_at timestamp for a token
 * Called after successful validation
 *
 * @param tokenId - The token ID to update
 */
export async function updateLastUsed(tokenId: number): Promise<{ success: boolean }> {
  await query(
    'UPDATE personal_access_tokens SET last_used_at = NOW() WHERE token_id = $1',
    [tokenId]
  );
  return { success: true };
}

// ============================================================================
// Admin Analytics (US-MCP-05)
// ============================================================================

/**
 * Get PAT usage statistics for admin dashboard
 */
export async function getTokenStats(): Promise<{
  total: number;
  active: number;
  revoked: number;
  usedToday: number;
  usedLast7Days: number;
}> {
  const [totalResult, activeResult, revokedResult, usageResult] = await Promise.all([
    query<{ count: string }>('SELECT COUNT(*) as count FROM personal_access_tokens'),
    query<{ count: string }>(
      "SELECT COUNT(*) as count FROM personal_access_tokens WHERE status = 'active'"
    ),
    query<{ count: string }>(
      "SELECT COUNT(*) as count FROM personal_access_tokens WHERE status = 'revoked'"
    ),
    query<{ used_today: string; used_7d: string }>(
      `SELECT
        COUNT(*) FILTER (WHERE last_used_at >= NOW() - INTERVAL '1 day') as used_today,
        COUNT(*) FILTER (WHERE last_used_at >= NOW() - INTERVAL '7 days') as used_7d
       FROM personal_access_tokens
       WHERE status = 'active'`
    ),
  ]);

  return {
    total: parseInt(totalResult.rows[0].count, 10),
    active: parseInt(activeResult.rows[0].count, 10),
    revoked: parseInt(revokedResult.rows[0].count, 10),
    usedToday: parseInt(usageResult.rows[0].used_today || '0', 10),
    usedLast7Days: parseInt(usageResult.rows[0].used_7d || '0', 10),
  };
}
