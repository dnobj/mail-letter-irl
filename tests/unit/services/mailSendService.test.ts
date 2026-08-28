import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
// Today's letter counts, for the daily caps (#179). Defaults of 0 keep every
// pre-existing test on the "well under the ceiling" path.
let lettersTodayForUser = 0;
let lettersTodayGlobal = 0;
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
    if (sql.includes('COUNT(*) AS count') && sql.includes('FROM letters')) {
      // The caps FAIL CLOSED, so an unanswered COUNT is a refusal rather than
      // a pass - which is why this branch has to exist at all.
      const scoped = sql.includes('user_id = $1');
      return { rows: [{ count: String(scoped ? lettersTodayForUser : lettersTodayGlobal) }] };
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
    lettersTodayForUser = 0;
    lettersTodayGlobal = 0;
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

  /**
   * The beta cohort gate (#179), and the one place it must NOT apply.
   *
   * The exemption is the interesting half. This function runs during Pay & Send
   * FULFILMENT, after Stripe has already charged the customer, so a refusal
   * here would take the money and withhold the send in the same transaction -
   * leaving funds stranded and needing a refund. Pay & Send is gated earlier,
   * in createJitCheckout, before any charge exists. Exactly the reasoning the
   * sends_blocked check beside it already uses.
   */
  describe('the beta cohort gate', () => {
    afterEach(() => vi.unstubAllEnvs());

    const gateUp = () => {
      vi.stubEnv('LETTER_IRL_BETA_GATE_ENABLED', 'true');
      vi.stubEnv('LETTER_IRL_BETA_ALLOWED_SUBJECTS', 'auth0|admitted');
      vi.stubEnv('LETTER_IRL_ADMIN_USER_IDS', '');
    };

    it('refuses a prepaid send from a subject outside the cohort', async () => {
      gateUp();
      await expect(
        createMailOrderFromDraft({
          draftId: 'draft-1',
          userId: 'user-1',
          mailType: 'letter'
        })
      ).rejects.toMatchObject({ code: 'BETA_ACCESS_DENIED' });
      // No money moved and nothing was queued for the printer.
      expect(deductCredits).not.toHaveBeenCalled();
      expect(createOutboxJob).not.toHaveBeenCalled();
    });

    it('EXEMPTS jit_order funding, because the customer has already been charged', async () => {
      gateUp();
      commerceOrder = {
        order_id: 'order-jit',
        order_type: 'jit_mail',
        user_id: 'user-1',
        draft_id: 'draft-1',
        status: 'paid'
      };

      // user-1 is NOT in the cohort, and this still goes through. Refusing
      // would strand a real payment.
      await createMailOrderFromDraft({
        draftId: 'draft-1',
        userId: 'user-1',
        mailType: 'letter',
        funding: { type: 'jit_order', orderId: 'order-jit' }
      });

      expect(createOutboxJob).toHaveBeenCalledTimes(1);
    });

    it('lets an admitted subject send on prepaid balance', async () => {
      gateUp();
      draft.user_id = 'auth0|admitted';

      await createMailOrderFromDraft({
        draftId: 'draft-1',
        userId: 'auth0|admitted',
        mailType: 'letter'
      });

      expect(createOutboxJob).toHaveBeenCalledTimes(1);
    });

    it('stands aside entirely while the gate is down', async () => {
      vi.stubEnv('LETTER_IRL_BETA_GATE_ENABLED', 'false');
      await createMailOrderFromDraft({
        draftId: 'draft-1',
        userId: 'user-1',
        mailType: 'letter'
      });
      expect(createOutboxJob).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * The daily mail caps (#179).
   *
   * The check runs AFTER deductCreditsFromLedgerWithClient, because that call
   * has already taken users FOR UPDATE and the per-account count needs to be
   * serialised. So the credit really is deducted before the refusal - and the
   * only thing that gives it back is the transaction rolling back. That is the
   * property worth asserting, not merely that it threw.
   */
  describe('the daily mail caps', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('refuses over the per-account cap and rolls the deduction back', async () => {
      vi.stubEnv('LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP', '3');
      lettersTodayForUser = 4; // includes the row this send inserted

      await expect(
        createMailOrderFromDraft({
          draftId: 'draft-1',
          userId: 'user-1',
          mailType: 'letter'
        })
      ).rejects.toMatchObject({ code: 'ACCOUNT_DAILY_MAIL_CAP' });

      // The deduction DID happen - the check deliberately sits after it - and
      // the rollback is what undoes it.
      expect(deductCredits).toHaveBeenCalledTimes(1);
      // Nothing reached the printer, and the draft is spendable again.
      expect(createOutboxJob).not.toHaveBeenCalled();
      expect(draft.status).toBe('pending');
      expect(savedLetter).toBeNull();
    });

    it('refuses over the global ceiling', async () => {
      vi.stubEnv('LETTER_IRL_BETA_GLOBAL_DAILY_MAIL_CEILING', '25');
      lettersTodayGlobal = 26;

      await expect(
        createMailOrderFromDraft({
          draftId: 'draft-1',
          userId: 'user-1',
          mailType: 'letter'
        })
      ).rejects.toMatchObject({ code: 'GLOBAL_DAILY_MAIL_CEILING' });
      expect(createOutboxJob).not.toHaveBeenCalled();
    });

    it('stops on the kill switch', async () => {
      vi.stubEnv('LETTER_IRL_MAIL_SENDING_ENABLED', 'false');
      await expect(
        createMailOrderFromDraft({
          draftId: 'draft-1',
          userId: 'user-1',
          mailType: 'letter'
        })
      ).rejects.toMatchObject({ code: 'MAIL_SENDING_DISABLED' });
      expect(createOutboxJob).not.toHaveBeenCalled();
    });

    it('EXEMPTS jit_order funding from the caps as well as the gate', async () => {
      // The customer has already been charged. A ceiling reached between their
      // payment and their fulfilment must not strand their money - Pay & Send
      // is capped in createJitCheckout instead, before the charge.
      vi.stubEnv('LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP', '0');
      vi.stubEnv('LETTER_IRL_BETA_GLOBAL_DAILY_MAIL_CEILING', '0');
      lettersTodayForUser = 99;
      lettersTodayGlobal = 99;
      commerceOrder = {
        order_id: 'order-jit',
        order_type: 'jit_mail',
        user_id: 'user-1',
        draft_id: 'draft-1',
        status: 'paid'
      };

      await createMailOrderFromDraft({
        draftId: 'draft-1',
        userId: 'user-1',
        mailType: 'letter',
        funding: { type: 'jit_order', orderId: 'order-jit' }
      });

      expect(createOutboxJob).toHaveBeenCalledTimes(1);
    });

    it('lets an ordinary send through well under the caps', async () => {
      await createMailOrderFromDraft({
        draftId: 'draft-1',
        userId: 'user-1',
        mailType: 'letter'
      });
      expect(createOutboxJob).toHaveBeenCalledTimes(1);
    });
  });
});
