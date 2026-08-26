import { query } from '../db/index.js';
import { classifyDiagnosticError } from '../utils/diagnosticLog.js';
import type { JobStatus, LetterStatus, OrderStatus } from './types.js';

/**
 * Data retention enforcement for the periods published in
 * docs/privacy-policy.md (#153).
 *
 * THE APPROVED SCHEDULE
 *   - Sent letter content: 90 days.
 *   - Drafts attached to a PAID order: the same schedule.
 *   - Unsent drafts never paid for: 7 days. cleanupOldDrafts() DELETES the
 *     ones it can; purgeAbandonedDraftContent handles the ones the schema
 *     forbids deleting.
 *
 * REDACTION MOVES CONTENT TO QUARANTINE; IT DOES NOT DESTROY IT
 * Two max-effort reviews of the direct-overwrite design each found ways it
 * destroyed content it was required to keep, and each repair introduced new
 * ones. That is structural: the sweep has to decide "is it safe to destroy
 * this FOREVER?" from a matrix of ten order statuses, six job statuses,
 * eleven letter statuses and a credit-ledger graph, none designed to answer
 * it - and every finding was severe only because the mistake was permanent.
 *
 * So the sweep MOVES content into redacted_content_quarantine, and the
 * quarantine is purged on a pure time rule with no joins and no state machine.
 * The guards below now decide only WHEN content leaves the live tables, never
 * whether the removal can be undone. A wrong allow-list costs a recovery
 * window; restoreQuarantinedContent puts the row back.
 *
 * THE PUBLISHED NUMBER IS THE TOTAL EXPOSURE, NOT THE LIVE WINDOW
 * splitRetentionWindow divides it: content leaves the live tables at
 * (total - quarantine) days and the quarantine row purges at exactly `total`,
 * so no copy survives the published period. 90 becomes 83 live + 7 quarantine;
 * 7 becomes 4 + 3.
 *
 * EVERY GUARD IS AN ALLOW-LIST
 * A deny-list fails OPEN: the day a migration adds a status, every row sitting
 * in it becomes eligible. An allow-list of states known safe fails CLOSED - an
 * unknown status holds the row, which is under-deletion and recoverable.
 */

