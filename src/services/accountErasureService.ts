import {
  MAX_OPERATION_ATTEMPTS,
  enqueueAdminOperation,
  processAdminOperations,
  type OperationResult,
  type SqlClient
} from './adminOperationsQueue.js';
import {
  DRAFT_REDACTION_SET,
  REDACTABLE_LETTER_STATUSES,
  SETTLED_JOB_STATUSES,
  SETTLED_ORDER_STATUSES
} from './retentionService.js';

/**
 * Account erasure (#289, docs/account-erasure.md).
 *
 * ANONYMISE, DO NOT DELETE
 * The owner's decision (#289, 2026-09-23): orders, ledger and transaction rows,
 * disputes, refunds and the admin audit trail are kept for accounting, without
 * personal details. Letter content and addresses, drafts, uploads, the saved
 * return address, access tokens, feature requests and unredeemed gift codes go.
 * The users row stays as a tombstone so the kept rows keep their foreign keys,
 * and nothing is deleted through the orders cascade, so migration 027's
 * attribution guard never fires.
 *
 * TWO HALVES, TWO DATABASE ROLES
 * The admin command (account.erase) previews the account and QUEUES the
 * erasure as an admin_operations row. It runs as the panel's operator role,
 * which is deliberately unable to touch an email, an address or a letter's
 * content (src/admin/provisioning.ts), and this keeps it that way. The hourly
 * maintenance run carries the erasure out as the database owner, the role the
 * retention sweep already scrubs content with. So the panel gains no power to
 * rewrite customer data; it can only ask for a whole account to be erased,
 * with a preview, elevation, a typed phrase and an audit row in front of it.
 *
 * THE GATE
 * Nothing is erased while money or mail is still moving: an open checkout, a
 * paid order not yet mailed, a letter or job still on its way, an open
 * dispute, a refund in progress or an image generation in flight. The preview
 * shows the gate and the command refuses on it; the worker reads it again
 * under the account's locks, because the account can change in the hour
 * between the two. Every list is an allow-list of FINISHED states, shared with
 * the retention sweep, so a status added by a later migration holds an account
 * back rather than letting it through.
 *
 * WHAT IS LEFT BY HAND
 * The Auth0 user with the account's id, and the id in the beta and admin
 * lists, are an operator's to remove (docs/account-erasure.md): no service
 * holds a credential that can delete Auth0 users (#453, #454). So the erasure
 * opens an operator alert in the transaction that writes the tombstone, and
 * it stays open until someone has done them and resolves it.
 */

/** admin_operations.operation_type for an erasure. */
export const ACCOUNT_ERASE_OPERATION = 'account.erase';

/**
 * commerce_operational_alerts.alert_type of the alert an erasure leaves for
 * the operator (migration 036). Its details carry the account id and nothing
 * else.
 */
export const ERASURE_FOLLOWUP_ALERT = 'account_erasure_followup';

/** The resolution code the panel offers for that alert. */
export const ERASURE_FOLLOWUP_RESOLUTION = 'auth0_user_deleted';

/**
 * The tombstone's placeholder address, as a LIKE pattern. Migration 035's
 * users_erased_tombstone requires it of every erased row, which is what lets
 * the panel tell an erased account from the email column it can read, without
 * a grant on erased_at.
 */
export const ERASED_EMAIL_PATTERN = 'erased-%@erased.invalid';

/** Refunds that are over; any other status is still moving money. */
const SETTLED_PACK_REFUND_STATUSES = ['succeeded', 'failed', 'compensated'];

/** Image generations that are over. */
const SETTLED_RESERVATION_STATUSES = ['consumed', 'released'];

/**
 * An unexpected failure is retried on the next runs, up to this many attempts
 * in all, an hour apart (src/services/adminOperationsQueue.ts). A refusal by
 * the gate is not retried: an open dispute can take months, and the operator
 * re-queues when it settles.
 */
