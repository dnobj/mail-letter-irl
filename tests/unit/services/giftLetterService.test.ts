import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * giftLetterService against a scripted client (docs/gift-letters.md). The
 * transactional guarantees - one redemption per code under concurrency, one
 * gift per send - are proven against PostgreSQL in
 * tests/integration/giftLetters.postgres.test.ts; these pin the decisions.
 */

type Handler = (sql: string, params: any[]) => { rows: any[] } | undefined;

const state = vi.hoisted(() => ({
  handlers: [] as Array<(sql: string, params: any[]) => { rows: any[] } | undefined>,
  log: [] as Array<{ sql: string; params: any[] }>
}));

function answer(sql: string, params: any[] = []) {
  state.log.push({ sql, params });
  for (const handler of state.handlers) {
    const result = handler(sql, params);
    if (result) return result;
  }
  return { rows: [] };
}

const client = { query: vi.fn(async (sql: string, params?: any[]) => answer(sql, params ?? [])) };

vi.mock('../../../src/db/index.js', () => ({
  query: vi.fn(async (sql: string, params?: any[]) => answer(sql, params ?? [])),
  transaction: vi.fn(async (callback: (c: typeof client) => Promise<unknown>) => callback(client))
}));

import {
  consumeGiftLetterForSendWithClient,
  getGiftBalance,
  grantGiftLettersWithClient,
  isGiftLetterCompensated,
  lookupGiftCodePublic,
  redeemChainCode,
  returnGiftLetterForFailedSendWithClient,
  revokeGiftLettersForOrderWithClient
} from '../../../src/services/giftLetterService.js';
import { VerifiedEmailRequiredError } from '../../../src/auth/verifiedEmail.js';

function on(match: string, rows: any[] | ((params: any[]) => any[])): void {
  state.handlers.push((sql, params) =>
    sql.includes(match) ? { rows: typeof rows === 'function' ? rows(params) : rows } : undefined
  );
}

function ran(match: string): Array<{ sql: string; params: any[] }> {
  return state.log.filter(entry => entry.sql.includes(match));
}

const FUTURE = new Date(Date.now() + 30 * 86_400_000);
const PAST = new Date(Date.now() - 86_400_000);

function gift(overrides: Record<string, any> = {}) {
  return {
    gift_id: 'gift-1',
    user_id: 'user-1',
    generations_remaining: 1,
    source: 'pack_purchase',
    source_reference_id: 'order-1',
    grant_index: 0,
    source_order_id: 'order-1',
    source_campaign_id: null,
    parent_code: null,
    card_campaign_id: null,
    status: 'available',
    expires_at: FUTURE,
    source_reversed_at: null,
    ...overrides
  };
}

beforeEach(() => {
  state.handlers = [];
  state.log = [];
  process.env.LETTER_IRL_GIFT_LETTERS_ENABLED = 'true';
  process.env.LETTER_IRL_GIFT_LANDING_BASE_URL = 'https://letterirl.com';
});

afterEach(() => {
  delete process.env.LETTER_IRL_GIFT_LETTERS_ENABLED;
  delete process.env.LETTER_IRL_GIFT_LANDING_BASE_URL;
});

