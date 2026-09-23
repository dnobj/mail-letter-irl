/**
 * Gift letters (docs/gift-letters.md).
 *
 * A gift letter is a free send that prints a card for the recipient. It is a
 * separate entitlement, not a credit_ledger lot: a lot would join the FIFO
 * spend order and could be spent on an ordinary letter, which is not what a
 * gift is for.
 *
 * The cost bound. Each gift letter prints at most one chain code and each
 * code grants at most one gift letter, with one less budget
 * (generations_remaining). A chain is therefore a path, and the free letters
 * descending from any grant are at most its budget. The schema holds the
 * branching factor (gift_codes.gift_id and .letter_id are UNIQUE); this file
 * holds the decrement. Seed codes are the one deliberate exception: operator
 * campaigns, multi-use, bounded by the campaign's own redemption cap.
 *
 * Because a chain code grants the same thing whoever redeems it, identity
 * rules on chain codes cannot change what a chain costs. The one kept here is
 * that a sender cannot redeem their own code, which protects the recipient
 * the code was printed for. Identity limits that do bound cost sit on seed
 * codes, in promoService. The daily send cap in betaSpendLimits bounds the
 * spend per day across everything.
 *
 * Lock order: the account row first (lockAccountForBalanceChange), then
 * gift_letters, then gift_codes, as with the ledger and image entitlements.
 */

import type pg from 'pg';
import { query, transaction } from '../db/index.js';
import { lockAccountForBalanceChange } from './accountLock.js';
import { ensureAccountRowWithClient } from './userService.js';
import {
  giftCodeTtlDays,
  giftLandingBaseUrl,
  giftLetterTtlDays,
  isGiftLettersEnabled
} from '../config/giftLetters.js';
import { generateGiftCode, normalizeEmail, normalizeGiftCode } from './giftCodes.js';
import type { GiftCardContent, GiftCardState } from './giftCardRenderer.js';
import { writeDiagnostic } from '../utils/diagnosticLog.js';

/**
 * A transaction client or the pool's query(). Narrow on purpose, as in
 * betaSpendLimits.ts: Pick<pg.PoolClient, 'query'> drags in the overload set,
 * which the exported query() function does not satisfy.
 */
interface Queryable {
  query<T extends pg.QueryResultRow = any>(text: string, params?: any[]): Promise<pg.QueryResult<T>>;
}

/** Everything that takes the account lock runs on a real transaction client. */
type TxClient = Pick<pg.PoolClient, 'query'>;

export type GiftLetterSource =
  | 'pack_purchase'
  | 'seed_redemption'
  | 'chain_redemption'
  | 'operator'
  | 'send_failed';

export interface GiftLetterRow {
  gift_id: string;
  user_id: string;
  generations_remaining: number;
  source: GiftLetterSource;
  source_reference_id: string;
  grant_index: number;
  source_order_id: string | null;
  source_campaign_id: string | null;
  parent_code: string | null;
  card_campaign_id: string | null;
  status: 'available' | 'consumed' | 'expired' | 'revoked';
  expires_at: Date | null;
  consumed_at: Date | null;
  consumed_by_letter_id: string | null;
  source_reversed_at: Date | null;
  created_at: Date;
}

export interface GiftCodeRow {
  code: string;
  gift_id: string;
  letter_id: string;
  issued_to_user_id: string;
  grants_generations_remaining: number;
  status: 'issued' | 'redeemed' | 'void';
  expires_at: Date;
  redeemed_by_user_id: string | null;
  redeemed_at: Date | null;
}

