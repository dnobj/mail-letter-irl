-- Authoritative commerce orders, replay-safe Stripe events, JIT funding,
-- and explicit image-generation entitlements.

-- ---------------------------------------------------------------------------
-- Commerce orders
-- ---------------------------------------------------------------------------

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS valid_order_status,
  DROP CONSTRAINT IF EXISTS orders_credits_check;

ALTER TABLE orders
  ALTER COLUMN credits DROP NOT NULL,
  ALTER COLUMN status SET DEFAULT 'checkout_pending',
  ALTER COLUMN currency SET DEFAULT 'usd';

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS order_type VARCHAR(30) NOT NULL DEFAULT 'letter_pack',
  ADD COLUMN IF NOT EXISTS draft_id UUID REFERENCES letter_drafts(draft_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS letter_id VARCHAR(255) REFERENCES letters(letter_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS product_code VARCHAR(100),
  ADD COLUMN IF NOT EXISTS product_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS payment_provider VARCHAR(30) NOT NULL DEFAULT 'stripe',
  ADD COLUMN IF NOT EXISTS stripe_checkout_session_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255),
  ADD COLUMN IF NOT EXISTS checkout_url TEXT,
  ADD COLUMN IF NOT EXISTS checkout_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fulfillment_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fulfilled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payment_failed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS refund_pending_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stripe_refund_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS refund_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error_code VARCHAR(100),
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE orders
SET status = CASE status
  WHEN 'pending' THEN 'checkout_pending'
  WHEN 'completed' THEN 'fulfilled'
  WHEN 'failed' THEN 'payment_failed'
  ELSE status
END,
currency = LOWER(currency),
product_code = COALESCE(product_code, 'legacy-letter-pack'),
product_snapshot = CASE
  WHEN product_snapshot = '{}'::jsonb
    THEN jsonb_build_object('name', 'Legacy Letter Pack')
  ELSE product_snapshot
END,
idempotency_key = COALESCE(idempotency_key, 'legacy-order:' || order_id),
paid_at = COALESCE(paid_at, completed_at),
fulfilled_at = COALESCE(fulfilled_at, completed_at),
updated_at = NOW();

ALTER TABLE orders
  ALTER COLUMN product_code SET NOT NULL,
  ALTER COLUMN idempotency_key SET NOT NULL,
  ADD CONSTRAINT valid_order_type CHECK (order_type IN ('letter_pack', 'jit_mail')),
  ADD CONSTRAINT valid_order_status CHECK (status IN (
    'checkout_pending',
    'paid',
    'fulfillment_pending',
    'fulfilled',
    'payment_failed',
    'refund_pending',
    'refunded',
    'cancelled'
  )),
  ADD CONSTRAINT valid_order_credits CHECK (
    (order_type = 'letter_pack' AND credits IS NOT NULL AND credits > 0)
    OR (order_type = 'jit_mail' AND credits IS NULL)
  ),
  ADD CONSTRAINT valid_order_draft CHECK (
    (order_type = 'jit_mail' AND draft_id IS NOT NULL)
    OR order_type = 'letter_pack'
  ),
  ADD CONSTRAINT valid_refund_attempts CHECK (refund_attempts >= 0);

-- Recover historical pack orders from the purchase ledger when no commerce
-- order was recorded. Duplicate legacy session references are retained as
-- distinct audit rows, but only the first may claim the Stripe session ID.
WITH purchase_rows AS (
  SELECT
    ledger.*,
    ROW_NUMBER() OVER (
      PARTITION BY ledger.source_reference_id
      ORDER BY ledger.created_at, ledger.ledger_id
    ) AS reference_rank
  FROM credit_ledger AS ledger
  WHERE ledger.source_type = 'purchase'
), legacy_orders AS (
  SELECT
    'legacy-pack-' || REPLACE(ledger_id::text, '-', '') AS order_id,
    user_id,
    initial_amount AS credits,
    CASE
      WHEN COALESCE(source_metadata->>'amount_paid', '') ~ '^[0-9]+([.][0-9]+)?$'
        THEN GREATEST(1, ROUND((source_metadata->>'amount_paid')::numeric * 100)::integer)
      ELSE 1
    END AS amount_cents,
    LOWER(COALESCE(NULLIF(source_metadata->>'currency', ''), 'usd')) AS currency,
    CASE
      WHEN COALESCE(source_metadata->>'stripe_payment_intent', '') <> ''
        THEN source_metadata->>'stripe_payment_intent'
      ELSE NULL
    END AS payment_intent_id,
    CASE
      WHEN source_reference_id LIKE 'cs\_%' ESCAPE '\' AND reference_rank = 1
        THEN source_reference_id
      ELSE NULL
    END AS checkout_session_id,
    COALESCE(NULLIF(source_metadata->>'product_id', ''), 'legacy-letter-pack') AS product_code,
    created_at
  FROM purchase_rows
)
INSERT INTO orders (
  order_id,
  user_id,
  credits,
  amount_cents,
  currency,
  stripe_payment_intent_id,
  status,
  created_at,
  completed_at,
  order_type,
  product_code,
  product_snapshot,
  payment_provider,
  stripe_checkout_session_id,
  idempotency_key,
  paid_at,
  fulfilled_at,
  updated_at
)
SELECT
  legacy.order_id,
  legacy.user_id,
  legacy.credits,
  legacy.amount_cents,
  legacy.currency,
  legacy.payment_intent_id,
  'fulfilled',
  legacy.created_at,
  legacy.created_at,
  'letter_pack',
  legacy.product_code,
  jsonb_build_object('name', 'Legacy Letter Pack', 'migrated', true),
  'stripe',
  legacy.checkout_session_id,
  'legacy-ledger:' || legacy.order_id,
  legacy.created_at,
  legacy.created_at,
  NOW()
FROM legacy_orders AS legacy
ON CONFLICT DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_checkout_session_unique
  ON orders(stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_payment_intent_unique
  ON orders(stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idempotency_unique
  ON orders(idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_refund_unique
  ON orders(stripe_refund_id)
  WHERE stripe_refund_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_active_jit_draft_unique
  ON orders(draft_id)
  WHERE order_type = 'jit_mail'
    AND status IN ('checkout_pending', 'paid', 'fulfillment_pending', 'refund_pending');

CREATE INDEX IF NOT EXISTS idx_orders_recovery
  ON orders(status, updated_at)
  WHERE status IN ('checkout_pending', 'paid', 'fulfillment_pending', 'refund_pending');

CREATE TRIGGER update_orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE stripe_webhook_events (
  event_id VARCHAR(255) PRIMARY KEY,
  event_type VARCHAR(100) NOT NULL,
  provider_object_id VARCHAR(255),
  order_id VARCHAR(255) REFERENCES orders(order_id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_stripe_webhook_events_order
  ON stripe_webhook_events(order_id, processed_at DESC);

CREATE TABLE commerce_order_events (
  order_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id VARCHAR(255) NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  event_type VARCHAR(100) NOT NULL,
  from_status VARCHAR(50),
  to_status VARCHAR(50),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_commerce_order_events_order
  ON commerce_order_events(order_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Funding audit on physical-mail records
-- ---------------------------------------------------------------------------

ALTER TABLE letters
  ADD COLUMN IF NOT EXISTS funding_type VARCHAR(30) NOT NULL DEFAULT 'prepaid_balance',
  ADD COLUMN IF NOT EXISTS funding_order_id VARCHAR(255) REFERENCES orders(order_id) ON DELETE SET NULL;

ALTER TABLE letters
  ADD CONSTRAINT valid_letter_funding CHECK (funding_type IN ('prepaid_balance', 'jit_order')),
  ADD CONSTRAINT valid_letter_funding_order CHECK (
    (funding_type = 'jit_order' AND funding_order_id IS NOT NULL)
    OR (funding_type = 'prepaid_balance' AND funding_order_id IS NULL)
  );

CREATE UNIQUE INDEX idx_letters_jit_order_unique
  ON letters(funding_order_id)
  WHERE funding_order_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Explicit image entitlements and reservations
-- ---------------------------------------------------------------------------

CREATE TABLE image_entitlements (
  entitlement_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(255) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  source_type VARCHAR(40) NOT NULL,
  source_reference_id VARCHAR(255) NOT NULL,
  source_order_id VARCHAR(255) REFERENCES orders(order_id) ON DELETE SET NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  consumed_quantity INTEGER NOT NULL DEFAULT 0 CHECK (consumed_quantity >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT valid_image_entitlement_consumption CHECK (consumed_quantity <= quantity),
  CONSTRAINT valid_image_entitlement_status CHECK (status IN ('active', 'depleted', 'expired', 'revoked')),
  UNIQUE(source_type, source_reference_id)
);

CREATE INDEX idx_image_entitlements_available
  ON image_entitlements(user_id, expires_at NULLS LAST, created_at)
  WHERE status = 'active' AND consumed_quantity < quantity;

CREATE TRIGGER update_image_entitlements_updated_at
  BEFORE UPDATE ON image_entitlements
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE image_generation_reservations (
  reservation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entitlement_id UUID NOT NULL REFERENCES image_entitlements(entitlement_id) ON DELETE CASCADE,
  user_id VARCHAR(255) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'reserved',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT valid_image_reservation_status CHECK (status IN ('reserved', 'consumed', 'released'))
);

CREATE INDEX idx_image_generation_reservations_user
  ON image_generation_reservations(user_id, created_at DESC);

-- Preserve allowances already earned under the prior five-generations-per-
-- purchased-letter formula. Runtime grants are configurable after migration.
INSERT INTO image_entitlements (
  user_id,
  source_type,
  source_reference_id,
  quantity,
  consumed_quantity,
  status
)
SELECT
  user_id,
  'legacy_migration',
  'legacy-user:' || user_id,
  FLOOR(credits_purchased::numeric / 2)::integer * 5,
  LEAST(
    image_generations_used,
    FLOOR(credits_purchased::numeric / 2)::integer * 5
  ),
  CASE
    WHEN image_generations_used >= FLOOR(credits_purchased::numeric / 2)::integer * 5
      THEN 'depleted'
    ELSE 'active'
  END
FROM users
WHERE FLOOR(credits_purchased::numeric / 2)::integer * 5 > 0
ON CONFLICT (source_type, source_reference_id) DO NOTHING;

COMMENT ON TABLE orders IS
  'Authoritative record for letter-pack and just-in-time physical-mail purchases.';

COMMENT ON TABLE stripe_webhook_events IS
  'Unique, transactionally claimed Stripe events used to prevent replayed state transitions.';

COMMENT ON TABLE image_entitlements IS
  'Append-only grants controlling Letter IRL-funded image generation.';
