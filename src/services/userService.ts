/**
 * User Service
 *
 * Handles user account CRUD operations
 */

import type pg from 'pg';
import { query } from '../db/index.js';
import { User, CreateUserParams } from './types.js';
import { writeDiagnostic } from '../utils/diagnosticLog.js';
import { VerifiedEmailRequiredError } from '../auth/verifiedEmail.js';

/**
 * The name PostgreSQL gives the inline UNIQUE on users.email
 * (db/migrations/001_initial_schema.sql:7). Asserted against a real database
 * in tests/integration/accountIdentity.postgres.test.ts, because a mocked
 * client will happily agree with whatever name is written here.
 */
const EMAIL_UNIQUE_CONSTRAINT = 'users_email_key';

/**
 * No instruction to "sign in the way you did the first time": after Auth0
 * links two identities, the sign-in they used the first time may no longer
 * exist as a separate login, so that advice can be impossible to follow. The
 * only reliable route is an operator joining the two accounts.
 */
export const EMAIL_ALREADY_LINKED_MESSAGE =
  'That email address already belongs to a Letter IRL account opened with a ' +
  'different sign-in method. Email support@letterirl.com from that address and ' +
  'we will join the two.';

/**
 * One address, two Auth0 subjects.
 *
 * Auth0 mints a subject per sign-in method, so the same person arriving by
 * Google and by password is two subjects presenting one address - and
 * users.email is UNIQUE. Until this existed the INSERT raised a bare 23505,
 * prepareAuthenticatedUser's caller swallowed it, and the customer was left
 * with no account row at all: balance 0, address saves that matched nothing,
 * and a draft that died on a foreign key.
 *
 * 409, not 403: nothing is wrong with the credentials and re-authorizing
 * cannot help - two accounts want one address, and only an operator can join
 * them. The Auth0 post-login Action is what should prevent this from ever
 * being reached, by linking the two identities before the second one asks for
 * an account; this is what happens when it does not, and it is raised ONLY for
 * a subject that has no account of its own (src/auth/identity.ts).
 */
export class EmailAlreadyLinkedError extends Error {
  readonly statusCode = 409;

  constructor() {
    super(EMAIL_ALREADY_LINKED_MESSAGE);
    this.name = 'EmailAlreadyLinkedError';
  }
}

/** Name the collision, or pass the failure along untouched. */
function rethrowEmailCollision(error: unknown): never {
  const pgError = error as { code?: string; constraint?: string };
  if (pgError?.code === '23505' && pgError.constraint === EMAIL_UNIQUE_CONSTRAINT) {
    writeDiagnostic('warn', 'identity.email_already_linked');
    throw new EmailAlreadyLinkedError();
  }
  throw error;
}

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
    throw new Error('User not found');
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

  // DO NOTHING, because a first arrival is not one request. Authentication
  // opens the account row, and a dashboard load authenticates several times at
  // once: a plain INSERT hands every request but one a 23505 on users_pkey,
  // which is not the email collision below and so reached the customer as
  // "the account could not be read" on most of the page.
  //
  // It conflicts on the primary key only, so an address another subject holds
  // still raises, and is still named.
  let result;
  try {
    result = await query<User>(
      `INSERT INTO users (user_id, email, credits, credits_purchased, credits_used)
       VALUES ($1, $2, 0, 0, 0)
       ON CONFLICT (user_id) DO NOTHING
       RETURNING *`,
      [userId, email]
    );
  } catch (error) {
    rethrowEmailCollision(error);
  }

  if (result.rows.length > 0) {
    writeDiagnostic('info', 'identity.user_created');
    return result.rows[0];
  }

  // The race's loser: the row is there, committed by whoever won.
  const existing = await findUser(userId);
  if (!existing) {
    throw new Error('User not found');
  }
  return existing;
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
      return await updateUserEmail(userId, email);
    }
    return existing;
  }

  // Create new user
  return await createUser({ userId, email });
}

