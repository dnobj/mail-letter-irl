import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The gift branch of the send transaction (docs/gift-letters.md): a draft
 * previewed as a gift is funded by a gift letter, never by the balance, and
 * the card the consumption decides is written into the letter so every
 * process that prints it prints the same code.
 */

const mocks = vi.hoisted(() => ({
  deductCredits: vi.fn(),
  createOutboxJob: vi.fn(),
  transaction: vi.fn(),
  consumeGift: vi.fn()
}));

type Row = Record<string, any>;
let draft: Row;
let savedLetter: Row | null;
let giftSendsToday = 0;
let lettersTodayForUser = 0;
let recentLetters: Row[] = [];
let calls: string[] = [];

const client = {
  query: vi.fn(async (sql: string, params?: any[]) => {
    if (sql.includes('duplicate mail check')) {
      calls.push('duplicate');
      if (sql.includes('duplicate mail check: draft')) {
        return {
          rows: [
            {
              mail_type: draft.mail_type,
              layout_type: draft.layout_type,
              sender: draft.sender,
              recipient: draft.recipient,
              body_text: draft.body_text,
              sign_off: draft.sign_off
            }
          ]
        };
      }
      if (sql.includes('duplicate mail check: letters')) return { rows: recentLetters };
      return { rows: [] };
    }
    if (sql.startsWith('SELECT * FROM letter_drafts')) return { rows: [{ ...draft }] };
    if (sql.startsWith('SELECT credits FROM users')) return { rows: [{ credits: 0 }] };
    if (sql.includes('SELECT sends_blocked_reason')) return { rows: [{ sends_blocked_reason: null }] };
    if (sql.includes('SELECT order_id FROM orders')) return { rows: [] };
    if (sql.includes('INSERT INTO letters')) {
      calls.push('insert-letter');
      savedLetter = {
        letter_id: params?.[0],
        user_id: params?.[1],
        content: JSON.parse(params?.[2]),
        credits_cost: params?.[4],
        status: 'draft',
        mail_type: params?.[6],
        funding_type: params?.[7],
        funding_order_id: params?.[8]
      };
      return { rows: [{ ...savedLetter }] };
    }
    if (sql.includes('UPDATE letters SET content = content ||')) {
      calls.push('write-card');
      savedLetter = { ...savedLetter!, content: { ...savedLetter!.content, ...JSON.parse(params?.[1]) } };
      return { rows: [{ ...savedLetter }] };
    }
    if (sql.includes('UPDATE letter_drafts')) {
      draft = { ...draft, status: 'consumed', consumed_letter_id: params?.[0] };
      return { rows: [] };
    }
    if (sql.includes("funding_type = 'gift_letter'") && sql.includes('COUNT(*)')) {
      calls.push('gift-cap');
      return { rows: [{ count: String(giftSendsToday) }] };
    }
    if (sql.includes('COUNT(*) AS count') && sql.includes('FROM letters')) {
      calls.push('mail-cap');
      return { rows: [{ count: String(sql.includes('user_id = $1') ? lettersTodayForUser : 1) }] };
    }
    return { rows: [] };
  })
};

vi.mock('../../../src/db/index.js', () => ({ transaction: mocks.transaction }));
vi.mock('../../../src/services/creditLedgerService.js', () => ({
  deductCreditsFromLedgerWithClient: mocks.deductCredits
}));
vi.mock('../../../src/services/letterJobService.js', () => ({
  createLetterJobWithClient: mocks.createOutboxJob
}));
vi.mock('../../../src/services/giftLetterService.js', () => ({
  consumeGiftLetterForSendWithClient: mocks.consumeGift
}));

import { createMailOrderFromDraft } from '../../../src/services/mailSendService.js';

const FUNDED_CARD = {
  state: 'funded',
  code: 'K7M2QX9A',
  url: 'https://letterirl.com/g/K7M2QX9A',
  displayUrl: 'letterirl.com/g',
  redeemBy: '2026-12-16'
};

