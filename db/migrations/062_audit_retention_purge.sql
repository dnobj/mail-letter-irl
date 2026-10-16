-- Purpose: operator audit records are deleted 2 years after the action they
-- record (#398), as docs/privacy-policy.md and docs/security-and-policy.md say.
--
-- admin_audit_events (022) and commerce_operator_audit_events (023) each carry
-- a BEFORE UPDATE OR DELETE trigger that refuses every change, the owner's
-- included. This replaces both trigger functions so that one DELETE passes:
-- of a row past its two years, in a transaction that has set
-- letter_irl.audit_retention_purge to 'on' (SET LOCAL, as the maintenance
-- sweep does). Every UPDATE, and every DELETE of a row still inside its two
-- years, is refused exactly as before, with the same SQLSTATE and message.
--
-- Why a setting and not a dedicated role (#398 proposed one): the admin roles
-- hold SELECT and INSERT only, so they cannot delete either way; the database
-- owner, which runs maintenance, can disable a trigger outright, so a role
-- check adds no protection against it, only a manual step on every branch.
-- What the trigger guarantees is the part that matters: nothing deletes an
-- audit row inside its two years, and nothing rewrites one.
--
-- The two years: commerce_operator_audit_events.retention_expires_at (023's
-- default, two years after the row); admin_audit_events.occurred_at plus two
-- years (it has no expiry column).
--
-- Both tables are 022's and 023's; the legacy replay runs without them, so each
-- change is guarded (docs: migrations run without 022 and 023).

DO $$
BEGIN
  IF to_regclass('admin_audit_events') IS NOT NULL THEN
    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION reject_admin_audit_event_mutation()
      RETURNS TRIGGER AS $body$
      BEGIN
        IF TG_OP = 'DELETE'
           AND current_setting('letter_irl.audit_retention_purge', true) = 'on'
           AND OLD.occurred_at < NOW() - INTERVAL '2 years' THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'admin_audit_events is append-only';
      END;
      $body$ LANGUAGE plpgsql
    $fn$;
    COMMENT ON FUNCTION reject_admin_audit_event_mutation() IS
      'Rejects UPDATE, and DELETE except of a row over 2 years old while letter_irl.audit_retention_purge is on (#398).';
  END IF;

  IF to_regclass('commerce_operator_audit_events') IS NOT NULL THEN
    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION reject_commerce_operator_audit_mutation()
      RETURNS TRIGGER AS $body$
      BEGIN
        IF TG_OP = 'DELETE'
           AND current_setting('letter_irl.audit_retention_purge', true) = 'on'
           AND OLD.retention_expires_at < NOW() THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'commerce_operator_audit_events is append-only';
      END;
      $body$ LANGUAGE plpgsql
    $fn$;
    REVOKE ALL ON FUNCTION reject_commerce_operator_audit_mutation() FROM PUBLIC;
  END IF;
END $$;
