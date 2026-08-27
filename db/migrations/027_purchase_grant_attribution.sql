-- 027: every purchase credit grant must name the order that funded it.
--
-- Migration 023 added the real protection against a double grant:
--
--   CREATE UNIQUE INDEX idx_credit_ledger_purchase_order_unique
--     ON credit_ledger(source_order_id)
--     WHERE source_order_id IS NOT NULL AND source_type = 'purchase';
--
-- That index is partial, so a purchase row written with source_order_id NULL
-- is invisible to it: the row inserts, and a second one for the same order
-- inserts beside it. The index looks like it protects the table; for those
-- rows it protects nothing.
--
-- A TypeScript-level check cannot close this. src/ contains seven raw
-- `INSERT INTO credit_ledger` statements, three of which (promoService,
-- and two in commerceService) hardcode source_type inline and omit the
-- source_order_id column entirely - each one word away from an unattributed
-- purchase grant that no static analysis of object literals would ever see.
-- The two service entry points bind source_type as a runtime parameter, so
-- they cannot be constrained statically at all.
--
-- WHY A TRIGGER AND NOT A CHECK CONSTRAINT
--
-- A CHECK - even one added NOT VALID - is enforced on UPDATE as well as
-- INSERT. credit_ledger rows are UPDATEd on every consumption, when
-- remaining_amount is decremented. 023's backfill deliberately left ambiguous
-- pre-021 history with source_order_id NULL, so any legacy purchase lot that
-- still has credits on it would start raising the moment a customer spent
-- from it. A constraint meant to prevent a double grant would have become an
-- outage on credit spend.
--
-- BEFORE INSERT has exactly the reach we want and no more: every write path
-- including raw SQL, and by construction never an existing row.

CREATE OR REPLACE FUNCTION reject_unattributed_purchase_grant()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.source_type = 'purchase' AND NEW.source_order_id IS NULL THEN
    RAISE EXCEPTION
      'purchase credit grants must set source_order_id (ledger %, user %)',
      NEW.ledger_id, NEW.user_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS reject_unattributed_purchase_grant ON credit_ledger;
CREATE TRIGGER reject_unattributed_purchase_grant
  BEFORE INSERT ON credit_ledger
  FOR EACH ROW
  EXECUTE FUNCTION reject_unattributed_purchase_grant();

COMMENT ON FUNCTION reject_unattributed_purchase_grant() IS
  'Issue #152: keeps every new purchase grant inside the reach of idx_credit_ledger_purchase_order_unique. INSERT only, so pre-023 rows with a NULL source_order_id can still be consumed.';