interface SeedCampaignRow {
  campaign_id: string;
  code: string;
  status: string;
  starts_at: Date;
  ends_at: Date | null;
  max_total_redemptions: number | null;
  current_redemptions: number;
  gift_generations_remaining: number | null;
}

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function landingHost(base: string): string {
  return base.replace(/^https?:\/\//, '');
}

/** The card for a chain code or a seed code: the QR opens the claim page. */
export function fundedCard(code: string, redeemBy?: Date | null): GiftCardContent {
  const base = giftLandingBaseUrl();
  return {
    state: 'funded',
    code,
    url: `${base}/g/${encodeURIComponent(code)}`,
    displayUrl: `${landingHost(base)}/g`,
    ...(redeemBy ? { redeemBy: isoDay(redeemBy) } : {})
  };
}

/**
 * The card a gift letter bound to a live seed campaign prints: the campaign's
 * own code, which many people may claim, so the card says so.
 */
export function seedCard(code: string, endsAt?: Date | null): GiftCardContent {
  return { ...fundedCard(code, endsAt), multiUse: true };
}

/**
 * A funded card for previews. The recipient's code does not exist until the
 * send, so the preview draws a placeholder and its QR opens the claim page's
 * entry form rather than a code that would not resolve.
 */
export function sampleFundedCard(): GiftCardContent {
  const base = giftLandingBaseUrl();
  return {
    state: 'funded',
    url: `${base}/g`,
    displayUrl: `${landingHost(base)}/g`,
    redeemBy: isoDay(daysFromNow(giftCodeTtlDays())),
    sample: true
  };
}

/** The card a spent budget prints: the QR opens the website. */
export function unfundedCard(): GiftCardContent {
  const base = giftLandingBaseUrl();
  return { state: 'unfunded', url: base, displayUrl: landingHost(base) };
}

// ============================================================================
// Balance
// ============================================================================

export interface GiftBalance {
  available: number;
  /** The gift letter the next gift send would use, and the card it would print. */
  next?: { giftId: string; cardState: GiftCardState };
}

function activeSeedCampaign(row: SeedCampaignRow | undefined): boolean {
  if (!row || row.status !== 'active' || row.gift_generations_remaining === null) return false;
  const now = Date.now();
  if (new Date(row.starts_at).getTime() > now) return false;
  if (row.ends_at && new Date(row.ends_at).getTime() <= now) return false;
  return true;
}

/**
 * Unsent, unexpired gift letters, oldest expiry first: the order a send uses
 * them in. Read without locks, for previews and balances.
 */
export async function getGiftBalance(userId: string, db: Queryable = { query }): Promise<GiftBalance> {
  const result = await db.query<GiftLetterRow & { campaign_status: string | null } & Partial<SeedCampaignRow>>(
    `SELECT g.*, c.status AS campaign_status, c.starts_at, c.ends_at, c.gift_generations_remaining
       FROM gift_letters g
       LEFT JOIN promo_campaigns c ON c.campaign_id = g.card_campaign_id
      WHERE g.user_id = $1
        AND g.status = 'available'
        AND (g.expires_at IS NULL OR g.expires_at > NOW())
      ORDER BY g.expires_at NULLS LAST, g.created_at, g.gift_id`,
    [userId]
  );
  const rows = result.rows ?? [];
  const first = rows[0];
  if (!first) return { available: 0 };
  const campaignFunds =
    first.card_campaign_id !== null &&
    activeSeedCampaign({
      campaign_id: first.card_campaign_id,
      code: '',
      status: first.campaign_status ?? '',
      starts_at: first.starts_at as Date,
      ends_at: (first.ends_at as Date | null) ?? null,
      max_total_redemptions: null,
      current_redemptions: 0,
      gift_generations_remaining: (first.gift_generations_remaining as number | null) ?? null
    });
  return {
    available: rows.length,
    next: {
      giftId: first.gift_id,
      cardState: campaignFunds || first.generations_remaining > 0 ? 'funded' : 'unfunded'
    }
  };
}

// ============================================================================
// Grant
// ============================================================================

export interface GrantGiftLettersParams {
  userId: string;
  quantity: number;
  generationsRemaining: number;
  source: Exclude<GiftLetterSource, 'send_failed'>;
  sourceReferenceId: string;
  sourceOrderId?: string | null;
  sourceCampaignId?: string | null;
  parentCode?: string | null;
  cardCampaignId?: string | null;
  expiresAt?: Date | null;
}

/**
 * Grant gift letters inside the caller's transaction. Idempotent per
 * (source, sourceReferenceId, grant index), so a replayed webhook or a repeated
 * redemption grants nothing twice. Returns only the rows this call created.
 */
export async function grantGiftLettersWithClient(
  client: TxClient,
  params: GrantGiftLettersParams
): Promise<GiftLetterRow[]> {
  if (!Number.isInteger(params.quantity) || params.quantity <= 0) return [];
  if (!Number.isInteger(params.generationsRemaining) || params.generationsRemaining < 0) {
    throw new Error('generationsRemaining must be a non-negative integer');
  }
  await lockAccountForBalanceChange(client, params.userId);
  const expiresAt = params.expiresAt === undefined ? daysFromNow(giftLetterTtlDays()) : params.expiresAt;
  const granted: GiftLetterRow[] = [];
  for (let index = 0; index < params.quantity; index += 1) {
    const result = await client.query<GiftLetterRow>(
      `INSERT INTO gift_letters (
         user_id, generations_remaining, source, source_reference_id, grant_index,
         source_order_id, source_campaign_id, parent_code, card_campaign_id, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (source, source_reference_id, grant_index) DO NOTHING
       RETURNING *`,
      [
        params.userId,
        params.generationsRemaining,
        params.source,
        params.sourceReferenceId,
        index,
        params.sourceOrderId ?? null,
        params.sourceCampaignId ?? null,
        params.parentCode ?? null,
        params.cardCampaignId ?? null,
        expiresAt
      ]
    );
    if (result.rows[0]) granted.push(result.rows[0]);
  }
  return granted;
}

// ============================================================================
// Send
// ============================================================================

export interface ConsumedGiftLetter {
  gift: GiftLetterRow;
  card: GiftCardContent;
}

async function mintChainCode(
  client: TxClient,
  gift: GiftLetterRow,
  letterId: string
): Promise<{ code: string; expiresAt: Date }> {
  const expiresAt = daysFromNow(giftCodeTtlDays());
  // A collision in 1.1e12 is not expected; the retry is there so that one
  // cannot fail a send. A campaign whose code READS as this code is skipped
  // too: redemption tries chain codes first, so a chain code equal to a
  // campaign's normalised form (WELCOME5 reads as WE1C0ME5) would take every
  // redemption of that campaign. The translate() is normalizeGiftCode in SQL:
  // O to 0, I and L to 1, hyphens and spaces dropped.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateGiftCode();
    const inserted = await client.query<{ code: string }>(
      `INSERT INTO gift_codes (
         code, gift_id, letter_id, issued_to_user_id, grants_generations_remaining, expires_at
       )
       SELECT $1::text, $2::uuid, $3::varchar, $4::varchar, $5::int, $6::timestamptz
        WHERE NOT EXISTS (
          SELECT 1 FROM promo_campaigns
           WHERE translate(UPPER(code), 'OIL- ', '011') = $1::text
        )
       ON CONFLICT (code) DO NOTHING
       RETURNING code`,
      [code, gift.gift_id, letterId, gift.user_id, gift.generations_remaining - 1, expiresAt]
    );
    if (inserted.rows[0]) return { code, expiresAt };
  }
  throw Object.assign(new Error('Could not mint a gift code'), {
    code: 'GIFT_CODE_UNAVAILABLE',
    diagnosticClass: 'GIFT_CODE_UNAVAILABLE'
  });
}

