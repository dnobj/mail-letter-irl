-- Index for the global daily image-generation ceiling, issue #227 Addendum 3.
--
-- generate_image_for_mail counts today's reservations on every credit-backed
-- call (countGenerationsToday: created_at >= date_trunc('day', NOW()) AND
-- status <> 'released'). Without an index that is a full-table scan on a
-- monotonically growing table. A plain btree on created_at turns the day
-- window into a range scan; the status filter is cheap on the small remainder.
--
-- Transaction-safe (no CONCURRENTLY) per db/README.md; the table is tiny at
-- migration time.

CREATE INDEX IF NOT EXISTS idx_image_generation_reservations_created_at
  ON image_generation_reservations (created_at);
