-- 034: end the ordinary promo campaigns that grant no letters (#420).
--
-- 007 relaxed promo_campaigns.credits_amount to allow 0, so a campaign could
-- be a pure access code for the website's preview gate, and seeded three:
-- EARLYBIRD, PREVIEW and LETTERIRL2024, all active. Redeeming one has never
-- worked: redemption inserts a ledger lot for credits_amount, and
-- credit_ledger.initial_amount keeps 003's CHECK (initial_amount > 0), so the
-- insert raises 23514 and the customer gets a database error. The preview gate
-- they served is retired (website #21), the admin panel no longer creates such
-- a campaign, and redemption now refuses one with a sentence.
--
-- A seed campaign (033: gift_generations_remaining set) may carry 0 credits,
-- because it grants a gift letter instead of a lot; the predicate leaves those
-- alone. Ending is the promo status machine's own final state
-- (PROMO_STATUS_TRANSITIONS), so the rows, and any redemption history, stay.
UPDATE promo_campaigns
   SET status = 'ended',
       updated_at = NOW()
 WHERE credits_amount = 0
   AND gift_generations_remaining IS NULL
   AND status <> 'ended';
