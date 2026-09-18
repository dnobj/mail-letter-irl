-- 033: gift letters (docs/gift-letters.md).
--
-- A gift letter is a free send that prints an extra page carrying a card for
-- the recipient. While the letter's propagation budget (generations_remaining)
-- is above zero the card carries a single-use code worth one gift letter with
-- one less budget; at zero the card only says the letter was sent with Letter
-- IRL. Each gift letter prints at most one code and each code grants at most
-- one gift letter, so a chain is a path, not a tree, and the budget bounds the
-- free letters descending from any grant. The UNIQUE constraints on
-- gift_codes.gift_id and gift_codes.letter_id are what hold that property.
--
-- Gift letters are NOT credit_ledger lots. A lot would join the FIFO spend
-- order and could be spent on an ordinary letter, and credit_source_type
-- cannot gain a value in a transactional migration (db/README.md). They follow
-- the image_entitlements precedent instead: a separate entitlement, idempotent
-- per (source, source_reference_id, grant_index), locked through the account
-- row (src/services/accountLock.ts).
--
-- Every object named here comes from 001, 003, 004 or 021, so the commerce
-- ACID legacy replay, which runs later migrations without 022 and 023, needs
-- no to_regclass guard. New string columns are TEXT: a parameter bound to a
-- varchar column and compared with a literal is refused by PostgreSQL.
--
-- Safe for the running image: it relaxes two CHECKs, adds nullable or
-- defaulted columns, and creates tables nothing reads yet.

-- 1. A letter can be funded by a gift letter. Neither constraint changes for
--    the two existing funding types.
ALTER TABLE letters DROP CONSTRAINT valid_letter_funding;
ALTER TABLE letters DROP CONSTRAINT valid_letter_funding_order;
ALTER TABLE letters
  ADD CONSTRAINT valid_letter_funding
    CHECK (funding_type IN ('prepaid_balance', 'jit_order', 'gift_letter')),
  ADD CONSTRAINT valid_letter_funding_order CHECK (
    (funding_type = 'jit_order' AND funding_order_id IS NOT NULL)
    OR (funding_type IN ('prepaid_balance', 'gift_letter') AND funding_order_id IS NULL)
  );

-- 2. The preview decides whether a draft is sent as a gift, because the
--    preview has to show the page that will print.
ALTER TABLE letter_drafts
  ADD COLUMN is_gift_send BOOLEAN NOT NULL DEFAULT false;

