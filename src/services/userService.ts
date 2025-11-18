/**
 * User Service
 *
 * Handles user account CRUD operations
 */

import { query } from '../db/index.js';
import { User, CreateUserParams } from './types.js';

/**
 * Get user by ID
 * @throws Error if user not found
 */
export async function getUser(userId: string): Promise<User> {
  const result = await query<User>(
    'SELECT * FROM users WHERE user_id = $1',
    [userId]
  );

  if (result.rows.length === 0) {
    throw new Error(`User not found: ${userId}`);
  }

  return result.rows[0];
}

/**
 * Get user by ID, returns null if not found (no error)
 */
export async function findUser(userId: string): Promise<User | null> {
  const result = await query<User>(
    'SELECT * FROM users WHERE user_id = $1',
    [userId]
  );

  return result.rows.length > 0 ? result.rows[0] : null;
}

/**
 * Get user by email
 */
export async function getUserByEmail(email: string): Promise<User | null> {
  const result = await query<User>(
    'SELECT * FROM users WHERE email = $1',
    [email]
  );

  return result.rows.length > 0 ? result.rows[0] : null;
}

/**
 * Create new user
 */
export async function createUser(params: CreateUserParams): Promise<User> {
  const { userId, email } = params;

  const result = await query<User>(
    `INSERT INTO users (user_id, email, credits, credits_purchased, credits_used)
     VALUES ($1, $2, 0, 0, 0)
     RETURNING *`,
    [userId, email]
  );

  console.log(`📝 Created new user: ${userId} (${email})`);
  return result.rows[0];
}

/**
 * Get user by ID, create if doesn't exist
 * This is the most commonly used function for user operations
 * Updates email if user exists but email changed
 */
export async function getOrCreateUser(userId: string, email: string): Promise<User> {
  // Try to find existing user
  const existing = await findUser(userId);
  if (existing) {
    // Update email if it changed
    if (existing.email !== email) {
      console.log(`📝 Updating email for ${userId}: ${existing.email} → ${email}`);
      return await updateUserEmail(userId, email);
    }
    return existing;
  }

  // Create new user
  return await createUser({ userId, email });
}

/**
 * Update user email
 */
export async function updateUserEmail(userId: string, email: string): Promise<User> {
  const result = await query<User>(
    `UPDATE users
     SET email = $1, updated_at = NOW()
     WHERE user_id = $2
     RETURNING *`,
    [email, userId]
  );

  if (result.rows.length === 0) {
    throw new Error(`User not found: ${userId}`);
  }

  console.log(`📝 Updated email for ${userId}: ${email}`);
  return result.rows[0];
}

/**
 * Get all users (for admin)
 */
export async function getAllUsers(limit: number = 100, offset: number = 0): Promise<{
  users: User[];
  total: number;
}> {
  const result = await query<User>(
    `SELECT * FROM users
     ORDER BY created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  const countResult = await query<{ count: string }>(
    'SELECT COUNT(*) as count FROM users'
  );

  return {
    users: result.rows,
    total: parseInt(countResult.rows[0].count)
  };
}

/**
 * Delete user (for testing/admin)
 * WARNING: This will cascade delete all user data
 */
export async function deleteUser(userId: string): Promise<void> {
  const result = await query(
    'DELETE FROM users WHERE user_id = $1',
    [userId]
  );

  console.log(`🗑️  Deleted user: ${userId}`);
}
