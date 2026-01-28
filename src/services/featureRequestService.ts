/**
 * Feature Request Service
 *
 * Handles user feature request submissions:
 * - Submit feature requests
 * - Rate limiting (5 requests per user per 24 hours)
 * - Query user's feature requests
 *
 * User Story: US-FEEDBACK-01
 */

import { query } from '../db/index.js';

// Types for feature requests
export type FeatureRequestCategory =
  | 'new_feature'
  | 'improvement'
  | 'integration'
  | 'mail_type'
  | 'international'
  | 'other';

export type FeatureRequestStatus =
  | 'new'
  | 'reviewed'
  | 'planned'
  | 'in_progress'
  | 'completed'
  | 'declined'
  | 'duplicate';

export interface FeatureRequest {
  request_id: string;
  user_id: string;
  title: string;
  description: string;
  category: FeatureRequestCategory;
  attempted_action: string | null;
  contact_email: string | null;
  contact_consent: boolean;
  status: FeatureRequestStatus;
  admin_notes: string | null;
  created_at: Date;
  updated_at: Date;
  reviewed_at: Date | null;
  resolved_at: Date | null;
}

export interface SubmitFeatureRequestInput {
  title: string;
  description: string;
  category?: FeatureRequestCategory;
  attemptedAction?: string;
  contactEmail?: string;
  okToContact?: boolean;
}

export interface SubmitFeatureRequestResult {
  requestId: string;
  category: FeatureRequestCategory;
  createdAt: Date;
}

// Rate limit: 5 requests per user per 24 hours
const RATE_LIMIT_COUNT = 5;
const RATE_LIMIT_HOURS = 24;

// Validation limits
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_ATTEMPTED_ACTION_LENGTH = 255;

// Valid categories for validation
const VALID_CATEGORIES: FeatureRequestCategory[] = [
  'new_feature',
  'improvement',
  'integration',
  'mail_type',
  'international',
  'other',
];

/**
 * Count recent feature requests from a user (for rate limiting)
 */
export async function countRecentRequests(userId: string): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM feature_requests
     WHERE user_id = $1
       AND created_at > NOW() - INTERVAL '${RATE_LIMIT_HOURS} hours'`,
    [userId]
  );

  return parseInt(result.rows[0].count, 10);
}

/**
 * Check if user has exceeded rate limit
 */
export async function isRateLimited(userId: string): Promise<boolean> {
  const recentCount = await countRecentRequests(userId);
  return recentCount >= RATE_LIMIT_COUNT;
}

/**
 * Submit a feature request
 *
 * @throws Error if validation fails
 * @throws Error if rate limit exceeded
 */
export async function submitFeatureRequest(
  userId: string,
  input: SubmitFeatureRequestInput
): Promise<SubmitFeatureRequestResult> {
  // Validate title
  if (!input.title || input.title.trim().length === 0) {
    throw new Error('Title is required');
  }
  if (input.title.length > MAX_TITLE_LENGTH) {
    throw new Error(`Title must be ${MAX_TITLE_LENGTH} characters or less`);
  }

  // Validate description
  if (!input.description || input.description.trim().length === 0) {
    throw new Error('Description is required');
  }
  if (input.description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`Description must be ${MAX_DESCRIPTION_LENGTH} characters or less`);
  }

  // Validate attempted action (optional)
  if (input.attemptedAction && input.attemptedAction.length > MAX_ATTEMPTED_ACTION_LENGTH) {
    throw new Error(`Attempted action must be ${MAX_ATTEMPTED_ACTION_LENGTH} characters or less`);
  }

  // Validate category (optional, defaults to 'other')
  const category: FeatureRequestCategory = input.category || 'other';
  if (!VALID_CATEGORIES.includes(category)) {
    throw new Error(`Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}`);
  }

  // Check rate limit
  const rateLimited = await isRateLimited(userId);
  if (rateLimited) {
    throw new Error(
      `You've submitted several feature requests recently. Please wait before submitting more. ` +
      `Limit: ${RATE_LIMIT_COUNT} requests per ${RATE_LIMIT_HOURS} hours.`
    );
  }

  // Insert feature request
  const result = await query<FeatureRequest>(
    `INSERT INTO feature_requests (
      user_id, title, description, category, attempted_action, contact_email, contact_consent
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *`,
    [
      userId,
      input.title.trim(),
      input.description.trim(),
      category,
      input.attemptedAction?.trim() || null,
      input.contactEmail?.trim() || null,
      input.okToContact ?? false,
    ]
  );

  const featureRequest = result.rows[0];

  console.log(
    `📝 Feature request submitted: ${featureRequest.request_id} by user ${userId} - "${featureRequest.title}"`
  );

  return {
    requestId: featureRequest.request_id,
    category: featureRequest.category,
    createdAt: featureRequest.created_at,
  };
}

/**
 * Get feature requests for a user (for future dashboard use)
 */
export async function getUserFeatureRequests(
  userId: string,
  limit = 20
): Promise<FeatureRequest[]> {
  const result = await query<FeatureRequest>(
    `SELECT * FROM feature_requests
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit]
  );

  return result.rows;
}

/**
 * Get a single feature request by ID
 */
export async function getFeatureRequest(
  requestId: string
): Promise<FeatureRequest | null> {
  const result = await query<FeatureRequest>(
    `SELECT * FROM feature_requests WHERE request_id = $1`,
    [requestId]
  );

  return result.rows[0] || null;
}
