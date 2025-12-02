/**
 * Promo Service
 *
 * Handles promotional credit campaigns:
 * - Create and manage promo campaigns
 * - Redeem promo codes
 * - Track redemptions
 */

import { transaction, query } from '../db/index.js';
import {
  PromoCampaign,
  PromoRedemption,
  CreatePromoCampaignParams,
  RedeemPromoParams,
  RedeemPromoResult,
  ValidatePromoResult,
  ListPromoCampaignsParams,
  PromoCampaignsResult,
  PromoCampaignStatus,
  CreditLedgerEntry,
} from './types.js';
import { addCreditsToLedger } from './creditLedgerService.js';
import { findUser } from './userService.js';

/**
 * Create a new promo campaign
 */
export async function createCampaign(
  params: CreatePromoCampaignParams
): Promise<PromoCampaign> {
  const {
    code,
    name,
    description,
    creditsAmount,
    expirationPolicy = 'days_from_activation',
    expirationDays = 90,
    fixedExpirationDate,
    maxTotalRedemptions,
    maxPerUser = 1,
    startsAt = new Date(),
    endsAt,
    requiresNewUser = false,
    createdBy,
  } = params;

  // Normalize code to uppercase for case-insensitive matching
  const normalizedCode = code.toUpperCase().trim();

  const result = await query<PromoCampaign>(
    `INSERT INTO promo_campaigns (
      code, name, description, credits_amount, expiration_policy,
      expiration_days, fixed_expiration_date, max_total_redemptions,
      max_per_user, starts_at, ends_at, requires_new_user, status, created_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'draft', $13)
    RETURNING *`,
    [
      normalizedCode,
      name,
      description || null,
      creditsAmount,
      expirationPolicy,
      expirationDays,
      fixedExpirationDate || null,
      maxTotalRedemptions || null,
      maxPerUser,
      startsAt,
      endsAt || null,
      requiresNewUser,
      createdBy || null,
    ]
  );

  console.log(`📢 Created promo campaign: ${normalizedCode} (${creditsAmount} credits)`);

  return result.rows[0];
}

/**
 * Get campaign by code
 */
export async function getCampaignByCode(code: string): Promise<PromoCampaign | null> {
  const normalizedCode = code.toUpperCase().trim();

  const result = await query<PromoCampaign>(
    'SELECT * FROM promo_campaigns WHERE UPPER(code) = $1',
    [normalizedCode]
  );

  return result.rows[0] || null;
}

/**
 * Get campaign by ID
 */
export async function getCampaignById(campaignId: string): Promise<PromoCampaign | null> {
  const result = await query<PromoCampaign>(
    'SELECT * FROM promo_campaigns WHERE campaign_id = $1',
    [campaignId]
  );

  return result.rows[0] || null;
}

/**
 * List all campaigns with optional filtering
 */