describe('consumeGiftLetterForSendWithClient', () => {
  it('locks the account before touching gift_letters', async () => {
    on('SELECT * FROM gift_letters', [gift({ generations_remaining: 0 })]);
    await consumeGiftLetterForSendWithClient(client, { userId: 'user-1', letterId: 'letter-1' });
    const lockAt = state.log.findIndex(entry => entry.sql.includes('FROM users WHERE user_id = $1 FOR UPDATE'));
    const firstGift = state.log.findIndex(entry => entry.sql.includes('gift_letters'));
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(lockAt).toBeLessThan(firstGift);
  });

  it('mints a chain code worth one less budget when budget remains', async () => {
    on('SELECT * FROM gift_letters', [gift({ generations_remaining: 2 })]);
    on('INSERT INTO gift_codes', params => [{ code: params[0] }]);
    const result = await consumeGiftLetterForSendWithClient(client, { userId: 'user-1', letterId: 'letter-1' });

    const insert = ran('INSERT INTO gift_codes')[0];
    expect(insert.params[1]).toBe('gift-1');
    expect(insert.params[2]).toBe('letter-1');
    expect(insert.params[3]).toBe('user-1');
    expect(insert.params[4]).toBe(1); // 2 - 1: the decrement is the cost bound
    expect(result?.card.state).toBe('funded');
    expect(result?.card.code).toBe(insert.params[0]);
    expect(result?.card.url).toBe(`https://letterirl.com/g/${insert.params[0]}`);
    expect(result?.card.displayUrl).toBe('letterirl.com/g');
    expect(result?.card.redeemBy).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // A chain code is single-use, and its card says so.
    expect(result?.card.multiUse).toBeUndefined();
    expect(ran("SET status = 'consumed'")[0].params).toEqual(['gift-1', 'letter-1']);
  });

  it('prints the plain card and mints nothing when the budget is spent', async () => {
    on('SELECT * FROM gift_letters', [gift({ generations_remaining: 0 })]);
    const result = await consumeGiftLetterForSendWithClient(client, { userId: 'user-1', letterId: 'letter-1' });
    expect(result?.card).toEqual({ state: 'unfunded', url: 'https://letterirl.com', displayUrl: 'letterirl.com' });
    expect(ran('INSERT INTO gift_codes')).toHaveLength(0);
  });

  it("prints a live seed campaign's own code instead of minting one", async () => {
    on('SELECT * FROM gift_letters', [gift({ generations_remaining: 0, card_campaign_id: 'campaign-1' })]);
    on('FROM promo_campaigns WHERE campaign_id', [
      {
        campaign_id: 'campaign-1',
        code: 'JANE-SMITH',
        status: 'active',
        starts_at: PAST,
        ends_at: null,
        gift_generations_remaining: 1
      }
    ]);
    const result = await consumeGiftLetterForSendWithClient(client, { userId: 'user-1', letterId: 'letter-1' });
    // Many people may claim a seed code, so its card must not say it works once.
    expect(result?.card).toMatchObject({ state: 'funded', code: 'JANE-SMITH', url: 'https://letterirl.com/g/JANE-SMITH', multiUse: true });
    // Open to every account: nothing on the card says otherwise.
    expect(result?.card.newAccountsOnly).toBeUndefined();
    expect(ran('INSERT INTO gift_codes')).toHaveLength(0);
  });

  it("says on the card when a seed campaign is for new accounts only", async () => {
    on('SELECT * FROM gift_letters', [gift({ generations_remaining: 0, card_campaign_id: 'campaign-1' })]);
    on('FROM promo_campaigns WHERE campaign_id', [
      {
        campaign_id: 'campaign-1',
        code: 'JANE-SMITH',
        status: 'active',
        starts_at: PAST,
        ends_at: null,
        gift_generations_remaining: 1,
        requires_new_user: true
      }
    ]);
    const result = await consumeGiftLetterForSendWithClient(client, { userId: 'user-1', letterId: 'letter-1' });
    expect(result?.card).toMatchObject({ code: 'JANE-SMITH', multiUse: true, newAccountsOnly: true });
    // The flag has to be read where the card is decided.
    expect(ran('FROM promo_campaigns WHERE campaign_id')[0].sql).toContain('requires_new_user');
  });

  it("stops printing a seed code once its campaign is at its cap, and falls back to the letter's own card (#435)", async () => {
    const capped = {
      campaign_id: 'campaign-1',
      code: 'JANE-SMITH',
      status: 'active',
      starts_at: PAST,
      ends_at: null,
      max_total_redemptions: 2,
      current_redemptions: 2,
      gift_generations_remaining: 1
    };
    on('SELECT * FROM gift_letters', [gift({ generations_remaining: 0, card_campaign_id: 'campaign-1' })]);
    on('FROM promo_campaigns WHERE campaign_id', [capped]);
    const plain = await consumeGiftLetterForSendWithClient(client, { userId: 'user-1', letterId: 'letter-1' });
    // Every claim of that code is refused now, so printing it would promise a letter nobody can have.
    expect(plain?.card).toEqual({ state: 'unfunded', url: 'https://letterirl.com', displayUrl: 'letterirl.com' });
    // The cap is read where the card is decided.
    expect(ran('FROM promo_campaigns WHERE campaign_id')[0].sql).toContain('max_total_redemptions');

    state.handlers = [];
    state.log = [];
    on('SELECT * FROM gift_letters', [gift({ generations_remaining: 1, card_campaign_id: 'campaign-1' })]);
    on('FROM promo_campaigns WHERE campaign_id', [capped]);
    on('INSERT INTO gift_codes', params => [{ code: params[0] }]);
    const chained = await consumeGiftLetterForSendWithClient(client, { userId: 'user-1', letterId: 'letter-1' });
    expect(chained?.card.state).toBe('funded');
    expect(chained?.card.code).not.toBe('JANE-SMITH');
    expect(chained?.card.multiUse).toBeUndefined();
    expect(ran('INSERT INTO gift_codes')).toHaveLength(1);

    // One claim short of the cap, the code still prints.
    state.handlers = [];
    on('SELECT * FROM gift_letters', [gift({ generations_remaining: 0, card_campaign_id: 'campaign-1' })]);
    on('FROM promo_campaigns WHERE campaign_id', [{ ...capped, current_redemptions: 1 }]);
    const open = await consumeGiftLetterForSendWithClient(client, { userId: 'user-1', letterId: 'letter-1' });
    expect(open?.card).toMatchObject({ code: 'JANE-SMITH', multiUse: true });

    // A campaign with no cap (NULL) never reaches one.
    state.handlers = [];
    on('SELECT * FROM gift_letters', [gift({ generations_remaining: 0, card_campaign_id: 'campaign-1' })]);
    on('FROM promo_campaigns WHERE campaign_id', [{ ...capped, max_total_redemptions: null, current_redemptions: 5000 }]);
    const uncapped = await consumeGiftLetterForSendWithClient(client, { userId: 'user-1', letterId: 'letter-1' });
    expect(uncapped?.card).toMatchObject({ code: 'JANE-SMITH', multiUse: true });
  });

  it('falls back to its own budget when its seed campaign has ended', async () => {
    on('SELECT * FROM gift_letters', [gift({ generations_remaining: 0, card_campaign_id: 'campaign-1' })]);
    on('FROM promo_campaigns WHERE campaign_id', [
      { campaign_id: 'campaign-1', code: 'JANE-SMITH', status: 'ended', starts_at: PAST, ends_at: null, gift_generations_remaining: 1 }
    ]);
    const result = await consumeGiftLetterForSendWithClient(client, { userId: 'user-1', letterId: 'letter-1' });
    expect(result?.card.state).toBe('unfunded');
  });

  it('answers null when there is no gift letter to use', async () => {
    const result = await consumeGiftLetterForSendWithClient(client, { userId: 'user-1', letterId: 'letter-1' });
    expect(result).toBeNull();
    expect(ran("SET status = 'consumed'")).toHaveLength(0);
  });

  it('never mints a code a promo campaign reads as', async () => {
    on('SELECT * FROM gift_letters', [gift()]);
    on('INSERT INTO gift_codes', params => [{ code: params[0] }]);
    await consumeGiftLetterForSendWithClient(client, { userId: 'user-1', letterId: 'letter-1' });
    const sql = ran('INSERT INTO gift_codes')[0].sql;
    expect(sql).toContain("translate(UPPER(code), 'OIL- ', '011') = $1::text");
  });

  it('retries a colliding code and gives up with a class after five', async () => {
    on('SELECT * FROM gift_letters', [gift()]);
    let attempts = 0;
    state.handlers.push(sql => {
      if (!sql.includes('INSERT INTO gift_codes')) return undefined;
      attempts += 1;
      return { rows: [] };
    });
    await expect(
      consumeGiftLetterForSendWithClient(client, { userId: 'user-1', letterId: 'letter-1' })
    ).rejects.toMatchObject({ code: 'GIFT_CODE_UNAVAILABLE' });
    expect(attempts).toBe(5);
  });
});