/**
 * Use one gift letter for a letter this transaction has just inserted, and
 * decide its card. Returns null when the account has none available; the
 * caller refuses the send.
 *
 * The card, in order: a gift letter an operator bound to a live seed campaign
 * prints that campaign's multi-use code; one with budget left mints a
 * single-use chain code worth one gift letter with one less budget; one with
 * no budget left prints the plain card.
 */
export async function consumeGiftLetterForSendWithClient(
  client: TxClient,
  params: { userId: string; letterId: string }
): Promise<ConsumedGiftLetter | null> {
  await lockAccountForBalanceChange(client, params.userId);
  await client.query(
    `UPDATE gift_letters SET status = 'expired'
      WHERE user_id = $1 AND status = 'available' AND expires_at <= NOW()`,
    [params.userId]
  );
  const selected = await client.query<GiftLetterRow>(
    `SELECT * FROM gift_letters
      WHERE user_id = $1 AND status = 'available'
      ORDER BY expires_at NULLS LAST, created_at, gift_id
      LIMIT 1
      FOR UPDATE`,
    [params.userId]
  );
  const gift = selected.rows[0];
  if (!gift) return null;

  await client.query(
    `UPDATE gift_letters
        SET status = 'consumed', consumed_at = NOW(), consumed_by_letter_id = $2
      WHERE gift_id = $1`,
    [gift.gift_id, params.letterId]
  );

  if (gift.card_campaign_id) {
    const campaign = await client.query<SeedCampaignRow>(
      `SELECT campaign_id, code, status, starts_at, ends_at, max_total_redemptions,
              current_redemptions, gift_generations_remaining
         FROM promo_campaigns WHERE campaign_id = $1`,
      [gift.card_campaign_id]
    );
    const row = campaign.rows[0];
    if (activeSeedCampaign(row)) {
      return { gift, card: seedCard(row!.code, row!.ends_at) };
    }
  }

  if (gift.generations_remaining > 0) {
    const minted = await mintChainCode(client, gift, params.letterId);
    return { gift, card: fundedCard(minted.code, minted.expiresAt) };
  }
  return { gift, card: unfundedCard() };
}

