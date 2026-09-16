-- 032: take raw error text and operator reasons out of the columns operators read (#394).
--
-- Migration 031 took the provider's message out of the three provider-error
-- columns. Other writers still stored prose: the JIT fulfilment, recovery and
-- refund catches wrote error.message into orders.last_error (a draft error
-- interpolates the draft id, a SQL error quotes values), the
-- jit.fulfillment_rejected event carried the same text, refund.requested and
-- operator.quarantine_released events carried an operator's or the sweep's
-- "reason", pre-023 outbox failures kept unclassified text, pack-refund
-- failures kept 80 characters of Stripe's message in three places, and
-- maintenance_tasks.last_error kept the driver's message. The code now writes
-- a class at every one of those sites; this rewrites the historic rows.
--
-- 'error_text_removed' is a migration-only label: code never writes it, so a
-- backfilled row stays distinguishable from a live unknown_error. Like 030 and
-- 031 the overwrite is deliberate and irreversible, and every statement is
-- idempotent: a rewritten value has no whitespace, or no longer has the key,
-- and so no longer matches.

-- 1. orders: prose under the codes that carried it. Every draft and JIT-order
--    check that mailSendService can throw inside the fulfilment savepoints, and
--    the outbox's missing-letter check, keeps its code, which is what the live
--    path writes now; anything else becomes the label. Rows already holding a
--    class (no whitespace), the 031 provider form and the sweep's fixed sentence
--    are left alone. The specific shapes come before the generic
--    "Draft <id> is <status>" and "Order <id> is <status>" ones.
UPDATE orders
   SET last_error = CASE
         WHEN last_error ~ '^Draft not found: '                                    THEN 'DRAFT_NOT_FOUND'
         WHEN last_error ~ '^Draft expired: '                                      THEN 'DRAFT_EXPIRED'
         WHEN last_error ~ '^Draft was cancelled: '                                THEN 'DRAFT_CANCELLED'
         WHEN last_error ~ '^Draft \S+ does not belong to (this )?user'            THEN 'DRAFT_NOT_OWNED'
         WHEN last_error ~ '^Draft \S+ is a \S+, not a \S+$'                       THEN 'DRAFT_WRONG_MAIL_TYPE'
         WHEN last_error ~ '^Draft \S+ (has no linked mail item|links to missing mail)$' THEN 'DRAFT_INCOMPLETE'
         WHEN last_error ~ '^Draft \S+ was already consumed by different funding$' THEN 'DRAFT_FUNDING_CONFLICT'
         WHEN last_error ~ '^Draft \S+ is \S+$'                                    THEN 'DRAFT_INVALID_STATE'
         WHEN last_error ~ '^Order not found: '                                    THEN 'JIT_ORDER_NOT_FOUND'
         WHEN last_error ~ '^Order \S+ is not a JIT order$'                        THEN 'JIT_ORDER_INVALID'
         WHEN last_error = 'JIT order ownership or draft binding does not match'   THEN 'JIT_ORDER_NOT_OWNED'
         WHEN last_error ~ '^Order \S+ is \S+$'                                    THEN 'JIT_ORDER_NOT_PAID'
         WHEN last_error ~ '^Letter not found for outbox job: '                    THEN 'LETTER_NOT_FOUND'
         ELSE 'error_text_removed' END,
       updated_at = NOW()
 WHERE last_error_code IN ('JIT_FULFILLMENT_REJECTED', 'RECOVERY_FAILED',
                           'REFUND_REQUEST_FAILED', 'PROVIDER_SUBMISSION_FAILED')
   AND last_error ~ '\s'
   AND last_error !~ '^provider_rejected'
   AND last_error <> 'Pre-provider fulfillment failure';

-- 2. jit.fulfillment_rejected: the same prose under metadata->'error', mapped
--    the same way. The event now carries errorClass, as provider.terminal_failure
--    has since 031.
UPDATE commerce_order_events
   SET metadata = (metadata - 'error')
                  || jsonb_build_object('errorClass', CASE
                       WHEN metadata->>'error' ~ '^Draft not found: '                                    THEN 'DRAFT_NOT_FOUND'
                       WHEN metadata->>'error' ~ '^Draft expired: '                                      THEN 'DRAFT_EXPIRED'
                       WHEN metadata->>'error' ~ '^Draft was cancelled: '                                THEN 'DRAFT_CANCELLED'
                       WHEN metadata->>'error' ~ '^Draft \S+ does not belong to (this )?user'            THEN 'DRAFT_NOT_OWNED'
                       WHEN metadata->>'error' ~ '^Draft \S+ is a \S+, not a \S+$'                       THEN 'DRAFT_WRONG_MAIL_TYPE'
                       WHEN metadata->>'error' ~ '^Draft \S+ (has no linked mail item|links to missing mail)$' THEN 'DRAFT_INCOMPLETE'
                       WHEN metadata->>'error' ~ '^Draft \S+ was already consumed by different funding$' THEN 'DRAFT_FUNDING_CONFLICT'
                       WHEN metadata->>'error' ~ '^Draft \S+ is \S+$'                                    THEN 'DRAFT_INVALID_STATE'
                       WHEN metadata->>'error' ~ '^Order not found: '                                    THEN 'JIT_ORDER_NOT_FOUND'
                       WHEN metadata->>'error' ~ '^Order \S+ is not a JIT order$'                        THEN 'JIT_ORDER_INVALID'
                       WHEN metadata->>'error' = 'JIT order ownership or draft binding does not match'   THEN 'JIT_ORDER_NOT_OWNED'
                       WHEN metadata->>'error' ~ '^Order \S+ is \S+$'                                    THEN 'JIT_ORDER_NOT_PAID'
                       WHEN metadata->>'error' ~ '^Letter not found for outbox job: '                    THEN 'LETTER_NOT_FOUND'
                       ELSE 'error_text_removed' END)
 WHERE event_type = 'jit.fulfillment_rejected'
   AND metadata ? 'error';

-- 3. refund.requested carried the "reason" the sweep passed in, which was the
--    order's previous last_error text. The refund id stays.
UPDATE commerce_order_events
   SET metadata = metadata - 'reason'
 WHERE event_type = 'refund.requested'
   AND metadata ? 'reason';

-- 4. operator.quarantine_released carried the operator's typed reason, which
--    admin_audit_events.reason already holds. The cleared code stays.
UPDATE commerce_order_events
   SET metadata = metadata - 'reason'
 WHERE event_type = 'operator.quarantine_released'
   AND metadata ? 'reason';

-- 5. letter_jobs: failures from before migration 023 were labelled
--    definite_failure with whatever text the old worker stored, and 031
--    rewrote only the HTTP-shaped ones. Every later definite failure is
--    HTTP-shaped and already rewritten; held and retryable rows carry a class.
UPDATE letter_jobs
   SET last_error = 'error_text_removed',
       error_message = 'error_text_removed',
       updated_at = NOW()
 WHERE status = 'failed'
   AND provider_outcome = 'definite_failure'
   AND COALESCE(last_error, '') !~ '^provider_rejected'
   AND (COALESCE(last_error, '') ~ '\s' OR COALESCE(error_message, '') ~ '\s');

-- 6, 7, 8. Pack-refund failure text: up to 80 characters of Stripe's message
--    in the alert, the refund row and the compensation lot's metadata. Stripe's
--    own failure_reason enum has no whitespace, and the sweep's fixed template
--    is excluded by name.
UPDATE commerce_operational_alerts
   SET details = details - 'failureReason'
 WHERE alert_type = 'pack_refund_failed'
   AND details->>'failureReason' ~ '\s'
   AND details->>'failureReason' !~ '^Stripe unreachable after \d+ attempts$';

UPDATE commerce_pack_refunds
   SET failure_reason = NULL,
       updated_at = NOW()
 WHERE status IN ('failed', 'compensated')
   AND failure_reason ~ '\s'
   AND failure_reason !~ '^Stripe unreachable after \d+ attempts$';

UPDATE credit_ledger
   SET source_metadata = source_metadata - 'failure_reason'
 WHERE source_type = 'adjustment'
   AND source_metadata->>'reason' = 'partial_refund_failed'
   AND source_metadata->>'failure_reason' ~ '\s'
   AND source_metadata->>'failure_reason' !~ '^Stripe unreachable after \d+ attempts$';

-- 9. maintenance_tasks: a label rather than NULL, so the panel's "has an
--    error" boolean (src/admin/queries/maintenance.ts) stays true. The runner's
--    own wrapped sweeps already store a class after a fixed prefix; those stay.
UPDATE maintenance_tasks
   SET last_error = 'error_text_removed',
       updated_at = NOW()
 WHERE last_status = 'failed'
   AND last_error ~ '\s'
   AND last_error !~ '^(retention sweeps failed|retention preview failed|recent uploads sweep failed|feature requests sweep failed): ';

COMMENT ON COLUMN orders.last_error IS
  'Under the provider, fulfilment, recovery and refund codes an error class only: provider_rejected http_<status> (031), the draft or outbox check code, a diagnostic class, or error_text_removed where 032 rewrote earlier text. The checkout and amount-mismatch codes store fixed server-authored sentences. Never provider, driver or draft message text.';
COMMENT ON COLUMN letter_jobs.last_error IS
  'An error class and provider status only (e.g. provider_rejected http_400). Never provider or driver message text (031, 032).';
COMMENT ON COLUMN letter_jobs.error_message IS
  'Legacy twin of last_error, written with the same class (032).';
COMMENT ON COLUMN maintenance_tasks.last_error IS
  'An error class only (032); the panel exposes whether it is set, never its text.';
COMMENT ON COLUMN commerce_pack_refunds.failure_reason IS
  'Stripe''s failure_reason enum, an error class, or the sweep''s fixed unreachable template (032). Never Stripe message text.';
