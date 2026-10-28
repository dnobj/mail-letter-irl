import type { AdminSqlClient } from "../database.js";
import { maskEmail } from "./accounts.js";

export interface CampaignView {
  campaignId: string;
  code: string;
  name: string;
  description: string | null;
  creditsAmount: number;
  expirationPolicy: string;
  expirationDays: number | null;
  fixedExpirationDate: Date | null;
  maxTotalRedemptions: number | null;
  maxPerUser: number;
  currentRedemptions: number;
  startsAt: Date;
  endsAt: Date | null;
  requiresNewUser: boolean;
  status: string;
  /** Non-null on a seed campaign (docs/gift-letters.md). */
  giftGenerationsRemaining: number | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface CampaignRow {
  campaign_id: string;
  code: string;
  name: string;
  description: string | null;
  credits_amount: number;
  expiration_policy: string;
  expiration_days: number | null;
  fixed_expiration_date: Date | null;
  max_total_redemptions: number | null;
  max_per_user: number;
  current_redemptions: number;
  starts_at: Date;
  ends_at: Date | null;
  requires_new_user: boolean;
  status: string;
  gift_generations_remaining: number | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

const CAMPAIGN_COLUMNS = `
  campaign_id, code, name, description, credits_amount, expiration_policy, expiration_days,
  fixed_expiration_date, max_total_redemptions, max_per_user, current_redemptions, starts_at,
  ends_at, requires_new_user, status, gift_generations_remaining, created_by, created_at, updated_at
`;

function toCampaignView(row: CampaignRow): CampaignView {
  return {
    campaignId: row.campaign_id,
    code: row.code,
    name: row.name,
    description: row.description,
    creditsAmount: row.credits_amount,
    expirationPolicy: row.expiration_policy,
    expirationDays: row.expiration_days,
    fixedExpirationDate: row.fixed_expiration_date,
    maxTotalRedemptions: row.max_total_redemptions,
    maxPerUser: row.max_per_user,
    currentRedemptions: row.current_redemptions,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    requiresNewUser: row.requires_new_user,
    status: row.status,
    giftGenerationsRemaining: row.gift_generations_remaining,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listCampaigns(client: AdminSqlClient, limit: number): Promise<CampaignView[]> {
  const result = await client.query<CampaignRow>(
    `SELECT ${CAMPAIGN_COLUMNS} FROM promo_campaigns ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return result.rows.map(toCampaignView);
}

export async function readCampaign(client: AdminSqlClient, campaignId: string): Promise<CampaignView | null> {
  if (!/^[0-9a-f-]{36}$/i.test(campaignId)) return null;
  const result = await client.query<CampaignRow>(
    `SELECT ${CAMPAIGN_COLUMNS} FROM promo_campaigns WHERE campaign_id = $1::uuid`,
    [campaignId],
  );
  return result.rows[0] ? toCampaignView(result.rows[0]) : null;
}

export async function readCampaignByCode(client: AdminSqlClient, code: string): Promise<CampaignView | null> {
  const result = await client.query<CampaignRow>(
    `SELECT ${CAMPAIGN_COLUMNS} FROM promo_campaigns WHERE code = $1`,
    [code.toUpperCase().trim()],
  );
  return result.rows[0] ? toCampaignView(result.rows[0]) : null;
}

export interface CampaignRedemptionView {
  redemptionId: string;
  userId: string;
  emailMasked: string;
  /** Null when a seed campaign granted only a gift letter. */
  ledgerId: string | null;
  giftId: string | null;
  redeemedAt: Date;
}

export async function listCampaignRedemptions(
  client: AdminSqlClient,
  campaignId: string,
  limit: number,
): Promise<CampaignRedemptionView[]> {
  const result = await client.query<{
    redemption_id: string;
    user_id: string;
    email: string;
    ledger_id: string | null;
    gift_id: string | null;
    redeemed_at: Date;
  }>(
    `SELECT r.redemption_id, r.user_id, u.email, r.ledger_id, r.gift_id, r.redeemed_at
     FROM promo_redemptions r JOIN users u ON u.user_id = r.user_id
     WHERE r.campaign_id = $1::uuid ORDER BY r.redeemed_at DESC LIMIT $2`,
    [campaignId, limit],
  );
  return result.rows.map((row) => ({
    redemptionId: row.redemption_id,
    userId: row.user_id,
    emailMasked: maskEmail(row.email),
    ledgerId: row.ledger_id,
    giftId: row.gift_id,
    redeemedAt: row.redeemed_at,
  }));
}
