/**
 * Promo Service
 *
 * Handles promotional credit campaigns:
 * - Create and manage promo campaigns
 * - Redeem promo codes
 * - Track redemptions
 */

import type pg from 'pg';

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
  PromoRefusalCode,
  CreditLedgerEntry,
} from './types.js';
import { addCreditsToLedger } from './creditLedgerService.js';
import { ensureAccountRowWithClient, findUser } from './userService.js';
import { grantGiftLettersWithClient } from './giftLetterService.js';
import { normalizeEmail } from './giftCodes.js';
import { isGiftLettersEnabled } from '../config/giftLetters.js';

const SEED_EMAIL_INDEX = 'idx_promo_redemptions_campaign_email';
const SEED_EMAIL_ALREADY_USED = 'This gift code has already been claimed with this email address.';

/**
 * A seed campaign's code is a gift code (docs/gift-letters.md): it is printed
 * on a gift letter's card and grants a gift letter. Its refusals therefore say
 * "gift code", as a chain code's do, and never "promo code" (#432). The cap's
 * sentence follows the claim page's ("This code has been claimed as many times
 * as it allows."), naming the gift code.
 */
const SEED_REFUSALS: Partial<Record<PromoRefusalCode, string>> = {
  inactive: 'This gift code is no longer valid.',
  not_started: "This gift code isn't active yet.",
  expired: 'This gift code has expired.',
  limit_reached: 'This gift code has been claimed as many times as it allows.',
  already_redeemed: 'You have already claimed this gift code.',
  new_users_only: 'This gift code is for new Letter IRL customers.',
};
const GIFTS_UNAVAILABLE = "Gift codes can't be claimed right now. Please try again later.";
/** #420: an ordinary campaign that grants no letters has nothing to give. */
const NO_LETTERS = "This code doesn't include any letters.";

export function isSeedCampaign(campaign: PromoCampaign | undefined): boolean {
  return campaign?.gift_generations_remaining !== null && campaign?.gift_generations_remaining !== undefined;
}

/** A refusal as the customer reads it: a seed campaign's in gift-code words. */
export function refusalText(validation: ValidatePromoResult): string | undefined {
  if (isSeedCampaign(validation.campaign) && validation.reasonCode) {
    return SEED_REFUSALS[validation.reasonCode] ?? validation.reason;
  }
  return validation.reason;
}

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

  console.log(`📢 Created promo campaign (${creditsAmount} credits)`);

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

  console.log(`📢 Updated promo campaign status to: ${status}`);

  return result.rows[0];
}

/**
 * Validate if a promo code exists and is active (public - no auth required)
 * Used for preview access validation before user is authenticated
 */
export async function validatePromoCodePublic(
  promoCode: string
): Promise<ValidatePromoResult> {
  const normalizedCode = promoCode.toUpperCase().trim();

  // Get campaign
  const campaign = await getCampaignByCode(normalizedCode);

  if (!campaign) {
    return { valid: false, reason: 'Promo code not found', reasonCode: 'not_found' };
  }

  // Check campaign status
  if (campaign.status !== 'active') {
    return { valid: false, reason: 'Promo code is not active', reasonCode: 'inactive', campaign };
  }

  // Check campaign validity window
  const now = new Date();
  if (campaign.starts_at > now) {
    return { valid: false, reason: 'Promo code is not yet active', reasonCode: 'not_started', campaign };
  }
  if (campaign.ends_at && campaign.ends_at < now) {
    return { valid: false, reason: 'Promo code has expired', reasonCode: 'expired', campaign };
  }

  // Check max total redemptions (global limit)
  if (
    campaign.max_total_redemptions &&
    campaign.current_redemptions >= campaign.max_total_redemptions
  ) {
    return { valid: false, reason: 'Promo code redemption limit reached', reasonCode: 'limit_reached', campaign };
  }

  // Code is valid for preview access
  return { valid: true, campaign };
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
    return { valid: false, reason: 'Promo code not found', reasonCode: 'not_found' };
  }

  // Check campaign status
  if (campaign.status !== 'active') {
    return { valid: false, reason: 'Promo code is not active', reasonCode: 'inactive', campaign };
  }

  // Check campaign validity window
  const now = new Date();
  if (campaign.starts_at > now) {
    return { valid: false, reason: 'Promo code is not yet active', reasonCode: 'not_started', campaign };
  }
  if (campaign.ends_at && campaign.ends_at < now) {
    return { valid: false, reason: 'Promo code has expired', reasonCode: 'expired', campaign };
  }

  // Check max total redemptions
  if (
    campaign.max_total_redemptions &&
    campaign.current_redemptions >= campaign.max_total_redemptions
  ) {
    return { valid: false, reason: 'Promo code redemption limit reached', reasonCode: 'limit_reached', campaign };
  }

  // Check if user already redeemed this code
  const redemptionCheck = await query<PromoRedemption>(
    'SELECT * FROM promo_redemptions WHERE campaign_id = $1 AND user_id = $2',
    [campaign.campaign_id, userId]
  );

  if (redemptionCheck.rows.length >= campaign.max_per_user) {
    return { valid: false, reason: 'You have already redeemed this promo code', reasonCode: 'already_redeemed', campaign };
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
        return { valid: false, reason: 'This promo code is for new users only', reasonCode: 'new_users_only', campaign };
      }
    }
  }

  return { valid: true, campaign };
}