// ============================================================================
// Redeem
// ============================================================================

export interface CodeRedemptionResult {
  success: boolean;
  /** Ledger credits granted (ordinary promo codes, and seeds that carry both). */
  credits?: number;
  /** Gift letters granted. */
  giftLetters?: number;
  expiresAt?: Date;
  error?: string;
  /** Stable class for surfaces that map their own wording. */
  reason?: GiftRedemptionReason;
}

export type GiftRedemptionReason =
  | 'not_available'
  | 'redeemed'
  | 'expired'
  | 'void'
  | 'own_code';

const REASON_TEXT: Record<GiftRedemptionReason, string> = {
  not_available: 'Gift letters are not available right now.',
  redeemed: 'This gift code has already been used.',
  expired: 'This gift code has expired.',
  void: 'This gift code is no longer valid.',
  own_code: 'This gift code was printed on a letter you sent, so it is for your recipient to use.'
};

function refused(reason: GiftRedemptionReason): CodeRedemptionResult {
  return { success: false, reason, error: REASON_TEXT[reason] };
}

function codeState(row: Pick<GiftCodeRow, 'status' | 'expires_at'>): GiftRedemptionReason | null {
  if (row.status === 'redeemed') return 'redeemed';
  if (row.status === 'void') return 'void';
  if (new Date(row.expires_at).getTime() <= Date.now()) return 'expired';
  return null;
}

/**
 * Redeem a chain code, or report that `rawCode` is not one so the caller can
 * try promo campaigns. Returns undefined for "not a chain code".
 */
export async function redeemChainCode(params: {
  userId: string;
  email?: string | null;
  rawCode: string;
}): Promise<CodeRedemptionResult | undefined> {
  const code = normalizeGiftCode(params.rawCode);
  if (!code) return undefined;
  const found = await query<GiftCodeRow & { issuer_email: string | null }>(
    `SELECT gc.*, u.email AS issuer_email
       FROM gift_codes gc
       LEFT JOIN users u ON u.user_id = gc.issued_to_user_id
      WHERE gc.code = $1`,
    [code]
  );
  const preview = found.rows[0];
  if (!preview) return undefined;
  if (!isGiftLettersEnabled()) return refused('not_available');

  const earlyRefusal = codeState(preview);
  if (earlyRefusal) return refused(earlyRefusal);
  const redeemerEmail = normalizeEmail(params.email);
  if (
    preview.issued_to_user_id === params.userId ||
    (redeemerEmail !== null && redeemerEmail === normalizeEmail(preview.issuer_email))
  ) {
    return refused('own_code');
  }

  return transaction(async client => {
    // gift_letters.user_id needs the row; an authenticated caller normally has
    // it already. A redeemer with neither a row nor an address is refused: an
    // account opened from a made-up address is exactly what walked through the
    // own-code check above on 2026-09-18.
    await ensureAccountRowWithClient(client, {
      userId: params.userId,
      email: params.email
    });
    await lockAccountForBalanceChange(client, params.userId);
    const locked = await client.query<GiftCodeRow>(
      'SELECT * FROM gift_codes WHERE code = $1 FOR UPDATE',
      [code]
    );
    const row = locked.rows[0];
    if (!row) return refused('void');
    const refusal = codeState(row);
    if (refusal) return refused(refusal);

    await client.query(
      `UPDATE gift_codes
          SET status = 'redeemed', redeemed_by_user_id = $2, redeemed_at = NOW()
        WHERE code = $1`,
      [code, params.userId]
    );
    const granted = await grantGiftLettersWithClient(client, {
      userId: params.userId,
      quantity: 1,
      generationsRemaining: row.grants_generations_remaining,
      source: 'chain_redemption',
      sourceReferenceId: code,
      parentCode: code
    });
    writeDiagnostic('info', 'gift.chain_code_redeemed', {
      generationsRemaining: row.grants_generations_remaining
    });
    return {
      success: true,
      giftLetters: granted.length,
      expiresAt: granted[0]?.expires_at ?? undefined
    };
  });
}

