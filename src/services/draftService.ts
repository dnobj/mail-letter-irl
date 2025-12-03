/**
 * Draft Service
 *
 * Manages letter drafts for idempotent send operations.
 * Prevents duplicate sends and double-charging when AI clients retry requests.
 */

import { query, transaction } from '../db/index.js';
import type pg from 'pg';
import type {
  LetterDraft,
  CreateDraftParams,
  CreateDraftResult,
  ConsumeDraftParams,
  ConsumeDraftResult,
} from './types.js';

// Default draft expiration: 24 hours
const DEFAULT_EXPIRATION_HOURS = 24;

// ============================================================================
// Draft Creation
// ============================================================================

/**
 * Create a new draft for a letter that has been previewed and validated.
 * Called by quote_and_preview_letter after successful address validation.
 */
export async function createDraft(params: CreateDraftParams): Promise<CreateDraftResult> {
  const expiresInHours = params.expiresInHours ?? DEFAULT_EXPIRATION_HOURS;
  const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);

  const result = await query<LetterDraft>(
    `INSERT INTO letter_drafts (
      user_id, sender, recipient, body_text, sign_off,
      required_credits, preview_html, sender_validation, recipient_validation,
      status, expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10)
    RETURNING draft_id, expires_at`,
    [
      params.userId,
      JSON.stringify(params.sender),
      JSON.stringify(params.recipient),
      params.bodyText,
      params.signOff,
      params.requiredCredits,
      params.previewHtml ?? null,
      params.senderValidation ? JSON.stringify(params.senderValidation) : null,
      params.recipientValidation ? JSON.stringify(params.recipientValidation) : null,
      expiresAt,
    ]
  );

  const draft = result.rows[0];

  console.log(`📝 Draft created: ${draft.draft_id} (expires: ${expiresAt.toISOString()})`);

  return {
    draftId: draft.draft_id,
    expiresAt: new Date(draft.expires_at),
  };
}

// ============================================================================
// Draft Consumption (Idempotent)
// ============================================================================

/**
 * Consume a draft when sending a letter.
 * This is the core idempotency mechanism.
 *
 * - Uses SELECT FOR UPDATE to prevent race conditions
 * - If draft is pending: marks as consumed, links to letterId
 * - If draft is already consumed: returns existing letter_id (idempotent retry)
 * - If draft is expired/not found: throws descriptive error
 */
export async function consumeDraft(params: ConsumeDraftParams): Promise<ConsumeDraftResult> {
  return await transaction(async (client: pg.PoolClient) => {
    // Lock the draft row to prevent concurrent consumption
    const selectResult = await client.query<LetterDraft>(
      `SELECT * FROM letter_drafts
       WHERE draft_id = $1
       FOR UPDATE`,
      [params.draftId]
    );

    if (selectResult.rows.length === 0) {
      const error = new Error(`Draft not found: ${params.draftId}`) as Error & { code: string; draftId: string };
      error.code = 'DRAFT_NOT_FOUND';
      error.draftId = params.draftId;
      throw error;
    }

    const draft = selectResult.rows[0];

    // Verify ownership
    if (draft.user_id !== params.userId) {
      const error = new Error(`Draft ${params.draftId} does not belong to user ${params.userId}`) as Error & { code: string; draftId: string; userId: string };
      error.code = 'DRAFT_NOT_OWNED';
      error.draftId = params.draftId;
      error.userId = params.userId;
      throw error;
    }

    // Check if already consumed (idempotent retry)
    if (draft.status === 'consumed') {
      console.log(`📝 Draft already consumed: ${params.draftId} -> letter ${draft.consumed_letter_id}`);
      return {
        draft,
        alreadyConsumed: true,
        existingLetterId: draft.consumed_letter_id!,
      };
    }

    // Check if expired
    if (draft.status === 'expired' || new Date(draft.expires_at) < new Date()) {
      const error = new Error(`Draft expired: ${params.draftId}`) as Error & { code: string; draftId: string; expiredAt: Date };
      error.code = 'DRAFT_EXPIRED';
      error.draftId = params.draftId;
      error.expiredAt = new Date(draft.expires_at);
      throw error;
    }

    // Check if cancelled
    if (draft.status === 'cancelled') {
      const error = new Error(`Draft was cancelled: ${params.draftId}`) as Error & { code: string; draftId: string };
      error.code = 'DRAFT_CANCELLED';
      error.draftId = params.draftId;
      throw error;
    }

    // Consume the draft
    const updateResult = await client.query<LetterDraft>(
      `UPDATE letter_drafts
       SET status = 'consumed',
           consumed_at = NOW(),
           consumed_letter_id = $2,
           updated_at = NOW()
       WHERE draft_id = $1
       RETURNING *`,
      [params.draftId, params.letterId]
    );

    const consumedDraft = updateResult.rows[0];
    console.log(`📝 Draft consumed: ${params.draftId} -> letter ${params.letterId}`);

    return {
      draft: consumedDraft,
      alreadyConsumed: false,
    };
  });
}

