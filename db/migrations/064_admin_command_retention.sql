-- Purpose: the admin panel's command runs and their queued operations are kept
-- for no more than 2 years after the command finished (#771), as the operator
-- audit records are (062, #398), under docs/privacy-policy.md's "up to 2
-- years" for records of actions the team takes on an account.
--
-- admin_command_runs (022) holds the operator, the target account, the action
-- and a sanitised result; admin_operations (022) the queued work a command
-- started (an erasure, for one). Neither has an append-only trigger, so this
-- needs no trigger switched off: purge_expired_admin_command_records
-- (batch_size) deletes, in its caller's transaction, at most batch_size runs
-- that are due, oldest first, and their operations first.
--
-- Due: two days before two years after the run finished (succeeded, failed
-- or rejected), as 062 counts, so a daily sweep that runs late still deletes
-- inside the policy. A run left pending or running (a command whose process
-- stopped between its provider call and its completion) is due two years
-- after it was requested: by then no session, CSRF token or elevation that
-- could finish it is left, and it may be the only record of the action. Never
-- deleted: a run with an operation still pending or processing, whose work is
-- not done; one whose operation finished later (an erasure the next
-- maintenance run carried out), until the operation is due too; and a run an
-- audit row still names (admin_audit_events.command_id is ON DELETE
-- RESTRICT), which 062 deletes on the same schedule, the run going on the
-- same or a later pass.
--
-- Locks: the due runs are taken FOR UPDATE SKIP LOCKED, so a run anything else
-- holds is left for the next pass and this waits on nothing; lock_timeout
-- bounds any wait at 5 seconds all the same. A finished run is not written
-- again (the runner writes a run only until it finishes, and the operations
-- queue claims only pending operations).
--
-- Replay: admin_command_runs is what stops a panel confirmation from running
-- twice (UNIQUE (environment, idempotency_key)). A key freed here belongs to a
-- confirmation two years old, which cannot be sent again: a confirmation needs
-- the session's CSRF token and a live elevation, both long gone.
--
-- Like 062: the tables are named only inside the body, resolved when it runs,
-- and a missing table is skipped, so the function is created the same way in
-- every migration order and no migration after 022 changes 022's objects.
-- Only the owner can run it: EXECUTE is revoked from PUBLIC, and the admin
-- roles hold no DELETE on either table.

CREATE OR REPLACE FUNCTION purge_expired_admin_command_records(batch_size integer)
RETURNS TABLE (runs_deleted integer, operations_deleted integer)
LANGUAGE plpgsql
AS $$
DECLARE
  due_ids uuid[];
  run_count integer := 0;
  operation_count integer := 0;
BEGIN
  IF batch_size IS NULL OR batch_size < 1 THEN
    RAISE EXCEPTION 'batch_size must be a positive integer';
  END IF;
  IF to_regclass('admin_command_runs') IS NULL
     OR to_regclass('admin_operations') IS NULL
     OR to_regclass('admin_audit_events') IS NULL THEN
    RETURN QUERY SELECT 0, 0;
    RETURN;
  END IF;
  -- Nothing here should wait; if anything does, at most 5 seconds (as 062).
  PERFORM set_config('lock_timeout', '5s', true);

  SELECT COALESCE(array_agg(due.id), '{}')
    INTO due_ids
    FROM (
      SELECT r.id
        FROM admin_command_runs r
       WHERE ((r.status IN ('succeeded', 'failed', 'rejected')
               AND r.completed_at < NOW() - INTERVAL '2 years' + INTERVAL '2 days'))
         AND NOT EXISTS (SELECT 1 FROM admin_audit_events a WHERE a.command_id = r.id)
         AND NOT EXISTS (
           SELECT 1 FROM admin_operations o
            WHERE o.command_id = r.id
              AND (o.status IN ('pending', 'processing')
                   OR o.completed_at >= NOW() - INTERVAL '2 years' + INTERVAL '2 days')
         )
       ORDER BY COALESCE(r.completed_at, r.requested_at)
       LIMIT batch_size
       FOR UPDATE OF r SKIP LOCKED
    ) AS due;

  IF cardinality(due_ids) = 0 THEN
    RETURN QUERY SELECT 0, 0;
    RETURN;
  END IF;

  -- The operations first: each names its run (ON DELETE RESTRICT).
  DELETE FROM admin_operations WHERE command_id = ANY (due_ids);
  GET DIAGNOSTICS operation_count = ROW_COUNT;
  DELETE FROM admin_command_runs WHERE id = ANY (due_ids);
  GET DIAGNOSTICS run_count = ROW_COUNT;

  RETURN QUERY SELECT run_count, operation_count;
END;
$$;

REVOKE ALL ON FUNCTION purge_expired_admin_command_records(integer) FROM PUBLIC;

COMMENT ON FUNCTION purge_expired_admin_command_records(integer) IS
  'Deletes admin command runs, and their operations, due under the 2-year policy (#771), at most batch_size runs a call; never one with work pending or named by an audit row.';