export const MAX_ERASURE_ATTEMPTS = MAX_OPERATION_ATTEMPTS;

/** Operations handled per maintenance run. */
const DEFAULT_ERASURE_BATCH = 5;

export interface ErasureBlockers {
  ordersInFlight: number;
  lettersInFlight: number;
  jobsInFlight: number;
  disputesOpen: number;
  refundsInFlight: number;
  imagesInFlight: number;
}

export function erasureBlocked(blockers: ErasureBlockers): boolean {
  return Object.values(blockers).some((count) => count > 0);
}

/**
 * What stops an erasure, counted.
 *
 * Readable by the admin reader role, which runs the preview: every column named
 * here is in its grants.
 *
 * A failed job holds the account only while the outbox would send it again on
 * its own: claimJob retries a failed job that never reached the provider and
 * has attempts left (src/services/letterJobService.ts). Any other failed job is
 * finished unless an operator retries it, and the erasure cancels it so that
 * nobody can: a retry after the scrub would mail an empty letter.
 *
 * A DISPUTED order never leaves that status: charge.dispute.closed writes it
 * again rather than restoring the order's earlier one (commerceService). So a
 * disputed order counts as settled once every dispute on its payment is closed,
 * won or lost. One with no dispute record at all still holds: that is a state
 * this cannot explain, and holding is the recoverable mistake (#446 review).
 */
export async function readErasureBlockers(client: SqlClient, userId: string): Promise<ErasureBlockers> {
  const result = await client.query(
    `SELECT
       (SELECT COUNT(o.order_id) FROM orders o
         WHERE o.user_id = $1
           AND NOT (o.status = ANY($2::varchar[]))
           AND NOT (
                 o.status = 'disputed'
             AND EXISTS (SELECT 1 FROM stripe_disputes d
                          WHERE d.payment_intent_id = o.stripe_payment_intent_id)
             AND NOT EXISTS (SELECT 1 FROM stripe_disputes d
                              WHERE d.payment_intent_id = o.stripe_payment_intent_id
                                AND d.resolved_at IS NULL)
               ))::int AS orders_in_flight,
       (SELECT COUNT(l.letter_id) FROM letters l
         WHERE l.user_id = $1
           AND NOT (l.status = ANY($3::varchar[])))::int AS letters_in_flight,
       (SELECT COUNT(j.job_id) FROM letter_jobs j
          JOIN letters l ON l.letter_id = j.letter_id
         WHERE l.user_id = $1
           AND NOT (j.status = ANY($4::varchar[]))
           AND NOT (
                 j.status = 'failed'
             AND NOT (j.provider_outcome = 'not_dispatched' AND j.attempts < j.max_attempts)
               ))::int AS jobs_in_flight,
       (SELECT COUNT(d.dispute_id) FROM stripe_disputes d
         WHERE d.resolved_at IS NULL
           AND (d.user_id = $1
                OR d.payment_intent_id IN (
                     SELECT o.stripe_payment_intent_id FROM orders o
                      WHERE o.user_id = $1 AND o.stripe_payment_intent_id IS NOT NULL
                   )))::int AS disputes_open,
       (SELECT COUNT(r.pack_refund_id) FROM commerce_pack_refunds r
         WHERE r.user_id = $1
           AND NOT (r.status = ANY($5::varchar[])))::int AS refunds_in_flight,
       (SELECT COUNT(g.reservation_id) FROM image_generation_reservations g
         WHERE g.user_id = $1
           AND NOT (g.status = ANY($6::varchar[])))::int AS images_in_flight`,
    [
      userId,
      SETTLED_ORDER_STATUSES,
      REDACTABLE_LETTER_STATUSES,
      SETTLED_JOB_STATUSES,
      SETTLED_PACK_REFUND_STATUSES,
      SETTLED_RESERVATION_STATUSES
    ]
  );
  const row = result.rows[0] ?? {};
  return {
    ordersInFlight: Number(row.orders_in_flight ?? 0),
    lettersInFlight: Number(row.letters_in_flight ?? 0),
    jobsInFlight: Number(row.jobs_in_flight ?? 0),
    disputesOpen: Number(row.disputes_open ?? 0),
    refundsInFlight: Number(row.refunds_in_flight ?? 0),
    imagesInFlight: Number(row.images_in_flight ?? 0)
  };
}