/**
 * Redeem a promo code for credits
 *
 * Uses a hybrid approach for race condition prevention (US-EDGE-08):
 * 1. Fast validation OUTSIDE transaction for quick user feedback
 * 2. Atomic conditional increment INSIDE transaction to prevent exceeding limits
 *
 * The atomic increment uses: UPDATE ... WHERE current_redemptions < max_total_redemptions
 * If no rows are affected, another user grabbed the last redemption slot.
 */
export async function redeemPromoCode(
  params: RedeemPromoParams
): Promise<RedeemPromoResult> {
  const { userId, email, promoCode } = params;

  // Validate first (optimistic - for fast user feedback)
  // This catches obvious issues like invalid codes, inactive campaigns, etc.
  const validation = await validatePromoCode(promoCode, userId);

  if (!validation.valid) {
    return {
      success: false,
      error: refusalText(validation),
    };
  }

  const campaign = validation.campaign!;

  // A seed campaign (docs/gift-letters.md) grants a gift letter, and may grant
  // letters from the ledger beside it. It is multi-use, so it is the one code
  // where identity bounds cost: one claim per person, where a person is their
  // email with +tags and Gmail dots removed. Everything about an ordinary
  // campaign is unchanged below.
  const isSeed = isSeedCampaign(campaign);
  if (isSeed && !isGiftLettersEnabled()) {
    return { success: false, error: GIFTS_UNAVAILABLE };
  }
  // Before this refusal, the ledger insert below raised 23514 for such a
  // campaign (credit_ledger.initial_amount > 0) and the customer got a
  // database error. 034 ended the three seeded ones; this answers any other.
  if (!isSeed && campaign.credits_amount <= 0) {
    return { success: false, error: NO_LETTERS };
  }
  const emailNormalized = isSeed ? normalizeEmail(email) : null;
  if (isSeed && emailNormalized) {
    const claimed = await query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM promo_redemptions WHERE campaign_id = $1 AND email_normalized = $2
       ) AS exists`,
      [campaign.campaign_id, emailNormalized]
    );
    if (claimed.rows[0]?.exists) return { success: false, error: SEED_EMAIL_ALREADY_USED };
  }
  // An ordinary campaign always takes the ledger path, as it always has. A
  // seed campaign takes it only when it also grants letters, because a lot
  // must hold at least one credit.
  const grantsCredits = !isSeed || campaign.credits_amount > 0;

  // Calculate expiration
  let expiresAt: Date | undefined;
  if (campaign.expiration_policy === 'fixed_date' && campaign.fixed_expiration_date) {
    expiresAt = campaign.fixed_expiration_date;
  } else if (campaign.expiration_policy === 'days_from_activation' && campaign.expiration_days) {
    expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + campaign.expiration_days);
  }
  // 'never' policy means no expiration

  try {
    return await transaction(async (client) => {
      // ATOMIC INCREMENT FIRST - prevents race condition (US-EDGE-08)
      // This UPDATE only succeeds if:
      // - Campaign has no limit (max_total_redemptions IS NULL), OR
      // - Current redemptions is still below the limit
      const incrementResult = await client.query<PromoCampaign>(
        `UPDATE promo_campaigns
         SET current_redemptions = current_redemptions + 1,
             updated_at = NOW()
         WHERE campaign_id = $1
           AND status = 'active'
           AND (max_total_redemptions IS NULL OR current_redemptions < max_total_redemptions)
         RETURNING *`,
        [campaign.campaign_id]
      );

      // If no rows affected, the limit was reached between validation and now
      if (incrementResult.rows.length === 0) {
        // Don't throw - return error result so transaction can rollback cleanly
        return {
          success: false,
          error: isSeed ? SEED_REFUSALS.limit_reached : 'Promo code redemption limit reached',
        };
      }

      // The account row credit_ledger's foreign key needs. A redemption that
      // carries no address can only credit an account that already exists; it
      // may not open one from a made-up address, which is what this did until
      // 2026-09-19 and which defeated the very per-email rules below.
      await ensureAccountRowWithClient(client, {
        userId,
        email,
        credits: grantsCredits ? campaign.credits_amount : 0
      });

      const ledgerEntry = grantsCredits
        ? await grantPromoCreditsWithClient(client, { userId, campaign, promoCode, expiresAt })
        : undefined;

      let giftId: string | null = null;
      if (isSeed) {
        const granted = await grantGiftLettersWithClient(client, {
          userId,
          quantity: 1,
          generationsRemaining: campaign.gift_generations_remaining!,
          source: 'seed_redemption',
          sourceReferenceId: `${campaign.campaign_id}:${userId}`,
          sourceCampaignId: campaign.campaign_id
        });
        giftId = granted[0]?.gift_id ?? null;
      }

      // Record redemption
      await client.query(
        `INSERT INTO promo_redemptions (campaign_id, user_id, ledger_id, gift_id, email_normalized)
         VALUES ($1, $2, $3, $4, $5)`,
        [campaign.campaign_id, userId, ledgerEntry?.ledger_id ?? null, giftId, emailNormalized]
      );

      // Note: Increment already done above with atomic check

      console.log(`🎁 Redeemed promo for ${grantsCredits ? campaign.credits_amount : 0} credits`);

      return {
        success: true,
        credits: grantsCredits ? campaign.credits_amount : 0,
        giftLetters: isSeed ? (giftId ? 1 : 0) : undefined,
        expiresAt,
        ledgerId: ledgerEntry?.ledger_id,
      };
    });
  } catch (error) {
    // Two claims of one seed from one email racing past the check above: the
    // unique index settles it, and the loser rolled back whole.
    const pgError = error as { code?: string; constraint?: string };
    if (pgError?.code === '23505' && pgError.constraint === SEED_EMAIL_INDEX) {
      return { success: false, error: SEED_EMAIL_ALREADY_USED };
    }
    throw error;
  }
}

/**
 * The ledger half of a redemption: one promo lot and its transaction row.
 * Unchanged from when it lived inline in redeemPromoCode; split out so a seed
 * campaign that grants only a gift letter can skip it.
 */
async function grantPromoCreditsWithClient(
  client: pg.PoolClient,
  params: { userId: string; campaign: PromoCampaign; promoCode: string; expiresAt?: Date }
): Promise<CreditLedgerEntry> {
  const { userId, campaign, promoCode, expiresAt } = params;
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

  // Record transaction
  await client.query(
    `INSERT INTO credit_transactions (
      user_id, amount, balance_after, type, reference_type, reference_id, description
    ) VALUES ($1, $2, (SELECT credits FROM users WHERE user_id = $3), 'adjustment', 'manual', $4, $5)`,
    [
      userId,
      campaign.credits_amount,
      userId,  // Separate param for subquery to avoid type inference issues
      String(ledgerEntry.ledger_id),  // Cast UUID to string for VARCHAR column
      `Promo: ${campaign.name} (${promoCode})`,
    ]
  );
  return ledgerEntry;
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

/**
 * Delete a promo campaign
 * Only allows deletion if there are no redemptions
 */
export async function deleteCampaign(campaignId: string): Promise<{ success: boolean; error?: string }> {
  // Check if campaign exists
  const campaign = await getCampaignById(campaignId);
  if (!campaign) {
    return { success: false, error: 'Campaign not found' };
  }

  // Check for existing redemptions
  if (campaign.current_redemptions > 0) {
    return {
      success: false,
      error: `Cannot delete campaign with ${campaign.current_redemptions} existing redemption(s). Set status to 'ended' instead.`,
    };
  }

  // Delete the campaign
  await query('DELETE FROM promo_campaigns WHERE campaign_id = $1', [campaignId]);

  console.log('🗑️ Deleted promo campaign');

  return { success: true };
}

// ============================================================================
// Operator (admin panel) variants: the caller's client, so the change commits
// with the command run and audit rows; a validated status machine; and an
// updated_at version so a stale preview cannot apply (issue #162).
// ============================================================================

export const PROMO_STATUS_TRANSITIONS: Record<PromoCampaignStatus, PromoCampaignStatus[]> = {
  draft: ['active', 'ended'],
  active: ['paused', 'ended'],
  paused: ['active', 'ended'],
  ended: [],
  expired: [],
};

export async function createCampaignWithClient(
  client: Pick<pg.PoolClient, 'query'>,
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
    giftGenerationsRemaining = null,
    createdBy,
  } = params;
  const result = await client.query<PromoCampaign>(
    `INSERT INTO promo_campaigns (
      code, name, description, credits_amount, expiration_policy,
      expiration_days, fixed_expiration_date, max_total_redemptions,
      max_per_user, starts_at, ends_at, requires_new_user, status, created_by,
      gift_generations_remaining
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'draft', $13, $14)
    RETURNING *`,
    [
      code.toUpperCase().trim(),
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
      giftGenerationsRemaining,
    ]
  );
  return result.rows[0];
}

/**
 * Throws Error('not_found' | 'invalid_state' | 'stale').
 */
export async function transitionCampaignStatusWithClient(
  client: Pick<pg.PoolClient, 'query'>,
  params: { campaignId: string; status: PromoCampaignStatus; expectedUpdatedAt: string }
): Promise<PromoCampaign> {
  const current = await client.query<PromoCampaign>(
    'SELECT * FROM promo_campaigns WHERE campaign_id = $1 FOR UPDATE',
    [params.campaignId]
  );
  const campaign = current.rows[0];
  if (!campaign) throw new Error('not_found');
  if (new Date(campaign.updated_at).toISOString() !== params.expectedUpdatedAt) throw new Error('stale');
  if (!PROMO_STATUS_TRANSITIONS[campaign.status].includes(params.status)) throw new Error('invalid_state');
  const result = await client.query<PromoCampaign>(
    `UPDATE promo_campaigns SET status = $1, updated_at = NOW() WHERE campaign_id = $2 RETURNING *`,
    [params.status, params.campaignId]
  );
  return result.rows[0];
}

/**
 * Throws Error('not_found' | 'invalid_state'): a campaign with redemptions is
 * ended, never deleted, so its ledger rows keep their campaign.
 */
export async function deleteCampaignWithClient(
  client: Pick<pg.PoolClient, 'query'>,
  campaignId: string
): Promise<void> {
  // A campaign any gift letter names is ended, never deleted, like one with
  // redemptions: its code may be printed on a letter already in the mail
  // (docs/gift-letters.md), and deleting it would SET NULL across gift_letters
  // while holding the campaign, against a failed-send return that holds a gift
  // row and wants the campaign.
  const current = await client.query<{ current_redemptions: number; redeemed: string; gifts: string }>(
    `SELECT c.current_redemptions,
            (SELECT COUNT(*) FROM promo_redemptions r WHERE r.campaign_id = c.campaign_id)::text AS redeemed,
            (SELECT COUNT(*) FROM gift_letters g
              WHERE g.card_campaign_id = c.campaign_id OR g.source_campaign_id = c.campaign_id)::text AS gifts
     FROM promo_campaigns c WHERE c.campaign_id = $1 FOR UPDATE`,
    [campaignId]
  );
  const row = current.rows[0];
  if (!row) throw new Error('not_found');
  if (row.current_redemptions > 0 || Number(row.redeemed) > 0 || Number(row.gifts) > 0) {
    throw new Error('invalid_state');
  }
  await client.query('DELETE FROM promo_campaigns WHERE campaign_id = $1', [campaignId]);
}
