-- Purpose: operator audit records are kept for no more than 2 years after the
-- action they record (#398), as docs/privacy-policy.md says ("up to 2 years").
--
-- admin_audit_events (022) and commerce_operator_audit_events (023) each carry
-- a BEFORE UPDATE OR DELETE trigger that refuses every change, the owner's
-- included. Those triggers stay exactly as they are: this adds one function,
-- purge_expired_audit_records(batch_size), that in its caller's transaction
-- switches each trigger off, deletes only rows due (oldest first, at most
-- batch_size from each table), and switches it back on.
--
-- Locks: ALTER TABLE ... DISABLE TRIGGER takes SHARE ROW EXCLUSIVE, which
-- blocks every writer (not readers) to the end of the caller's transaction,
-- so no other session can change a row while the trigger is off, and an
-- error rolls the switch back with the deletes. Both tables are locked up
-- front, one after the other: commerce_operator_audit_events first, then
-- admin_audit_events, the order the one transaction that writes both (an
-- admin command, src/admin/commands/runner.ts) writes them, so the two cannot
-- deadlock. Keep that order. Each lock waits at most 5 seconds (lock_timeout,
-- per lock), so a writer left open elsewhere makes this run fail and the next
-- one try again; while it waits on the admin table it already holds the
-- commerce one, so commerce audit writers can queue behind it for those
-- seconds.
--
-- It takes the locks and switches the triggers even when no row is due, as it
-- will every day until the first records fall due in mid-2028: that is cheap,
-- and a database whose tables have another owner fails (42501) on the first
-- run rather than the first due one.
--
-- Due: two days before the two years are up, so a daily sweep that runs late
-- still deletes inside the policy's "up to 2 years" (docs/privacy-policy.md):
-- admin_audit_events.occurred_at plus two years (it has no expiry column);
-- commerce_operator_audit_events.retention_expires_at (023's default, two
-- years after the row).
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
  has_admin boolean := to_regclass('admin_audit_events') IS NOT NULL;
  has_commerce boolean := to_regclass('commerce_operator_audit_events') IS NOT NULL;
BEGIN
  IF batch_size IS NULL OR batch_size < 1 THEN
    RAISE EXCEPTION 'batch_size must be a positive integer';
  END IF;

  PERFORM set_config('lock_timeout', '5s', true);
  IF has_admin AND has_commerce THEN
    LOCK TABLE admin_audit_events, commerce_operator_audit_events IN SHARE ROW EXCLUSIVE MODE;
  END IF;

  IF has_admin THEN
    ALTER TABLE admin_audit_events DISABLE TRIGGER admin_audit_events_append_only;
    DELETE FROM admin_audit_events
     WHERE id IN (
       SELECT id FROM admin_audit_events
        WHERE occurred_at < NOW() - INTERVAL '2 years' + INTERVAL '2 days'
        ORDER BY occurred_at
        LIMIT batch_size
     );
    GET DIAGNOSTICS admin_count = ROW_COUNT;
    ALTER TABLE admin_audit_events ENABLE TRIGGER admin_audit_events_append_only;
  END IF;

  IF has_commerce THEN
    ALTER TABLE commerce_operator_audit_events DISABLE TRIGGER commerce_operator_audit_events_append_only;
    DELETE FROM commerce_operator_audit_events
     WHERE audit_event_id IN (
       SELECT audit_event_id FROM commerce_operator_audit_events
        WHERE retention_expires_at < NOW() + INTERVAL '2 days'
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
  'Deletes operator audit records due under the 2-year policy (#398), at most batch_size from each table; the append-only triggers are off only inside the caller''s transaction.';