export interface ErasureScope {
  letters: number;
  draftsToDelete: number;
  draftsToScrub: number;
  savedCopies: number;
  accessTokens: number;
  featureRequests: number;
  unredeemedGiftCodes: number;
  seedCodeEmails: number;
  failedJobsToCancel: number;
  ordersKept: number;
  unusedGiftLetters: number;
  /** Open operational alerts on the account's orders, such as compensation still owed after a dispute. */
  openAlerts: number;
}

/**
 * What an erasure would remove and what it keeps, counted for the preview.
 * Counts only, and only columns the reader role holds: the preview's summary
 * is signed and written to the audit trail.
 */
export async function readErasureScope(client: SqlClient, userId: string): Promise<ErasureScope> {
  const result = await client.query(
    `SELECT
       (SELECT COUNT(l.letter_id) FROM letters l WHERE l.user_id = $1)::int AS letters,
       (SELECT COUNT(d.draft_id) FROM letter_drafts d
         WHERE d.user_id = $1
           AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.draft_id = d.draft_id))::int AS drafts_to_delete,
       (SELECT COUNT(d.draft_id) FROM letter_drafts d
         WHERE d.user_id = $1
           AND EXISTS (SELECT 1 FROM orders o WHERE o.draft_id = d.draft_id))::int AS drafts_to_scrub,
       (SELECT COUNT(q.quarantine_id) FROM redacted_content_quarantine q
         WHERE (q.source_table = 'letters'
                AND q.source_id IN (SELECT l.letter_id FROM letters l WHERE l.user_id = $1))
            OR (q.source_table = 'letter_drafts'
                AND q.source_id IN (SELECT d.draft_id::text FROM letter_drafts d WHERE d.user_id = $1)))::int AS saved_copies,
       (SELECT COUNT(t.token_id) FROM personal_access_tokens t WHERE t.user_id = $1)::int AS access_tokens,
       (SELECT COUNT(f.request_id) FROM feature_requests f WHERE f.user_id = $1)::int AS feature_requests,
       (SELECT COUNT(c.code) FROM gift_codes c
         WHERE c.issued_to_user_id = $1 AND c.status = 'issued')::int AS unredeemed_gift_codes,
       (SELECT COUNT(r.campaign_id) FROM promo_redemptions r
         WHERE r.user_id = $1 AND r.email_normalized IS NOT NULL)::int AS seed_code_emails,
       (SELECT COUNT(j.job_id) FROM letter_jobs j
          JOIN letters l ON l.letter_id = j.letter_id
         WHERE l.user_id = $1 AND j.status = 'failed')::int AS failed_jobs_to_cancel,
       (SELECT COUNT(o.order_id) FROM orders o WHERE o.user_id = $1)::int AS orders_kept,
       (SELECT COUNT(g.gift_id) FROM gift_letters g
         WHERE g.user_id = $1 AND g.status = 'available')::int AS unused_gift_letters,
       (SELECT COUNT(a.alert_id) FROM commerce_operational_alerts a
          JOIN orders o ON o.order_id = a.order_id
         WHERE o.user_id = $1 AND a.status <> 'resolved')::int AS open_alerts`,
    [userId]
  );
  const row = result.rows[0] ?? {};
  return {
    letters: Number(row.letters ?? 0),
    draftsToDelete: Number(row.drafts_to_delete ?? 0),
    draftsToScrub: Number(row.drafts_to_scrub ?? 0),
    savedCopies: Number(row.saved_copies ?? 0),
    accessTokens: Number(row.access_tokens ?? 0),
    featureRequests: Number(row.feature_requests ?? 0),
    unredeemedGiftCodes: Number(row.unredeemed_gift_codes ?? 0),
    seedCodeEmails: Number(row.seed_code_emails ?? 0),
    failedJobsToCancel: Number(row.failed_jobs_to_cancel ?? 0),
    ordersKept: Number(row.orders_kept ?? 0),
    unusedGiftLetters: Number(row.unused_gift_letters ?? 0),
    openAlerts: Number(row.open_alerts ?? 0)
  };
}

