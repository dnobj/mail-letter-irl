import type { AdminSqlClient } from "../database.js";

/**
 * Gift letters and the codes they print (docs/gift-letters.md). Neither table
 * holds letter content or an address; a code is a bearer value for one free
 * letter, shown here because support needs it and the reader role already
 * reads promo codes on the same terms.
 */

export interface GiftLetterView {
  giftId: string;
  userId: string;
  generationsRemaining: number;
  source: string;
  sourceReferenceId: string;
  sourceOrderId: string | null;
  cardCampaignCode: string | null;
  parentCode: string | null;
  status: string;
  expiresAt: Date | null;
  consumedAt: Date | null;
  consumedByLetterId: string | null;
  sourceReversedAt: Date | null;
  createdAt: Date;
}

interface GiftLetterRow {
  gift_id: string;
  user_id: string;
  generations_remaining: number;
  source: string;
  source_reference_id: string;
  source_order_id: string | null;
  card_campaign_code: string | null;
  parent_code: string | null;
  status: string;
  expires_at: Date | null;
  consumed_at: Date | null;
  consumed_by_letter_id: string | null;
  source_reversed_at: Date | null;
  created_at: Date;
}

function toGiftLetterView(row: GiftLetterRow): GiftLetterView {
  return {
    giftId: row.gift_id,
    userId: row.user_id,
    generationsRemaining: row.generations_remaining,
    source: row.source,
    sourceReferenceId: row.source_reference_id,
    sourceOrderId: row.source_order_id,
    cardCampaignCode: row.card_campaign_code,
    parentCode: row.parent_code,
    status: row.status,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    consumedByLetterId: row.consumed_by_letter_id,
    sourceReversedAt: row.source_reversed_at,
    createdAt: row.created_at,
  };
}

export async function listGiftLetters(client: AdminSqlClient, userId: string, limit = 50): Promise<GiftLetterView[]> {
  const result = await client.query<GiftLetterRow>(
    `SELECT g.gift_id, g.user_id, g.generations_remaining, g.source, g.source_reference_id,
            g.source_order_id, c.code AS card_campaign_code, g.parent_code, g.status, g.expires_at,
            g.consumed_at, g.consumed_by_letter_id, g.source_reversed_at, g.created_at
       FROM gift_letters g
       LEFT JOIN promo_campaigns c ON c.campaign_id = g.card_campaign_id
      WHERE g.user_id = $1
      ORDER BY g.created_at DESC
      LIMIT $2`,
    [userId, limit],
  );
  return result.rows.map(toGiftLetterView);
}

export interface GiftCodeView {
  code: string;
  giftId: string;
  letterId: string;
  issuedToUserId: string;
  grantsGenerationsRemaining: number;
  status: string;
  expiresAt: Date;
  redeemedByUserId: string | null;
  redeemedAt: Date | null;
  voidedAt: Date | null;
  voidReason: string | null;
  createdAt: Date;
}

interface GiftCodeRow {
  code: string;
  gift_id: string;
  letter_id: string;
  issued_to_user_id: string;
  grants_generations_remaining: number;
  status: string;
  expires_at: Date;
  redeemed_by_user_id: string | null;
  redeemed_at: Date | null;
  voided_at: Date | null;
  void_reason: string | null;
  created_at: Date;
}

const CODE_COLUMNS = `
  code, gift_id, letter_id, issued_to_user_id, grants_generations_remaining, status, expires_at,
  redeemed_by_user_id, redeemed_at, voided_at, void_reason, created_at
`;

function toGiftCodeView(row: GiftCodeRow): GiftCodeView {
  return {
    code: row.code,
    giftId: row.gift_id,
    letterId: row.letter_id,
    issuedToUserId: row.issued_to_user_id,
    grantsGenerationsRemaining: row.grants_generations_remaining,
    status: row.status,
    expiresAt: row.expires_at,
    redeemedByUserId: row.redeemed_by_user_id,
    redeemedAt: row.redeemed_at,
    voidedAt: row.voided_at,
    voidReason: row.void_reason,
    createdAt: row.created_at,
  };
}

/** Codes a user's letters printed, or every recent code when userId is omitted. */
export async function listGiftCodes(
  client: AdminSqlClient,
  options: { userId?: string; limit: number },
): Promise<GiftCodeView[]> {
  const result = options.userId
    ? await client.query<GiftCodeRow>(
        `SELECT ${CODE_COLUMNS} FROM gift_codes
          WHERE issued_to_user_id = $1 OR redeemed_by_user_id = $1
          ORDER BY created_at DESC LIMIT $2`,
        [options.userId, options.limit],
      )
    : await client.query<GiftCodeRow>(
        `SELECT ${CODE_COLUMNS} FROM gift_codes ORDER BY created_at DESC LIMIT $1`,
        [options.limit],
      );
  return result.rows.map(toGiftCodeView);
}

export async function readGiftCode(client: AdminSqlClient, code: string): Promise<GiftCodeView | null> {
  const result = await client.query<GiftCodeRow>(`SELECT ${CODE_COLUMNS} FROM gift_codes WHERE code = $1`, [code]);
  return result.rows[0] ? toGiftCodeView(result.rows[0]) : null;
}

export interface GiftProgrammeTotals {
  available: number;
  sentToday: number;
  codesIssued: number;
  codesRedeemed: number;
}

/** The programme at a glance: what is outstanding and what went out today. */
export async function readGiftTotals(client: AdminSqlClient): Promise<GiftProgrammeTotals> {
  const result = await client.query<{
    available: string;
    sent_today: string;
    codes_issued: string;
    codes_redeemed: string;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM gift_letters
         WHERE status = 'available' AND (expires_at IS NULL OR expires_at > NOW())) AS available,
       (SELECT COUNT(*) FROM letters
         WHERE funding_type = 'gift_letter'
           AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')) AS sent_today,
       (SELECT COUNT(*) FROM gift_codes WHERE status = 'issued' AND expires_at > NOW()) AS codes_issued,
       (SELECT COUNT(*) FROM gift_codes WHERE status = 'redeemed') AS codes_redeemed`,
  );
  const row = result.rows[0];
  return {
    available: Number(row?.available ?? 0),
    sentToday: Number(row?.sent_today ?? 0),
    codesIssued: Number(row?.codes_issued ?? 0),
    codesRedeemed: Number(row?.codes_redeemed ?? 0),
  };
}
