-- Purpose: operator audit records are deleted 2 years after the action they
-- record (#398), as docs/privacy-policy.md and docs/security-and-policy.md say.
--
-- admin_audit_events (022) and commerce_operator_audit_events (023) each carry
-- a BEFORE UPDATE OR DELETE trigger that refuses every change, the owner's
-- included. Those triggers stay exactly as they are: this adds one function,
-- purge_expired_audit_records(batch_size), that in its caller's transaction
-- switches each trigger off, deletes only rows past their two years (oldest
-- first, at most batch_size from each table), and switches it back on. ALTER
-- TABLE holds the table's ACCESS EXCLUSIVE lock to the end of that transaction,
-- so no other session can change a row while the trigger is off, and an error
-- rolls the switch back with the deletes.
--
-- The two years: admin_audit_events.occurred_at plus two years (it has no
-- expiry column); commerce_operator_audit_events.retention_expires_at (023's
-- default, two years after the row).
--
-- Why a function and not a change to the triggers: no migration after 022
-- changes 022's objects, so that a database which applied 022 after the later
-- migrations (the commerce ACID replay) ends with the same schema. The function
-- names the tables only inside its body, which PL/pgSQL resolves when it runs,
-- so it is created the same way in every order, and skips a table that is not
-- there. Only the owner can run it: ALTER TABLE needs the table's owner, and
-- EXECUTE is revoked from PUBLIC. The admin roles can delete nothing.

CREATE OR REPLACE FUNCTION purge_expired_audit_records(batch_size integer)
RETURNS TABLE (admin_deleted integer, commerce_deleted integer)
LANGUAGE plpgsql
AS $$
DECLARE
  admin_count integer := 0;
  commerce_count integer := 0;
BEGIN
  IF batch_size IS NULL OR batch_size < 1 THEN
    RAISE EXCEPTION 'batch_size must be a positive integer';
  END IF;

  IF to_regclass('admin_audit_events') IS NOT NULL THEN
    ALTER TABLE admin_audit_events DISABLE TRIGGER admin_audit_events_append_only;
    DELETE FROM admin_audit_events
     WHERE id IN (
       SELECT id FROM admin_audit_events
        WHERE occurred_at < NOW() - INTERVAL '2 years'
        ORDER BY occurred_at
        LIMIT batch_size
     );
    GET DIAGNOSTICS admin_count = ROW_COUNT;
    ALTER TABLE admin_audit_events ENABLE TRIGGER admin_audit_events_append_only;
  END IF;

  IF to_regclass('commerce_operator_audit_events') IS NOT NULL THEN
    ALTER TABLE commerce_operator_audit_events DISABLE TRIGGER commerce_operator_audit_events_append_only;
    DELETE FROM commerce_operator_audit_events
     WHERE audit_event_id IN (
       SELECT audit_event_id FROM commerce_operator_audit_events
        WHERE retention_expires_at < NOW()
        ORDER BY retention_expires_at
        LIMIT batch_size
     );
    GET DIAGNOSTICS commerce_count = ROW_COUNT;
    ALTER TABLE commerce_operator_audit_events ENABLE TRIGGER commerce_operator_audit_events_append_only;
  END IF;

  RETURN QUERY SELECT admin_count, commerce_count;
END;
$$;

REVOKE ALL ON FUNCTION purge_expired_audit_records(integer) FROM PUBLIC;

COMMENT ON FUNCTION purge_expired_audit_records(integer) IS
  'Deletes operator audit records past their two years (#398), at most batch_size from each table; the append-only triggers are off only inside the caller''s transaction.';
