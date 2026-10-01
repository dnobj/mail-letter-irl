-- Migration: 042_mail_job_release_audit.sql
-- Purpose: the operator audit records held mail released early (#535).
--
-- The admin panel's job.dispatch_now makes a held letter's job due at once,
-- so the next hourly maintenance run sends it instead of waiting for its mail
-- date (letterJobService.releaseHeldLetterJobAsAdmin). Like a retried job, it
-- writes a row to commerce_operator_audit_events, as 'mail_job_release'.
--
-- commerce_operator_audit_events is a 023 object, so this sits in a DO block
-- guarded through to_regclass: the commerce ACID legacy replay runs every
-- migration after 023 on a schema without it, as 029 does. The list is 029's
-- with the new operation added; the target type 'letter_job' is already in it.

DO $$
BEGIN
  IF to_regclass('commerce_operator_audit_events') IS NOT NULL THEN
    ALTER TABLE commerce_operator_audit_events
      DROP CONSTRAINT IF EXISTS valid_commerce_operator_audit_operation;
    ALTER TABLE commerce_operator_audit_events
      ADD CONSTRAINT valid_commerce_operator_audit_operation CHECK (
        operation IN (
          'image_reservation_resolve',
          'mail_fulfillment_resolve',
          'mail_job_retry',
          'commerce_alert_transition',
          'pack_refund',
          'mail_job_release'
        )
      );
  END IF;
END $$;
