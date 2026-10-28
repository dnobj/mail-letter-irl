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
  failRedemptionInsert: null as Error | null,
  alreadyRedeemed: false,
  txCount: '0',
  capRace: false
}));

function answer(sql: string, params: any[] = []) {
  state.log.push({ sql, params });
  if (sql.includes('FROM promo_campaigns WHERE UPPER(code)')) return { rows: state.campaign ? [state.campaign] : [] };
  if (sql.includes('FROM promo_redemptions WHERE campaign_id = $1 AND user_id')) {
    return { rows: state.alreadyRedeemed ? [{ redemption_id: 'earlier' }] : [] };
  }
  if (sql.includes('email_normalized = $2')) return { rows: [{ exists: state.emailClaimed }] };
  if (sql.includes('COUNT(*) as count FROM credit_transactions')) return { rows: [{ count: state.txCount }] };
  // Another claim took the last slot between validation and this UPDATE.
  if (sql.includes('UPDATE promo_campaigns')) return { rows: state.capRace ? [] : [state.campaign] };
  if (sql.includes('INSERT INTO credit_ledger')) return { rows: [{ ledger_id: 'ledger-1' }] };
  if (sql.includes('INSERT INTO promo_redemptions') && state.failRedemptionInsert) throw state.failRedemptionInsert;
  return { rows: [] };
}

const client = { query: vi.fn(async (sql: string, params?: any[]) => answer(sql, params ?? [])) };

vi.mock('../../../src/db/index.js', () => ({
  query: vi.fn(async (sql: string, params?: any[]) => answer(sql, params ?? [])),
  transaction: vi.fn(async (callback: (c: typeof client) => Promise<unknown>) => callback(client))
}));
const ensureAccount = vi.hoisted(() => vi.fn(async () => ({ user_id: 'reader-1' })));
const findUserMock = vi.hoisted(() => vi.fn(async (): Promise<Record<string, unknown> | null> => null));
vi.mock('../../../src/services/userService.js', () => ({
  findUser: findUserMock,
  ensureAccountRowWithClient: ensureAccount
}));
const grantGift = vi.hoisted(() => vi.fn());
vi.mock('../../../src/services/giftLetterService.js', () => ({ grantGiftLettersWithClient: grantGift }));

