import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Seed campaigns (docs/gift-letters.md): promo campaigns that grant a gift
 * letter. The multi-use code is the one place identity bounds cost, so one
 * claim per person, where a person is a normalised email. Ordinary campaigns
 * must behave exactly as before.
 */

const state = vi.hoisted(() => ({
  log: [] as Array<{ sql: string; params: any[] }>,
  campaign: null as Record<string, any> | null,
  emailClaimed: false,
  failRedemptionInsert: null as Error | null
}));

function answer(sql: string, params: any[] = []) {
  state.log.push({ sql, params });
  if (sql.includes('FROM promo_campaigns WHERE UPPER(code)')) return { rows: state.campaign ? [state.campaign] : [] };
  if (sql.includes('FROM promo_redemptions WHERE campaign_id = $1 AND user_id')) return { rows: [] };
  if (sql.includes('email_normalized = $2')) return { rows: [{ exists: state.emailClaimed }] };
  if (sql.includes('COUNT(*) as count FROM credit_transactions')) return { rows: [{ count: '0' }] };
  if (sql.includes('UPDATE promo_campaigns')) return { rows: [state.campaign] };
  if (sql.includes('INSERT INTO credit_ledger')) return { rows: [{ ledger_id: 'ledger-1' }] };
  if (sql.includes('INSERT INTO promo_redemptions') && state.failRedemptionInsert) throw state.failRedemptionInsert;
  return { rows: [] };
}

const client = { query: vi.fn(async (sql: string, params?: any[]) => answer(sql, params ?? [])) };

vi.mock('../../../src/db/index.js', () => ({
  query: vi.fn(async (sql: string, params?: any[]) => answer(sql, params ?? [])),
  transaction: vi.fn(async (callback: (c: typeof client) => Promise<unknown>) => callback(client))
}));
vi.mock('../../../src/services/userService.js', () => ({ findUser: vi.fn(async () => null) }));
const grantGift = vi.hoisted(() => vi.fn());
vi.mock('../../../src/services/giftLetterService.js', () => ({ grantGiftLettersWithClient: grantGift }));

import { redeemPromoCode } from '../../../src/services/promoService.js';

function campaign(overrides: Record<string, any> = {}) {
  return {
    campaign_id: 'campaign-1',
    code: 'JANE-SMITH',
    name: "Jane's readers",
    credits_amount: 0,
    expiration_policy: 'days_from_activation',
    expiration_days: 90,
    max_total_redemptions: 200,
    max_per_user: 1,
    current_redemptions: 3,
    starts_at: new Date(Date.now() - 86_400_000),
    ends_at: null,
    requires_new_user: true,
    status: 'active',
    gift_generations_remaining: 1,
    ...overrides
  };
}

function ran(match: string) {
  return state.log.filter(entry => entry.sql.includes(match));
}

describe('redeemPromoCode: seed campaigns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.log = [];
    state.campaign = campaign();
    state.emailClaimed = false;
    state.failRedemptionInsert = null;
    process.env.LETTER_IRL_GIFT_LETTERS_ENABLED = 'true';
    grantGift.mockResolvedValue([{ gift_id: 'gift-1' }]);
  });

  afterEach(() => {
    delete process.env.LETTER_IRL_GIFT_LETTERS_ENABLED;
  });

  it('grants a gift letter with the campaign budget and no ledger lot', async () => {
    const result = await redeemPromoCode({ userId: 'reader-1', email: 'Reader.One+x@gmail.com', promoCode: 'jane-smith' });

    expect(result).toMatchObject({ success: true, credits: 0, giftLetters: 1 });
    expect(grantGift).toHaveBeenCalledWith(client, {
      userId: 'reader-1',
      quantity: 1,
      generationsRemaining: 1,
      source: 'seed_redemption',
      sourceReferenceId: 'campaign-1:reader-1',
      sourceCampaignId: 'campaign-1'
    });
    // A lot must hold a credit; a gift-only seed writes none.
    expect(ran('INSERT INTO credit_ledger')).toHaveLength(0);
    expect(ran('INSERT INTO credit_transactions')).toHaveLength(0);
    const redemption = ran('INSERT INTO promo_redemptions')[0].params;
    expect(redemption).toEqual(['campaign-1', 'reader-1', null, 'gift-1', 'readerone@gmail.com']);
  });

  it('grants both when the seed also carries letters', async () => {
    state.campaign = campaign({ credits_amount: 4 });
    const result = await redeemPromoCode({ userId: 'reader-1', email: 'r@example.com', promoCode: 'JANE-SMITH' });
    expect(result).toMatchObject({ success: true, credits: 4, giftLetters: 1, ledgerId: 'ledger-1' });
    expect(ran('INSERT INTO promo_redemptions')[0].params.slice(2, 4)).toEqual(['ledger-1', 'gift-1']);
  });

  it('refuses a second claim from the same person under another spelling of their email', async () => {
    state.emailClaimed = true;
    const result = await redeemPromoCode({ userId: 'alt-account', email: 'r.e.a.d.e.r.o.n.e@gmail.com', promoCode: 'JANE-SMITH' });
    expect(result).toEqual({ success: false, error: 'This code has already been redeemed with this email address.' });
    expect(ran('email_normalized = $2')[0].params).toEqual(['campaign-1', 'readerone@gmail.com']);
    expect(grantGift).not.toHaveBeenCalled();
  });

  it('turns the unique index losing a race into the same answer, and rethrows anything else', async () => {
    state.failRedemptionInsert = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'idx_promo_redemptions_campaign_email'
    });
    expect(await redeemPromoCode({ userId: 'r', email: 'r@example.com', promoCode: 'JANE-SMITH' })).toEqual({
      success: false,
      error: 'This code has already been redeemed with this email address.'
    });

    state.failRedemptionInsert = Object.assign(new Error('other'), { code: '23505', constraint: 'promo_redemptions_campaign_id_user_id_key' });
    await expect(redeemPromoCode({ userId: 'r', email: 'r@example.com', promoCode: 'JANE-SMITH' })).rejects.toThrow('other');
  });

  it('refuses a seed while gift letters are off, before touching anything', async () => {
    process.env.LETTER_IRL_GIFT_LETTERS_ENABLED = 'false';
    const result = await redeemPromoCode({ userId: 'r', email: 'r@example.com', promoCode: 'JANE-SMITH' });
    expect(result).toEqual({ success: false, error: 'This code is not available right now.' });
    expect(ran('UPDATE promo_campaigns')).toHaveLength(0);
  });

  it('leaves an ordinary campaign exactly as it was: a lot, no gift, no email recorded', async () => {
    state.campaign = campaign({ code: 'WELCOME5', credits_amount: 10, gift_generations_remaining: null });
    const result = await redeemPromoCode({ userId: 'r', email: 'R+x@gmail.com', promoCode: 'WELCOME5' });
    expect(result).toMatchObject({ success: true, credits: 10, ledgerId: 'ledger-1' });
    expect(result.giftLetters).toBeUndefined();
    expect(grantGift).not.toHaveBeenCalled();
    expect(ran('email_normalized = $2')).toHaveLength(0);
    expect(ran('INSERT INTO promo_redemptions')[0].params).toEqual(['campaign-1', 'r', 'ledger-1', null, null]);
  });
});