// ============================================================================
// Draft Retrieval
// ============================================================================

/**
 * Get a draft by ID (without consuming it).
 * Used for validation before consumption.
 */
export async function getDraft(draftId: string): Promise<LetterDraft | null> {
  const result = await query<LetterDraft>(
    `SELECT * FROM letter_drafts WHERE draft_id = $1`,
    [draftId]
  );
  return result.rows[0] || null;
}

/**
 * Get all pending drafts for a user.
 */
export async function getPendingDrafts(userId: string): Promise<LetterDraft[]> {
  const result = await query<LetterDraft>(
    `SELECT * FROM letter_drafts
     WHERE user_id = $1 AND status = 'pending' AND expires_at > NOW()
     ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows;
}

// ============================================================================
// Draft Expiration & Cleanup
// ============================================================================

/**
 * Mark expired drafts.
 * Should be called periodically by a background worker.
 */
export async function markExpiredDrafts(): Promise<number> {
  const result = await query(
    `UPDATE letter_drafts
     SET status = 'expired', updated_at = NOW()
     WHERE status = 'pending' AND expires_at < NOW()
     RETURNING draft_id`
  );

  const count = result.rowCount ?? 0;
  if (count > 0) {
    console.log(`📝 Marked ${count} drafts as expired`);
  }

  return count;
}

/**
 * Delete old consumed/expired drafts.
 * Should be called periodically (e.g., weekly) by a background worker.
 */
export async function cleanupOldDrafts(olderThanDays: number = 7): Promise<number> {
  const cutoffDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

  const result = await query(
    `DELETE FROM letter_drafts
     WHERE status IN ('consumed', 'expired', 'cancelled')
       AND updated_at < $1
     RETURNING draft_id`,
    [cutoffDate]
  );

  const count = result.rowCount ?? 0;
  if (count > 0) {
    console.log(`📝 Cleaned up ${count} old drafts (older than ${olderThanDays} days)`);
  }

  return count;
}

/**
 * Cancel a pending draft.
 * Useful if user explicitly abandons a draft.
 */
export async function cancelDraft(draftId: string, userId: string): Promise<boolean> {
  const result = await query(
    `UPDATE letter_drafts
     SET status = 'cancelled', updated_at = NOW()
     WHERE draft_id = $1 AND user_id = $2 AND status = 'pending'
     RETURNING draft_id`,
    [draftId, userId]
  );

  const cancelled = (result.rowCount ?? 0) > 0;
  if (cancelled) {
    console.log(`📝 Draft cancelled: ${draftId}`);
  }

  return cancelled;
}

// ============================================================================
// Draft Statistics (for monitoring)
// ============================================================================

/**
 * Get draft statistics for monitoring.
 */
export async function getDraftStats(): Promise<{
  pending: number;
  consumed: number;
  expired: number;
  cancelled: number;
  expiringSoon: number;
}> {
  const result = await query<{ status: string; count: string }>(
    `SELECT status, COUNT(*)::int as count
     FROM letter_drafts
     GROUP BY status`
  );

  const expiringSoonResult = await query<{ count: string }>(
    `SELECT COUNT(*)::int as count
     FROM letter_drafts
     WHERE status = 'pending'
       AND expires_at < NOW() + INTERVAL '1 hour'`
  );

  const stats = {
    pending: 0,
    consumed: 0,
    expired: 0,
    cancelled: 0,
    expiringSoon: parseInt(expiringSoonResult.rows[0]?.count ?? '0'),
  };

  for (const row of result.rows) {
    if (row.status in stats) {
      stats[row.status as keyof typeof stats] = parseInt(row.count);
    }
  }

  return stats;
}
