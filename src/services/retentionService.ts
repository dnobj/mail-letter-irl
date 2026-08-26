import { query } from '../db/index.js';
import type { JobStatus, LetterStatus, OrderStatus } from './types.js';

/**
 * Data retention enforcement for the periods published in
 * docs/privacy-policy.md (#153).
 *
 * THE APPROVED SCHEDULE
 *   - Sent letter content: 90 days, then anonymized.
 *   - Drafts attached to a PAID order: the same schedule.
 *   - Unsent drafts never paid for: expire at 24h, content gone within 7 days.
 *     cleanupOldDrafts() DELETES the ones it can; purgeAbandonedDraftContent
 *     anonymizes the ones the schema forbids deleting.
 *
 * WHY ANONYMIZE RATHER THAN DELETE
 * orders, credit_ledger and letter_status_history reference these rows, and
 * the #158 promotion gate requires financial audit records to survive content
 * deletion. Content columns are overwritten; ids, amounts, timestamps,
 * provider references and status history are left exactly as they were.
 *
 * EVERY GUARD HERE IS AN ALLOW-LIST, AND THAT IS THE WHOLE DESIGN
 * The first cut wrote the holds as deny-lists of "contested" statuses. A
 * deny-list fails OPEN: the day a migration adds a status, every row sitting
 * in it becomes eligible and its content is destroyed IRREVERSIBLY, with
 * nothing to type-check and no test to fail. An allow-list of states known
 * safe to redact fails CLOSED - an unknown status holds the row, which is
 * under-deletion, and under-deletion is recoverable by a later run. For a
 * sweep whose mistakes cannot be undone, that asymmetry decides the shape.
 */

/**
 * Letter states in which the content is finished with. Everything else -
 * 'draft', 'queued', 'processing', 'held' - means work is still pending, and
 * letterJobService builds its provider params by reading letters.content, so
 * redacting under one of those would mail an empty letter to an empty address.
 */
const REDACTABLE_LETTER_STATUSES: LetterStatus[] = [
  'sent',
  'accepted',
  'in_transit',
  'delivered',
  'returned',
  'failed',
  'cancelled'
];

/**
 * Job states that are finished. Note 'failed' is NOT here: claimJob dispatches
 * on `status IN ('pending','failed')`, and the operator retry route re-enqueues
 * failed jobs at any age, so a failed job can still become a mailed letter.
 */
const SETTLED_JOB_STATUSES: JobStatus[] = ['completed', 'cancelled'];

/**
 * Order states in which the money is settled and the content is no longer
 * evidence. Everything else holds - including 'paid' and 'fulfillment_pending',
 * where the customer has been charged but the draft is still the only copy of
 * what they bought.
 */
const SETTLED_ORDER_STATUSES: OrderStatus[] = [
  'fulfilled',
  'refunded',
  'cancelled',
  'payment_failed'
];

/**
 * Order states that prove a draft was actually PAID for. An order row alone
 * does not: createJitCheckout inserts one at 'checkout_pending' before any
 * money moves, so every abandoned checkout leaves one behind. Treating those
 * as paid gave a never-paid draft 90-day retention instead of the 7-day
 * schedule the published policy promises it.
 */
const PAID_ORDER_STATUSES: OrderStatus[] = [
  'paid',
  'fulfillment_pending',
  'fulfilled',
  'refund_pending',
  'refunded',
  'disputed',
  'held'
];

/**
 * The published window for an unsent, never-paid draft. cleanupOldDrafts uses
 * the same number to DELETE the ones it can; this is for the ones it cannot.
 */
const UNPAID_DRAFT_RETENTION_DAYS = 7;

/**
 * Rows per run per table. Retention competes with live sends for row locks,
 * so the statement is bounded; `moreWaiting` tells the caller to come back.
 */
const DEFAULT_BATCH_LIMIT = 500;
const MAX_BATCH_LIMIT = 5000;

