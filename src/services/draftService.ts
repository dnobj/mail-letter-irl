/**
 * Draft Service
 *
 * Manages letter drafts for idempotent send operations.
 * Prevents duplicate sends and double-charging when AI clients retry requests.
 */

import { createHash } from 'node:crypto';
import { query, transaction } from '../db/index.js';
import type pg from 'pg';
import { writeDiagnostic } from '../utils/diagnosticLog.js';
import { stationeryOf, type Stationery } from '../render/stationery.js';
import { postcardFrontOf, type PostcardFront } from '../render/postcard.js';
import { POSTCARD_FRONT_RENDERER_VERSION, RENDERER_VERSION, rendererVersionFor } from '../render/pdf.js';
import { MAX_LETTER_PAGES } from '../render/geometry.js';
import type {
  Letter,
  LetterDraft,
  LetterStatus,
  CreateDraftParams,
  CreateDraftResult,
  ConsumeDraftParams,
  ConsumeDraftResult,
  DraftSchedule,
  PostcardDraft,
  CreatePostcardDraftParams,
  CreatePostcardDraftResult,
  MailService,
  PostcardSize,
} from './types.js';
import { MAIL_SERVICES } from '../config/certifiedMail.js';

// Default draft expiration: 24 hours
const DEFAULT_EXPIRATION_HOURS = 24;

// ============================================================================
// Draft Creation
// ============================================================================

/**
 * A postcard's front as a draft stores it (#594): none for full bleed, and
 * otherwise as the print reads it back (postcardFrontOf). One the print would
 * not read is refused before anything is written, so a stored front always
 * prints.
 */
function storedPostcardFront(front: PostcardFront | null | undefined): PostcardFront | null {
  if (front == null) return null;
  const stored = postcardFrontOf(front);
  if (!stored) {
    // The preview checks a front before it gets here, so this is a defect, classed as a refusal.
    throw Object.assign(new Error("The postcard's front cannot be stored: the print would not read it back."), {
      code: 'POSTCARD_FRONT_UNREADABLE',
      diagnosticClass: 'validation_error'
    });
  }
  return stored;
}

/**
 * A theme as a draft stores it (#563): none for Classic, and otherwise as the
 * print reads it back (stationeryOf). One the print would not read is refused
 * before anything is written, so a stored theme always prints.
 */
function storedStationery(stationery: Stationery | null | undefined): Stationery | null {
  const themed = stationery != null && stationery.theme !== 'classic';
  const stored = themed ? stationeryOf(stationery) : null;
  if (themed && !stored) {
    // The previews check a theme before it gets here, so this is a defect, classed as a refusal.
    throw Object.assign(new Error('The stationery cannot be stored: the print would not read it back.'), {
      code: 'STATIONERY_UNREADABLE',
      diagnosticClass: 'validation_error'
    });
  }
  return stored;
}

/**
 * The pages a letter draft records (#586): one unless its preview laid it out
 * on more, and never more than the renderer lays out. More than one only on a
 * letter our renderer drew and never on a gift send, whose free letter pays
 * for one page: migration 047's checks hold any writer to that. Refused here,
 * before anything is written.
 */
function storedPages(params: CreateDraftParams): number {
  const pages = params.pages ?? 1;
  const known = Number.isInteger(pages) && pages >= 1 && pages <= MAX_LETTER_PAGES;
  if (!known || (pages > 1 && (params.rendererVersion == null || params.isGiftSend === true))) {
    // The previews lay a letter out before it gets here, so this is a defect, classed as a refusal.
    throw Object.assign(new Error('The letter cannot be stored on that many pages.'), {
      code: 'DRAFT_PAGES_INVALID',
      diagnosticClass: 'validation_error'
    });
  }
  return pages;
}

/**
 * How a letter draft travels (#625): standard unless its preview asked for
 * certified mail. A service other than standard only for a letter and never a
 * gift send, whose free letter pays for standard mail only (#579): migration
 * 052's checks hold any writer to that. Refused here, before anything is
 * written.
 */
