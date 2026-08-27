-- 027: every purchase credit grant must name the order that funded it, and
-- must keep naming it.
--
-- Migration 023 added the real protection against a double grant:
--
--   CREATE UNIQUE INDEX idx_credit_ledger_purchase_order_unique
--     ON credit_ledger(source_order_id)
--     WHERE source_order_id IS NOT NULL AND source_type = 'purchase';
--
-- That index is partial, so a purchase row whose source_order_id is NULL is
-- invisible to it: the row inserts, and a second one for the same order
-- inserts beside it. The index looks like it protects the table; for those
-- rows it protects nothing.
--
-- A TypeScript-level check cannot close this. src/ contains seven raw
-- `INSERT INTO credit_ledger` statements, three of which hardcode source_type
-- inline and omit the source_order_id column entirely - each one word away
-- from an unattributed purchase grant that no static analysis of object
-- literals would ever see. The two service entry points bind source_type as a
-- runtime parameter, so they cannot be constrained statically at all.
--
-- WHY TRIGGERS AND NOT A CHECK CONSTRAINT
--
-- A CHECK - even one added NOT VALID - is enforced on every UPDATE.
-- credit_ledger rows are UPDATEd on every consumption, when remaining_amount
-- is decremented. 023's backfill deliberately left ambiguous pre-021 history
-- with source_order_id NULL, so any legacy purchase lot that still has credits
-- on it would start raising the moment a customer spent from it. A constraint
-- meant to prevent a double grant would have become an outage on credit spend.
--
-- TWO TRIGGERS, BECAUSE INSERT ALONE IS NOT ENOUGH
--
-- An earlier revision of this migration guarded INSERT only, and claimed that
-- was the whole reach. It was not. 023 declares the column
--
--   source_order_id VARCHAR(255) REFERENCES orders(order_id) ON DELETE SET NULL
--
-- so deleting an order NULLs source_order_id on its ledger rows by UPDATE,
-- with no INSERT anywhere - dropping a committed purchase grant straight back
-- out of the index's partial predicate, after which a re-grant for a recreated
-- order succeeds. Nothing in the repository deletes an order today, so this is
-- a durability gap rather than a live bug, but the guarantee is worth stating
-- truthfully.
--
-- The disowning guard is a TRANSITION check - not-null becoming null - which
-- is precisely why it does not have the problem a CHECK would: a legacy lot's
-- source_order_id is ALREADY null, so OLD is null, so the guard cannot fire on
-- it and those lots stay spendable. The reasoning that ruled out a CHECK does
-- not rule this out; conflating the two is what left the gap.
--
-- LOCK WINDOW (cf. 026's note)
--
-- CREATE TRIGGER takes SHARE ROW EXCLUSIVE on credit_ledger, which blocks
-- concurrent grants and consumption until the migration run commits - not
-- merely until this file ends, since the migrator wraps the whole run in one
-- transaction. No table rewrite happens, so the window is a queue rather than
-- a scan. The drops below are guarded by a catalog lookup rather than written
-- as DROP TRIGGER IF EXISTS, because that form takes ACCESS EXCLUSIVE on the
-- table before it checks whether the trigger exists - which would block reads
-- as well as writes on the live credits table during the FIRST deploy, when
-- the trigger cannot possibly be there.

-- The column test is deliberate. commerceAcid.postgres.test.ts applies the
-- migration set with 022_ and 023_ filtered out (see the loop that skips them
-- before calling migrate), so 027 does land on a schema where source_order_id
-- does not exist, and PL/pgSQL resolves NEW.<field> at EXECUTION time - a bare
-- NEW.source_order_id raises `record "new" has no field "source_order_id"`
-- there. Reading through to_jsonb lets the guards stand down on a schema with
-- no column to attribute against, where they would mean nothing anyway, and
-- start working by themselves if 023 lands afterwards.

CREATE OR REPLACE FUNCTION reject_unattributed_purchase_grant()
RETURNS TRIGGER AS $$
BEGIN
  IF to_jsonb(NEW) ? 'source_order_id'
     AND to_jsonb(NEW)->>'source_order_id' IS NULL THEN
    RAISE EXCEPTION
      'purchase credit grants must set source_order_id (user %)', NEW.user_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION reject_purchase_grant_disowning()
RETURNS TRIGGER AS $$
BEGIN
  IF to_jsonb(OLD) ? 'source_order_id'
     AND to_jsonb(OLD)->>'source_order_id' IS NOT NULL
     AND to_jsonb(NEW)->>'source_order_id' IS NULL THEN
    RAISE EXCEPTION
      'a purchase credit grant cannot be disowned from its order (user %)',
      NEW.user_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop, create and harden in ONE dynamic block.
--
-- The previous revision wrote these as top-level statements and CI reported
-- `trigger "reject_unattributed_purchase_grant" for table "credit_ledger" does
-- not exist` from the ALTER. The migrator sends each file as a single
-- multi-statement simple query, so the whole string is parsed before any of it
-- runs; going through EXECUTE defers every name resolution to the moment that
-- statement actually executes, which is the only ordering guarantee worth
-- relying on here.
--
-- The drops are guarded by a catalog lookup rather than written as
-- DROP TRIGGER IF EXISTS, because that form takes ACCESS EXCLUSIVE on the table
-- before it checks whether the trigger exists - which would block reads as well
-- as writes on the live credits table during the FIRST deploy, when the trigger
-- cannot possibly be there.
--
-- The WHEN clauses reference source_type only, which has existed since 003, so
-- they parse on every schema this can land on. They keep promo, signup_bonus,
-- refund, adjustment and legacy writes - and every consumption UPDATE of a
-- non-purchase lot - out of PL/pgSQL entirely.
--
-- KNOWN GAP, deliberately left. These are created ENABLE ORIGIN, the default,
-- so `SET session_replication_role = 'replica'` walks past them - which is what
-- `pg_restore --data-only --disable-triggers` sets. Hardening them with
-- ALTER TABLE ... ENABLE ALWAYS was attempted and reproducibly failed the
-- migration with `trigger ... for table "credit_ledger" does not exist`, even
-- issued through EXECUTE immediately after the CREATE in the same block. That
-- is worth understanding before it is worth shipping, and a restore-time bypass
-- is an operator action on a database already being rewritten wholesale - a
-- much narrower exposure than the application paths these guards exist for. Not
-- worth trading a reliable migration to close.
DO $do$
DECLARE
  guard RECORD;
BEGIN
  FOR guard IN
    SELECT * FROM (VALUES
      ('reject_unattributed_purchase_grant', 'BEFORE INSERT'),
      ('reject_purchase_grant_disowning',    'BEFORE UPDATE')
    ) AS t(trigger_name, timing)
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE t.tgname = guard.trigger_name
        AND c.relname = 'credit_ledger' AND NOT t.tgisinternal
    ) THEN
      EXECUTE format('DROP TRIGGER %I ON credit_ledger', guard.trigger_name);
    END IF;

    EXECUTE format(
      'CREATE TRIGGER %I %s ON credit_ledger FOR EACH ROW '
      || 'WHEN (NEW.source_type = ''purchase'') EXECUTE FUNCTION %I()',
      guard.trigger_name, guard.timing, guard.trigger_name
    );
  END LOOP;
END
$do$;

COMMENT ON FUNCTION reject_unattributed_purchase_grant() IS
  'Issue #152: a new purchase grant must name its funding order, so it falls inside idx_credit_ledger_purchase_order_unique. INSERT only - pre-023 rows with a NULL source_order_id are untouched and stay consumable.';

COMMENT ON FUNCTION reject_purchase_grant_disowning() IS
  'Issue #152: a purchase grant that already names an order cannot have that link cleared, which is what ON DELETE SET NULL on the orders foreign key would otherwise do. A transition check, so pre-023 rows whose link is already NULL are unaffected.';