describe('redeemChainCode', () => {
  function code(overrides: Record<string, any> = {}) {
    return {
      code: 'K7M2QX9A',
      gift_id: 'gift-1',
      letter_id: 'letter-1',
      issued_to_user_id: 'sender-1',
      issuer_email: 'Sarah.J+x@gmail.com',
      grants_generations_remaining: 0,
      status: 'issued',
      expires_at: FUTURE,
      ...overrides
    };
  }

  it('answers undefined for something that is not a chain code, so promo campaigns get it', async () => {
    expect(await redeemChainCode({ userId: 'u', rawCode: 'JANE-SMITH' })).toBeUndefined();
    expect(state.log).toHaveLength(0);
    // Shaped like a chain code but not one: still falls through.
    expect(await redeemChainCode({ userId: 'u', rawCode: 'WELCOME5' })).toBeUndefined();
  });

  it('grants one gift letter with the code budget and marks the code redeemed', async () => {
    on('FROM gift_codes gc', [code({ grants_generations_remaining: 2 })]);
    on('SELECT * FROM users WHERE user_id = $1', [{ user_id: 'recipient-1' }]);
    on('FOR UPDATE', [code({ grants_generations_remaining: 2 })]);
    on('INSERT INTO gift_letters', params => [gift({ user_id: params[0], generations_remaining: params[1] })]);
    const result = await redeemChainCode({ userId: 'recipient-1', email: 'grandma@example.com', rawCode: 'k7m2-qx9a' });

    expect(result).toMatchObject({ success: true, giftLetters: 1 });
    expect(ran("SET status = 'redeemed'")[0].params).toEqual(['K7M2QX9A', 'recipient-1']);
    const grant = ran('INSERT INTO gift_letters')[0].params;
    expect(grant.slice(0, 5)).toEqual(['recipient-1', 2, 'chain_redemption', 'K7M2QX9A', 0]);
    expect(grant[7]).toBe('K7M2QX9A'); // parent_code
  });

  it("refuses the sender's own code, by account and by the same mailbox", async () => {
    on('FROM gift_codes gc', [code()]);
    expect(await redeemChainCode({ userId: 'sender-1', email: 'other@example.com', rawCode: 'K7M2QX9A' })).toMatchObject({
      success: false,
      reason: 'own_code'
    });
    expect(await redeemChainCode({ userId: 'alt-account', email: 'sarahj@gmail.com', rawCode: 'K7M2QX9A' })).toMatchObject({
      success: false,
      reason: 'own_code'
    });
    expect(ran("SET status = 'redeemed'")).toHaveLength(0);
  });

  it('refuses a redeemed, void or expired code', async () => {
    for (const [overrides, reason] of [
      [{ status: 'redeemed' }, 'redeemed'],
      [{ status: 'void' }, 'void'],
      [{ expires_at: PAST }, 'expired']
    ] as const) {
      state.handlers = [];
      on('FROM gift_codes gc', [code(overrides)]);
      expect(await redeemChainCode({ userId: 'r', rawCode: 'K7M2QX9A' })).toMatchObject({ success: false, reason });
    }
    expect(ran("SET status = 'redeemed'")).toHaveLength(0);
  });

  it('re-checks under the lock: a code redeemed between the read and the lock is refused', async () => {
    on('FROM gift_codes gc', [code()]);
    on('SELECT * FROM users WHERE user_id = $1', [{ user_id: 'r' }]);
    on('FOR UPDATE', [code({ status: 'redeemed' })]);
    expect(await redeemChainCode({ userId: 'r', rawCode: 'K7M2QX9A' })).toMatchObject({ success: false, reason: 'redeemed' });
    expect(ran('INSERT INTO gift_letters')).toHaveLength(0);
  });

  it('refuses a redeemer with neither an account nor an address to open one', async () => {
    // The row gift_letters.user_id needs used to be opened from
    // `${userId}@unknown.com`. That account is real, its address is not, and
    // the own-code check above - which compares mailboxes - cannot see it.
    // One walked through it on 2026-09-18. There is no address of last
    // resort now: no row and no address is a refusal.
    on('FROM gift_codes gc', [code()]);
    on('FOR UPDATE', [code()]);
    await expect(redeemChainCode({ userId: 'stranger', rawCode: 'K7M2QX9A' })).rejects.toBeInstanceOf(
      VerifiedEmailRequiredError
    );
    expect(ran('INSERT INTO users')).toHaveLength(0);
    expect(ran('INSERT INTO gift_letters')).toHaveLength(0);
  });

  it('refuses every code while gift letters are off', async () => {
    process.env.LETTER_IRL_GIFT_LETTERS_ENABLED = 'false';
    on('FROM gift_codes gc', [code()]);
    expect(await redeemChainCode({ userId: 'r', rawCode: 'K7M2QX9A' })).toMatchObject({ success: false, reason: 'not_available' });
  });
});

