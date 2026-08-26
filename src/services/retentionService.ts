import { query } from '../db/index.js';

/**
 * Data retention enforcement for the periods published in
 * docs/privacy-policy.md (#153, decision record 2026-08-26).
 *
 * THE APPROVED SCHEDULE
 *   - Sent letter content: 90 days after sending, then anonymized.
 *   - Unsent drafts never paid for: expire at 24h, deleted within 7 days.
 *     That is cleanupOldDrafts() in draftService and is unchanged here.
 *   - Drafts attached to a paid order: the letter-content schedule. Nothing
 *     handled these before - cleanupOldDrafts excludes any draft with an
 *     order row, so a paid draft kept its full body and recipient address
 *     indefinitely. That gap is what purgePaidDraftContent closes.
 *
 * WHY ANONYMIZE RATHER THAN DELETE
 * orders, credit_ledger and letter_status_history reference these rows, and
 * the #158 promotion gate requires financial audit records to survive content
 * deletion. Deleting the row would either cascade into the audit trail or
 * null the reference that ties money to fulfilment. So the content columns
 * are overwritten and the non-content metadata (ids, amounts, timestamps,
 * provider references, status history) is left exactly as it was.
 *
 * WHY A CONSTANT SENTINEL
 * REDACTED is a fixed value, so `content <> REDACTED` is both the idempotency
 * guard and the work bound: a second run in the same window matches nothing
 * and updates nothing. A sentinel carrying a redaction timestamp would defeat
 * that - every run would re-match every previously redacted row.
 */

/** Written over every redacted JSONB content column. Must stay constant. */
const REDACTED = '{"redacted":true}';

/**
 * Rows updated per run. Retention is a background sweep competing with live
 * sends for row locks, so an unbounded UPDATE on a table this size is a
 * latency incident waiting for the first large backlog. Whatever is left is
 * picked up by the next daily run.
 */
const DEFAULT_BATCH_LIMIT = 500;

export interface RetentionSweepResult {
  /** Sent letters whose content was anonymized this run. */
  lettersRedacted: number;
  /** Paid drafts whose content was anonymized this run. */
  draftsRedacted: number;
  /** True when a batch filled, meaning more rows are waiting for the next run. */
  moreWaiting: boolean;
}

/**
 * Anonymize sent letter content past the retention window.
 *
 * TWO HOLDS, both deliberately narrow:
 *
 * 1. IN-FLIGHT WORK. letterJobService builds its provider params by reading
 *    letters.content and letters.recipient (letterParams/postcardParams).
 *    Redacting under a live job would hand the mail provider an empty letter
 *    and an empty address. 'held' counts as live: migration 023 routes an
 *    AMBIGUOUS provider outcome there to await operator reconciliation, which
 *    is precisely the case where someone will need to read what was sent.
 *
 * 2. DISPUTE / REFUND HOLD. The content IS the evidence in a chargeback, and
 *    the published 90-day period names "delivery verification and disputes"
 *    as its reason. An order sitting in disputed, refund_pending or held
 *    holds its letter - 'held' is migration 023's JIT recovery state, which
 *    is by definition awaiting an operator who may need to read it. #153 requires holds to be explicit, scoped and auditable rather
 *    than a switch that silently disables all cleanup - so this is scoped to
 *    the individual order, not the user and not the whole sweep.
 */
export async function purgeExpiredLetterContent(
  retentionDays = 90,
  batchLimit = DEFAULT_BATCH_LIMIT
): Promise<number> {
  const result = await query<{ letter_id: string }>(
    `WITH due AS (
       SELECT l.letter_id
         FROM letters l
        WHERE l.sent_at IS NOT NULL
          AND l.sent_at < NOW() - make_interval(days => $1::int)
          AND l.content <> $2::jsonb
          AND NOT EXISTS (
                SELECT 1 FROM letter_jobs j
                 WHERE j.letter_id = l.letter_id
                   AND j.status IN ('pending', 'processing', 'held')
              )
          AND NOT EXISTS (
                SELECT 1 FROM orders o
                 WHERE o.letter_id = l.letter_id
                   AND o.status IN ('disputed', 'refund_pending', 'held')
              )
        ORDER BY l.sent_at
        LIMIT $3::int
        FOR UPDATE OF l SKIP LOCKED
     )
     UPDATE letters
        SET content = $2::jsonb,
            recipient = $2::jsonb,
            preview_html = NULL
       WHERE letter_id IN (SELECT letter_id FROM due)
     RETURNING letter_id`,
    [retentionDays, REDACTED, batchLimit]
  );
  return result.rowCount ?? 0;
}

