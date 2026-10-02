import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deductCredits: vi.fn(),
  createOutboxJob: vi.fn(),
  transaction: vi.fn(),
  diagnostics: [] as Array<{ level: string; event: string; fields: Record<string, unknown> }>
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
// The duplicate check (#412): mail the account sent recently, as the letters
// query returns it, and every tagged query in the order it ran.
let recentLetters: Record<string, any>[] = [];
let duplicateQueries: Array<{ sql: string; params: any[] }> = [];
// The letters INSERT as it ran, for the arrive-by dates (#535).
let letterInsert: { sql: string; params: any[] } | undefined;

const EMPTY_MD5 = 'd41d8cd98f00b204e9800998ecf8427e';

/** The current draft as the duplicate check reads it. */
function comparableRow(source: DraftState, extra: Record<string, any> = {}) {
  return {
    mail_type: source.mail_type,
    layout_type: source.layout_type ?? null,
    postcard_size: source.postcard_size ?? null,
    sender: source.sender,
    recipient: source.recipient,
    body_text: source.body_text,
    sign_off: source.sign_off,
    header_image_md5: EMPTY_MD5,
    inline_image_md5: EMPTY_MD5,
    front_image_md5: EMPTY_MD5,
    ...extra
  };
}

const client = {
  query: vi.fn(async (sql: string, params?: any[]) => {
    if (sql.includes('duplicate mail check')) {
      duplicateQueries.push({ sql, params: params ?? [] });
      if (sql.includes('duplicate mail check: draft')) return { rows: [comparableRow(draft)] };
      if (sql.includes('duplicate mail check: letters')) return { rows: recentLetters };
      return { rows: [] };
    }
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
      letterInsert = { sql, params: params ?? [] };
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
vi.mock('../../../src/utils/diagnosticLog.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/utils/diagnosticLog.js')>()),
  writeDiagnostic: (level: string, event: string, fields: Record<string, unknown> = {}) => {
    mocks.diagnostics.push({ level, event, fields });
  }
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
    recentLetters = [];
    duplicateQueries = [];
    letterInsert = undefined;
    mocks.diagnostics.length = 0;
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
      }),
      // Not held (#535): the draft names no arrival date.
      { notBefore: undefined }
    );
    expect(result.job?.idempotency_key).toBe(result.letter.letter_id);
  });

  it('copies the renderer the preview was drawn with into the letter (#534)', async () => {
    draft.renderer_version = 'pdf-1';
    await createMailOrderFromDraft({ draftId: 'draft-1', userId: 'user-1', mailType: 'letter' });
    expect(savedLetter?.content.rendererVersion).toBe('pdf-1');
  });

  it('copies the stationery the preview was drawn in into the letter (#563)', async () => {
    const botanical = { theme: 'botanical', dateLine: 'October 1, 2026' };
    (draft as Record<string, unknown>).renderer_version = 'pdf-2';
    (draft as Record<string, unknown>).stationery = botanical;
    await createMailOrderFromDraft({ draftId: 'draft-1', userId: 'user-1', mailType: 'letter' });
    expect(savedLetter?.content).toMatchObject({ rendererVersion: 'pdf-2', stationery: botanical });
  });

  it("leaves a Classic letter's content without stationery (#563)", async () => {
    (draft as Record<string, unknown>).renderer_version = 'pdf-1';
    (draft as Record<string, unknown>).stationery = null;
    await createMailOrderFromDraft({ draftId: 'draft-1', userId: 'user-1', mailType: 'letter' });
    expect(savedLetter?.content).toMatchObject({ rendererVersion: 'pdf-1' });
    expect(savedLetter?.content).not.toHaveProperty('stationery');
  });

  it('copies the pages a longer letter was laid out on into the letter, and none for one page (#586)', async () => {
    const funding = { type: 'jit_order' as const, orderId: 'order-jit' };
    commerceOrder = {
      order_id: 'order-jit', order_type: 'jit_mail', product_code: 'jit-letter-3-pages',
      user_id: 'user-1', draft_id: 'draft-1', status: 'paid'
    };
    draft = { ...draft, pages: 3, renderer_version: 'pdf-1' };
    await createMailOrderFromDraft({ draftId: 'draft-1', userId: 'user-1', mailType: 'letter', funding });
    expect(savedLetter?.content).toMatchObject({ rendererVersion: 'pdf-1', pages: 3 });
  });

  it("leaves a one-page letter's content without pages (#586)", async () => {
    draft = { ...draft, pages: 1, renderer_version: 'pdf-1' };
    await createMailOrderFromDraft({ draftId: 'draft-1', userId: 'user-1', mailType: 'letter' });
    expect(savedLetter?.content).toMatchObject({ rendererVersion: 'pdf-1' });
    expect(savedLetter?.content).not.toHaveProperty('pages');
  });

  it('copies the renderer into a postcard too (#534 Phase 4)', async () => {
    draft.mail_type = 'postcard';
    draft.renderer_version = 'pdf-1';
    await createMailOrderFromDraft({ draftId: 'draft-1', userId: 'user-1', mailType: 'postcard' });
    expect(savedLetter?.content).toMatchObject({ message: draft.body_text, rendererVersion: 'pdf-1' });
  });

  it('copies the front a postcard was drawn with into the letter (#594)', async () => {
    const front = { layout: 'greetings', place: 'Asheville' };
    draft.mail_type = 'postcard';
    draft.renderer_version = 'pdf-3';
    (draft as Record<string, unknown>).postcard_front = front;
    await createMailOrderFromDraft({ draftId: 'draft-1', userId: 'user-1', mailType: 'postcard' });
    expect(savedLetter?.content).toMatchObject({ rendererVersion: 'pdf-3', postcardFront: front });
  });

  it("leaves a full-bleed postcard's content without a front (#594)", async () => {
    draft.mail_type = 'postcard';
    draft.renderer_version = 'pdf-1';
    (draft as Record<string, unknown>).postcard_front = null;
    await createMailOrderFromDraft({ draftId: 'draft-1', userId: 'user-1', mailType: 'postcard' });
    expect(savedLetter?.content).toMatchObject({ rendererVersion: 'pdf-1' });
    expect(savedLetter?.content).not.toHaveProperty('postcardFront');
  });

  it("leaves a legacy postcard's content without a renderer version (#534 Phase 4)", async () => {
    draft.mail_type = 'postcard';
    draft.renderer_version = null;
    await createMailOrderFromDraft({ draftId: 'draft-1', userId: 'user-1', mailType: 'postcard' });
    expect(savedLetter?.content).toHaveProperty('message');
    expect(savedLetter?.content).not.toHaveProperty('rendererVersion');
  });

  it("leaves a legacy letter's content without a renderer version (#534)", async () => {
    draft.renderer_version = null;
    await createMailOrderFromDraft({ draftId: 'draft-1', userId: 'user-1', mailType: 'letter' });
    expect(savedLetter?.content).toBeDefined();
    expect(savedLetter?.content).not.toHaveProperty('rendererVersion');
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
      order_type: 'jit_mail', product_code: 'jit-letter',
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

  describe('the mail a Pay & Send order paid for (#586)', () => {
    const paidOrder = (productCode: string) => ({
      order_id: 'order-jit',
      order_type: 'jit_mail',
      product_code: productCode,
      user_id: 'user-1',
      draft_id: 'draft-1',
      status: 'paid'
    });
    const sendPaid = () =>
      createMailOrderFromDraft({
        draftId: 'draft-1',
        userId: 'user-1',
        mailType: 'letter',
        funding: { type: 'jit_order', orderId: 'order-jit' }
      });

    it('sends a two-page letter its two-page order paid for', async () => {
      draft = { ...draft, pages: 2, renderer_version: 'pdf-1' };
      commerceOrder = paidOrder('jit-letter-2-pages');
      await expect(sendPaid()).resolves.toMatchObject({ alreadyConsumed: false });
      expect(createOutboxJob).toHaveBeenCalledTimes(1);
    });

    it('refuses a letter whose pages changed after its order was paid, so the order is refunded rather than sent', async () => {
      draft = { ...draft, pages: 2, renderer_version: 'pdf-1' };
      commerceOrder = paidOrder('jit-letter');
      await expect(sendPaid()).rejects.toMatchObject({
        code: 'JIT_PRODUCT_MISMATCH',
        diagnosticClass: 'JIT_PRODUCT_MISMATCH'
      });
      expect(createOutboxJob).not.toHaveBeenCalled();
      expect(savedLetter).toBeNull();
      expect(draft.status).toBe('pending');
    });

    it('refuses the reverse too: a one-page letter on a two-page order', async () => {
      commerceOrder = paidOrder('jit-letter-2-pages');
      await expect(sendPaid()).rejects.toMatchObject({ code: 'JIT_PRODUCT_MISMATCH' });
      expect(createOutboxJob).not.toHaveBeenCalled();
    });

    it('refuses an order with a product code no mail is', async () => {
      commerceOrder = paidOrder('credit-pack-10');
      await expect(sendPaid()).rejects.toMatchObject({ code: 'JIT_PRODUCT_MISMATCH' });
    });

    it('refuses a draft no Pay & Send product matches by name, never by a TypeError', async () => {
      // Migration 047 allows at most three pages; a row past that matches no product.
      draft = { ...draft, pages: 4, renderer_version: 'pdf-1' };
      commerceOrder = paidOrder('jit-letter-3-pages');
      await expect(sendPaid()).rejects.toMatchObject({ code: 'JIT_PRODUCT_MISMATCH', diagnosticClass: 'JIT_PRODUCT_MISMATCH' });
      expect(createOutboxJob).not.toHaveBeenCalled();
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
    // The code doubles as the diagnostic class, so a catch that stores a class records which check failed (#394).
    ).rejects.toMatchObject({ code: 'DRAFT_FUNDING_CONFLICT', diagnosticClass: 'DRAFT_FUNDING_CONFLICT' });

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
    ).rejects.toMatchObject({ code: 'DRAFT_CHECKOUT_PENDING', diagnosticClass: 'DRAFT_CHECKOUT_PENDING' });
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
        order_type: 'jit_mail', product_code: 'jit-letter',
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
        order_type: 'jit_mail', product_code: 'jit-letter',
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
  /**
   * The same mail twice (#412). Checked after the deduction, like the caps,
   * so the account row is locked and two sends cannot both pass; a refusal
   * rolls the deduction back.
   */
  describe('the duplicate check', () => {
    const send = (extra: Record<string, unknown> = {}) =>
      createMailOrderFromDraft({ draftId: 'draft-1', userId: 'user-1', mailType: 'letter', ...extra });

    it('refuses mail that went out in the last day, and rolls the send back', async () => {
      recentLetters = [comparableRow(draft, { age_seconds: 180 })];

      await expect(send()).rejects.toMatchObject({
        code: 'DUPLICATE_RECENT_MAIL',
        duplicate: { kind: 'sent', mailType: 'letter', recipientName: 'Recipient', ageSeconds: 180 }
      });

      expect(deductCredits).toHaveBeenCalledTimes(1);
      expect(createOutboxJob).not.toHaveBeenCalled();
      expect(draft.status).toBe('pending');
      expect(savedLetter).toBeNull();
    });

    it('checks after the deduction, and leaves this send out', async () => {
      await send();

      const letters = duplicateQueries.find(query => query.sql.includes('duplicate mail check: letters'))!;
      expect(letters.params).toEqual(['user-1', 'letter', savedLetter!.letter_id]);
      const draftRead = duplicateQueries.find(query => query.sql.includes('duplicate mail check: draft'))!;
      expect(draftRead.params).toEqual(['draft-1', 'user-1']);

      const checkCall = client.query.mock.calls.findIndex(([sql]) => String(sql).includes('duplicate mail check'));
      const checkOrder = client.query.mock.invocationCallOrder[checkCall];
      expect(deductCredits.mock.invocationCallOrder[0]).toBeLessThan(checkOrder);
      const outboxOrder = createOutboxJob.mock.invocationCallOrder[0];
      expect(checkOrder).toBeLessThan(outboxOrder);
    });

    it('sends another copy when the person asked for one', async () => {
      recentLetters = [comparableRow(draft)];

      await expect(send({ allowDuplicate: true })).resolves.toMatchObject({ alreadyConsumed: false });

      expect(duplicateQueries).toEqual([]);
      expect(createOutboxJob).toHaveBeenCalledTimes(1);
    });

    it('lets different mail through', async () => {
      recentLetters = [comparableRow(draft, { body_text: 'Something else' })];

      await expect(send()).resolves.toMatchObject({ alreadyConsumed: false });
      expect(createOutboxJob).toHaveBeenCalledTimes(1);
    });

    it('never checks Pay & Send fulfilment, which runs after the customer paid', async () => {
      recentLetters = [comparableRow(draft)];
      commerceOrder = {
        order_id: 'order-jit',
        order_type: 'jit_mail', product_code: 'jit-letter',
        user_id: 'user-1',
        draft_id: 'draft-1',
        status: 'paid'
      };

      await send({ funding: { type: 'jit_order', orderId: 'order-jit' } });

      expect(duplicateQueries).toEqual([]);
      expect(createOutboxJob).toHaveBeenCalledTimes(1);
    });

    it('returns the existing order for a draft already sent, without checking', async () => {
      recentLetters = [comparableRow(draft)];
      draft = { ...draft, status: 'consumed', consumed_letter_id: 'letter-prepaid' };
      savedLetter = { letter_id: 'letter-prepaid', user_id: 'user-1', funding_type: 'prepaid_balance' };

      await expect(send()).resolves.toMatchObject({ alreadyConsumed: true });
      expect(duplicateQueries).toEqual([]);
    });
  });

  describe('arrive-by: mail held to its date (#535)', () => {
    // A Thursday, 10:00 in New York: today is still a mail date.
    const THURSDAY_MORNING = new Date('2026-10-01T14:00:00Z');
    const send = (funding?: Parameters<typeof createMailOrderFromDraft>[0]['funding']) =>
      createMailOrderFromDraft({ draftId: 'draft-1', userId: 'user-1', mailType: 'letter', ...(funding ? { funding } : {}) });
    const dates = () => [letterInsert!.params[9], letterInsert!.params[10]];

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(THURSDAY_MORNING);
      draft.expires_at = new Date(THURSDAY_MORNING.getTime() + 60_000);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('copies the dates to the letter and holds its job until 09:00 New York time on the mail date', async () => {
      draft.arrive_by = '2026-10-16';
      draft.mail_on = '2026-10-06';

      const result = await send();

      expect(letterInsert!.sql).toContain('arrive_by, mail_on');
      expect(letterInsert!.sql).toContain('$10::date, $11::date');
      expect(dates()).toEqual(['2026-10-16', '2026-10-06']);
      expect(createOutboxJob).toHaveBeenCalledWith(client, expect.objectContaining({ letter_id: result.letter.letter_id }), {
        notBefore: new Date('2026-10-06T13:00:00Z')
      });
      // The value moved as for any send: the hold is only when it prints.
      expect(deductCredits).toHaveBeenCalledTimes(1);
    });

    it('mails today when today is its mail date, released at once since 09:00 has passed', async () => {
      draft.arrive_by = '2026-10-13';
      draft.mail_on = '2026-10-01';

      await send();

      expect(dates()).toEqual(['2026-10-13', '2026-10-01']);
      const [, , options] = createOutboxJob.mock.calls[0];
      expect(options.notBefore).toEqual(new Date('2026-10-01T13:00:00Z'));
      expect(options.notBefore.getTime()).toBeLessThan(THURSDAY_MORNING.getTime());
    });

    it('sends as soon as it can, with no dates, when the draft names none', async () => {
      await send();

      expect(dates()).toEqual([null, null]);
      expect(createOutboxJob.mock.calls[0][2]).toEqual({ notBefore: undefined });
    });

    it('refuses a prepaid send whose mail date has passed, before any value moves', async () => {
      for (const [now, mailOn] of [
        ['2026-10-01T16:00:00Z', '2026-10-01'], // noon in New York, on the mail date
        [THURSDAY_MORNING.toISOString(), '2026-09-30'] // the day before
      ] as const) {
        vi.setSystemTime(new Date(now));
        draft.expires_at = new Date(Date.parse(now) + 60_000);
        draft.arrive_by = '2026-10-12';
        draft.mail_on = mailOn;

        await expect(send()).rejects.toMatchObject({ code: 'SCHEDULE_PASSED' });
        expect(letterInsert).toBeUndefined();
        expect(deductCredits).not.toHaveBeenCalled();
        expect(createOutboxJob).not.toHaveBeenCalled();
        expect(draft.status).toBe('pending');
      }
    });

    it('mails a paid Pay & Send order as soon as it can when its date has passed, and logs the miss', async () => {
      vi.setSystemTime(new Date('2026-10-01T17:00:00Z')); // 13:00 in New York
      draft.expires_at = new Date(Date.parse('2026-10-01T17:00:00Z') + 60_000);
      draft.arrive_by = '2026-10-12';
      draft.mail_on = '2026-10-01';
      commerceOrder = { order_id: 'order-jit', order_type: 'jit_mail', product_code: 'jit-letter', user_id: 'user-1', draft_id: 'draft-1', status: 'paid' };

      await send({ type: 'jit_order', orderId: 'order-jit' });

      expect(dates()).toEqual([null, null]);
      expect(createOutboxJob.mock.calls[0][2]).toEqual({ notBefore: undefined });
      expect(mocks.diagnostics).toContainEqual({
        level: 'warn',
        event: 'send.schedule_missed',
        fields: { funding: 'jit_order', mailOn: '2026-10-01' }
      });
    });

    it('holds a paid Pay & Send order whose date is still ahead, like any other', async () => {
      draft.arrive_by = '2026-10-16';
      draft.mail_on = '2026-10-06';
      commerceOrder = { order_id: 'order-jit', order_type: 'jit_mail', product_code: 'jit-letter', user_id: 'user-1', draft_id: 'draft-1', status: 'paid' };

      await send({ type: 'jit_order', orderId: 'order-jit' });

      expect(dates()).toEqual(['2026-10-16', '2026-10-06']);
      expect(createOutboxJob.mock.calls[0][2]).toEqual({ notBefore: new Date('2026-10-06T13:00:00Z') });
    });

    it('refuses dates it cannot read as calendar days rather than guessing the day', async () => {
      for (const [arriveBy, mailOn, column] of [
        ['2026-10-16', new Date('2026-10-06T00:00:00'), 'mail_on'], // a Date: pg without the DATE parser
        ['2026-10-16', null, 'mail_on'], // half a schedule
        [null, '2026-10-06', 'arrive_by'],
        ['2026-10-16', '2026-02-30', 'mail_on']
      ] as const) {
        draft.arrive_by = arriveBy;
        draft.mail_on = mailOn;
        await expect(send(), String(mailOn)).rejects.toThrow(`letter_drafts.${column} is not a 'YYYY-MM-DD' string`);
        expect(letterInsert).toBeUndefined();
      }
    });
  });
});