describe('lookupGiftCodePublic', () => {
  it('reports a claimable chain code without naming who sent it', async () => {
    on('SELECT status, expires_at FROM gift_codes', [{ status: 'issued', expires_at: FUTURE }]);
    const result = await lookupGiftCodePublic('K7M2-QX9A');
    expect(result).toEqual({ valid: true, kind: 'chain', redeemBy: FUTURE.toISOString().slice(0, 10) });
    expect(state.log[0].sql).not.toContain('users');
  });

  it('reports a seed campaign, and refuses an ordinary one', async () => {
    on('FROM promo_campaigns WHERE UPPER(code)', params =>
      params[0] === 'JANE-SMITH'
        ? [{ code: 'JANE-SMITH', status: 'active', starts_at: PAST, ends_at: null, max_total_redemptions: 10, current_redemptions: 3, gift_generations_remaining: 1 }]
        : [{ code: 'WELCOME5', status: 'active', starts_at: PAST, ends_at: null, max_total_redemptions: null, current_redemptions: 0, gift_generations_remaining: null }]
    );
    expect(await lookupGiftCodePublic('jane-smith')).toEqual({ valid: true, kind: 'seed' });
    expect(await lookupGiftCodePublic('WELCOME5')).toEqual({ valid: false, reason: 'not_found' });
  });

  it('tells the claim page when a seed is for new customers only, and only then', async () => {
    on('FROM promo_campaigns WHERE UPPER(code)', params => [
      {
        code: params[0],
        status: 'active',
        starts_at: PAST,
        ends_at: null,
        max_total_redemptions: 10,
        current_redemptions: 3,
        gift_generations_remaining: 1,
        requires_new_user: params[0] === 'NEW-ONLY'
      }
    ]);
    expect(await lookupGiftCodePublic('new-only')).toEqual({ valid: true, kind: 'seed', newCustomersOnly: true });
    expect(await lookupGiftCodePublic('ANYONE')).toEqual({ valid: true, kind: 'seed' });
    expect(ran('FROM promo_campaigns WHERE UPPER(code)')[0].sql).toContain('requires_new_user');
  });

  it('reports a full seed campaign', async () => {
    on('FROM promo_campaigns WHERE UPPER(code)', [
      { code: 'JANE', status: 'active', starts_at: PAST, ends_at: null, max_total_redemptions: 3, current_redemptions: 3, gift_generations_remaining: 1 }
    ]);
    expect(await lookupGiftCodePublic('JANE')).toEqual({ valid: false, kind: 'seed', reason: 'limit_reached' });
  });

  it('says nothing while gift letters are off', async () => {
    process.env.LETTER_IRL_GIFT_LETTERS_ENABLED = '';
    expect(await lookupGiftCodePublic('K7M2QX9A')).toEqual({ valid: false, reason: 'not_available' });
    expect(state.log).toHaveLength(0);
  });
});