function storedMailService(params: { mailService?: MailService; isGiftSend?: boolean }): MailService {
  const service = params.mailService ?? 'standard';
  const known = (MAIL_SERVICES as readonly string[]).includes(service);
  if (!known || (service !== 'standard' && params.isGiftSend === true)) {
    // The previews check this before it gets here, so this is a defect, classed as a refusal.
    throw Object.assign(new Error('The letter cannot be stored with that mail service.'), {
      code: 'DRAFT_MAIL_SERVICE_INVALID',
      diagnosticClass: 'validation_error'
    });
  }
  return service;
}

/**
 * Create a new draft for a letter that has been previewed and validated.
 * Called by quote_and_preview_letter after successful address validation.
 */
export async function createDraft(params: CreateDraftParams): Promise<CreateDraftResult> {
  const expiresInHours = params.expiresInHours ?? DEFAULT_EXPIRATION_HOURS;
  const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);
  const layoutType = params.layoutType ?? 'text_only';
  const stationery = storedStationery(params.stationery);
  const pages = storedPages(params);
  const mailService = storedMailService(params);

  const result = await query<LetterDraft>(
    `INSERT INTO letter_drafts (
      user_id, sender, recipient, body_text, sign_off,
      required_credits, preview_html, sender_validation, recipient_validation,
      layout_type, header_image_data, header_image_url, inline_image_data, inline_image_url,
      is_gift_send, renderer_version, status, expires_at, arrive_by, mail_on, stationery, pages, signature_image,
      mail_service
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'pending', $17,
              $18::date, $19::date, $20::jsonb, $21::smallint, $22, $23::text)
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
      stationery ? JSON.stringify(stationery) : null,
      pages,
      params.signatureImage ?? null,
      mailService,
    ]
  );

  const draft = result.rows[0];

  writeDiagnostic('info', 'draft.created', {
    layoutType,
    expiresInHours,
    renderer: params.rendererVersion ?? 'html',
    scheduled: params.schedule !== undefined,
    pages,
    mailService,
    signed: params.signatureImage !== undefined
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
  const front = storedPostcardFront(params.postcardFront);

  const result = await query<PostcardDraft>(
    `INSERT INTO letter_drafts (
      user_id, sender, recipient, body_text, sign_off,
      required_credits, preview_html, sender_validation, recipient_validation,
      mail_type, front_image_data, front_image_url, postcard_size,
      is_gift_send, renderer_version, status, expires_at, arrive_by, mail_on, postcard_front
    ) VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, 'postcard', $9, $10, $11, $12, $13, 'pending', $14,
              $15::date, $16::date, $17::jsonb)
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
      front ? JSON.stringify(front) : null,
    ]
  );

  const draft = result.rows[0];

  writeDiagnostic('info', 'draft.postcard_created', {
    postcardSize,
    expiresInHours,
    renderer: params.rendererVersion ?? 'html',
    scheduled: params.schedule !== undefined,
    layout: front?.layout ?? 'full_bleed'
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
 * when it expires, its arrival dates, and the mail it became once sent, with
 * that letter's own status, funding and dates (#535), so an answer about a
 * sent draft says where the order stands now. For get_draft_status, which the
 * preview card asks where its host keeps no state for it.
 */
export interface DraftState
  extends Pick<
    LetterDraft,
    | 'draft_id' | 'user_id' | 'status' | 'expires_at' | 'consumed_letter_id' | 'arrive_by' | 'mail_on'
    | 'mail_type' | 'renderer_version' | 'stationery' | 'preview_html' | 'pages' | 'mail_service' | 'is_gift_send' | 'required_credits'
    | 'body_text' | 'sign_off' | 'postcard_size' | 'postcard_front'
  > {
  /** The letter the draft became; null for a draft not sent, or a letter that is not the draft owner's. */
  letter_status: LetterStatus | null;
  letter_funding_type: Letter['funding_type'] | null;
  letter_arrive_by: string | null;
  letter_mail_on: string | null;
  /** Whether the draft holds a signature (#608): its copy is never read here. */
  signed: boolean;
}

export async function getDraftState(draftId: string): Promise<DraftState | null> {
  const result = await query<DraftState>(
    `SELECT d.draft_id, d.user_id, d.status, d.expires_at, d.consumed_letter_id, d.arrive_by, d.mail_on,
            d.mail_type, d.renderer_version, d.stationery, d.pages, d.mail_service, d.is_gift_send, d.required_credits,
            d.body_text, d.sign_off, d.postcard_size, d.postcard_front,
            -- Whether it is signed (#608), not the picture.
            (d.signature_image IS NOT NULL AND d.signature_image <> '') AS signed,
            -- The page only where get_draft_status can give it: a letter or
            -- postcard (#594) our renderer drew, still pending.
            CASE WHEN d.status = 'pending' AND d.renderer_version IS NOT NULL
                 THEN d.preview_html END AS preview_html,
            l.status AS letter_status, l.funding_type AS letter_funding_type,
            l.arrive_by AS letter_arrive_by, l.mail_on AS letter_mail_on
       FROM letter_drafts d
       LEFT JOIN letters l ON l.letter_id = d.consumed_letter_id AND l.user_id = d.user_id
      WHERE d.draft_id = $1`,
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
 * Delete drafts that are done with: sent (consumed), expired or cancelled,
 * last changed more than `olderThanDays` ago, and never paid for by an order.
 * The hourly maintenance calls it once a day.
 *
 * A sent draft whose letter waits for its mail date (#535) stays until
 * `olderThanDays` after that date: its confirmation link and a reopened card
 * read the letter through it (#564), and a wait can be 60 days. The date
 * cutoff is its own integer parameter; the timestamp one is never cast a
 * second way.
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
       AND NOT EXISTS (
         SELECT 1 FROM letters
          WHERE letters.letter_id = letter_drafts.consumed_letter_id
            AND letters.mail_on >= CURRENT_DATE - $2::int
       )
     RETURNING draft_id`,
    [cutoffDate, olderThanDays]
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
 * Why a draft's page was not drawn again in place (setDraftStationery,
 * setDraftWords): as for its dates, or 'changed', when what the page was
 * drawn from changed under the caller (#586).
 */
export type DraftRedrawRefusal = DraftScheduleRefusal | 'changed';

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
    const refusal = await lockChangeableDraft(client, draftId, userId, now);
    if (refusal) return refusal;

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

/** Why a draft's mail service cannot be changed (#625): a draft that may change, or one that cannot be certified. */
export type MailServiceRefusal = DraftScheduleRefusal | 'not_a_letter' | 'gift_send';

/**
 * Sets how a letter draft travels (#625, set_mail_service). It changes only a
 * draft setDraftSchedule would change, under the same lock, so a send or a Pay
 * & Send checkout runs before or after it, never between: one that goes first
 * leaves this refused ('sent', 'checkout_pending'), and one that goes second
 * sends and prices the new service. The preview's page does not change with
 * the service (the certified label is on the envelope), so nothing is drawn
 * again.
 *
 * A service other than standard only for a letter that is not a gift send:
 * read under the lock and refused by name, as migration 052's checks would
 * refuse it. Returns the refusal, or null once the service is set.
 */
export async function setDraftMailService(
  draftId: string,
  userId: string,
  mailService: MailService,
  now: Date = new Date()
): Promise<MailServiceRefusal | null> {
  const service = storedMailService({ mailService });
  return transaction(async client => {
    const refusal = await lockChangeableDraft(client, draftId, userId, now);
    if (refusal) return refusal;

    const locked = await client.query<Pick<LetterDraft, 'mail_type' | 'is_gift_send'>>(
      'SELECT mail_type, is_gift_send FROM letter_drafts WHERE draft_id = $1',
      [draftId]
    );
    const draft = locked.rows[0];
    if (!draft) return 'not_found';
    if (service !== 'standard') {
      if (draft.mail_type !== 'letter') return 'not_a_letter';
      if (draft.is_gift_send) return 'gift_send';
    }

    await client.query('UPDATE letter_drafts SET mail_service = $2::text, updated_at = NOW() WHERE draft_id = $1', [
      draftId,
      service
    ]);
    writeDiagnostic('info', 'draft.mail_service_set', { mailService: service });
    return null;
  });
}

/**
 * Locks a draft a tool may still change (its dates, its stationery, its words), or says
 * why it may not: it is the caller's, pending, unexpired and not emptied by an
 * erasure, with no live Pay & Send order but a checkout whose window has
 * passed. Someone else's draft is refused as a missing one, and is not locked.
 *
 * An erasure empties a draft an order points at rather than deleting it, and
 * leaves it pending; no sweep visits it again (they skip redacted rows). A
 * change that waited on the erasure's lock reads the emptied row here and is
 * refused, so it cannot write the letter's page back into it.
 */
async function lockChangeableDraft(
  client: pg.PoolClient,
  draftId: string,
  userId: string,
  now: Date
): Promise<DraftScheduleRefusal | null> {
  const locked = await client.query<Pick<LetterDraft, 'status' | 'expires_at' | 'redacted_at'>>(
    'SELECT status, expires_at, redacted_at FROM letter_drafts WHERE draft_id = $1 AND user_id = $2 FOR UPDATE',
    [draftId, userId]
  );
  const draft = locked.rows[0];
  if (!draft) return 'not_found';
  if (draft.status === 'consumed') return 'sent';
  if (draft.status !== 'pending' || draft.redacted_at || !(new Date(draft.expires_at).getTime() > now.getTime())) {
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
  return live.rows[0] ? 'checkout_pending' : null;
}

// ============================================================================
// Stationery
// ============================================================================

/** What set_stationery reads of a draft to draw its page again (#563). */
export interface DraftForStationery {
  mail_type: string;
  status: string;
  expires_at: Date;
  redacted_at: Date | null;
  renderer_version: string | null;
  body_text: string;
  sign_off: string | null;
  layout_type: string | null;
  header_image_data: string | null;
  inline_image_data: string | null;
  sender: Record<string, unknown>;
  recipient: Record<string, unknown>;
  preview_html: string | null;
  /** The pages it was laid out on (migration 047, #586). */
  pages: number;
  /** How it travels (migration 052, #625): a restyle prices it again by this as well as its pages. */
  mail_service: MailService;
  /** A gift letter pays for one page only (#579): its restyle stays on one. */
  is_gift_send: boolean;
  /** The letters its preview priced it at, for what a restyle says it costs. */
  required_credits: number;
  /** The stationery as stored (null for Classic): new words are laid out in it (#586). */
  stationery: unknown;
  /** The signature as the letter was previewed with it (#608): laid out again with the letter. */
  signature_image: string | null;
}

/** The caller's draft, as set_stationery draws it again, or null when it is not theirs or not there. */
export async function getDraftForStationery(draftId: string, userId: string): Promise<DraftForStationery | null> {
  const result = await query<DraftForStationery>(
    `SELECT mail_type, status, expires_at, redacted_at, renderer_version, body_text, sign_off, layout_type,
            header_image_data, inline_image_data, sender, recipient, preview_html, pages, mail_service, is_gift_send,
            required_credits, stationery, signature_image
     FROM letter_drafts
     WHERE draft_id = $1 AND user_id = $2`,
    [draftId, userId]
  );
  return result.rows[0] ?? null;
}

/**
 * What an in-place edit drew its page from, as it read the draft before the
 * lock (#586): a restyle draws the letter's words, and new words are drawn in
 * its stationery. Each writes what the other draws from, so whichever
 * committed second would store a page drawn from what the first replaced.
 * A page is drawn with the draft's signature too, which set_letter_signature
 * changes in place (#608). Read again under the lock; any change refuses the
 * edit, to be tried again.
 */
type DrawnFrom = { words?: { bodyText: string; signOff: string | null }; stationery?: unknown; signature?: string | null };

async function drawnFromChanged(client: pg.PoolClient, draftId: string, drawnFrom: DrawnFrom): Promise<boolean> {
  const locked = await client.query<{ body_text: string; sign_off: string | null; stationery: unknown; signature_image: string | null }>(
    'SELECT body_text, sign_off, stationery, signature_image FROM letter_drafts WHERE draft_id = $1',
    [draftId]
  );
  const row = locked.rows[0];
  if (!row) return true;
  const words = drawnFrom.words;
  if (words && (row.body_text !== words.bodyText || (row.sign_off ?? null) !== (words.signOff ?? null))) return true;
  // Both read from the same jsonb column, so an unchanged value serialises the same.
  if ('stationery' in drawnFrom && JSON.stringify(row.stationery ?? null) !== JSON.stringify(drawnFrom.stationery ?? null)) return true;
  return 'signature' in drawnFrom && (row.signature_image ?? null) !== (drawnFrom.signature ?? null);
}

/**
 * Restyles a letter draft (#563, set_stationery): its stationery, the renderer
 * version that goes with it (rendererVersionFor), and its preview drawn again
 * in it, which the caller made from the draft's own content. It changes only a draft
 * setDraftSchedule would change, under the same lock, so a send or a Pay &
 * Send checkout runs before or after it, never between: one that goes first
 * leaves this refused, and one that goes second sends the new style.
 *
 * In the same transaction the account remembers the theme (migration 045):
 * restyling is an explicit choice, made by the model or on the card.
 *
 * Returns the refusal, or null once the draft is restyled: 'changed' when its
 * words changed since the caller read them (#586), as the page was drawn
 * from those.
 */
export async function setDraftStationery(
  draftId: string,
  userId: string,
  /**
   * `pages`: the pages the letter is laid out on now (#586); left as it was
   * when absent. `drawnFrom`: the words the page was drawn from, as read.
   */
  change: {
    stationery: Stationery;
    previewHtml: string;
    pages?: number;
    /** The words, and the signature (#608) when the caller drew one, as read. */
    drawnFrom: { bodyText: string; signOff: string | null; signature?: string | null };
  },
  now: Date = new Date()
): Promise<DraftRedrawRefusal | null> {
  const stationery = storedStationery(change.stationery);
  // The version goes with the stationery stored (rendererVersionFor), so
  // 044's pair check holds whatever the caller drew. A signed draft keeps
  // pdf-4 (#608, 051's pair): its signature is the draft's own, read in the
  // UPDATE under the lock, which the restyle never changes.
  const rendererVersion = rendererVersionFor(stationery);
  return transaction(async client => {
    const refusal = await lockChangeableDraft(client, draftId, userId, now);
    if (refusal) return refusal;
    const { signature, ...words } = change.drawnFrom;
    if (await drawnFromChanged(client, draftId, { words, ...(signature !== undefined ? { signature } : {}) })) return 'changed';

    await client.query(
      `UPDATE letter_drafts
       SET stationery = $2::jsonb,
           renderer_version = CASE WHEN signature_image IS NOT NULL THEN 'pdf-4' ELSE $3::text END,
           preview_html = $4,
           pages = COALESCE($5::smallint, pages), updated_at = NOW()
       WHERE draft_id = $1`,
      [draftId, stationery ? JSON.stringify(stationery) : null, rendererVersion, change.previewHtml, change.pages ?? null]
    );
    // Never on an erased account (rememberStationery).
    await client.query('UPDATE users SET stationery_theme = $2 WHERE user_id = $1 AND erased_at IS NULL', [
      userId,
      change.stationery.theme
    ]);
    writeDiagnostic('info', 'draft.stationery_set', { theme: change.stationery.theme });
    return null;
  });
}

/**
 * A letter draft's words changed in place (#586, set_letter_words): its body
 * and sign-off, the preview drawn again from them, which the caller laid out
 * in the draft's own stationery, and the pages it now takes. Under the same
 * lock as a restyle, so a send or a Pay & Send checkout runs before or after
 * it, never between, and its price is the draft's from then on.
 *
 * Returns the refusal, or null once the words are changed: 'changed' when the
 * stationery changed since the caller read it, as the page was drawn in that,
 * or the words it replaces did (#593 review round 1).
 */
export async function setDraftWords(
  draftId: string,
  userId: string,
  /**
   * `drawnIn`: the stored stationery the page was drawn in, as read.
   * `replacing`: the words it replaces, as read.
   */
  change: {
    bodyText: string;
    signOff: string;
    previewHtml: string;
    pages: number;
    drawnIn: unknown;
    replacing: { bodyText: string; signOff: string | null };
    /** The signature the page was drawn with (#608), as read; a change of it refuses. */
    drawnWith?: string | null;
  },
  now: Date = new Date()
): Promise<DraftRedrawRefusal | null> {
  return transaction(async client => {
    const refusal = await lockChangeableDraft(client, draftId, userId, now);
    if (refusal) return refusal;
    const drawnFrom: DrawnFrom = { words: change.replacing, stationery: change.drawnIn };
    if (change.drawnWith !== undefined) drawnFrom.signature = change.drawnWith;
    if (await drawnFromChanged(client, draftId, drawnFrom)) return 'changed';

    await client.query(
      `UPDATE letter_drafts
       SET body_text = $2, sign_off = $3, preview_html = $4, pages = $5::smallint, updated_at = NOW()
       WHERE draft_id = $1`,
      [draftId, change.bodyText, change.signOff, change.previewHtml, change.pages]
    );
    // Counts only: the words never reach the log.
    writeDiagnostic('info', 'draft.words_set', { pages: change.pages, characters: change.bodyText.length + change.signOff.length });
    return null;
  });
}

/**
 * A letter draft signed or unsigned in place (#608, set_letter_signature):
 * its own copy of the signature (the saved one's PNG as a data URI, or null
 * for none), the renderer version that goes with it (pdf-4 with one; pdf-2
 * or pdf-1 by its stationery without), its preview drawn again, which the
 * caller made from the draft's own content, and the pages it now takes.
 * Under the lock a restyle takes, so a send or a Pay & Send checkout runs
 * before or after it, never between; refused as 'changed' when its words,
 * stationery or signature changed since the caller read them.
 *
 * In the same transaction the account remembers the choice (migration 050's
 * use_by_default), as a restyle remembers its theme: on or off, explicitly.
 */
export async function setDraftSignature(
  draftId: string,
  userId: string,
  change: {
    signatureImage: string | null;
    previewHtml: string;
    pages: number;
    /** What the page was drawn from, as read: its words, stationery and signature. */
    drawnFrom: { words: { bodyText: string; signOff: string | null }; stationery: unknown; signature: string | null };
  },
  now: Date = new Date()
): Promise<DraftRedrawRefusal | null> {
  return transaction(async client => {
    const refusal = await lockChangeableDraft(client, draftId, userId, now);
    if (refusal) return refusal;
    if (await drawnFromChanged(client, draftId, change.drawnFrom)) return 'changed';

    // The version from the row's own stationery, read under the lock, so
    // 044's and 051's pairs hold whatever the caller drew.
    await client.query(
      `UPDATE letter_drafts
       SET signature_image = $2::text,
           renderer_version = CASE WHEN $2::text IS NOT NULL THEN 'pdf-4'
                                   WHEN stationery IS NOT NULL THEN 'pdf-2'
                                   ELSE 'pdf-1' END,
           preview_html = $3,
           pages = $4::smallint, updated_at = NOW()
       WHERE draft_id = $1`,
      [draftId, change.signatureImage, change.previewHtml, change.pages]
    );
    await client.query('UPDATE user_signatures SET use_by_default = $2 WHERE user_id = $1', [userId, change.signatureImage !== null]);
    writeDiagnostic('info', 'draft.signature_set', { signed: change.signatureImage !== null, pages: change.pages });
    return null;
  });
}

/** What set_postcard_style reads of a draft to draw it again (#594). */
export interface DraftForPostcardStyle {
  mail_type: string;
  status: string;
  expires_at: Date;
  redacted_at: Date | null;
  renderer_version: string | null;
  body_text: string;
  sender: unknown;
  recipient: unknown;
  front_image_data: string | null;
  front_image_url: string | null;
  postcard_size: PostcardSize | null;
  postcard_front: unknown;
  preview_html: string | null;
  is_gift_send: boolean;
  required_credits: number;
}

/** The caller's draft, as set_postcard_style draws it again, or null when it is not theirs or not there. */
export async function getDraftForPostcardStyle(draftId: string, userId: string): Promise<DraftForPostcardStyle | null> {
  const result = await query<DraftForPostcardStyle>(
    `SELECT mail_type, status, expires_at, redacted_at, renderer_version, body_text, sender, recipient,
            front_image_data, front_image_url, postcard_size, postcard_front, preview_html, is_gift_send,
            required_credits
     FROM letter_drafts
     WHERE draft_id = $1 AND user_id = $2`,
    [draftId, userId]
  );
  return result.rows[0] ?? null;
}

/**
 * Restyles a postcard draft (#594, set_postcard_style): its size, its front,
 * the renderer version that goes with the front ('pdf-3' with one, 'pdf-1'
 * without, as migration 048 holds them), its preview drawn again, and, at a
 * new size, its picture cropped again. Under the same lock as a stationery
 * change, so a send or a Pay & Send checkout runs before or after it, never
 * between: one that goes first leaves this refused, and one that goes second
 * sends and prices the new style.
 *
 * `drawnFrom` is the preview the caller read, which it drew from (the back
 * and the picture it kept): one that changed since, under another restyle,
 * refuses this as 'changed', to be tried again. A gift postcard is a 6x9
 * (#579): one asked to leave it is refused as 'changed' too, though the tool
 * refuses it first.
 *
 * Returns the refusal, or null once the draft is restyled.
 */
export async function setDraftPostcardStyle(
  draftId: string,
  userId: string,
  change: {
    size: PostcardSize;
    front: PostcardFront | null;
    previewHtml: string;
    /** The picture cropped again at a new size; absent, the stored one stays. */
    frontImageData?: string;
    drawnFrom: { previewHtml: string | null };
  },
  now: Date = new Date()
): Promise<DraftRedrawRefusal | null> {
  const front = storedPostcardFront(change.front);
  const rendererVersion = front ? POSTCARD_FRONT_RENDERER_VERSION : RENDERER_VERSION;
  return transaction(async client => {
    const refusal = await lockChangeableDraft(client, draftId, userId, now);
    if (refusal) return refusal;
    const locked = await client.query<{ preview_md5: string | null; is_gift_send: boolean }>(
      'SELECT md5(preview_html) AS preview_md5, is_gift_send FROM letter_drafts WHERE draft_id = $1',
      [draftId]
    );
    const row = locked.rows[0];
    const drawnFrom = change.drawnFrom.previewHtml === null ? null : createHash('md5').update(change.drawnFrom.previewHtml, 'utf8').digest('hex');
    if (!row || row.preview_md5 !== drawnFrom || (row.is_gift_send && change.size !== '6x9')) return 'changed';

    await client.query(
      `UPDATE letter_drafts
       SET postcard_size = $2, postcard_front = $3::jsonb, renderer_version = $4, preview_html = $5,
           front_image_data = COALESCE($6, front_image_data), updated_at = NOW()
       WHERE draft_id = $1`,
      [draftId, change.size, front ? JSON.stringify(front) : null, rendererVersion, change.previewHtml, change.frontImageData ?? null]
    );
    writeDiagnostic('info', 'draft.postcard_style_set', {
      size: change.size,
      layout: front?.layout ?? 'full_bleed',
      pictureCroppedAgain: change.frontImageData !== undefined
    });
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
