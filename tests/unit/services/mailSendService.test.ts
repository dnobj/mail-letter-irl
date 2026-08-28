import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deductCredits: vi.fn(),
  createOutboxJob: vi.fn(),
  transaction: vi.fn()
}));
const deductCredits = mocks.deductCredits;
const createOutboxJob = mocks.createOutboxJob;

type DraftState = Record<string, any>;
let draft: DraftState;
let savedLetter: Record<string, any> | null;
let commerceOrder: Record<string, any> | null;
let activeCheckout = false;
let transactionChain: Promise<unknown>;

const client = {
  query: vi.fn(async (sql: string, params?: any[]) => {
    if (sql.startsWith('SELECT * FROM letter_drafts')) {
      return { rows: [{ ...draft }] };
    }
    if (sql.startsWith('SELECT * FROM letters')) {
      return { rows: savedLetter ? [{ ...savedLetter }] : [] };
    }
    if (sql.startsWith('SELECT credits FROM users')) {
      return { rows: [{ credits: 8 }] };
    }
    if (sql.includes('SELECT order_id FROM orders')) {
      return { rows: activeCheckout ? [{ order_id: 'order-active' }] : [] };
    }
    if (sql.startsWith('SELECT * FROM orders')) {
      return { rows: commerceOrder ? [{ ...commerceOrder }] : [] };
    }
    if (sql.includes('INSERT INTO letters')) {
      savedLetter = {
        letter_id: params?.[0],
        user_id: params?.[1],
        content: JSON.parse(params?.[2]),
        recipient: JSON.parse(params?.[3]),
        credits_cost: params?.[4],
        status: 'draft',
        mail_type: params?.[6]
      };
      return { rows: [{ ...savedLetter }] };
    }
    if (sql.includes('UPDATE letter_drafts')) {
      draft = {
        ...draft,
        status: 'consumed',
        consumed_letter_id: params?.[0]
      };
      return { rows: [] };
    }
    if (sql.includes('UPDATE orders')) {
      commerceOrder = commerceOrder
        ? {
            ...commerceOrder,
            status: 'fulfillment_pending',
            letter_id: params?.[0]
          }
        : null;
      return { rows: commerceOrder ? [{ ...commerceOrder }] : [] };
    }
    return { rows: [] };
  })
};

