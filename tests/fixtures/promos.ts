/**
 * Test fixtures for promo campaigns
 *
 * Based on personas from docs/PERSONAS.md (Alex - The Promo Hunter)
 */

import type { PromoCampaign, PromoRedemption } from '../../src/services/types.js';

let campaignIdCounter = 1;
let redemptionIdCounter = 1;

/**
 * Create a test promo campaign
 */
export function createCampaign(
  overrides: Partial<PromoCampaign> = {}
): PromoCampaign {
  const now = new Date();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 90);

  return {
    campaign_id: `campaign-${campaignIdCounter++}`,
    code: `TEST${campaignIdCounter}`,
    name: 'Test Campaign',
    description: 'A test promotional campaign',
    credits_amount: 5,
    expiration_policy: 'days_from_activation',
    expiration_days: 90,
    fixed_expiration_date: null,
    max_total_redemptions: null,
    max_per_user: 1,
    current_redemptions: 0,
    starts_at: now,
    ends_at: null,
    requires_new_user: false,
    status: 'active',
    created_by: 'test',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

/**
 * Test campaigns based on actual use cases
 */
export const testCampaigns = {
  // Standard welcome campaign with limited redemptions (no new user requirement)
  welcome: createCampaign({
    campaign_id: 'campaign-welcome',
    code: 'WELCOME5',
    name: 'Welcome Bonus',
    credits_amount: 5,
    max_total_redemptions: 100,
    max_per_user: 1,
    requires_new_user: false,  // Use newUsersOnly campaign for testing new user requirement
  }),

  // Campaign at its limit (99 of 100 redeemed)
  nearLimit: createCampaign({
    campaign_id: 'campaign-near-limit',
    code: 'NEARLIMIT',
    name: 'Near Limit Campaign',
    credits_amount: 3,
    max_total_redemptions: 100,
    current_redemptions: 99,
    max_per_user: 1,
  }),

  // Campaign at exact limit
  atLimit: createCampaign({
    campaign_id: 'campaign-at-limit',
    code: 'ATLIMIT',
    name: 'At Limit Campaign',
    credits_amount: 3,
    max_total_redemptions: 100,
    current_redemptions: 100,
    max_per_user: 1,
  }),

  // Campaign with only 1 redemption allowed (for race condition testing)
  singleUse: createCampaign({
    campaign_id: 'campaign-single-use',
    code: 'SINGLEUSE',
    name: 'Single Use Campaign',
    credits_amount: 10,
    max_total_redemptions: 1,
    current_redemptions: 0,
    max_per_user: 1,
  }),

  // Unlimited campaign
  unlimited: createCampaign({
    campaign_id: 'campaign-unlimited',
    code: 'UNLIMITED',
    name: 'Unlimited Campaign',
    credits_amount: 2,
    max_total_redemptions: null, // No limit
    max_per_user: 1,
  }),

  // New users only campaign
  newUsersOnly: createCampaign({
    campaign_id: 'campaign-new-users',
    code: 'NEWUSER10',
    name: 'New Users Only',
    credits_amount: 10,
    max_total_redemptions: 50,
    max_per_user: 1,
    requires_new_user: true,
  }),

  // Inactive campaign
  inactive: createCampaign({
    campaign_id: 'campaign-inactive',
    code: 'INACTIVE',
    name: 'Inactive Campaign',
    credits_amount: 5,
    status: 'paused',
  }),

  // Expired campaign (ended in the past)
  expired: createCampaign({
    campaign_id: 'campaign-expired',
    code: 'EXPIRED',
    name: 'Expired Campaign',
    credits_amount: 5,
    ends_at: new Date(Date.now() - 86400000), // Yesterday
  }),
};

/**
 * Create a test redemption record
 */
export function createRedemption(
  campaignId: string,
  userId: string,
  ledgerId: string = `ledger-${redemptionIdCounter}`
): PromoRedemption {
  return {
    redemption_id: `redemption-${redemptionIdCounter++}`,
    campaign_id: campaignId,
    user_id: userId,
    ledger_id: ledgerId,
    redeemed_at: new Date(),
  };
}

/**
 * Helper to create campaign row for database mock
 */
export function createCampaignRow(campaign: PromoCampaign): PromoCampaign {
  return { ...campaign };
}

/**
 * Helper to simulate concurrent redemption scenario
 * Returns two campaigns representing the same campaign at different states
 */
export function createConcurrentScenario() {
  const baseCampaign = createCampaign({
    campaign_id: 'campaign-concurrent',
    code: 'CONCURRENT',
    name: 'Concurrent Test',
    credits_amount: 5,
    max_total_redemptions: 1,
    current_redemptions: 0,
  });

  return {
    // What User A sees during validation
    beforeRedemption: { ...baseCampaign, current_redemptions: 0 },
    // What exists after User B redeems (but before User A's transaction)
    afterOtherRedemption: { ...baseCampaign, current_redemptions: 1 },
  };
}