/**
 * Queue an erasure: the command's whole write, inside the runner's transaction
 * on the operator role. command_id is UNIQUE and references the run row the
 * runner has just written, so one confirmation queues exactly one erasure.
 */
export async function enqueueAccountErasure(
  client: SqlClient,
  params: { commandId: string; environment: string; userId: string }
): Promise<string> {
  return enqueueAdminOperation(client, {
    commandId: params.commandId,
    environment: params.environment,
    operationType: ACCOUNT_ERASE_OPERATION,
    payload: { userId: params.userId }
  });
}

/**
 * Whether the account is an erased tombstone, or null when there is no such
 * account. The comparison happens in SQL, so the address never leaves the
 * database; a reopened account has a real address again and reads false.
 */
export async function readAccountErased(client: SqlClient, userId: string): Promise<boolean | null> {
  const result = await client.query(
    `SELECT email LIKE $2 AS erased FROM users WHERE user_id = $1`,
    [userId, ERASED_EMAIL_PATTERN]
  );
  const row = result.rows[0];
  return row ? row.erased === true : null;
}

export interface ErasureOperationView {
  operationId: string;
  status: string;
  attempts: number;
  requestedAt: Date;
  completedAt: Date | null;
  errorCode: string | null;
  result: Record<string, unknown> | null;
}