export async function listCampaigns(
  params?: ListPromoCampaignsParams
): Promise<PromoCampaignsResult> {
  const { status, limit = 50, offset = 0 } = params || {};

  let whereClause = '';
  const queryParams: (string | string[] | number)[] = [];

  if (status && status.length > 0) {
    whereClause = 'WHERE status = ANY($1)';
    queryParams.push(status);
  }

  // Get campaigns
  const result = await query<PromoCampaign>(
    `SELECT * FROM promo_campaigns
     ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`,
    [...queryParams, limit, offset]
  );

  // Get total count
  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM promo_campaigns ${whereClause}`,
    queryParams
  );

  return {
    campaigns: result.rows,
    total: parseInt(countResult.rows[0].count, 10),
  };
}

/**
 * Update campaign status
 */
export async function updateCampaignStatus(
  campaignId: string,
  status: PromoCampaignStatus
): Promise<PromoCampaign> {
  const result = await query<PromoCampaign>(
    `UPDATE promo_campaigns
     SET status = $1, updated_at = NOW()
     WHERE campaign_id = $2
     RETURNING *`,
    [status, campaignId]
  );

  if (result.rows.length === 0) {
    throw new Error(`Campaign not found: ${campaignId}`);
  }

  console.log(`📢 Updated promo campaign ${campaignId} status to: ${status}`);

  return result.rows[0];
}

/**
 * Validate if a promo code can be redeemed by a user
 */
export async function validatePromoCode(
  promoCode: string,
  userId: string
): Promise<ValidatePromoResult> {
  const normalizedCode = promoCode.toUpperCase().trim();

  // Get campaign
  const campaign = await getCampaignByCode(normalizedCode);

  if (!campaign) {
    return { valid: false, reason: 'Promo code not found' };
  }

  // Check campaign status
  if (campaign.status !== 'active') {
    return { valid: false, reason: 'Promo code is not active', campaign };
  }

  // Check campaign validity window
  const now = new Date();
  if (campaign.starts_at > now) {
    return { valid: false, reason: 'Promo code is not yet active', campaign };
  }
  if (campaign.ends_at && campaign.ends_at < now) {
    return { valid: false, reason: 'Promo code has expired', campaign };
  }

  // Check max total redemptions
  if (
    campaign.max_total_redemptions &&
    campaign.current_redemptions >= campaign.max_total_redemptions
  ) {
    return { valid: false, reason: 'Promo code redemption limit reached', campaign };
  }

  // Check if user already redeemed this code
  const redemptionCheck = await query<PromoRedemption>(
    'SELECT * FROM promo_redemptions WHERE campaign_id = $1 AND user_id = $2',
    [campaign.campaign_id, userId]
  );

  if (redemptionCheck.rows.length >= campaign.max_per_user) {
    return { valid: false, reason: 'You have already redeemed this promo code', campaign };
  }

  // Check if requires new user
  if (campaign.requires_new_user) {
    const user = await findUser(userId);
    if (user) {
      // Check if user has any previous transactions or credits used
      const txCheck = await query<{ count: string }>(
        'SELECT COUNT(*) as count FROM credit_transactions WHERE user_id = $1',
        [userId]
      );
      if (parseInt(txCheck.rows[0].count, 10) > 0) {
        return { valid: false, reason: 'This promo code is for new users only', campaign };
      }
    }
  }

  return { valid: true, campaign };
}

/**
 * Redeem a promo code for credits
 */
export async function redeemPromoCode(
  params: RedeemPromoParams
): Promise<RedeemPromoResult> {
  const { userId, email, promoCode } = params;

  // Validate first
  const validation = await validatePromoCode(promoCode, userId);

  if (!validation.valid) {
    return {
      success: false,
      error: validation.reason,
    };
  }

  const campaign = validation.campaign!;

  // Calculate expiration
  let expiresAt: Date | undefined;
  if (campaign.expiration_policy === 'fixed_date' && campaign.fixed_expiration_date) {
    expiresAt = campaign.fixed_expiration_date;
  } else if (campaign.expiration_policy === 'days_from_activation' && campaign.expiration_days) {
    expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + campaign.expiration_days);
  }
  // 'never' policy means no expiration

  return await transaction(async (client) => {
    // Add credits via ledger
    const ledgerResult = await client.query<CreditLedgerEntry>(
      `INSERT INTO credit_ledger (
        user_id, initial_amount, remaining_amount, source_type,
        source_reference_id, source_metadata, activated_at, expires_at,
        expiration_policy, expiration_days, status, description
      ) VALUES ($1, $2, $2, 'promo', $3, $4, NOW(), $5, $6, $7, 'active', $8)
      RETURNING *`,
      [
        userId,
        campaign.credits_amount,
        campaign.campaign_id,
        JSON.stringify({ promo_code: promoCode, campaign_name: campaign.name }),
        expiresAt || null,
        campaign.expiration_policy,
        campaign.expiration_days || null,
        `Promo: ${campaign.name} (${promoCode})`,
      ]
    );

    const ledgerEntry = ledgerResult.rows[0];

    // Upsert user and update credits cache
    await client.query(
      `INSERT INTO users (user_id, email, credits, credits_purchased, credits_used)
       VALUES ($1, $2, $3, 0, 0)
       ON CONFLICT (user_id) DO UPDATE
       SET credits = users.credits + $3,
           updated_at = NOW()`,
      [userId, email || `${userId}@unknown.com`, campaign.credits_amount]
    );

    // Record transaction
    await client.query(
      `INSERT INTO credit_transactions (
        user_id, amount, balance_after, type, reference_type, reference_id, description
      ) VALUES ($1, $2, (SELECT credits FROM users WHERE user_id = $1), 'adjustment', 'manual', $3, $4)`,
      [
        userId,
        campaign.credits_amount,
        ledgerEntry.ledger_id,
        `Promo: ${campaign.name} (${promoCode})`,
      ]
    );

    // Record redemption
    await client.query(
      `INSERT INTO promo_redemptions (campaign_id, user_id, ledger_id)
       VALUES ($1, $2, $3)`,
      [campaign.campaign_id, userId, ledgerEntry.ledger_id]
    );

    // Increment campaign redemption count
    await client.query(
      `UPDATE promo_campaigns
       SET current_redemptions = current_redemptions + 1, updated_at = NOW()
       WHERE campaign_id = $1`,
      [campaign.campaign_id]
    );

    console.log(
      `🎁 Redeemed promo ${promoCode} for user ${userId}: ${campaign.credits_amount} credits, expires: ${expiresAt?.toISOString() || 'never'}`
    );

    return {
      success: true,
      credits: campaign.credits_amount,
      expiresAt,
      ledgerId: ledgerEntry.ledger_id,
    };
  });
}

/**
 * Get redemptions for a campaign
 */
export async function getCampaignRedemptions(
  campaignId: string,
  limit = 50,
  offset = 0
): Promise<{ redemptions: PromoRedemption[]; total: number }> {
  const result = await query<PromoRedemption>(
    `SELECT * FROM promo_redemptions
     WHERE campaign_id = $1
     ORDER BY redeemed_at DESC
     LIMIT $2 OFFSET $3`,
    [campaignId, limit, offset]
  );

  const countResult = await query<{ count: string }>(
    'SELECT COUNT(*) as count FROM promo_redemptions WHERE campaign_id = $1',
    [campaignId]
  );

  return {
    redemptions: result.rows,
    total: parseInt(countResult.rows[0].count, 10),
  };
}

/**
 * Get user's promo redemptions
 */
export async function getUserRedemptions(
  userId: string
): Promise<Array<{ redemption: PromoRedemption; campaign: PromoCampaign }>> {
  const result = await query<PromoRedemption & PromoCampaign>(
    `SELECT r.*, c.* FROM promo_redemptions r
     JOIN promo_campaigns c ON r.campaign_id = c.campaign_id
     WHERE r.user_id = $1
     ORDER BY r.redeemed_at DESC`,
    [userId]
  );

  // Split combined rows back into separate objects
  return result.rows.map((row) => ({
    redemption: {
      redemption_id: row.redemption_id,
      campaign_id: row.campaign_id,
      user_id: row.user_id,
      ledger_id: row.ledger_id,
      redeemed_at: row.redeemed_at,
    },
    campaign: {
      campaign_id: row.campaign_id,
      code: row.code,
      name: row.name,
      description: row.description,
      credits_amount: row.credits_amount,
      expiration_policy: row.expiration_policy,
      expiration_days: row.expiration_days,
      fixed_expiration_date: row.fixed_expiration_date,
      max_total_redemptions: row.max_total_redemptions,
      max_per_user: row.max_per_user,
      current_redemptions: row.current_redemptions,
      starts_at: row.starts_at,
      ends_at: row.ends_at,
      requires_new_user: row.requires_new_user,
      status: row.status,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
  }));
}
