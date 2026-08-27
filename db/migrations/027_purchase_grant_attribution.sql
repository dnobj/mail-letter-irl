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
-- order succeeds.
--
-- WHAT THIS COSTS, STATED PLAINLY: an order with an attributed purchase grant
-- is now UNDELETABLE. `DELETE FROM orders WHERE order_id = <attributed>` raises
-- 23514, because 023's ON DELETE SET NULL is the very UPDATE the guard refuses.
-- That reaches further than it looks: orders.user_id is
-- `REFERENCES users(user_id) ON DELETE CASCADE`, so userService.deleteUser()'s
-- `DELETE FROM users` cascades into orders, and the orders constraint (from
-- 001) fires ahead of credit_ledger's (from 003) - so the SET NULL lands on
-- ledger rows that still exist and the whole erasure aborts. deleteUser has no
-- callers today; whoever wires up account erasure will meet this, and should.
--
-- That is the deliberate trade. The guard could stand down when the referenced
-- order is already gone, which would let the cascade through - but it would
-- also let delete-then-recreate reopen the double grant, which is the whole
-- point of the file. A loud 23514 in front of someone building erasure is a
-- better failure than silently orphaning purchase attribution, and how erasure
-- should treat funded orders is a decision for whoever builds it (see the issue
-- linked from PR #284: issue #289).
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
-- a scan. The drop below is guarded by a catalog lookup for a second lock
-- reason, spelled out at the block itself.

-- The column test is deliberate. commerceAcid.postgres.test.ts's
-- amount-backfill test applies the migration set with BOTH 022_ and 023_
-- filtered out - not prepareMigrationDirectory, which skips only 022_ - so 027
-- does land on a schema where source_order_id does not exist, and PL/pgSQL resolves NEW.<field> at EXECUTION time - a bare
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
DECLARE
  -- Bound once each. This fires on every consumption UPDATE of a purchase lot,
  -- which is the hot path over this table, and credit_ledger carries a JSONB
  -- source_metadata column that is serialized on each call - PostgreSQL does
  -- not common-subexpression these away.
  old_row CONSTANT jsonb := to_jsonb(OLD);
  new_row CONSTANT jsonb := to_jsonb(NEW);
BEGIN
  -- Only OLD is key-tested: in a row trigger OLD and NEW share the relation
  -- descriptor, so if the column is absent it is absent from both.
  IF old_row ? 'source_order_id'
     AND old_row->>'source_order_id' IS NOT NULL
     AND new_row->>'source_order_id' IS NULL THEN
    RAISE EXCEPTION
      'a purchase credit grant cannot be disowned from its order (user %)',
      NEW.user_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop, create and harden in one dynamic block.
--
-- The block is here for the DROP, not for ordering. An earlier revision claimed
-- EXECUTE was needed because the migrator sends each file as one
-- multi-statement simple query and "the whole string is parsed before any of it
-- runs". That is false, and 003 disproves it in this same repository: it
-- creates credit_ledger and then a trigger ON credit_ledger in one file.
-- PostgreSQL raw-parses the string up front but runs parse-analysis and
-- execution per statement, interleaved.
--
-- What the block IS for: the drop must be guarded by a catalog lookup rather
-- than written as DROP TRIGGER IF EXISTS, because that form takes ACCESS
-- EXCLUSIVE on the table before it checks whether the trigger exists - which
-- would block reads as well as writes on the live credits table during the
-- FIRST deploy, when the trigger cannot possibly be there. A conditional drop
-- needs PL/pgSQL, and once the drop is in a block the create belongs beside it.
--
-- The WHEN clauses reference source_type only, which has existed since 003, so
-- they parse on every schema this can land on. They keep promo, signup_bonus,
-- refund, adjustment and legacy writes - and every consumption UPDATE of a
-- non-purchase lot - out of PL/pgSQL entirely.
--
-- ENABLE ALWAYS, not the default ENABLE ORIGIN: otherwise
-- `SET session_replication_role = 'replica'` - which is what
-- `pg_restore --data-only --disable-triggers` sets - walks straight past both
-- guards and reinstates exactly the rows they exist to refuse. An earlier
-- revision deleted this, blaming it for a migration failure that the NEXT
-- commit traced to the unguarded DROP above: the relname lookup matched a
-- sibling schema's trigger, and the DROP's error text got pinned on the ALTER.
-- With the lookup scoped by to_regclass, the ALTER has never been shown to
-- fail. Deleting code to make an error go away, without understanding the
-- error, is how it came out in the first place.
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
    -- to_regclass, NOT `c.relname = 'credit_ledger'`. A bare relname matches
    -- credit_ledger in EVERY schema of the database, while the DROP below
    -- resolves through search_path to exactly one - so on a database holding
    -- more than one migrated schema, the guard saw a sibling schema's trigger
    -- and then failed dropping a trigger that was never in this one. CI
    -- reproduced it immediately, because each integration suite migrates its
    -- own schema into the same database. Any deployment with more than one
    -- migrated schema would have hit it too.
    IF EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = guard.trigger_name
        AND tgrelid = to_regclass('credit_ledger')
        AND NOT tgisinternal
    ) THEN
      EXECUTE format('DROP TRIGGER %I ON credit_ledger', guard.trigger_name);
    END IF;

    EXECUTE format(
      'CREATE TRIGGER %I %s ON credit_ledger FOR EACH ROW '
      || 'WHEN (NEW.source_type = ''purchase'') EXECUTE FUNCTION %I()',
      guard.trigger_name, guard.timing, guard.trigger_name
    );
    EXECUTE format(
      'ALTER TABLE credit_ledger ENABLE ALWAYS TRIGGER %I', guard.trigger_name
    );
  END LOOP;
END
$do$;

COMMENT ON FUNCTION reject_unattributed_purchase_grant() IS
  'Issue #152: a new purchase grant must name its funding order, so it falls inside idx_credit_ledger_purchase_order_unique. INSERT only - pre-023 rows with a NULL source_order_id are untouched and stay consumable.';

-- KNOWN LIMIT of the disowning guard: its WHEN clause tests NEW.source_type, so
-- a single UPDATE that rewrites the type AND clears the link -
-- `SET source_type = 'adjustment', source_order_id = NULL` - never enters the
-- function and takes the row out of the index's predicate. Widening the WHEN to
-- `NEW.source_type = 'purchase' OR OLD.source_type = 'purchase'` would close it
-- at the cost of entering PL/pgSQL for more writes. Nothing in src/ rewrites
-- source_type on an existing row, so this is left as a stated limit rather than
-- guessed at.

COMMENT ON FUNCTION reject_purchase_grant_disowning() IS
  'Issue #152: a purchase grant that already names an order cannot have that link cleared, which is what ON DELETE SET NULL on the orders foreign key would otherwise do. A transition check, so pre-023 rows whose link is already NULL are unaffected.';
