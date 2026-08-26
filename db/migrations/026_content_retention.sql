-- Content retention support, issue #153.
--
-- WHY A COLUMN RATHER THAN A SENTINEL VALUE
-- The first cut of this feature marked a redacted row by writing a magic
-- '{"redacted":true}' into letters.content and using `content <> sentinel` as
-- the idempotency guard. That failed four ways at once, and this column fixes
-- all four:
--
--   1. It could not be indexed usefully, so every nightly run seq-scanned and
--      sorted the whole table, and got SLOWER as the feature succeeded -
--      already-redacted rows were re-read and re-rejected forever.
--   2. It gave a NOT NULL "the letter" column an undeclared second shape that
--      no reader knew about (#153 review).
--   3. It could not answer "when was this purged", which a retention feature
--      is the one feature that must be able to answer.
--   4. Fatally: it conflated "redacted" with "one particular column was
--      overwritten". A sweep that missed a content column marked the row done
--      anyway, and no later fix could ever revisit it - a bug shipped once
--      needed a hand-written backfill. redacted_at can be cleared to re-sweep.
--
-- Migration 024 made the same call for the same reason: a dispute send-block
-- became its own users.sends_blocked_at column rather than a negative balance,
-- "to keep the balance honest and make the restriction explicit and auditable".

ALTER TABLE letters
  ADD COLUMN IF NOT EXISTS redacted_at TIMESTAMPTZ;

ALTER TABLE letter_drafts
  ADD COLUMN IF NOT EXISTS redacted_at TIMESTAMPTZ;

COMMENT ON COLUMN letters.redacted_at IS
  'When the retention sweep anonymized this row''s content. NULL means content is intact. Clearing it re-queues the row for a future sweep.';
COMMENT ON COLUMN letter_drafts.redacted_at IS
  'When the retention sweep anonymized this row''s content. NULL means content is intact. Clearing it re-queues the row for a future sweep.';

-- The sweep predicates. Partial on redacted_at IS NULL so each index SHRINKS
-- as rows are redacted: the daily cost becomes proportional to rows still
-- DUE rather than to rows ever created, which is the opposite of the sentinel
-- design's behaviour. Both leading keys are the retention clock, so they also
-- supply the ORDER BY and remove the sort.
--
-- The clocks are deliberately IMMUTABLE columns. An earlier draft used
-- COALESCE(consumed_at, updated_at), but letter_drafts carries a BEFORE UPDATE
-- trigger that rewrites updated_at on every write - so any future writer would
-- silently restart a draft's 90-day clock, and the expression index would be
-- rebuilt on every draft edit. consumed_at and created_at are both write-once.
CREATE INDEX IF NOT EXISTS idx_letters_retention_due
  ON letters (COALESCE(sent_at, created_at))
  WHERE redacted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_letter_drafts_retention_due
  ON letter_drafts (COALESCE(consumed_at, created_at))
  WHERE redacted_at IS NULL;

-- The holds join orders by letter_id and by draft_id. Neither had an index:
-- orders.letter_id had none at all (an unindexed FK), and the only draft_id
-- index is idx_orders_active_jit_draft_unique, whose partial predicate the
-- retention holds deliberately do not imply - they must match orders in ANY
-- status, including fulfilled and cancelled.
CREATE INDEX IF NOT EXISTS idx_orders_letter_id
  ON orders (letter_id)
  WHERE letter_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_draft_id
  ON orders (draft_id)
  WHERE draft_id IS NOT NULL;

-- A PREPAID letter reaches its funding pack order only through the ledger:
-- orders.letter_id is written in exactly one place (mailSendService, inside
-- `if (jitOrder)`), so for prepaid_balance letters - the schema default and
-- the majority path - it is always NULL. The dispute hold has to walk
-- credit_transactions -> credit_consumption -> credit_ledger.source_order_id,
-- the same chain isLetterAlreadyCompensated uses.
CREATE INDEX IF NOT EXISTS idx_credit_transactions_letter_reference
  ON credit_transactions (reference_id)
  WHERE reference_type = 'letter' AND type = 'deduction';

-- Transaction-safe (no CONCURRENTLY) per db/README.md.