/** The newest erasure queued for an account, or null. Reader-safe. */
export async function readLatestErasure(client: SqlClient, userId: string): Promise<ErasureOperationView | null> {
  const result = await client.query(
    `SELECT o.id, o.status, o.attempts, r.requested_at, o.completed_at, o.error_code,
            o.sanitized_result_json
       FROM admin_operations o
       JOIN admin_command_runs r ON r.id = o.command_id
      WHERE o.operation_type = $1
        AND o.payload_json->>'userId' = $2
      ORDER BY r.requested_at DESC, o.id DESC
      LIMIT 1`,
    [ACCOUNT_ERASE_OPERATION, userId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    operationId: String(row.id),
    status: String(row.status),
    attempts: Number(row.attempts),
    requestedAt: row.requested_at,
    completedAt: row.completed_at ?? null,
    errorCode: row.error_code ?? null,
    result: row.sanitized_result_json ?? null
  };
}

export interface ErasureFollowupView {
  alertId: string;
  status: string;
  resolvedAt: Date | null;
  resolutionCode: string | null;
}

/**
 * The newest follow-up alert an erasure of this account opened, or null: none
 * for an account erased before migration 036. Reader-safe.
 */
export async function readErasureFollowup(client: SqlClient, userId: string): Promise<ErasureFollowupView | null> {
  const result = await client.query(
    `SELECT alert_id, status, resolved_at, resolution_code
       FROM commerce_operational_alerts
      WHERE alert_type = $1
        AND details->>'userId' = $2
      ORDER BY created_at DESC, alert_id DESC
      LIMIT 1`,
    [ERASURE_FOLLOWUP_ALERT, userId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    alertId: String(row.alert_id),
    status: String(row.status),
    resolvedAt: row.resolved_at ?? null,
    resolutionCode: row.resolution_code ?? null
  };
}

export interface ErasureCounts {
  lettersScrubbed: number;
  jobsCancelled: number;
  draftsScrubbed: number;
  draftsDeleted: number;
  savedCopiesDeleted: number;
  accessTokensDeleted: number;
  uploadsDeleted: number;
  featureRequestsDeleted: number;
  seedCodeEmailsCleared: number;
  giftCodesDeleted: number;
  descriptionsCleared: number;
}

export type ErasureOutcome =
  | { outcome: 'erased'; counts: ErasureCounts }
  | { outcome: 'blocked'; blockers: ErasureBlockers }
  | { outcome: 'not_found' }
  | { outcome: 'already_erased' };

/**
 * Erase one account, inside the caller's transaction, as the database owner.
 *
 * Locks first, in the canonical order (src/services/accountLock.ts): orders,
 * letters, letter_jobs, image_generation_reservations, then the account row,
 * and the gate is read after the account row is locked. What that guarantees,
 * and what it does not (#446 review):
 *   - a send or fulfilment that reaches the account row after this took it
 *     waits, and then finds the account blocked (the tombstone sets a send
 *     block) or its caller refused at sign-in;
 *   - a checkout's order insert waits for the account row this holds FOR
 *     UPDATE, and the checkout reads the account again after it
 *     (commerceService's assertAccountMayPurchase), so a checkout caught in
 *     this window is refused and opens no order (#449). That depends on the
 *     row being locked FOR UPDATE BEFORE the gate is read: with a weaker lock
 *     there (FOR NO KEY UPDATE, or none), a checkout could insert and commit
 *     between the gate and the tombstone, and the window would reopen;
 *   - one that already holds its draft when this runs can deadlock with it
 *     instead, because the send paths take the draft first and no order
 *     serves both. PostgreSQL aborts one side. If it is this one, the worker
 *     rolls back to its savepoint and tries again at the next run without
 *     spending an attempt; the gate then sees whatever the send left behind.
 *   - a tool call already past sign-in when this commits can still write one
 *     draft to the tombstone. Nothing reads it, and the draft cleanup deletes
 *     it within about eight days (expired a day after its expiry, deleted a
 *     week after that).
 *
 * Order within the writes matters in one place: the saved copies are found
 * through the drafts, so they are deleted before the drafts are.
 */
export async function eraseAccountWithClient(client: SqlClient, userId: string): Promise<ErasureOutcome> {
  await client.query(`SELECT order_id FROM orders WHERE user_id = $1 ORDER BY order_id FOR UPDATE`, [userId]);
  await client.query(`SELECT letter_id FROM letters WHERE user_id = $1 ORDER BY letter_id FOR UPDATE`, [userId]);
  await client.query(
    `SELECT j.job_id FROM letter_jobs j JOIN letters l ON l.letter_id = j.letter_id
      WHERE l.user_id = $1 ORDER BY j.job_id FOR UPDATE OF j`,
    [userId]
  );
  await client.query(
    `SELECT reservation_id FROM image_generation_reservations WHERE user_id = $1
      ORDER BY reservation_id FOR UPDATE`,
    [userId]
  );
  const account = await client.query(`SELECT erased_at FROM users WHERE user_id = $1 FOR UPDATE`, [userId]);
  if (account.rows.length === 0) return { outcome: 'not_found' };
  if (account.rows[0].erased_at) return { outcome: 'already_erased' };

  const blockers = await readErasureBlockers(client, userId);
  if (erasureBlocked(blockers)) return { outcome: 'blocked', blockers };

  // Straight to deletion, not through the quarantine: the quarantine exists to
  // keep a copy, and valid_quarantine_window forbids an empty window.
  const savedCopies = await client.query(
    `DELETE FROM redacted_content_quarantine q
      WHERE (q.source_table = 'letters'
             AND q.source_id IN (SELECT l.letter_id FROM letters l WHERE l.user_id = $1))
         OR (q.source_table = 'letter_drafts'
             AND q.source_id IN (SELECT d.draft_id::text FROM letter_drafts d WHERE d.user_id = $1))`,
    [userId]
  );
  // Every letter, sent or not: the gate has already held back any still on its
  // way. redacted_at keeps the retention sweep from quarantining the empty row.
  const letters = await client.query(
    `UPDATE letters
        SET content = '{}'::jsonb,
            recipient = '{}'::jsonb,
            preview_html = NULL,
            redacted_at = COALESCE(redacted_at, NOW()),
            updated_at = NOW()
      WHERE user_id = $1`,
    [userId]
  );
  // The failed jobs the gate let through are the ones only an operator could
  // send again. Cancelled is allowed for both of a failed job's outcomes
  // (valid_letter_job_outcome_state), so this cannot trip the constraint.
  const jobs = await client.query(
    `UPDATE letter_jobs j
        SET status = 'cancelled',
            completed_at = COALESCE(j.completed_at, NOW()),
            locked_at = NULL,
            operator_resolution = 'account_erased',
            resolved_at = NOW(),
            updated_at = NOW()
       FROM letters l
      WHERE l.letter_id = j.letter_id
        AND l.user_id = $1
        AND j.status = 'failed'`,
    [userId]
  );
  // A draft an order points at cannot be deleted: orders.draft_id is ON DELETE
  // SET NULL and valid_order_draft requires it on a Pay & Send order. Those are
  // emptied with the retention sweep's own SET list; the rest are deleted.
  const draftsScrubbed = await client.query(
    `UPDATE letter_drafts d${DRAFT_REDACTION_SET}
      WHERE d.user_id = $1
        AND EXISTS (SELECT 1 FROM orders o WHERE o.draft_id = d.draft_id)`,
    [userId]
  );
  const draftsDeleted = await client.query(
    `DELETE FROM letter_drafts d
      WHERE d.user_id = $1
        AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.draft_id = d.draft_id)`,
    [userId]
  );
  // A dead link once the gate has passed (no checkout is left open), but a
  // link into a Stripe session all the same, and readable by the panel.
  await client.query(
    `UPDATE orders SET checkout_url = NULL WHERE user_id = $1 AND checkout_url IS NOT NULL`,
    [userId]
  );
  const tokens = await client.query(`DELETE FROM personal_access_tokens WHERE user_id = $1`, [userId]);
  const uploads = await client.query(`DELETE FROM recent_uploads WHERE user_id = $1`, [userId]);
  const requests = await client.query(`DELETE FROM feature_requests WHERE user_id = $1`, [userId]);
  // The address a seed code was claimed with. Clearing it frees that address
  // to claim the same campaign once more from a new account, which is the
  // price of not keeping it.
  const seedEmails = await client.query(
    `UPDATE promo_redemptions SET email_normalized = NULL
      WHERE user_id = $1 AND email_normalized IS NOT NULL`,
    [userId]
  );
  // Only codes nobody has redeemed. A redeemed code records the gift another
  // account received, and holds nothing personal.
  const giftCodes = await client.query(
    `DELETE FROM gift_codes WHERE issued_to_user_id = $1 AND status = 'issued'`,
    [userId]
  );
  // Both descriptions are derived labels today, but rows written before #162
  // can still hold a recipient's name or an operator's reason (migration 030
  // rewrote only the shapes it recognised). Nothing reads them for an erased
  // account, so they are cleared rather than rewritten.
  const transactionDescriptions = await client.query(
    `UPDATE credit_transactions SET description = NULL
      WHERE user_id = $1 AND description IS NOT NULL`,
    [userId]
  );
  const lotDescriptions = await client.query(
    `UPDATE credit_ledger SET description = NULL
      WHERE user_id = $1 AND description IS NOT NULL`,
    [userId]
  );
  // Last, so everything above still finds the account. The placeholder is
  // unique, derived from nothing, and on a reserved domain nobody can register
  // (RFC 2606). The send block stops a send that was already waiting on this
  // row; COALESCE keeps a dispute's block and its reason.
  await client.query(
    `UPDATE users
        SET email = 'erased-' || gen_random_uuid()::text || '@erased.invalid',
            return_address = NULL,
            return_address_validated_at = NULL,
            sends_blocked_at = COALESCE(sends_blocked_at, NOW()),
            sends_blocked_reason = COALESCE(sends_blocked_reason, 'account_erased'),
            erased_at = NOW(),
            updated_at = NOW()
      WHERE user_id = $1`,
    [userId]
  );
  // In this transaction, so the alert exists exactly when the erasure
  // committed: a refusal, a rollback to the savepoint or an account erased by
  // an earlier run raises none. The id is all it carries; the steps are on its
  // page (#453).
  await client.query(
    `INSERT INTO commerce_operational_alerts (alert_type, severity, details)
     VALUES ($1, 'warning', jsonb_build_object('userId', $2::text))`,
    [ERASURE_FOLLOWUP_ALERT, userId]
  );

  return {
    outcome: 'erased',
    counts: {
      lettersScrubbed: letters.rowCount ?? 0,
      jobsCancelled: jobs.rowCount ?? 0,
      draftsScrubbed: draftsScrubbed.rowCount ?? 0,
      draftsDeleted: draftsDeleted.rowCount ?? 0,
      savedCopiesDeleted: savedCopies.rowCount ?? 0,
      accessTokensDeleted: tokens.rowCount ?? 0,
      uploadsDeleted: uploads.rowCount ?? 0,
      featureRequestsDeleted: requests.rowCount ?? 0,
      seedCodeEmailsCleared: seedEmails.rowCount ?? 0,
      giftCodesDeleted: giftCodes.rowCount ?? 0,
      descriptionsCleared: (transactionDescriptions.rowCount ?? 0) + (lotDescriptions.rowCount ?? 0)
    }
  };
}

export interface AccountErasureRunSummary {
  erased: number;
  refused: number;
  retrying: number;
  failed: number;
}

/**
 * Carry out queued erasures: the maintenance half, through the shared runner
 * (src/services/adminOperationsQueue.ts), which claims each operation, runs
 * the erasure under a savepoint and records the outcome in one transaction.
 */
export async function processAccountErasures(
  batchLimit = DEFAULT_ERASURE_BATCH
): Promise<AccountErasureRunSummary> {
  const summary = await processAdminOperations(
    {
      operationType: ACCOUNT_ERASE_OPERATION,
      errorCode: 'ACCOUNT_ERASURE_ERROR',
      event: 'account_erasure',
      handle: handleAccountErasure
    },
    batchLimit
  );
  return { erased: summary.done, refused: summary.refused, retrying: summary.retrying, failed: summary.failed };
}

/** One queued erasure, as the database owner, inside the runner's savepoint. */
export async function handleAccountErasure(client: SqlClient, payload: unknown): Promise<OperationResult> {
  const payloadUser = (payload as { userId?: unknown } | null)?.userId;
  const userId = typeof payloadUser === 'string' && payloadUser.length > 0 ? payloadUser : null;
  const outcome: ErasureOutcome =
    userId !== null ? await eraseAccountWithClient(client, userId) : { outcome: 'not_found' };
  switch (outcome.outcome) {
    case 'erased':
      return { outcome: 'done', result: { ...outcome.counts }, diagnostic: { alreadyErased: false } };
    case 'already_erased':
      return { outcome: 'done', result: { alreadyErased: true }, diagnostic: { alreadyErased: true } };
    case 'blocked':
      return { outcome: 'refused', code: 'ACCOUNT_ERASURE_BLOCKED', result: { ...outcome.blockers } };
    default:
      return { outcome: 'refused', code: 'ACCOUNT_ERASURE_NOT_FOUND', result: {} };
  }
}