export interface RetentionSweepResult {
  lettersRedacted: number;
  draftsRedacted: number;
  /** Never-paid drafts stranded by an abandoned checkout, anonymized at 7 days. */
  abandonedDraftsRedacted: number;
  /** True when a batch filled, so rows are still due. */
  moreWaiting: boolean;
  /** Populated when a sweep failed; the others still ran. */
  errors: string[];
}

/**
 * Both parameters are validated because both are public API on functions whose
 * only job is irreversible deletion. retentionDays <= 0 would put the boundary
 * at or after NOW() and redact every letter in the database in one statement.
 */
function validated(retentionDays: number, batchLimit: number): [number, number] {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new Error(`retentionDays must be a positive integer, received ${retentionDays}`);
  }
  if (!Number.isInteger(batchLimit) || batchLimit < 1 || batchLimit > MAX_BATCH_LIMIT) {
    throw new Error(
      `batchLimit must be an integer in 1..${MAX_BATCH_LIMIT}, received ${batchLimit}`
    );
  }
  return [retentionDays, batchLimit];
}

/**
 * The SET list that anonymizes a draft. Shared by both draft sweeps so they
 * cannot drift - a column added to one and forgotten in the other would leave
 * content standing on exactly one population, silently.
 *
 * The image blobs are EMPTIED rather than nulled: postcard_requires_image,
 * header_layout_requires_image and inline_layout_requires_image (migrations
 * 012/013) are all `layout != X OR col IS NOT NULL` with NO condition on the
 * row being spent, so a plain NULL violates the constraint and rolls back the
 * whole batch - every other due row with it. The CASE preserves NULL where the
 * column was already NULL, so a column never changes shape for a mail type
 * this is not about. required_credits is left alone: non-content, CHECK (> 0),
 * and the refund path still reads it.
 */
const DRAFT_REDACTION_SET = `
        SET sender = '{}'::jsonb,
            recipient = '{}'::jsonb,
            body_text = '',
            sign_off = CASE WHEN sign_off IS NULL THEN NULL ELSE '' END,
            preview_html = NULL,
            sender_validation = NULL,
            recipient_validation = NULL,
            front_image_data = CASE WHEN front_image_data IS NULL THEN NULL ELSE '' END,
            front_image_url = NULL,
            header_image_data = CASE WHEN header_image_data IS NULL THEN NULL ELSE '' END,
            header_image_url = NULL,
            inline_image_data = CASE WHEN inline_image_data IS NULL THEN NULL ELSE '' END,
            inline_image_url = NULL,
            redacted_at = NOW()`;

/**
 * Anonymize letter content past the retention window.
 *
 * THE DISPUTE HOLD HAS TWO ARMS, and the second one is the whole point.
 * orders.letter_id is written in exactly one place - mailSendService, inside
 * `if (jitOrder)` - so for a PREPAID letter (funding_type defaults to
 * 'prepaid_balance', the majority path) no order row carries its letter_id and
 * a hold keyed on that column alone is vacuously true. A prepaid letter
 * reaches its funding pack order only through the ledger, so the second arm
 * walks credit_transactions -> credit_consumption -> credit_ledger, the same
 * chain isLetterAlreadyCompensated uses. Without it, a customer who buys a
 * pack, sends ten letters and then charges back has all ten letters' content
 * and recipient addresses destroyed - precisely the evidence the published
 * 90-day period exists to preserve.
 */