describe('returnGiftLetterForFailedSendWithClient', () => {
  it('voids the unmailed code and hands back a gift with the same budget, once', async () => {
    on('SELECT * FROM gift_letters', [gift({ status: 'consumed', generations_remaining: 3, card_campaign_id: 'c-1' })]);
    on('SELECT * FROM gift_codes WHERE letter_id', [{ code: 'K7M2QX9A', status: 'issued' }]);
    const returned = await returnGiftLetterForFailedSendWithClient(client, { letterId: 'letter-1', userId: 'user-1', failureCode: 'PROVIDER_REJECTED' });

    expect(returned).toBe(1);
    expect(ran("void_reason = 'send_failed'")[0].params).toEqual(['K7M2QX9A']);
    const insert = ran('INSERT INTO gift_letters')[0];
    expect(insert.sql).toContain("'send_failed'");
    expect(insert.params.slice(0, 3)).toEqual(['user-1', 3, 'letter-1']);
    expect(insert.params[6]).toBe('c-1'); // keeps its seed binding
  });

  it('gives the replacement a fresh life when the used gift was near its end', async () => {
    on('SELECT * FROM gift_letters', [gift({ status: 'consumed', expires_at: PAST })]);
    on('SELECT * FROM gift_codes WHERE letter_id', [{ code: 'K7M2QX9A', status: 'issued' }]);
    await returnGiftLetterForFailedSendWithClient(client, { letterId: 'letter-1', userId: 'user-1', failureCode: 'X' });
    const expiresAt = ran('INSERT INTO gift_letters')[0].params[7] as Date;
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 170 * 86_400_000);
  });

  it('keeps a later expiry when the used gift had more life left than a fresh one', async () => {
    const far = new Date(Date.now() + 400 * 86_400_000);
    on('SELECT * FROM gift_letters', [gift({ status: 'consumed', expires_at: far })]);
    on('SELECT * FROM gift_codes WHERE letter_id', [{ code: 'K7M2QX9A', status: 'issued' }]);
    await returnGiftLetterForFailedSendWithClient(client, { letterId: 'letter-1', userId: 'user-1', failureCode: 'X' });
    expect(ran('INSERT INTO gift_letters')[0].params[7]).toBe(far);
  });

  it('keeps a gift that never expired never expiring', async () => {
    on('SELECT * FROM gift_letters', [gift({ status: 'consumed', expires_at: null })]);
    on('SELECT * FROM gift_codes WHERE letter_id', [{ code: 'K7M2QX9A', status: 'issued' }]);
    await returnGiftLetterForFailedSendWithClient(client, { letterId: 'letter-1', userId: 'user-1', failureCode: 'X' });
    expect(ran('INSERT INTO gift_letters')[0].params[7]).toBeNull();
  });

  it('returns nothing on a replay', async () => {
    on("source = 'send_failed' AND source_reference_id", [{ gift_id: 'returned' }]);
    expect(await returnGiftLetterForFailedSendWithClient(client, { letterId: 'letter-1', userId: 'user-1', failureCode: 'X' })).toBe(0);
    expect(ran('INSERT INTO gift_letters')).toHaveLength(0);
  });

  it('returns nothing once the code has been redeemed: the letter evidently arrived', async () => {
    on('SELECT * FROM gift_letters', [gift({ status: 'consumed' })]);
    on('SELECT * FROM gift_codes WHERE letter_id', [{ code: 'K7M2QX9A', status: 'redeemed' }]);
    expect(await returnGiftLetterForFailedSendWithClient(client, { letterId: 'letter-1', userId: 'user-1', failureCode: 'X' })).toBe(0);
    expect(ran("SET status = 'void'")).toHaveLength(0);
    expect(ran('INSERT INTO gift_letters')).toHaveLength(0);
  });

  it('voids the code but returns nothing when the purchase was reversed', async () => {
    on('SELECT * FROM gift_letters', [gift({ status: 'consumed', source_reversed_at: PAST })]);
    on('SELECT * FROM gift_codes WHERE letter_id', [{ code: 'K7M2QX9A', status: 'issued' }]);
    expect(await returnGiftLetterForFailedSendWithClient(client, { letterId: 'letter-1', userId: 'user-1', failureCode: 'X' })).toBe(0);
    expect(ran("void_reason = 'send_failed'")).toHaveLength(1);
    expect(ran('INSERT INTO gift_letters')).toHaveLength(0);
  });

  it('counts a returned gift or a reversed purchase as compensation', async () => {
    on('AS compensated', [{ compensated: true }]);
    expect(await isGiftLetterCompensated(client, 'letter-1')).toBe(true);
    expect(ran('AS compensated')[0].sql).toContain("source_reversed_at IS NOT NULL");
  });
});

