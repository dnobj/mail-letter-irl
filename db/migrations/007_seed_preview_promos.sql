-- Migration 007: Seed initial preview access promo campaigns
-- These codes match the fallback codes in the website's preview-access API
-- They are "preview-only" codes (0 credits) that just unlock the preview lock screen

-- First, alter the constraint to allow 0 credits for preview-only codes
ALTER TABLE promo_campaigns DROP CONSTRAINT IF EXISTS promo_campaigns_credits_amount_check;
ALTER TABLE promo_campaigns ADD CONSTRAINT promo_campaigns_credits_amount_check CHECK (credits_amount >= 0);

-- EARLYBIRD - Preview access only (0 credits)
INSERT INTO promo_campaigns (
  code, name, description, credits_amount,
  expiration_policy, max_per_user,
  starts_at, status, created_by
) VALUES (
  'EARLYBIRD',
  'Early Bird Preview',
  'Preview access for early adopters - no credits included',
  0,
  'never',
  1,
  NOW(),
  'active',
  'system'
) ON CONFLICT (code) DO UPDATE SET
  status = 'active',
  updated_at = NOW();

-- PREVIEW - Generic preview access (0 credits)
INSERT INTO promo_campaigns (
  code, name, description, credits_amount,
  expiration_policy, max_per_user,
  starts_at, status, created_by
) VALUES (
  'PREVIEW',
  'Preview Access',
  'General preview access code - no credits included',
  0,
  'never',
  1,
  NOW(),
  'active',
  'system'
) ON CONFLICT (code) DO UPDATE SET
  status = 'active',
  updated_at = NOW();

-- LETTERIRL2024 - Legacy preview code (0 credits)
INSERT INTO promo_campaigns (
  code, name, description, credits_amount,
  expiration_policy, max_per_user,
  starts_at, status, created_by
) VALUES (
  'LETTERIRL2024',
  'Letter IRL 2024 Preview',
  'Legacy preview access code from 2024 launch - no credits included',
  0,
  'never',
  1,
  NOW(),
  'active',
  'system'
) ON CONFLICT (code) DO UPDATE SET
  status = 'active',
  updated_at = NOW();

-- WELCOME5 - Welcome promo with 5 free credits
INSERT INTO promo_campaigns (
  code, name, description, credits_amount,
  expiration_policy, expiration_days, max_per_user,
  requires_new_user, starts_at, status, created_by
) VALUES (
  'WELCOME5',
  'Welcome Bonus',
  'Welcome bonus for new users - 5 free credits',
  5,
  'days_from_activation',
  90,
  1,
  true,
  NOW(),
  'active',
  'system'
) ON CONFLICT (code) DO UPDATE SET
  status = 'active',
  updated_at = NOW();
