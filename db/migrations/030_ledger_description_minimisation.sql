-- 030: take personal data out of the two ledger description columns (#162).
--
-- credit_transactions.description and credit_ledger.description are free text
-- that two writers filled with data neither column should hold:
--
--   * every prepaid send wrote "Letter to <recipient name>", so the name of a
--     third party who never used the service sat in a column the admin panel's
--     reader role could select for every customer, and rendered it on the
--     account page with no reveal step and no audit row;
--   * an operator balance adjustment wrote "Operator adjustment: <reason>",
--     and the customer can read that description back through
--     GET /api/credits/transactions.
--
-- The code no longer writes either (mailSendService, admin/commands/accounts),
-- and 162's grant list drops `description` from both tables so the panel cannot
-- select it at all. This migration rewrites the rows already written.
--
-- THIS OVERWRITE IS DELIBERATE AND IRREVERSIBLE. 026_content_retention.sql
-- argues at length for quarantining content rather than destroying it, and a
-- reader will reasonably expect that doctrine here. It does not apply: the
-- quarantine exists so redacted letter content can be restored to the customer
-- who wrote it, whereas these strings are a derived label whose informative
-- half (mail type, credits, that an adjustment happened) is reconstructed
-- below from columns that are not going anywhere. The recipient's own name
-- remains on letters.recipient, which is the authoritative place for it.
--
-- Each UPDATE is predicated on both the row type and the exact prefix the code
-- used to write, so a description a human or a future writer put there in some
-- other shape is left untouched rather than flattened.

-- Sends. amount is negative on a deduction, so ABS() reproduces the credit
-- count the new code writes, and the LIKE keeps letters and postcards apart.
UPDATE credit_transactions
SET description = 'Sent letter (' || ABS(amount) || ' credits)'
WHERE type = 'deduction'
  AND reference_type = 'letter'
  AND description LIKE 'Letter to %';

UPDATE credit_transactions
SET description = 'Sent postcard (' || ABS(amount) || ' credits)'
WHERE type = 'deduction'
  AND reference_type = 'letter'
  AND description LIKE 'Postcard to %';

-- Operator adjustments. The reason stays on admin_audit_events.reason, which
-- is append-only and readable only inside the panel.
UPDATE credit_transactions
SET description = 'Operator adjustment'
WHERE type = 'adjustment'
  AND description LIKE 'Operator adjustment: %';

UPDATE credit_ledger
SET description = 'Operator adjustment'
WHERE source_type = 'adjustment'
  AND description LIKE 'Operator adjustment: %';

COMMENT ON COLUMN credit_transactions.description IS
  'Issue #162: a derived label only. Never a recipient, an address, or an operator reason - the admin reader role has no SELECT on this column and the customer can read it back through the credits API.';

COMMENT ON COLUMN credit_ledger.description IS
  'Issue #162: a derived label only. Never a recipient, an address, or an operator reason - the admin reader role has no SELECT on this column.';