/**
 * Letter states in which the content is finished with. Everything else -
 * 'draft', 'queued', 'processing', 'held' - means work is still pending, and
 * letterJobService builds its provider params by reading letters.content.
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
 * Job states that are finished. 'failed' is NOT here: claimJob dispatches on
 * `status IN ('pending','failed')`, and the operator retry route re-enqueues
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

/** Order states that prove a draft was actually PAID for. */
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
 * Order states that prove money definitively did NOT move. Used as a positive
 * allow-list, so an unrecognised status holds rather than qualifying a draft
 * for the shorter unpaid window.
 *
 * 'checkout_pending' is deliberately ABSENT. runCommerceMaintenance refuses to
 * cancel a pending order that still has a Stripe session, because "a completed
 * asynchronous payment may remain unpaid beyond its original expires_at" - so
 * an ACH or SEPA payment can still land days later. Treating pending as
 * never-paid put the only copy of a draft on the 7-day clock and destroyed it
 * the night before the payment arrived (#153 review round 2).
 */
const NEVER_PAID_ORDER_STATUSES: OrderStatus[] = ['cancelled', 'payment_failed'];

/**
 * Ledger source types where real money moved, so an unresolvable funding order
 * must hold the letter. promo, signup_bonus and legacy grants cannot be
 * charged back, so a NULL source_order_id on those is not a hold.
 */
const MONEY_BACKED_SOURCE_TYPES = ['purchase', 'adjustment', 'refund'];

/** The published window for an unsent, never-paid draft. */
const UNPAID_DRAFT_RETENTION_DAYS = 7;

/** Longest recovery window; shortened for short retention periods. */
const MAX_QUARANTINE_DAYS = 7;

const DEFAULT_BATCH_LIMIT = 500;
const MAX_BATCH_LIMIT = 5000;

export interface RetentionSweepResult {
  lettersRedacted: number;
  draftsRedacted: number;
  abandonedDraftsRedacted: number;
  /** Quarantine rows whose recovery window expired and were purged. */
  quarantinePurged: number;
  moreWaiting: boolean;
  /**
   * Error CLASSES, never driver messages. A Postgres primary message routinely
   * embeds the offending value ("invalid input syntax for type uuid: ..."),
   * and this result is logged - #153 forbids cleanup compensating for deleted
   * content by writing it into logs.
   */
  errors: string[];
}

/**
 * Split a published retention period into the live window and the recovery
 * window, so the two sum to exactly the published number. The quarantine is
 * capped at MAX_QUARANTINE_DAYS and at half the period, so a short window
 * still leaves at least a day of each.
 */
export function splitRetentionWindow(totalDays: number): {
  liveDays: number;
  quarantineDays: number;
} {
  const quarantineDays = Math.min(MAX_QUARANTINE_DAYS, Math.max(1, Math.floor(totalDays / 2)));
  return { liveDays: totalDays - quarantineDays, quarantineDays };
}

/**
 * Validated because both are public API on functions that move customer
 * content. A period below 2 cannot be split into a live and a recovery window.
 */
function assertRetentionArgs(totalDays: number, batchLimit: number): void {
  if (!Number.isInteger(totalDays) || totalDays < 2) {
    throw new Error(`retentionDays must be an integer of at least 2, received ${totalDays}`);
  }
  if (!Number.isInteger(batchLimit) || batchLimit < 1 || batchLimit > MAX_BATCH_LIMIT) {
    throw new Error(
      `batchLimit must be an integer in 1..${MAX_BATCH_LIMIT}, received ${batchLimit}`
    );
  }
}

/** Columns the draft sweeps clear, and the shape the quarantine stores them in. */
const DRAFT_CONTENT_COLUMNS = [
  'sender',
  'recipient',
  'body_text',
  'sign_off',
  'preview_html',
  'sender_validation',
  'recipient_validation',
  'front_image_data',
  'front_image_url',
  'header_image_data',
  'header_image_url',
  'inline_image_data',
  'inline_image_url'
] as const;

const DRAFT_QUARANTINE_OBJECT = DRAFT_CONTENT_COLUMNS.map(
  column => `'${column}', to_jsonb(d.${column})`
).join(', ');

/**
 * The SET list that empties a draft. Shared by both draft sweeps so they cannot
 * drift - a column added to one and forgotten in the other would leave content
 * standing on exactly one population, silently.
 *
 * The image blobs are EMPTIED rather than nulled: postcard_requires_image,
 * header_layout_requires_image and inline_layout_requires_image (migrations
 * 012/013) are all `layout != X OR col IS NOT NULL` with NO condition on the
 * row being spent, so a plain NULL violates the constraint and rolls back the
 * whole batch. The CASE preserves NULL where the column was already NULL.
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
 * THE DUE PREDICATES, DEFINED ONCE.
 *
 * Each is shared verbatim between the REPORT path (a plain SELECT) and the
 * ENFORCE path (the destructive CTE). That sharing is the point: a dry run is
 * only evidence if it selects exactly the rows the real sweep would, and two
 * hand-maintained copies would drift on the first edit.
 *
 * Parameters $1..$5 are identical in both paths; the enforce path appends its
 * own LIMIT and quarantine-window parameters after them.
 */
const LETTER_DUE_PREDICATE = `        WHERE l.redacted_at IS NULL
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
                  LEFT JOIN orders o ON o.order_id = lot.source_order_id
                 WHERE txn.reference_type = 'letter'
                   AND txn.type = 'deduction'
                   AND txn.reference_id = l.letter_id
                   AND (
                         lot.status = 'revoked'
                      OR (o.order_id IS NULL AND lot.source_type::text = ANY($5::varchar[]))
                      OR (o.order_id IS NOT NULL AND NOT (o.status = ANY($4::varchar[])))
                       )
              )`;

const PAID_DRAFT_DUE_PREDICATE = `        WHERE d.redacted_at IS NULL
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
              )`;

const ABANDONED_DRAFT_DUE_PREDICATE = `        WHERE d.redacted_at IS NULL
          AND d.created_at < NOW() - make_interval(days => $1::int)
          AND EXISTS (
                SELECT 1 FROM orders o WHERE o.draft_id = d.draft_id
              )
          AND NOT EXISTS (
                SELECT 1 FROM orders o
                 WHERE o.draft_id = d.draft_id
                   AND NOT (o.status = ANY($2::varchar[]))
              )
          AND NOT EXISTS (
                SELECT 1 FROM letter_jobs j
                 WHERE d.consumed_letter_id IS NOT NULL
                   AND j.letter_id = d.consumed_letter_id
                   AND NOT (j.status = ANY($3::varchar[]))
              )`;

export interface RetentionPreview {
  /** Rows past the live window, ignoring every hold. */
  pastWindow: number;
  /** Rows that pass every hold - what an enforcing run would touch. */
  due: number;
  /** pastWindow - due: how much work the holds are actually doing. */
  heldBack: number;
  /** Age in days of the oldest and newest due row, or null when none are due. */
  oldestDueDays: number | null;
  newestDueDays: number | null;
}

const EMPTY_PREVIEW: RetentionPreview = {
  pastWindow: 0,
  due: 0,
  heldBack: 0,
  oldestDueDays: null,
  newestDueDays: null
};

function toPreview(row: Record<string, unknown> | undefined): RetentionPreview {
  if (!row) return EMPTY_PREVIEW;
  const pastWindow = Number(row.past_window ?? 0);
  const due = Number(row.due ?? 0);
  return {
    pastWindow,
    due,
    heldBack: pastWindow - due,
    oldestDueDays:
      row.oldest_due_days === null || row.oldest_due_days === undefined
        ? null
        : Math.floor(Number(row.oldest_due_days)),
    newestDueDays:
      row.newest_due_days === null || row.newest_due_days === undefined
        ? null
        : Math.floor(Number(row.newest_due_days))
  };
}

/**
 * REPORT MODE. Counts what an enforcing run would touch, and writes nothing.
 *
 * These are separate functions rather than a flag inside the destructive
 * statements, deliberately. A boolean guarding an UPDATE is one inverted
 * condition away from destroying data, and three review rounds of this feature
 * have each found exactly that class of defect. A function whose SQL contains
 * no INSERT, UPDATE or DELETE token cannot destroy anything however it is
 * called, and a test can assert that property directly.
 *
 * heldBack is the number worth watching: if the holds catch nothing, or catch
 * everything, the predicates are wrong in a way these counts will show long
 * before any content is removed.
 */
export async function previewExpiredLetterContent(
  retentionDays = 90
): Promise<RetentionPreview> {
  assertRetentionArgs(retentionDays, 1);
  const { liveDays } = splitRetentionWindow(retentionDays);
  const result = await query(
    `SELECT
       (SELECT COUNT(*) FROM letters l
         WHERE l.redacted_at IS NULL
           AND COALESCE(l.sent_at, l.created_at) < NOW() - make_interval(days => $1::int)
       ) AS past_window,
       (SELECT COUNT(*) FROM letters l
${LETTER_DUE_PREDICATE}
       ) AS due,
       (SELECT MAX(EXTRACT(EPOCH FROM (NOW() - COALESCE(l.sent_at, l.created_at))) / 86400)
          FROM letters l
${LETTER_DUE_PREDICATE}
       ) AS oldest_due_days,
       (SELECT MIN(EXTRACT(EPOCH FROM (NOW() - COALESCE(l.sent_at, l.created_at))) / 86400)
          FROM letters l
${LETTER_DUE_PREDICATE}
       ) AS newest_due_days`,
    [
      liveDays,
      REDACTABLE_LETTER_STATUSES,
      SETTLED_JOB_STATUSES,
      SETTLED_ORDER_STATUSES,
      MONEY_BACKED_SOURCE_TYPES
    ]
  );
  return toPreview(result.rows[0] as Record<string, unknown> | undefined);
}

export async function previewPaidDraftContent(retentionDays = 90): Promise<RetentionPreview> {
  assertRetentionArgs(retentionDays, 1);
  const { liveDays } = splitRetentionWindow(retentionDays);
  const result = await query(
    `SELECT
       (SELECT COUNT(*) FROM letter_drafts d
         WHERE d.redacted_at IS NULL
           AND COALESCE(d.consumed_at, d.created_at) < NOW() - make_interval(days => $1::int)
       ) AS past_window,
       (SELECT COUNT(*) FROM letter_drafts d
${PAID_DRAFT_DUE_PREDICATE}
       ) AS due,
       (SELECT MAX(EXTRACT(EPOCH FROM (NOW() - COALESCE(d.consumed_at, d.created_at))) / 86400)
          FROM letter_drafts d
${PAID_DRAFT_DUE_PREDICATE}
       ) AS oldest_due_days,
       (SELECT MIN(EXTRACT(EPOCH FROM (NOW() - COALESCE(d.consumed_at, d.created_at))) / 86400)
          FROM letter_drafts d
${PAID_DRAFT_DUE_PREDICATE}
       ) AS newest_due_days`,
    [liveDays, PAID_ORDER_STATUSES, SETTLED_ORDER_STATUSES, SETTLED_JOB_STATUSES]
  );
  return toPreview(result.rows[0] as Record<string, unknown> | undefined);
}

export async function previewAbandonedDraftContent(
  retentionDays = UNPAID_DRAFT_RETENTION_DAYS
): Promise<RetentionPreview> {
  assertRetentionArgs(retentionDays, 1);
  const { liveDays } = splitRetentionWindow(retentionDays);
  const result = await query(
    `SELECT
       (SELECT COUNT(*) FROM letter_drafts d
         WHERE d.redacted_at IS NULL
           AND d.created_at < NOW() - make_interval(days => $1::int)
       ) AS past_window,
       (SELECT COUNT(*) FROM letter_drafts d
${ABANDONED_DRAFT_DUE_PREDICATE}
       ) AS due,
       (SELECT MAX(EXTRACT(EPOCH FROM (NOW() - d.created_at)) / 86400)
          FROM letter_drafts d
${ABANDONED_DRAFT_DUE_PREDICATE}
       ) AS oldest_due_days,
       (SELECT MIN(EXTRACT(EPOCH FROM (NOW() - d.created_at)) / 86400)
          FROM letter_drafts d
${ABANDONED_DRAFT_DUE_PREDICATE}
       ) AS newest_due_days`,
    [liveDays, NEVER_PAID_ORDER_STATUSES, SETTLED_JOB_STATUSES]
  );
  return toPreview(result.rows[0] as Record<string, unknown> | undefined);
}

/**
 * Anonymize letter content past the live window, saving it to quarantine.
 *
 * THE DISPUTE HOLD HAS TWO ARMS. orders.letter_id is written in exactly one
 * place - mailSendService, inside `if (jitOrder)` - so for a PREPAID letter
 * (the schema default and the majority path) no order row carries its
 * letter_id and an orders-only hold is vacuously true. The second arm walks
 * the credit ledger.
 *
 * The ledger arm LEFT JOINs, deliberately. credit_ledger.source_order_id is
 * NULL for admin comp credits, for the compensating lots minted by
 * returnConsumedCreditsForLetter and compensateDisputedPacks, and for every
 * pre-023 purchase the backfill skipped - all of which are money. An INNER
 * JOIN dropped those rows and RELEASED the hold, which is the failure the arm
 * exists to prevent. A money-backed lot whose order cannot be resolved holds;
 * a promo or signup_bonus lot does not, because no money moved and no
 * chargeback is possible. A revoked lot holds outright: that is the direct
 * signal the money came back.
 */
export async function purgeExpiredLetterContent(
  retentionDays = 90,
  batchLimit = DEFAULT_BATCH_LIMIT
): Promise<number> {
  assertRetentionArgs(retentionDays, batchLimit);
  const { liveDays, quarantineDays } = splitRetentionWindow(retentionDays);
  const result = await query(
    `WITH due AS (
       SELECT l.letter_id
         FROM letters l
${LETTER_DUE_PREDICATE}
        ORDER BY COALESCE(l.sent_at, l.created_at)
        LIMIT $6::int
        FOR UPDATE OF l SKIP LOCKED
     ),
     quarantined AS (
       INSERT INTO redacted_content_quarantine (source_table, source_id, content, purge_after)
       SELECT 'letters',
              l.letter_id,
              jsonb_build_object(
                'content', l.content,
                'recipient', l.recipient,
                'preview_html', to_jsonb(l.preview_html)
              ),
              NOW() + make_interval(days => $7::int)
         FROM letters l
        WHERE l.letter_id IN (SELECT letter_id FROM due)
       ON CONFLICT (source_table, source_id) DO UPDATE
          SET content = EXCLUDED.content,
              quarantined_at = NOW(),
              purge_after = EXCLUDED.purge_after
     )
     UPDATE letters
        SET content = '{}'::jsonb,
            recipient = '{}'::jsonb,
            preview_html = NULL,
            redacted_at = NOW()
      WHERE letter_id IN (SELECT letter_id FROM due)`,
    [
      liveDays,
      REDACTABLE_LETTER_STATUSES,
      SETTLED_JOB_STATUSES,
      SETTLED_ORDER_STATUSES,
      MONEY_BACKED_SOURCE_TYPES,
      batchLimit,
      quarantineDays
    ]
  );
  return result.rowCount ?? 0;
}

/** Anonymize the content of drafts that were actually paid for. */
export async function purgePaidDraftContent(
  retentionDays = 90,
  batchLimit = DEFAULT_BATCH_LIMIT
): Promise<number> {
  assertRetentionArgs(retentionDays, batchLimit);
  const { liveDays, quarantineDays } = splitRetentionWindow(retentionDays);
  const result = await query(
    `WITH due AS (
       SELECT d.draft_id
         FROM letter_drafts d
${PAID_DRAFT_DUE_PREDICATE}
        ORDER BY COALESCE(d.consumed_at, d.created_at)
        LIMIT $5::int
        FOR UPDATE OF d SKIP LOCKED
     ),
     quarantined AS (
       INSERT INTO redacted_content_quarantine (source_table, source_id, content, purge_after)
       SELECT 'letter_drafts', d.draft_id::text,
              jsonb_build_object(${DRAFT_QUARANTINE_OBJECT}),
              NOW() + make_interval(days => $6::int)
         FROM letter_drafts d
        WHERE d.draft_id IN (SELECT draft_id FROM due)
       ON CONFLICT (source_table, source_id) DO UPDATE
          SET content = EXCLUDED.content,
              quarantined_at = NOW(),
              purge_after = EXCLUDED.purge_after
     )
     UPDATE letter_drafts${DRAFT_REDACTION_SET}
      WHERE draft_id IN (SELECT draft_id FROM due)`,
    [
      liveDays,
      PAID_ORDER_STATUSES,
      SETTLED_ORDER_STATUSES,
      SETTLED_JOB_STATUSES,
      batchLimit,
      quarantineDays
    ]
  );
  return result.rowCount ?? 0;
}

/**
 * Anonymize drafts stranded by an ABANDONED CHECKOUT, on the unpaid schedule.
 *
 * These rows can never be deleted, and that is a schema fact: orders.draft_id
 * is `REFERENCES letter_drafts ON DELETE SET NULL` while valid_order_draft is
 * `CHECK ((order_type = 'jit_mail' AND draft_id IS NOT NULL) OR order_type =
 * 'letter_pack')`, so deleting the draft fires the SET NULL, which violates the
 * CHECK. cleanupOldDrafts' `NOT EXISTS (orders)` guard is load-bearing rather
 * than incidental, and it left every abandoned Pay & Send checkout holding a
 * full body and both addresses with nothing to clean it.
 *
 * The never-paid test is a positive allow-list (NEVER_PAID_ORDER_STATUSES), not
 * the absence of a paid status. Phrased as an absence it was a deny-list on the
 * SHORTEST clock, and it fired on 'checkout_pending' - destroying the only copy
 * of a draft whose asynchronous payment had not landed yet.
 */
export async function purgeAbandonedDraftContent(
  retentionDays = UNPAID_DRAFT_RETENTION_DAYS,
  batchLimit = DEFAULT_BATCH_LIMIT
): Promise<number> {
  assertRetentionArgs(retentionDays, batchLimit);
  const { liveDays, quarantineDays } = splitRetentionWindow(retentionDays);
  const result = await query(
    `WITH due AS (
       SELECT d.draft_id
         FROM letter_drafts d
${ABANDONED_DRAFT_DUE_PREDICATE}
        ORDER BY d.created_at
        LIMIT $4::int
        FOR UPDATE OF d SKIP LOCKED
     ),
     quarantined AS (
       INSERT INTO redacted_content_quarantine (source_table, source_id, content, purge_after)
       SELECT 'letter_drafts', d.draft_id::text,
              jsonb_build_object(${DRAFT_QUARANTINE_OBJECT}),
              NOW() + make_interval(days => $5::int)
         FROM letter_drafts d
        WHERE d.draft_id IN (SELECT draft_id FROM due)
       ON CONFLICT (source_table, source_id) DO UPDATE
          SET content = EXCLUDED.content,
              quarantined_at = NOW(),
              purge_after = EXCLUDED.purge_after
     )
     UPDATE letter_drafts${DRAFT_REDACTION_SET}
      WHERE draft_id IN (SELECT draft_id FROM due)`,
    [
      liveDays,
      NEVER_PAID_ORDER_STATUSES,
      SETTLED_JOB_STATUSES,
      batchLimit,
      quarantineDays
    ]
  );
  return result.rowCount ?? 0;
}

/**
 * Expire the recovery window.
 *
 * This is the statement that finally destroys content, and it is deliberately
 * the simplest one in the module: one table, one column, one direction, no
 * joins, no status lists, nothing that a future migration can invalidate. All
 * the judgement lives upstream in the sweeps, where a mistake is recoverable.
 */
export async function purgeExpiredQuarantine(batchLimit = DEFAULT_BATCH_LIMIT): Promise<number> {
  assertRetentionArgs(2, batchLimit);
  const result = await query(
    `DELETE FROM redacted_content_quarantine
      WHERE quarantine_id IN (
            SELECT quarantine_id
              FROM redacted_content_quarantine
             WHERE purge_after <= NOW()
             ORDER BY purge_after
             LIMIT $1::int
          )`,
    [batchLimit]
  );
  return result.rowCount ?? 0;
}

/**
 * Put a quarantined row's content back and re-open it to a future sweep.
 *
 * The recovery path that makes every allow-list bet above survivable. Returns
 * false when the recovery window has already expired, so a caller can tell
 * "restored" from "too late" without reading the table.
 */
export async function restoreQuarantinedContent(
  sourceTable: 'letters' | 'letter_drafts',
  sourceId: string
): Promise<boolean> {
  if (sourceTable === 'letters') {
    const result = await query(
      `WITH saved AS (
         SELECT content FROM redacted_content_quarantine
          WHERE source_table = 'letters' AND source_id = $1
       )
       UPDATE letters l
          SET content = (SELECT content->'content' FROM saved),
              recipient = (SELECT content->'recipient' FROM saved),
              preview_html = (SELECT content->>'preview_html' FROM saved),
              redacted_at = NULL
        WHERE l.letter_id = $1 AND EXISTS (SELECT 1 FROM saved)`,
      [sourceId]
    );
    if ((result.rowCount ?? 0) === 0) return false;
  } else {
    const assignments = DRAFT_CONTENT_COLUMNS.map(column =>
      column === 'sender' ||
      column === 'recipient' ||
      column === 'sender_validation' ||
      column === 'recipient_validation'
        ? `${column} = (SELECT content->'${column}' FROM saved)`
        : `${column} = (SELECT content->>'${column}' FROM saved)`
    ).join(',\n              ');
    const result = await query(
      `WITH saved AS (
         SELECT content FROM redacted_content_quarantine
          WHERE source_table = 'letter_drafts' AND source_id = $1
       )
       UPDATE letter_drafts d
          SET ${assignments},
              redacted_at = NULL
        WHERE d.draft_id = $1::uuid AND EXISTS (SELECT 1 FROM saved)`,
      [sourceId]
    );
    if ((result.rowCount ?? 0) === 0) return false;
  }
  await query(
    `DELETE FROM redacted_content_quarantine WHERE source_table = $1 AND source_id = $2`,
    [sourceTable, sourceId]
  );
  return true;
}

export interface RetentionPreviewResult {
  letters: RetentionPreview;
  paidDrafts: RetentionPreview;
  abandonedDrafts: RetentionPreview;
  errors: string[];
}

/**
 * One REPORT pass: what an enforcing run would touch, without touching it.
 *
 * This is the default mode. Retention has been through three review rounds,
 * each of which found the predicates selecting rows they should not have, so
 * the sensible order is to let production tell us what the predicates actually
 * match before anything acts on them. Nothing here writes.
 */
export async function runRetentionPreview(
  retentionDays = 90
): Promise<RetentionPreviewResult> {
  const errors: string[] = [];
  const run = async (label: string, task: () => Promise<RetentionPreview>) => {
    try {
      return await task();
    } catch (error) {
      errors.push(`${label}:${classifyDiagnosticError(error, 'unknown_error')}`);
      return EMPTY_PREVIEW;
    }
  };

  return {
    letters: await run('letters', () => previewExpiredLetterContent(retentionDays)),
    paidDrafts: await run('paid_drafts', () => previewPaidDraftContent(retentionDays)),
    abandonedDrafts: await run('abandoned_drafts', () =>
      previewAbandonedDraftContent(UNPAID_DRAFT_RETENTION_DAYS)
    ),
    errors
  };
}

/**
 * One retention pass.
 *
 * The sweeps are isolated from each other: they cover independent published
 * obligations, so a failure in one must not stop the others. Errors carry a
 * CLASS, never a driver message, because this result is logged.
 */
export async function runRetentionSweep(
  retentionDays = 90,
  batchLimit = DEFAULT_BATCH_LIMIT
): Promise<RetentionSweepResult> {
  const errors: string[] = [];
  const counts = { letters: 0, drafts: 0, abandoned: 0, quarantine: 0 };

  const run = async (label: string, task: () => Promise<number>): Promise<number> => {
    try {
      return await task();
    } catch (error) {
      errors.push(`${label}:${classifyDiagnosticError(error, 'unknown_error')}`);
      return 0;
    }
  };

  counts.letters = await run('letters', () =>
    purgeExpiredLetterContent(retentionDays, batchLimit)
  );
  counts.drafts = await run('paid_drafts', () =>
    purgePaidDraftContent(retentionDays, batchLimit)
  );
  // The unpaid window is its own published number, not the caller's.
  counts.abandoned = await run('abandoned_drafts', () =>
    purgeAbandonedDraftContent(UNPAID_DRAFT_RETENTION_DAYS, batchLimit)
  );
  counts.quarantine = await run('quarantine', () => purgeExpiredQuarantine(batchLimit));

  return {
    lettersRedacted: counts.letters,
    draftsRedacted: counts.drafts,
    abandonedDraftsRedacted: counts.abandoned,
    quarantinePurged: counts.quarantine,
    moreWaiting:
      counts.letters >= batchLimit ||
      counts.drafts >= batchLimit ||
      counts.abandoned >= batchLimit ||
      counts.quarantine >= batchLimit ||
      errors.length > 0,
    errors
  };
}