const runTransaction = (callback: (dbClient: typeof client) => Promise<unknown>) => {
  const run = transactionChain.then(async () => {
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
  transactionChain = run.catch(() => undefined);
  return run;
};

vi.mock('../../../src/db/index.js', () => ({ transaction: mocks.transaction }));
vi.mock('../../../src/services/creditLedgerService.js', () => ({
  deductCreditsFromLedgerWithClient: mocks.deductCredits
}));
vi.mock('../../../src/services/letterJobService.js', () => ({
  createLetterJobWithClient: mocks.createOutboxJob
}));

import { createMailOrderFromDraft } from '../../../src/services/mailSendService.js';

describe('createMailOrderFromDraft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(runTransaction);
    transactionChain = Promise.resolve();
    savedLetter = null;
    commerceOrder = null;
    activeCheckout = false;
    draft = {
      draft_id: 'draft-1',
      user_id: 'user-1',
      mail_type: 'letter',
      sender: { name: 'Sender' },
      recipient: { name: 'Recipient' },
      body_text: 'Hello',
      sign_off: 'Regards',
      required_credits: 2,
      layout_type: 'text_only',
      status: 'pending',
      expires_at: new Date(Date.now() + 60_000)
    };
    deductCredits.mockResolvedValue({ user: { credits: 8 } });
    createOutboxJob.mockImplementation(async (_client, letter) => ({
      job_id: 'job-1',
      letter_id: letter.letter_id,
      status: 'pending',
      idempotency_key: letter.letter_id
    }));
  });

  it('commits draft, credit, letter, and outbox work through one transaction client', async () => {
    const result = await createMailOrderFromDraft({
      draftId: 'draft-1',
      userId: 'user-1',
      mailType: 'letter'
    });

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(deductCredits).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        userId: 'user-1',
        letterId: result.letter.letter_id
      })
    );
    expect(createOutboxJob).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        letter_id: result.letter.letter_id
      })
    );
    expect(result.job?.idempotency_key).toBe(result.letter.letter_id);
  });

  it('serializes concurrent retries into one credit deduction and one letter', async () => {
    const [first, second] = await Promise.all([
      createMailOrderFromDraft({
        draftId: 'draft-1',
        userId: 'user-1',
        mailType: 'letter'
      }),
      createMailOrderFromDraft({
        draftId: 'draft-1',
        userId: 'user-1',
        mailType: 'letter'
      })
    ]);

    expect(deductCredits).toHaveBeenCalledTimes(1);
    expect(createOutboxJob).toHaveBeenCalledTimes(1);
    expect(first.letter.letter_id).toBe(second.letter.letter_id);
    expect([first.alreadyConsumed, second.alreadyConsumed].sort()).toEqual([false, true]);
  });

  it('rolls every state change back when credit deduction fails', async () => {
    deductCredits.mockRejectedValueOnce(new Error('Insufficient credits'));

    await expect(
      createMailOrderFromDraft({
        draftId: 'draft-1',
        userId: 'user-1',
        mailType: 'letter'
      })
    ).rejects.toThrow('Insufficient credits');

    expect(draft.status).toBe('pending');
    expect(savedLetter).toBeNull();
    expect(createOutboxJob).not.toHaveBeenCalled();
  });

  it('uses paid JIT funding without mutating prepaid balance', async () => {
    commerceOrder = {
      order_id: 'order-jit',
      order_type: 'jit_mail',
      user_id: 'user-1',
      draft_id: 'draft-1',
      status: 'paid'
    };

    const result = await createMailOrderFromDraft({
      draftId: 'draft-1',
      userId: 'user-1',
      mailType: 'letter',
      funding: { type: 'jit_order', orderId: 'order-jit' }
    });

    expect(deductCredits).not.toHaveBeenCalled();
    expect(createOutboxJob).toHaveBeenCalledTimes(1);
    expect(result.creditsRemaining).toBe(8);
    expect(commerceOrder).toMatchObject({
      status: 'fulfillment_pending',
      letter_id: result.letter.letter_id
    });
  });

  it('rejects late JIT funding when prepaid funding already consumed the draft', async () => {
    draft = {
      ...draft,
      status: 'consumed',
      consumed_letter_id: 'letter-prepaid'
    };
    savedLetter = {
      letter_id: 'letter-prepaid',
      user_id: 'user-1',
      funding_type: 'prepaid_balance',
      funding_order_id: null
    };

    await expect(
      createMailOrderFromDraft({
        draftId: 'draft-1',
        userId: 'user-1',
        mailType: 'letter',
        funding: { type: 'jit_order', orderId: 'order-jit' }
      })
    ).rejects.toMatchObject({ code: 'DRAFT_FUNDING_CONFLICT' });

    expect(deductCredits).not.toHaveBeenCalled();
    expect(createOutboxJob).not.toHaveBeenCalled();
  });

  it('returns the existing mail item for an idempotent retry of the same JIT order', async () => {
    draft = {
      ...draft,
      status: 'consumed',
      consumed_letter_id: 'letter-jit'
    };
    savedLetter = {
      letter_id: 'letter-jit',
      user_id: 'user-1',
      funding_type: 'jit_order',
      funding_order_id: 'order-jit'
    };

    await expect(
      createMailOrderFromDraft({
        draftId: 'draft-1',
        userId: 'user-1',
        mailType: 'letter',
        funding: { type: 'jit_order', orderId: 'order-jit' }
      })
    ).resolves.toMatchObject({
      alreadyConsumed: true,
      letter: { letter_id: 'letter-jit' }
    });

    expect(deductCredits).not.toHaveBeenCalled();
    expect(createOutboxJob).not.toHaveBeenCalled();
  });

  it('blocks prepaid consumption while a JIT checkout is active', async () => {
    activeCheckout = true;
    await expect(
      createMailOrderFromDraft({
        draftId: 'draft-1',
        userId: 'user-1',
        mailType: 'letter'
      })
    ).rejects.toMatchObject({ code: 'DRAFT_CHECKOUT_PENDING' });
    expect(deductCredits).not.toHaveBeenCalled();
    expect(createOutboxJob).not.toHaveBeenCalled();
  });
});
