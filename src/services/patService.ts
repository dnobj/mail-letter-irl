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
 * - A token is found by the SHA-256 of the whole token (059, #730)
 * - Raw tokens are shown once at creation, never stored
 * - Token prefix (last 4 chars) stored for UI identification
 * - Every new token expires: 90 days by default, 365 at most
 */

import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { query } from '../db/index.js';
import { classifyDiagnosticError, writeDiagnostic } from '../utils/diagnosticLog.js';
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

/**
 * How a token is found (#730): the SHA-256 (hex) of the whole token, matched
 * exactly through a unique index (migration 059). A token carries about 165
 * random bits, so the hash cannot be reversed or guessed; no key is needed.
 */
export function tokenLookupHash(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
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
 * in the future and within the maximum. Tokens created before this rule were
 * given one by migration 057 (#730), and the column now refuses a token without.
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
    `INSERT INTO personal_access_tokens (user_id, name, token_hash, token_prefix, expires_at, token_lookup)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING token_id, name, expires_at`,
    [userId, name, tokenHash, tokenPrefix, expiresAt, tokenLookupHash(rawToken)]
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
    `SELECT token_id, name, token_prefix, status, expires_at, last_used_at, created_at, scopes
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
    scopes: Array.isArray(row.scopes) ? row.scopes : [],
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

  // One indexed read by the whole token's hash (#730): what a request sends
  // no longer chooses how many rows are read or bcrypt compares are run.
  const lookup = tokenLookupHash(rawToken);
  const found = await query<PersonalAccessToken>(
    `SELECT token_id, user_id, status, expires_at, scopes
     FROM personal_access_tokens
     WHERE token_lookup = $1`,
    [lookup]
  );
  const token = found.rows[0] ?? (await findTokenMadeBeforeLookup(rawToken, lookup));

  // The reasons only reach the server's log: the MCP and REST answers are
  // fixed words whatever they are (#743).
  if (!token) {
    return { valid: false, error: 'Token not found' };
  }
  if (token.status !== 'active') {
    return { valid: false, error: 'Token has been revoked' };
  }
  // No expiry is refused, not read as never expiring: 057 holds the column
  // NOT NULL, so a NULL could only come from a schema that lost that.
  if (!token.expires_at || new Date(token.expires_at) <= new Date()) {
    return { valid: false, error: 'Token has expired' };
  }

  return {
    valid: true,
    userId: token.user_id,
    tokenId: token.token_id,
    scopes: Array.isArray(token.scopes) ? token.scopes : [],
  };
}

/**
 * A token made before migration 059 has no lookup hash. It is found as tokens
 * were before, by its last four characters and a bcrypt compare, but only
 * among live tokens still without one, and is given its hash on the first
 * match, so from then on it is found by that. A token may be made to last up
 * to MAX_TOKEN_LIFETIME_DAYS, and an older image (during the pre-deploy, or
 * after a rollback across 059) still makes tokens without a hash, so this
 * stays until `SELECT max(expires_at) FROM personal_access_tokens WHERE token_lookup IS NULL` is NULL or past. Until then every miss runs this
 * read too, and compares only against live tokens that have no hash.
 *
 * It reads live tokens only, so a revoked or expired token without a hash is
 * logged as not found rather than as revoked or expired. Callers see the same
 * fixed words either way (#743).
 */
async function findTokenMadeBeforeLookup(
  rawToken: string,
  lookup: string
): Promise<PersonalAccessToken | null> {
  const suffix = rawToken.slice(-4);
  const result = await query<PersonalAccessToken>(
    `SELECT token_id, user_id, token_hash, status, expires_at, scopes
     FROM personal_access_tokens
     WHERE token_prefix = $1 AND token_lookup IS NULL
       AND status = 'active' AND expires_at > NOW()`,
    [suffix]
  );

  for (const token of result.rows) {
    if (await bcrypt.compare(rawToken, token.token_hash)) {
      // Filled once; a second request racing this one finds it already set.
      // Failing to fill it costs only the next request a compare.
      await query(
        `UPDATE personal_access_tokens SET token_lookup = $2
         WHERE token_id = $1 AND token_lookup IS NULL`,
        [token.token_id, lookup]
      ).catch((error) => {
        writeDiagnostic('warn', 'auth.pat_lookup_fill_failed', {
          errorClass: classifyDiagnosticError(error, 'database_error')
        });
      });
      return token;
    }
  }
  return null;
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