import { deleteCampaignWithClient, redeemPromoCode } from '../../../src/services/promoService.js';

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
    state.alreadyRedeemed = false;
    state.txCount = '0';
    state.capRace = false;
    findUserMock.mockResolvedValue(null);
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

  it("opens the account from the redeemer's own address, never a placeholder", async () => {
    // `${userId}@unknown.com` used to stand in whenever no address reached
    // this call. That row is a real account with a fake address, and the
    // per-email rules this file is about - one claim per mailbox, and the
    // gift own-code check - cannot see it. One walked through the own-code
    // check on 2026-09-18.
    await redeemPromoCode({ userId: 'reader-1', email: 'Reader.One+x@gmail.com', promoCode: 'jane-smith' });

    expect(ensureAccount).toHaveBeenCalledWith(client, {
      userId: 'reader-1',
      email: 'Reader.One+x@gmail.com',
      credits: 0
    });
    expect(ran('INSERT INTO users')).toHaveLength(0);
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
    expect(result).toEqual({ success: false, error: 'This gift code has already been claimed with this email address.' });
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
      error: 'This gift code has already been claimed with this email address.'
    });

    state.failRedemptionInsert = Object.assign(new Error('other'), { code: '23505', constraint: 'promo_redemptions_campaign_id_user_id_key' });
    await expect(redeemPromoCode({ userId: 'r', email: 'r@example.com', promoCode: 'JANE-SMITH' })).rejects.toThrow('other');
  });

  it('refuses a seed while gift letters are off, before touching anything', async () => {
    process.env.LETTER_IRL_GIFT_LETTERS_ENABLED = 'false';
    const result = await redeemPromoCode({ userId: 'r', email: 'r@example.com', promoCode: 'JANE-SMITH' });
    expect(result).toEqual({ success: false, error: "Gift codes can't be claimed right now. Please try again later." });
    expect(ran('UPDATE promo_campaigns')).toHaveLength(0);
  });

  it('words every refusal of a seed code as a gift code, never a promo code (#432)', async () => {
    const future = new Date(Date.now() + 86_400_000);
    const past = new Date(Date.now() - 86_400_000);
    const cases: Array<[() => void, string]> = [
      [() => { state.campaign = campaign({ status: 'paused' }); }, 'This gift code is no longer valid.'],
      [() => { state.campaign = campaign({ starts_at: future }); }, "This gift code isn't active yet."],
      [() => { state.campaign = campaign({ ends_at: past }); }, 'This gift code has expired.'],
      [() => { state.campaign = campaign({ current_redemptions: 200 }); }, 'This gift code has been claimed as many times as it allows.'],
      [() => { state.alreadyRedeemed = true; }, 'You have already claimed this gift code.'],
      [() => { findUserMock.mockResolvedValue({ user_id: 'r' }); state.txCount = '2'; }, 'This gift code is for new Letter IRL customers.'],
    ];
    for (const [arrange, expected] of cases) {
      state.campaign = campaign();
      state.alreadyRedeemed = false;
      state.txCount = '0';
      findUserMock.mockResolvedValue(null);
      arrange();
      const result = await redeemPromoCode({ userId: 'r', email: 'r@example.com', promoCode: 'JANE-SMITH' });
      expect(result).toEqual({ success: false, error: expected });
    }
    expect(grantGift).not.toHaveBeenCalled();
  });

  it('keeps the promo wording for an ordinary campaign', async () => {
    state.campaign = campaign({ code: 'WELCOME5', credits_amount: 10, gift_generations_remaining: null, current_redemptions: 200 });
    expect(await redeemPromoCode({ userId: 'r', email: 'r@example.com', promoCode: 'WELCOME5' })).toEqual({
      success: false,
      error: 'Promo code redemption limit reached'
    });
    state.campaign = campaign({ code: 'WELCOME5', credits_amount: 10, gift_generations_remaining: null });
    findUserMock.mockResolvedValue({ user_id: 'r' });
    state.txCount = '2';
    expect(await redeemPromoCode({ userId: 'r', email: 'r@example.com', promoCode: 'WELCOME5' })).toEqual({
      success: false,
      error: 'This promo code is for new users only'
    });
  });

  it('answers a claim that loses the last slot to a race in the same words as the cap', async () => {
    state.capRace = true;
    expect(await redeemPromoCode({ userId: 'r', email: 'r@example.com', promoCode: 'JANE-SMITH' })).toEqual({
      success: false,
      error: 'This gift code has been claimed as many times as it allows.'
    });
    state.campaign = campaign({ code: 'WELCOME5', credits_amount: 10, gift_generations_remaining: null });
    expect(await redeemPromoCode({ userId: 'r', email: 'r@example.com', promoCode: 'WELCOME5' })).toEqual({
      success: false,
      error: 'Promo code redemption limit reached'
    });
    expect(grantGift).not.toHaveBeenCalled();
  });

  it('refuses an ordinary campaign that grants no letters, before touching anything (#420)', async () => {
    state.campaign = campaign({
      code: 'EARLYBIRD',
      credits_amount: 0,
      gift_generations_remaining: null,
      requires_new_user: false,
      max_total_redemptions: null
    });
    expect(await redeemPromoCode({ userId: 'r', email: 'r@example.com', promoCode: 'EARLYBIRD' })).toEqual({
      success: false,
      error: "This code doesn't include any letters."
    });
    // Before #420 the ledger insert raised 23514 inside the transaction.
    expect(ran('UPDATE promo_campaigns')).toHaveLength(0);
    expect(ran('INSERT INTO credit_ledger')).toHaveLength(0);
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

describe('deleteCampaignWithClient', () => {
  function campaignClient(row: Record<string, string | number>) {
    const deletes: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FOR UPDATE')) return { rows: [row] };
        if (sql.startsWith('DELETE')) deletes.push(sql);
        return { rows: [] };
      })
    };
    return { client, deletes };
  }

  it('deletes an unused campaign', async () => {
    const { client, deletes } = campaignClient({ current_redemptions: 0, redeemed: '0', gifts: '0' });
    await deleteCampaignWithClient(client as never, 'campaign-1');
    expect(deletes).toHaveLength(1);
  });

  it('refuses a campaign any gift letter names: its code may be on paper already', async () => {
    const { client, deletes } = campaignClient({ current_redemptions: 0, redeemed: '0', gifts: '1' });
    await expect(deleteCampaignWithClient(client as never, 'campaign-1')).rejects.toThrow('invalid_state');
    expect(deletes).toHaveLength(0);
    expect(String(client.query.mock.calls[0][0])).toContain('g.card_campaign_id = c.campaign_id OR g.source_campaign_id = c.campaign_id');
  });
});