export interface PublicGiftCodeLookup {
  valid: boolean;
  kind?: 'chain' | 'seed';
  reason?: GiftRedemptionReason | 'not_found' | 'limit_reached';
  redeemBy?: string;
}

/**
 * What the claim page may know before sign-in: whether a code can be claimed,
 * and nothing about who sent it. The sender's name stays on the paper.
 */
export async function lookupGiftCodePublic(rawCode: string): Promise<PublicGiftCodeLookup> {
  if (!isGiftLettersEnabled()) return { valid: false, reason: 'not_available' };
  const code = normalizeGiftCode(rawCode);
  if (code) {
    const found = await query<Pick<GiftCodeRow, 'status' | 'expires_at'>>(
      'SELECT status, expires_at FROM gift_codes WHERE code = $1',
      [code]
    );
    const row = found.rows[0];
    if (row) {
      const refusal = codeState(row);
      return refusal
        ? { valid: false, kind: 'chain', reason: refusal }
        : { valid: true, kind: 'chain', redeemBy: isoDay(new Date(row.expires_at)) };
    }
  }
  const trimmed = typeof rawCode === 'string' ? rawCode.trim().toUpperCase() : '';
  if (!trimmed) return { valid: false, reason: 'not_found' };
  const campaign = await query<SeedCampaignRow>(
    `SELECT campaign_id, code, status, starts_at, ends_at, max_total_redemptions,
            current_redemptions, gift_generations_remaining
       FROM promo_campaigns WHERE UPPER(code) = $1`,
    [trimmed]
  );
  const row = campaign.rows[0];
  if (!row || row.gift_generations_remaining === null) return { valid: false, reason: 'not_found' };
  if (!activeSeedCampaign(row)) return { valid: false, kind: 'seed', reason: 'expired' };
  if (row.max_total_redemptions !== null && row.current_redemptions >= row.max_total_redemptions) {
    return { valid: false, kind: 'seed', reason: 'limit_reached' };
  }
  return {
    valid: true,
    kind: 'seed',
    ...(row.ends_at ? { redeemBy: isoDay(new Date(row.ends_at)) } : {})
  };
}

// ============================================================================
// Failure and reversal
// ============================================================================

/**
 * Hand back the gift letter a terminally failed send used, exactly once.
 *
 * Mirrors returnConsumedCreditsForLetter: a new row (source 'send_failed',
 * keyed by the letter) rather than reopening the consumed one, so the history
 * stays and the replay is a no-op. The code printed on the failed letter is
 * voided, because no recipient ever held it.
 *
 * Two cases return nothing. A redeemed code proves the letter reached
 * someone, so a failure recorded after it is wrong and a return would pay
 * twice. A gift from a purchase since refunded or disputed was paid back with
 * the purchase.
 */
