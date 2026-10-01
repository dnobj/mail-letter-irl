/**
 * Draft Service
 *
 * Manages letter drafts for idempotent send operations.
 * Prevents duplicate sends and double-charging when AI clients retry requests.
 */

import { query, transaction } from '../db/index.js';
import type pg from 'pg';
import { writeDiagnostic } from '../utils/diagnosticLog.js';
import type {
  LetterDraft,
  CreateDraftParams,
  CreateDraftResult,
  ConsumeDraftParams,
  ConsumeDraftResult,
  DraftSchedule,
  PostcardDraft,
  CreatePostcardDraftParams,
  CreatePostcardDraftResult,
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
  const layoutType = params.layoutType ?? 'text_only';

  const result = await query<LetterDraft>(
    `INSERT INTO letter_drafts (
      user_id, sender, recipient, body_text, sign_off,
      required_credits, preview_html, sender_validation, recipient_validation,
      layout_type, header_image_data, header_image_url, inline_image_data, inline_image_url,
      is_gift_send, renderer_version, status, expires_at, arrive_by, mail_on
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'pending', $17,
              $18::date, $19::date)
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
      layoutType,
      params.headerImageData ?? null,
      params.headerImageUrl ?? null,
      params.inlineImageData ?? null,
      params.inlineImageUrl ?? null,
      params.isGiftSend === true,
      params.rendererVersion ?? null,
      expiresAt,
      params.schedule?.arriveBy ?? null,
      params.schedule?.mailOn ?? null,
    ]
  );

  const draft = result.rows[0];

  writeDiagnostic('info', 'draft.created', {
    layoutType,
    expiresInHours,
    renderer: params.rendererVersion ?? 'html',
    scheduled: params.schedule !== undefined
  });

  return {
    draftId: draft.draft_id,
    expiresAt: new Date(draft.expires_at),
  };
}

/**
 * Create a new draft for a postcard that has been previewed and validated.
 * Called by quote_and_preview_postcard after successful address validation and image processing.
 */
export async function createPostcardDraft(params: CreatePostcardDraftParams): Promise<CreatePostcardDraftResult> {
  const expiresInHours = params.expiresInHours ?? DEFAULT_EXPIRATION_HOURS;
  const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);
  const postcardSize = params.postcardSize ?? '6x9';

  const result = await query<PostcardDraft>(
    `INSERT INTO letter_drafts (
      user_id, sender, recipient, body_text, sign_off,
      required_credits, preview_html, sender_validation, recipient_validation,
      mail_type, front_image_data, front_image_url, postcard_size,
      is_gift_send, renderer_version, status, expires_at, arrive_by, mail_on
    ) VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, 'postcard', $9, $10, $11, $12, $13, 'pending', $14,
              $15::date, $16::date)
    RETURNING draft_id, expires_at`,
    [
      params.userId,
      JSON.stringify(params.sender),
      JSON.stringify(params.recipient),
      params.message,
      params.requiredCredits ?? 2, // Default cost for postcards
      params.previewHtml ?? null,
      params.senderValidation ? JSON.stringify(params.senderValidation) : null,
      params.recipientValidation ? JSON.stringify(params.recipientValidation) : null,
      params.frontImageData,
      params.frontImageUrl,
      postcardSize,
      params.isGiftSend === true,
      params.rendererVersion ?? null,
      expiresAt,
      params.schedule?.arriveBy ?? null,
      params.schedule?.mailOn ?? null,
    ]
  );

  const draft = result.rows[0];

  writeDiagnostic('info', 'draft.postcard_created', {
    postcardSize,
    expiresInHours,
    renderer: params.rendererVersion ?? 'html',
    scheduled: params.schedule !== undefined
  });

  return {
    draftId: draft.draft_id,
    expiresAt: new Date(draft.expires_at),
  };
}

/**
 * Get a postcard draft by ID (without consuming it).
 * Returns null if not found or if not a postcard.
 */
export async function getPostcardDraft(draftId: string): Promise<PostcardDraft | null> {
  const result = await query<PostcardDraft>(
    `SELECT * FROM letter_drafts WHERE draft_id = $1 AND mail_type = 'postcard'`,
    [draftId]
  );
  return result.rows[0] || null;
}

// ============================================================================
// Draft Consumption (Idempotent)
// ============================================================================

/**
 * Consume a draft when sending a letter.
 * This is the core idempotency mechanism.
 *
 * - Uses SELECT FOR UPDATE to prevent race conditions
 * - If draft is pending: marks as consumed (letter ID set later via linkDraftToLetter)
 * - If draft is already consumed: returns existing letter_id (idempotent retry)
 * - If draft is expired/not found: throws descriptive error
 *
 * Note: consumed_letter_id is NOT set here due to FK constraint - the letter
 * must be created first. Call linkDraftToLetter() after creating the letter.
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
      console.log('📝 Draft already consumed');
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

    // Consume the draft (without setting letter ID - that happens after letter is created)
    const updateResult = await client.query<LetterDraft>(
      `UPDATE letter_drafts
       SET status = 'consumed',
           consumed_at = NOW(),
           updated_at = NOW()
       WHERE draft_id = $1
       RETURNING *`,
      [params.draftId]
    );

    const consumedDraft = updateResult.rows[0];
    console.log('📝 Draft consumed (letter ID will be linked after creation)');

    return {
      draft: consumedDraft,
      alreadyConsumed: false,
    };
  });
}

/**
 * Link a consumed draft to the created letter.
 * Called after the letter is created in the database to satisfy the FK constraint.
 */
export async function linkDraftToLetter(draftId: string, letterId: string): Promise<void> {
  await query(
    `UPDATE letter_drafts
     SET consumed_letter_id = $2,
         updated_at = NOW()
     WHERE draft_id = $1 AND status = 'consumed'`,
    [draftId, letterId]
  );
  console.log('📝 Draft linked to letter');
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
 * What became of a draft, without its content (#474): who owns it, its status,
 * when it expires, and the mail it became once sent. For get_draft_status,
 * which the preview card asks where its host keeps no state for it.
 */
export async function getDraftState(
  draftId: string
): Promise<Pick<LetterDraft, 'draft_id' | 'user_id' | 'status' | 'expires_at' | 'consumed_letter_id'> | null> {
  const result = await query<Pick<LetterDraft, 'draft_id' | 'user_id' | 'status' | 'expires_at' | 'consumed_letter_id'>>(
    `SELECT draft_id, user_id, status, expires_at, consumed_letter_id
     FROM letter_drafts WHERE draft_id = $1`,
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
       AND NOT EXISTS (
         SELECT 1 FROM orders WHERE orders.draft_id = letter_drafts.draft_id
       )
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
    console.log('📝 Draft cancelled');
  }

  return cancelled;
}

// ============================================================================
// Arrival Dates
// ============================================================================

/**
 * The Pay & Send orders that fix a draft's dates: any live one, as migration
 * 023's idx_orders_active_jit_draft_unique counts them (commerceService's
 * ACTIVE_JIT_STATUSES, which a test holds this to). Payment sends the mail
 * with the dates the draft has, so they do not move under it.
 */
export const LIVE_PAY_AND_SEND_STATUSES = [
  'checkout_pending',
  'paid',
  'fulfillment_pending',
  'refund_pending',
  'disputed',
  'held',
] as const;

/** Why a draft's arrival date was left as it was (setDraftSchedule). */
export type DraftScheduleRefusal = 'not_found' | 'sent' | 'expired' | 'checkout_pending';

/**
 * Sets, moves or clears a draft's arrival dates (#535, set_arrival_date):
 * only a draft that is the caller's, still pending and unexpired, with no live
 * Pay & Send order but a checkout whose window has passed, which can no
 * longer be paid. The dates were checked by the caller.
 *
 * The draft row is locked first, as the send (mailSendService) and the Pay &
 * Send checkout (commerceService) lock it before they read its dates, so this
 * and either of them run one after the other. A send or checkout that goes
 * first leaves this refused ('sent', 'checkout_pending'); one that goes second
 * reads the new dates.
 *
 * Returns the refusal, or null once the dates are written. Someone else's
 * draft is refused as a missing one, and is not locked.
 */
export async function setDraftSchedule(
  draftId: string,
  userId: string,
  schedule: DraftSchedule | null,
  now: Date = new Date()
): Promise<DraftScheduleRefusal | null> {
  return transaction(async client => {
    const locked = await client.query<Pick<LetterDraft, 'status' | 'expires_at'>>(
      'SELECT status, expires_at FROM letter_drafts WHERE draft_id = $1 AND user_id = $2 FOR UPDATE',
      [draftId, userId]
    );
    const draft = locked.rows[0];
    if (!draft) return 'not_found';
    if (draft.status === 'consumed') return 'sent';
    if (draft.status !== 'pending' || !(new Date(draft.expires_at).getTime() > now.getTime())) {
      return 'expired';
    }

    const live = await client.query(
      `SELECT 1 FROM orders
       WHERE draft_id = $1
         AND order_type = 'jit_mail'
         AND status = ANY($2::varchar[])
         AND (status <> 'checkout_pending' OR checkout_expires_at IS NULL OR checkout_expires_at > NOW())
       LIMIT 1`,
      [draftId, [...LIVE_PAY_AND_SEND_STATUSES]]
    );
    if (live.rows[0]) return 'checkout_pending';

    await client.query(
      `UPDATE letter_drafts
       SET arrive_by = $2::date, mail_on = $3::date, updated_at = NOW()
       WHERE draft_id = $1`,
      [draftId, schedule?.arriveBy ?? null, schedule?.mailOn ?? null]
    );
    writeDiagnostic('info', 'draft.schedule_set', { scheduled: schedule !== null });
    return null;
  });
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
    expiringSoon: parseInt(expiringSoonResult.rows[0]?.count ?? '0', 10),
  };

  for (const row of result.rows) {
    if (row.status in stats) {
      stats[row.status as keyof typeof stats] = parseInt(row.count, 10);
    }
  }

  return stats;
}