export async function purgeExpiredLetterContent(
  retentionDays = 90,
  batchLimit = DEFAULT_BATCH_LIMIT
): Promise<number> {
  const [days, limit] = validated(retentionDays, batchLimit);
  const result = await query(
    `WITH due AS (
       SELECT l.letter_id
         FROM letters l
        WHERE l.redacted_at IS NULL
          AND COALESCE(l.sent_at, l.created_at) < NOW() - make_interval(days => $1::int)
          AND l.status = ANY($2::varchar[])
          AND NOT EXISTS (
                SELECT 1 FROM letter_jobs j
                 WHERE j.letter_id = l.letter_id
                   AND NOT (j.status = ANY($3::varchar[]))
              )
          AND NOT EXISTS (
                SELECT 1 FROM orders o
                 WHERE o.letter_id = l.letter_id
                   AND NOT (o.status = ANY($4::varchar[]))
              )
          AND NOT EXISTS (
                SELECT 1
                  FROM credit_transactions txn
                  JOIN credit_consumption cc ON cc.transaction_id = txn.transaction_id
                  JOIN credit_ledger lot ON lot.ledger_id = cc.ledger_id
                  JOIN orders o ON o.order_id = lot.source_order_id
                 WHERE txn.reference_type = 'letter'
                   AND txn.type = 'deduction'
                   AND txn.reference_id = l.letter_id
                   AND NOT (o.status = ANY($4::varchar[]))
              )
        ORDER BY COALESCE(l.sent_at, l.created_at)
        LIMIT $5::int
        FOR UPDATE OF l SKIP LOCKED
     )
     UPDATE letters
        SET content = '{}'::jsonb,
            recipient = '{}'::jsonb,
            preview_html = NULL,
            redacted_at = NOW()
      WHERE letter_id IN (SELECT letter_id FROM due)`,
    [days, REDACTABLE_LETTER_STATUSES, SETTLED_JOB_STATUSES, SETTLED_ORDER_STATUSES, limit]
  );
  return result.rowCount ?? 0;
}

/**
 * Anonymize the content of drafts that were actually paid for.
 *
 * These are the rows cleanupOldDrafts can never touch: its predicate excludes
 * any draft with an order row, which is correct for DELETION (the order still
 * references it) but left the content standing forever.
 *
 * The clock is consumed_at when consumed and created_at otherwise. Both are
 * write-once. An earlier version used updated_at, which letter_drafts' BEFORE
 * UPDATE trigger rewrites on every write - so any future writer would silently
 * restart the 90-day window, and this sweep's own UPDATE would have done so.
 */
export async function purgePaidDraftContent(
  retentionDays = 90,
  batchLimit = DEFAULT_BATCH_LIMIT
): Promise<number> {
  const [days, limit] = validated(retentionDays, batchLimit);
  const result = await query(
    `WITH due AS (
       SELECT d.draft_id
         FROM letter_drafts d
        WHERE d.redacted_at IS NULL
          AND COALESCE(d.consumed_at, d.created_at) < NOW() - make_interval(days => $1::int)
          AND EXISTS (
                SELECT 1 FROM orders o
                 WHERE o.draft_id = d.draft_id
                   AND o.status = ANY($2::varchar[])
              )
          AND NOT EXISTS (
                SELECT 1 FROM orders o
                 WHERE o.draft_id = d.draft_id
                   AND NOT (o.status = ANY($3::varchar[]))
              )
          AND NOT EXISTS (
                SELECT 1 FROM letter_jobs j
                 WHERE d.consumed_letter_id IS NOT NULL
                   AND j.letter_id = d.consumed_letter_id
                   AND NOT (j.status = ANY($4::varchar[]))
              )
        ORDER BY COALESCE(d.consumed_at, d.created_at)
        LIMIT $5::int
        FOR UPDATE OF d SKIP LOCKED
     )
     UPDATE letter_drafts${DRAFT_REDACTION_SET}
      WHERE draft_id IN (SELECT draft_id FROM due)`,
    [days, PAID_ORDER_STATUSES, SETTLED_ORDER_STATUSES, SETTLED_JOB_STATUSES, limit]
  );
  return result.rowCount ?? 0;
}