/**
 * The account row a user-scoped write needs, inside the caller's transaction.
 *
 * Four call sites - two credit grants, a promo redemption and a gift
 * redemption - used to open an account from `${userId}@unknown.com` whenever
 * no address had reached them. The row that produced is a real account with a
 * fake address: invisible to every per-email rule we have, unreachable by the
 * admin panel's email lookup, and unmergeable later because nobody can tell
 * whose it is. One walked straight through the gift "you cannot redeem your
 * own code" check on 2026-09-18.
 *
 * So there is no longer an address of last resort. With one, the account is
 * opened or credited; without one, the account must ALREADY EXIST - which is
 * the ordinary case for a personal access token, a Stripe webhook and an
 * operator adjustment, all of which act on an account somebody already opened.
 * Nothing else may open one.
 *
 * `credits` is added on top of whatever is there, matching what every one of
 * those call sites did; `countAsPurchased` additionally moves the lifetime
 * purchased total, which only the two credit grants do.
 */
export async function ensureAccountRowWithClient(
  client: Pick<pg.PoolClient, 'query'>,
  params: {
    userId: string;
    email?: string | null;
    credits?: number;
    countAsPurchased?: boolean;
  }
): Promise<User> {
  const credits = params.credits ?? 0;
  const purchased = params.countAsPurchased ? credits : 0;
  const email = typeof params.email === 'string' ? params.email.trim() : '';

  if (credits === 0 && purchased === 0) {
    // A gift redemption adds no credits, and this is the statement it used to
    // run: an INSERT that does nothing when the row is there. Writing an
    // UPDATE instead would move users.updated_at, which the admin panel reads
    // as an account's optimistic version - so every gift redemption would
    // stale an operator's open preview.
    if (email) {
      await client
        .query(
          `INSERT INTO users (user_id, email, credits, credits_purchased, credits_used)
           VALUES ($1, $2, 0, 0, 0)
           ON CONFLICT (user_id) DO NOTHING`,
          [params.userId, email]
        )
        .catch(rethrowEmailCollision);
    }
    const found = await client.query<User>('SELECT * FROM users WHERE user_id = $1', [
      params.userId
    ]);
    if (found.rows.length === 0) {
      throw new VerifiedEmailRequiredError();
    }
    return found.rows[0];
  }

  if (email) {
    const opened = await client
      .query<User>(
        `INSERT INTO users (user_id, email, credits, credits_purchased, credits_used)
         VALUES ($1, $2, $3, $4, 0)
         ON CONFLICT (user_id) DO UPDATE
         SET credits = users.credits + $3,
             credits_purchased = users.credits_purchased + $4,
             updated_at = NOW()
         RETURNING *`,
        [params.userId, email, credits, purchased]
      )
      .catch(rethrowEmailCollision);
    return opened.rows[0];
  }

  const existing = await client.query<User>(
    `UPDATE users
        SET credits = credits + $2,
            credits_purchased = credits_purchased + $3,
            updated_at = NOW()
      WHERE user_id = $1
      RETURNING *`,
    [params.userId, credits, purchased]
  );
  if (existing.rows.length === 0) {
    throw new VerifiedEmailRequiredError();
  }
  return existing.rows[0];
}

/**
 * Update user email
 */
export async function updateUserEmail(userId: string, email: string): Promise<User> {
  let result;
  try {
    result = await query<User>(
      `UPDATE users
       SET email = $1, updated_at = NOW()
       WHERE user_id = $2
       RETURNING *`,
      [email, userId]
    );
  } catch (error) {
    // An UPDATE collides on the same key an INSERT does: someone whose
    // address changed to one another subject already holds.
    rethrowEmailCollision(error);
  }

  if (result.rows.length === 0) {
    throw new Error('User not found');
  }

  writeDiagnostic('info', 'identity.email_updated');
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
    total: parseInt(countResult.rows[0].count, 10)
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

  writeDiagnostic('info', 'identity.user_deleted');
}