-- 3. The entitlement.
CREATE TABLE gift_letters (
  gift_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(255) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  -- How many further funded cards may follow this one. 0 prints the plain card.
  generations_remaining INTEGER NOT NULL CHECK (generations_remaining >= 0),
  source TEXT NOT NULL,
  source_reference_id TEXT NOT NULL,
  grant_index INTEGER NOT NULL DEFAULT 0 CHECK (grant_index >= 0),
  -- Deliberately NOT a foreign key. The failed-send return inserts a row
  -- carrying this value while it holds the account lock, and a foreign key
  -- would then take FOR KEY SHARE on the order, after users. The refund and
  -- dispute paths hold the order FOR UPDATE and then lock users, so the two
  -- would invert (#288). Revocation matches by value, as revokeWholePack
  -- does for credit_ledger; orders rows are only ever deleted by the users
  -- cascade, which deletes these rows too.
  source_order_id VARCHAR(255),
  source_campaign_id UUID REFERENCES promo_campaigns(campaign_id) ON DELETE SET NULL,
  -- The chain code whose redemption granted this letter, if any.
  parent_code TEXT,
  -- An operator can make a gift letter print a campaign's multi-use code
  -- instead of minting a chain code: the seed-code path for press and
  -- influencer letters, whose photographs reach more than one reader.
  card_campaign_id UUID REFERENCES promo_campaigns(campaign_id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'available',
  expires_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  consumed_by_letter_id VARCHAR(255) REFERENCES letters(letter_id) ON DELETE SET NULL,
  -- Set on a consumed letter when the purchase that granted it is reversed,
  -- so a later failed send does not hand back a gift the refund already paid.
  source_reversed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT valid_gift_letter_source CHECK (
    source IN ('pack_purchase', 'seed_redemption', 'chain_redemption', 'operator', 'send_failed')
  ),
  CONSTRAINT valid_gift_letter_status CHECK (
    status IN ('available', 'consumed', 'expired', 'revoked')
  ),
  UNIQUE (source, source_reference_id, grant_index)
);

CREATE INDEX idx_gift_letters_available
  ON gift_letters(user_id, expires_at NULLS LAST, created_at)
  WHERE status = 'available';

CREATE INDEX idx_gift_letters_source_order
  ON gift_letters(source_order_id)
  WHERE source_order_id IS NOT NULL;

CREATE TRIGGER update_gift_letters_updated_at
  BEFORE UPDATE ON gift_letters
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- 4. Chain codes: one per gift letter sent with budget left, minted inside the
--    send transaction, never at preview time. The code is the canonical
--    8-character Crockford base32 form (no I, L, O or U).
CREATE TABLE gift_codes (
  code TEXT PRIMARY KEY,
  gift_id UUID NOT NULL UNIQUE REFERENCES gift_letters(gift_id) ON DELETE CASCADE,
  letter_id VARCHAR(255) NOT NULL UNIQUE REFERENCES letters(letter_id) ON DELETE CASCADE,
  issued_to_user_id VARCHAR(255) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  -- The budget the redeemer's gift letter receives: the sender's budget less one.
  grants_generations_remaining INTEGER NOT NULL CHECK (grants_generations_remaining >= 0),
  status TEXT NOT NULL DEFAULT 'issued',
  expires_at TIMESTAMPTZ NOT NULL,
  redeemed_by_user_id VARCHAR(255) REFERENCES users(user_id) ON DELETE SET NULL,
  redeemed_at TIMESTAMPTZ,
  voided_at TIMESTAMPTZ,
  -- A fixed class ('send_failed', 'purchase_reversed', 'operator'), never prose.
  void_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT valid_gift_code_status CHECK (status IN ('issued', 'redeemed', 'void')),
  CONSTRAINT valid_gift_code_format CHECK (code ~ '^[0-9A-HJKMNP-TV-Z]{8}$'),
  CONSTRAINT gift_code_redeemed_at CHECK ((status = 'redeemed') = (redeemed_at IS NOT NULL)),
  CONSTRAINT gift_code_voided_at CHECK ((status = 'void') = (voided_at IS NOT NULL))
);

CREATE INDEX idx_gift_codes_issued_to
  ON gift_codes(issued_to_user_id, created_at DESC);

CREATE TRIGGER update_gift_codes_updated_at
  BEFORE UPDATE ON gift_codes
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- 5. Seed codes are promo campaigns that grant a gift letter. The value is the
--    budget the granted letter receives; NULL keeps a campaign an ordinary one.
ALTER TABLE promo_campaigns
  ADD COLUMN gift_generations_remaining INTEGER
    CHECK (gift_generations_remaining IS NULL OR gift_generations_remaining >= 0);

-- 6. A seed campaign may grant only a gift letter, which has no ledger lot, so
--    a redemption records whichever it granted. Both references cascade: a
--    SET NULL racing the CHECK during an account delete would fail the delete.
--    email_normalized is written for seed redemptions only, so one person
--    cannot claim a campaign twice through +tags or Gmail dots.
ALTER TABLE promo_redemptions
  ALTER COLUMN ledger_id DROP NOT NULL,
  ADD COLUMN gift_id UUID REFERENCES gift_letters(gift_id) ON DELETE CASCADE,
  ADD COLUMN email_normalized TEXT,
  ADD CONSTRAINT promo_redemption_grants_something
    CHECK (ledger_id IS NOT NULL OR gift_id IS NOT NULL);

CREATE UNIQUE INDEX idx_promo_redemptions_campaign_email
  ON promo_redemptions(campaign_id, email_normalized)
  WHERE email_normalized IS NOT NULL;