/**
 * Anonymize drafts stranded by an ABANDONED CHECKOUT, on the unpaid schedule.
 *
 * These rows can never be deleted, and that is a schema fact rather than a
 * policy choice: orders.draft_id is `REFERENCES letter_drafts ON DELETE SET
 * NULL` while valid_order_draft is `CHECK ((order_type = 'jit_mail' AND
 * draft_id IS NOT NULL) OR order_type = 'letter_pack')`. Deleting the draft
 * fires the SET NULL, which violates the CHECK, and the DELETE errors. So
 * cleanupOldDrafts' `NOT EXISTS (orders)` guard is load-bearing rather than
 * incidental - and it left every abandoned Pay & Send checkout holding a full
 * body and both addresses with nothing to clean it.
 *
 * createJitCheckout inserts the order at 'checkout_pending' BEFORE any money
 * moves, so this is every abandoned checkout, not an edge case. The content
 * goes on the 7-day unpaid schedule; the row itself stays, which is why the
 * published policy promises the CONTENT is deleted rather than the row.
 */
export async function purgeAbandonedDraftContent(
  retentionDays = UNPAID_DRAFT_RETENTION_DAYS,
  batchLimit = DEFAULT_BATCH_LIMIT
): Promise<number> {
  const [days, limit] = validated(retentionDays, batchLimit);
  const result = await query(
    `WITH due AS (
       SELECT d.draft_id
         FROM letter_drafts d
        WHERE d.redacted_at IS NULL
          AND d.created_at < NOW() - make_interval(days => $1::int)
          AND EXISTS (
                SELECT 1 FROM orders o WHERE o.draft_id = d.draft_id
              )
          AND NOT EXISTS (
                SELECT 1 FROM orders o
                 WHERE o.draft_id = d.draft_id
                   AND o.status = ANY($2::varchar[])
              )
          AND NOT EXISTS (
                SELECT 1 FROM letter_jobs j
                 WHERE d.consumed_letter_id IS NOT NULL
                   AND j.letter_id = d.consumed_letter_id
                   AND NOT (j.status = ANY($3::varchar[]))
              )
        ORDER BY d.created_at
        LIMIT $4::int
        FOR UPDATE OF d SKIP LOCKED
     )
     UPDATE letter_drafts${DRAFT_REDACTION_SET}
      WHERE draft_id IN (SELECT draft_id FROM due)`,
    [days, PAID_ORDER_STATUSES, SETTLED_JOB_STATUSES, limit]
  );
  return result.rowCount ?? 0;
}

/**
 * One retention pass.
 *
 * The sweeps are isolated from each other. They cover independent published
 * obligations, so a failure in one must not stop the others from running - the
 * same argument that gives retention its own maintenance task rather than a
 * step inside runDailyMaintenance.
 *
 * Counts only in the result: never ids, addresses, or any fragment of content.
 * No statement uses RETURNING, so the identifiers never reach this process at
 * all - the promise is structural rather than test-enforced.
 */
export async function runRetentionSweep(
  retentionDays = 90,
  batchLimit = DEFAULT_BATCH_LIMIT
): Promise<RetentionSweepResult> {
  const errors: string[] = [];
  let lettersRedacted = 0;
  let draftsRedacted = 0;
  let abandonedDraftsRedacted = 0;

  try {
    lettersRedacted = await purgeExpiredLetterContent(retentionDays, batchLimit);
  } catch (error) {
    errors.push(`letters: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  try {
    draftsRedacted = await purgePaidDraftContent(retentionDays, batchLimit);
  } catch (error) {
    errors.push(`paid drafts: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  try {
    // The unpaid window is its own published number, not the caller's.
    abandonedDraftsRedacted = await purgeAbandonedDraftContent(
      UNPAID_DRAFT_RETENTION_DAYS,
      batchLimit
    );
  } catch (error) {
    errors.push(`abandoned drafts: ${error instanceof Error ? error.message : 'unknown error'}`);
  }

  return {
    lettersRedacted,
    draftsRedacted,
    abandonedDraftsRedacted,
    moreWaiting:
      lettersRedacted >= batchLimit ||
      draftsRedacted >= batchLimit ||
      abandonedDraftsRedacted >= batchLimit,
    errors
  };
}