describe('grant, balance and reversal', () => {
  it('grants idempotently per index, under the account lock', async () => {
    on('INSERT INTO gift_letters', params => (params[4] === 0 ? [gift()] : []));
    const granted = await grantGiftLettersWithClient(client, {
      userId: 'user-1',
      quantity: 2,
      generationsRemaining: 1,
      source: 'pack_purchase',
      sourceReferenceId: 'order-1',
      sourceOrderId: 'order-1'
    });
    expect(granted).toHaveLength(1); // index 1 already existed
    expect(ran('INSERT INTO gift_letters').map(entry => entry.params[4])).toEqual([0, 1]);
    expect(ran('INSERT INTO gift_letters')[0].sql).toContain('ON CONFLICT (source, source_reference_id, grant_index) DO NOTHING');
    expect(state.log[0].sql).toContain('FOR UPDATE');
  });

  it('refuses a negative budget', async () => {
    await expect(
      grantGiftLettersWithClient(client, { userId: 'u', quantity: 1, generationsRemaining: -1, source: 'operator', sourceReferenceId: 'x' })
    ).rejects.toThrow();
  });

  it('reports the card the next gift send would print', async () => {
    on('FROM gift_letters g', [gift({ generations_remaining: 0 }), gift({ gift_id: 'gift-2' })]);
    expect(await getGiftBalance('user-1')).toEqual({ available: 2, next: { giftId: 'gift-1', cardState: 'unfunded' } });
  });

  it('reports when the next gift letter prints a live seed campaign, so the preview can say so', async () => {
    const seedBound = {
      card_campaign_id: 'campaign-1',
      campaign_code: 'JANE-SMITH',
      campaign_status: 'active',
      starts_at: PAST,
      ends_at: null,
      gift_generations_remaining: 1
    };
    const ENDS = new Date(Date.now() + 40 * 86_400_000);
    on('FROM gift_letters g', [gift({ generations_remaining: 0, ...seedBound, ends_at: ENDS, requires_new_user: true })]);
    // The preview draws the card the print will: the campaign's own code and end date (#433).
    expect(await getGiftBalance('user-1')).toEqual({
      available: 1,
      next: { giftId: 'gift-1', cardState: 'funded', seed: { code: 'JANE-SMITH', endsAt: ENDS, newAccountsOnly: true } }
    });
    const sql = ran('FROM gift_letters g')[0].sql;
    for (const column of ['c.requires_new_user', 'c.code AS campaign_code', 'c.max_total_redemptions', 'c.current_redemptions']) {
      expect(sql).toContain(column);
    }

    state.handlers = [];
    on('FROM gift_letters g', [gift({ generations_remaining: 0, ...seedBound, requires_new_user: false })]);
    expect((await getGiftBalance('user-1')).next?.seed).toEqual({ code: 'JANE-SMITH', endsAt: null, newAccountsOnly: false });

    // At its cap the campaign prints nothing, and the preview says what will print instead (#435).
    state.handlers = [];
    on('FROM gift_letters g', [gift({ generations_remaining: 0, ...seedBound, max_total_redemptions: 2, current_redemptions: 2 })]);
    expect((await getGiftBalance('user-1')).next).toEqual({ giftId: 'gift-1', cardState: 'unfunded' });

    // An ended campaign funds nothing, and the card falls back to the letter's own budget.
    state.handlers = [];
    on('FROM gift_letters g', [gift({ generations_remaining: 0, ...seedBound, campaign_status: 'ended' })]);
    expect((await getGiftBalance('user-1')).next).toEqual({ giftId: 'gift-1', cardState: 'unfunded' });
  });

  it('revokes unsent gifts on a refund and leaves printed codes alone', async () => {
    await revokeGiftLettersForOrderWithClient(client, 'order-1', 'payment_refunded');
    expect(ran("SET status = 'revoked'")[0].params).toEqual(['order-1']);
    expect(ran('source_reversed_at = COALESCE')[0].params).toEqual(['order-1']);
    expect(ran('gift_codes')).toHaveLength(0);
  });

  it('also voids the unredeemed codes on a dispute', async () => {
    await revokeGiftLettersForOrderWithClient(client, 'order-1', 'payment_disputed');
    const voided = ran("void_reason = 'purchase_reversed'");
    expect(voided).toHaveLength(1);
    expect(voided[0].sql).toContain("WHERE status = 'issued'");
  });
});