export async function returnGiftLetterForFailedSendWithClient(
  client: TxClient,
  params: { letterId: string; userId: string; failureCode: string }
): Promise<number> {
  await lockAccountForBalanceChange(client, params.userId);
  const already = await client.query<{ gift_id: string }>(
    `SELECT gift_id FROM gift_letters
      WHERE source = 'send_failed' AND source_reference_id = $1`,
    [params.letterId]
  );
  if (already.rows[0]) return 0;

  const consumed = await client.query<GiftLetterRow>(
    `SELECT * FROM gift_letters
      WHERE consumed_by_letter_id = $1 AND user_id = $2
      FOR UPDATE`,
    [params.letterId, params.userId]
  );
  const gift = consumed.rows[0];
  if (!gift) return 0;

  const codeResult = await client.query<GiftCodeRow>(
    'SELECT * FROM gift_codes WHERE letter_id = $1 FOR UPDATE',
    [params.letterId]
  );
  const code = codeResult.rows[0];
  if (code?.status === 'redeemed') {
    writeDiagnostic('warn', 'gift.return_skipped_code_redeemed', { failureCode: params.failureCode });
    return 0;
  }
  if (code?.status === 'issued') {
    await client.query(
      `UPDATE gift_codes SET status = 'void', voided_at = NOW(), void_reason = 'send_failed'
        WHERE code = $1`,
      [code.code]
    );
  }
  if (gift.source_reversed_at) return 0;

  // A fresh lifetime at least: a gift used near the end of its life and
  // refused days later must not come back already expired, which would
  // compensate the customer with nothing. One that never expired still never
  // does.
  const freshExpiry = daysFromNow(giftLetterTtlDays());
  const expiresAt =
    gift.expires_at === null
      ? null
      : new Date(gift.expires_at).getTime() > freshExpiry.getTime()
        ? gift.expires_at
        : freshExpiry;

  await client.query(
    `INSERT INTO gift_letters (
       user_id, generations_remaining, source, source_reference_id, grant_index,
       source_order_id, source_campaign_id, parent_code, card_campaign_id, expires_at
     ) VALUES ($1, $2, 'send_failed', $3, 0, $4, $5, $6, $7, $8)
     ON CONFLICT (source, source_reference_id, grant_index) DO NOTHING`,
    [
      params.userId,
      gift.generations_remaining,
      params.letterId,
      gift.source_order_id,
      gift.source_campaign_id,
      gift.parent_code,
      gift.card_campaign_id,
      expiresAt
    ]
  );
  writeDiagnostic('info', 'gift.returned_after_failed_send', { failureCode: params.failureCode });
  return 1;
}

/**
 * Whether a failed gift letter has been made good already, by a returned gift
 * or by the reversal of the purchase that granted it. The gift half of
 * isLetterAlreadyCompensated: resending such a letter posts mail nobody is
 * paying for.
 */
export async function isGiftLetterCompensated(
  client: TxClient,
  letterId: string
): Promise<boolean> {
  const result = await client.query<{ compensated: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM gift_letters
        WHERE (source = 'send_failed' AND source_reference_id = $1::text)
           OR (consumed_by_letter_id = $1::text AND source_reversed_at IS NOT NULL)
     ) AS compensated`,
    [letterId]
  );
  return result.rows[0]?.compensated === true;
}

/**
 * A pack's whole reversal takes back its gift letters: unsent ones are
 * revoked, sent ones are marked so a later failed send is not handed back.
 * A dispute also voids the unredeemed codes those letters printed, which stops
 * the chain at its first hop; a refund leaves them, because the recipient
 * holding one did nothing wrong. Caller holds the account lock.
 */
export async function revokeGiftLettersForOrderWithClient(
  client: TxClient,
  orderId: string,
  cause: 'payment_refunded' | 'payment_disputed'
): Promise<void> {
  await client.query(
    `UPDATE gift_letters SET status = 'revoked'
      WHERE source_order_id = $1 AND status = 'available'`,
    [orderId]
  );
  await client.query(
    `UPDATE gift_letters SET source_reversed_at = COALESCE(source_reversed_at, NOW())
      WHERE source_order_id = $1 AND status = 'consumed'`,
    [orderId]
  );
  if (cause === 'payment_disputed') {
    await client.query(
      `UPDATE gift_codes SET status = 'void', voided_at = NOW(), void_reason = 'purchase_reversed'
        WHERE status = 'issued'
          AND gift_id IN (SELECT gift_id FROM gift_letters WHERE source_order_id = $1)`,
      [orderId]
    );
  }
}