describe('createMailOrderFromDraft: gift sends', () => {
  const previousEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.LETTER_IRL_GIFT_LETTERS_ENABLED = 'true';
    delete process.env.LETTER_IRL_GIFT_DAILY_SEND_CAP;
    mocks.transaction.mockImplementation(async (callback: (c: typeof client) => Promise<unknown>) => {
      const draftSnapshot = { ...draft };
      const letterSnapshot = savedLetter ? { ...savedLetter } : null;
      try {
        return await callback(client);
      } catch (error) {
        draft = draftSnapshot;
        savedLetter = letterSnapshot;
        throw error;
      }
    });
    savedLetter = null;
    giftSendsToday = 1;
    lettersTodayForUser = 1;
    recentLetters = [];
    calls = [];
    draft = {
      draft_id: 'draft-gift',
      user_id: 'user-1',
      mail_type: 'letter',
      sender: { name: 'Sarah' },
      recipient: { name: 'Grandma' },
      body_text: 'Hello',
      sign_off: 'Love',
      required_credits: 2,
      layout_type: 'text_only',
      status: 'pending',
      is_gift_send: true,
      expires_at: new Date(Date.now() + 60_000)
    };
    mocks.consumeGift.mockImplementation(async () => {
      calls.push('consume-gift');
      return { gift: { gift_id: 'gift-1', generations_remaining: 1 }, card: FUNDED_CARD };
    });
    mocks.createOutboxJob.mockImplementation(async (_client: unknown, letter: Row) => ({
      job_id: 'job-1',
      letter_id: letter.letter_id
    }));
  });

  afterEach(() => {
    process.env = { ...previousEnv };
  });

  it('funds the letter with a gift letter, never the balance, and writes the card into it', async () => {
    const result = await createMailOrderFromDraft({ draftId: 'draft-gift', userId: 'user-1', mailType: 'letter' });

    expect(mocks.deductCredits).not.toHaveBeenCalled();
    expect(mocks.consumeGift).toHaveBeenCalledWith(client, { userId: 'user-1', letterId: result.letter.letter_id });
    expect(savedLetter?.funding_type).toBe('gift_letter');
    expect(savedLetter?.funding_order_id).toBeNull();
    expect(savedLetter?.content.giftCard).toEqual(FUNDED_CARD);
    expect(result.fundingType).toBe('gift_letter');
    expect(result.giftCard).toEqual(FUNDED_CARD);
    expect(mocks.createOutboxJob).toHaveBeenCalledTimes(1);
  });

  it('checks the caps and the duplicate guard only after the gift consumption has locked the account', async () => {
    await createMailOrderFromDraft({ draftId: 'draft-gift', userId: 'user-1', mailType: 'letter' });
    const consumeAt = calls.indexOf('consume-gift');
    expect(consumeAt).toBeGreaterThan(calls.indexOf('insert-letter'));
    for (const step of ['mail-cap', 'gift-cap', 'duplicate', 'write-card']) {
      expect(calls.indexOf(step), step).toBeGreaterThan(consumeAt);
    }
  });

  it('refuses a gift draft while gift letters are off, before inserting anything', async () => {
    process.env.LETTER_IRL_GIFT_LETTERS_ENABLED = 'ture';
    await expect(
      createMailOrderFromDraft({ draftId: 'draft-gift', userId: 'user-1', mailType: 'letter' })
    ).rejects.toMatchObject({ code: 'GIFT_LETTERS_DISABLED' });
    expect(mocks.consumeGift).not.toHaveBeenCalled();
    expect(savedLetter).toBeNull();
  });

  it('refuses and rolls back when the account has no gift letter left', async () => {
    mocks.consumeGift.mockResolvedValueOnce(null);
    await expect(
      createMailOrderFromDraft({ draftId: 'draft-gift', userId: 'user-1', mailType: 'letter' })
    ).rejects.toMatchObject({ code: 'GIFT_LETTER_UNAVAILABLE' });
    expect(draft.status).toBe('pending');
    expect(savedLetter).toBeNull();
    expect(mocks.createOutboxJob).not.toHaveBeenCalled();
  });

  it('refuses past the daily gift budget, counting this send', async () => {
    process.env.LETTER_IRL_GIFT_DAILY_SEND_CAP = '1';
    giftSendsToday = 2; // this send plus one earlier today
    await expect(
      createMailOrderFromDraft({ draftId: 'draft-gift', userId: 'user-1', mailType: 'letter' })
    ).rejects.toMatchObject({ code: 'GIFT_DAILY_SEND_CAP' });
    expect(draft.status).toBe('pending');

    giftSendsToday = 1; // this send is the first today
    await expect(
      createMailOrderFromDraft({ draftId: 'draft-gift', userId: 'user-1', mailType: 'letter' })
    ).resolves.toMatchObject({ fundingType: 'gift_letter' });
  });

  it('treats a gift cap of 0 as a kill switch', async () => {
    process.env.LETTER_IRL_GIFT_DAILY_SEND_CAP = '0';
    await expect(
      createMailOrderFromDraft({ draftId: 'draft-gift', userId: 'user-1', mailType: 'letter' })
    ).rejects.toMatchObject({ code: 'GIFT_DAILY_SEND_CAP' });
  });

  it('runs the #412 duplicate guard on a gift send unless another copy was asked for', async () => {
    recentLetters = [
      {
        mail_type: 'letter',
        layout_type: 'text_only',
        sender: draft.sender,
        recipient: draft.recipient,
        body_text: draft.body_text,
        sign_off: draft.sign_off,
        age_seconds: 60
      }
    ];
    await expect(
      createMailOrderFromDraft({ draftId: 'draft-gift', userId: 'user-1', mailType: 'letter' })
    ).rejects.toMatchObject({ code: 'DUPLICATE_RECENT_MAIL' });
    await expect(
      createMailOrderFromDraft({ draftId: 'draft-gift', userId: 'user-1', mailType: 'letter', allowDuplicate: true })
    ).resolves.toMatchObject({ fundingType: 'gift_letter' });
  });

  it('leaves an ordinary draft on the balance even with gift letters on', async () => {
    draft.is_gift_send = false;
    mocks.deductCredits.mockResolvedValue({ user: { credits: 6 } });
    const result = await createMailOrderFromDraft({ draftId: 'draft-gift', userId: 'user-1', mailType: 'letter' });
    expect(mocks.consumeGift).not.toHaveBeenCalled();
    expect(mocks.deductCredits).toHaveBeenCalledTimes(1);
    expect(result.fundingType).toBe('prepaid_balance');
    expect(savedLetter?.content.giftCard).toBeUndefined();
  });
});