/**
 * Anonymize the content of drafts attached to a paid order, on the same
 * schedule as the letter they funded.
 *
 * These are the rows cleanupOldDrafts can never touch: its predicate excludes
 * any draft with an order row, which is correct for DELETION (the order still
 * points at it) but left the content untouched forever.
 *
 * The clock is consumed_at when the draft was consumed into a letter, and
 * updated_at otherwise - a paid draft that was never consumed (checkout
 * abandoned after payment, or fulfilment refused) has no letter to date from,
 * and updated_at is the last time anything happened to it.
 *
 * front_image_data is a base64 data URI of the POSTCARD'S PICTURE and
 * front_image_url is the original generator URL (migration 012). Both are
 * content in every sense the policy means, so both go.
 *
 * front_image_data is emptied rather than nulled, and that is NOT cosmetic:
 * postcard_requires_image (migration 012) is
 *   CHECK (mail_type != 'postcard' OR front_image_data IS NOT NULL)
 * with NO condition on the row being spent, so NULLing it would violate the
 * constraint and abort the WHOLE sweep the first time a postcard draft came
 * due. The empty string satisfies IS NOT NULL while keeping no image. The
 * CASE preserves NULL on letter drafts, which never had one, so the column
 * does not silently change shape for a mail type this is not about.
 *
 * required_credits is left alone: it is non-content, it is CHECK (> 0), and
 * the fulfilment and refund paths still read it.
 */
export async function purgePaidDraftContent(
  retentionDays = 90,
  batchLimit = DEFAULT_BATCH_LIMIT
): Promise<number> {
  const result = await query<{ draft_id: string }>(
    `WITH due AS (
       SELECT d.draft_id
         FROM letter_drafts d
        WHERE COALESCE(d.consumed_at, d.updated_at) < NOW() - make_interval(days => $1::int)
          AND d.sender <> $2::jsonb
          AND EXISTS (
                SELECT 1 FROM orders o WHERE o.draft_id = d.draft_id
              )
          AND NOT EXISTS (
                SELECT 1 FROM orders o
                 WHERE o.draft_id = d.draft_id
                   AND o.status IN ('disputed', 'refund_pending', 'held')
              )
          AND NOT EXISTS (
                SELECT 1 FROM letter_jobs j
                 WHERE j.letter_id = d.consumed_letter_id
                   AND j.status IN ('pending', 'processing', 'held')
              )
        ORDER BY COALESCE(d.consumed_at, d.updated_at)
        LIMIT $3::int
        FOR UPDATE OF d SKIP LOCKED
     )
     UPDATE letter_drafts
        SET sender = $2::jsonb,
            recipient = $2::jsonb,
            body_text = '',
            sign_off = '',
            preview_html = NULL,
            sender_validation = NULL,
            recipient_validation = NULL,
            front_image_data = CASE WHEN front_image_data IS NULL THEN NULL ELSE '' END,
            front_image_url = NULL,
            updated_at = NOW()
      WHERE draft_id IN (SELECT draft_id FROM due)
     RETURNING draft_id`,
    [retentionDays, REDACTED, batchLimit]
  );
  return result.rowCount ?? 0;
}

/**
 * One retention pass. Safe to call repeatedly: every statement is bounded and
 * idempotent, so a crashed or re-run pass repeats work rather than corrupting
 * it.
 *
 * Counts only in the summary - never letter ids, draft ids, addresses or any
 * fragment of content. #153 is explicit that cleanup must not compensate for
 * deleted content by writing it into logs.
 */
export async function runRetentionSweep(
  retentionDays = 90,
  batchLimit = DEFAULT_BATCH_LIMIT
): Promise<RetentionSweepResult> {
  const lettersRedacted = await purgeExpiredLetterContent(retentionDays, batchLimit);
  const draftsRedacted = await purgePaidDraftContent(retentionDays, batchLimit);
  return {
    lettersRedacted,
    draftsRedacted,
    moreWaiting: lettersRedacted >= batchLimit || draftsRedacted >= batchLimit
  };
}
