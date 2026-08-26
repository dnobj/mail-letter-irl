-- Content retention support, issue #153.
--
-- WHY A QUARANTINE RATHER THAN A DIRECT OVERWRITE
-- Two max-effort reviews of the direct-overwrite design each found ways it
-- destroyed content it was required to keep, and each repair introduced new
-- ones. The reason is structural rather than a run of bad luck: the sweep has
-- to decide "is it safe to destroy this FOREVER?" from a matrix of ten order
-- statuses, six job statuses, eleven letter statuses and a credit-ledger
-- graph, none of which was designed to answer that question. Every review
-- found another cell in that matrix, and every finding was severe only
-- because the mistake could not be undone.
--
-- So redaction now MOVES content into redacted_content_quarantine instead of
-- overwriting it, and the quarantine is purged on a pure time rule with no
-- joins and no state machine. The complex predicates now decide only WHEN
-- content leaves the live tables, never WHETHER it is recoverable - a wrong
-- allow-list costs a recovery window instead of the data.
--
-- THE PUBLISHED NUMBER IS THE TOTAL, NOT THE LIVE WINDOW
-- A naive quarantine would hold content for 90 + 7 days and quietly breach the
-- published promise. Instead the published period is SPLIT: content leaves the
-- live tables at (total - quarantine) days and the quarantine row purges at
-- exactly `total`, so no copy of it exists anywhere after the published
-- period. Each quarantine row carries its own purge_after, so the letters
-- window (90 = 83 live + 7) and the drafts window (7 = 4 live + 3) coexist
-- under one trivial purge statement.
--
-- WHY redacted_at IS STILL A COLUMN
-- The first cut marked a redacted row with a magic '{"redacted":true}' value
-- and used `content <> sentinel` as the idempotency guard. That could not be
-- indexed (every run seq-scanned and got SLOWER as the feature succeeded),
-- could not answer "when was this purged", and fatally conflated "redacted"
-- with "one particular column was overwritten" - a sweep that missed a column
-- marked the row done forever. Migration 024 made the same call for the same
-- reason with users.sends_blocked_at.

ALTER TABLE letters
  ADD COLUMN IF NOT EXISTS redacted_at TIMESTAMPTZ;

ALTER TABLE letter_drafts
  ADD COLUMN IF NOT EXISTS redacted_at TIMESTAMPTZ;

COMMENT ON COLUMN letters.redacted_at IS
  'When the retention sweep moved this row''s content to quarantine. NULL means content is intact. Clearing it re-queues the row for a future sweep.';
COMMENT ON COLUMN letter_drafts.redacted_at IS
  'When the retention sweep moved this row''s content to quarantine. NULL means content is intact. Clearing it re-queues the row for a future sweep.';

-- The recovery window. One row per redacted source row; purge_after is stamped
-- at insert so a single predicate serves every retention window.
CREATE TABLE IF NOT EXISTS redacted_content_quarantine (
  quarantine_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_table VARCHAR(32) NOT NULL,
  source_id VARCHAR(255) NOT NULL,
  -- Every column the sweep cleared, keyed by column name, so a restore is a
  -- mechanical write-back and no schema knowledge is encoded in the table.
  content JSONB NOT NULL,
  quarantined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  purge_after TIMESTAMPTZ NOT NULL,

  CONSTRAINT valid_quarantine_source CHECK (source_table IN ('letters', 'letter_drafts')),
  CONSTRAINT valid_quarantine_window CHECK (purge_after > quarantined_at),
  -- One live quarantine row per source row. A re-redaction after a restore
  -- replaces it rather than accumulating copies of the same content.
  CONSTRAINT uniq_quarantine_source UNIQUE (source_table, source_id)
);

COMMENT ON TABLE redacted_content_quarantine IS
  'Recovery window for content removed by the retention sweep (#153). Purged on purge_after with no joins and no state machine, so the sweep predicates control only WHEN content leaves the live tables, never whether the removal can be undone.';

-- The purge. One column, one direction, no partial predicate - this statement
-- is the one part of retention that must be impossible to get wrong.
CREATE INDEX IF NOT EXISTS idx_quarantine_purge_after
  ON redacted_content_quarantine (purge_after);

-- The sweep predicates. Partial on redacted_at IS NULL so each index SHRINKS
-- as rows are redacted: the daily cost becomes proportional to rows still DUE
-- rather than to rows ever created. The leading key is the retention clock, so
-- each also supplies its sweep's ORDER BY and removes the sort.
--
-- The clocks are deliberately IMMUTABLE columns. An earlier draft used
-- COALESCE(consumed_at, updated_at), but letter_drafts carries a BEFORE UPDATE
-- trigger that rewrites updated_at on every write - so any future writer would
-- silently restart a draft's clock, and the expression index would be rebuilt
-- on every draft edit. consumed_at and created_at are both write-once.
CREATE INDEX IF NOT EXISTS idx_letters_retention_due
  ON letters (COALESCE(sent_at, created_at))
  WHERE redacted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_letter_drafts_retention_due
  ON letter_drafts (COALESCE(consumed_at, created_at))
  WHERE redacted_at IS NULL;

-- purgeAbandonedDraftContent clocks on BARE created_at, not the COALESCE - an
-- abandoned checkout was never consumed, so the two agree on exactly the rows
-- it targets, but PostgreSQL cannot prove that and will not match a bare-column
-- predicate to an expression index. Without this the shortest-window and
-- therefore highest-volume sweep seq-scans and sorts the widest table in the
-- schema every night (#153 review round 2).
CREATE INDEX IF NOT EXISTS idx_letter_drafts_abandoned_due
  ON letter_drafts (created_at)
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
-- the majority path - it is always NULL. The dispute hold walks
-- credit_transactions -> credit_consumption -> credit_ledger.
CREATE INDEX IF NOT EXISTS idx_credit_transactions_letter_reference
  ON credit_transactions (reference_id)
  WHERE reference_type = 'letter' AND type = 'deduction';

-- Transaction-safe (no CONCURRENTLY) per db/README.md. See docs/deployment.md
-- for the lock window this takes on letters, letter_drafts and orders, and the
-- post-deploy ANALYZE the two expression indexes need before their statistics
-- exist.
