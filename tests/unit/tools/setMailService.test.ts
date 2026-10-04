/**
 * set_mail_service (#625): how a previewed letter travels, changed without
 * previewing it again. The draft changes only through setDraftMailService,
 * whose refusals become sentences the model can act on; the answer prices the
 * draft as it stands after the change. Behind certified mail being offered
 * (LETTER_IRL_CERTIFIED_MAIL_ENABLED with Pay & Send).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/draftService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/draftService.js')>()),
  setDraftMailService: vi.fn(),
  getDraftForMailService: vi.fn()
}));

vi.mock('../../../src/services/giftLetterService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/giftLetterService.js')>()),
  getGiftBalance: vi.fn()
}));

vi.mock('../../../src/services/commerceService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/commerceService.js')>()),
  getSendEligibility: vi.fn()
}));

import { getDraftForMailService, setDraftMailService } from '../../../src/services/draftService.js';
import { getSendEligibility } from '../../../src/services/commerceService.js';
import { getGiftBalance } from '../../../src/services/giftLetterService.js';
import { MailServiceRefusedError, SET_MAIL_SERVICE_TOOL, setMailServiceTool } from '../../../src/tools/setMailService.js';
import { CERTIFIED_PAID_PER_SEND_REASON } from '../../../src/tools/letterHelpers.js';
import { setMailServiceInputSchema, setMailServiceOutputSchema } from '../../../src/schemas.js';
import { setMailServiceInputZ, setMailServiceOutputZ } from '../../../src/zodSchemas.js';
import type { ToolContext } from '../../../src/contracts/types.js';

const DRAFT_ID = '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0';
const NOW = new Date('2026-10-01T14:00:00Z');

function context(credits = 10): ToolContext {
  return {
    user: { userId: 'auth0|owner', creditsRemaining: credits, orders: [] } as unknown as ToolContext['user'],
    correlationId: 'corr-1',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never,
    now: () => NOW,
    persist: vi.fn()
  };
}

const set = (input: Record<string, unknown>, ctx = context()) => setMailServiceTool.handler(input as never, ctx);

/** The draft as the answer reads it after the change. */
const draft = (overrides: Record<string, unknown> = {}) =>
  ({ mail_type: 'letter', postcard_size: null, pages: 1, mail_service: 'standard', is_gift_send: false, required_credits: 1, status: 'pending', ...overrides }) as never;

beforeEach(() => {
  vi.stubEnv('LETTER_IRL_CERTIFIED_MAIL_ENABLED', 'true');
  vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
  vi.mocked(setDraftMailService).mockReset().mockResolvedValue(null);
  vi.mocked(getDraftForMailService).mockReset().mockResolvedValue(draft({ mail_service: 'certified' }));
  vi.mocked(getGiftBalance).mockReset().mockResolvedValue({ available: 0, next: undefined } as never);
  vi.mocked(getSendEligibility).mockReset().mockReturnValue({
    payAndSend: { available: true, amountCents: 1199 },
    letterPack: { available: false, purchaseUrl: 'https://packs.example/pricing' },
    packPays: false
  } as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the cards and the tool list (#625)', () => {
  it('may be called by the letter card, changes nothing but a draft, and is safe to repeat', () => {
    expect(setMailServiceTool.name).toBe(SET_MAIL_SERVICE_TOOL);
    expect(setMailServiceTool.meta?.['openai/widgetAccessible']).toBe(true);
    expect(setMailServiceTool.meta?.readOnlyHint).toBe(false);
    expect(setMailServiceTool.meta?.idempotentHint).toBe(true);
    expect(setMailServiceTool.readOnly).toBe(false);
  });

  it('asks for a draft and a service, one of three', () => {
    expect(setMailServiceInputSchema.required).toEqual(['draftId', 'mailService']);
    expect((setMailServiceInputSchema.properties as Record<string, { enum?: string[] }>).mailService.enum).toEqual([
      'standard',
      'certified',
      'certified_return_receipt'
    ]);
    expect(setMailServiceInputZ.safeParse({ draftId: DRAFT_ID, mailService: 'certified' }).success).toBe(true);
    for (const bad of ['Certified', 'express', '', null, undefined]) {
      expect(setMailServiceInputZ.safeParse({ draftId: DRAFT_ID, mailService: bad }).success, String(bad)).toBe(false);
    }
  });

  it('says in its description that it is for when the person asks, costs more and is not a pack or a gift', () => {
    const description = String(setMailServiceTool.description);
    expect(description).toContain('Only when the person asks to add or remove certified mail');
    expect(description).toContain('costs more');
    expect(description).toContain('never a letter pack or a gift letter');
    expect(description).toContain('Nothing is sent by this tool');
  });
});

describe('set_mail_service while certified mail is not offered (#625)', () => {
  it.each([
    ['the flag is off', { LETTER_IRL_CERTIFIED_MAIL_ENABLED: 'false', JIT_PURCHASE_ENABLED: 'true' }],
    ['Pay & Send is off', { LETTER_IRL_CERTIFIED_MAIL_ENABLED: 'true', JIT_PURCHASE_ENABLED: 'false' }],
    ['the flag is a typo', { LETTER_IRL_CERTIFIED_MAIL_ENABLED: 'yes please', JIT_PURCHASE_ENABLED: 'true' }]
  ])('refuses every service when %s, and reads no draft', async (_name, env) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    for (const mailService of ['certified', 'standard']) {
      await expect(set({ draftId: DRAFT_ID, mailService })).rejects.toMatchObject({ code: 'MAIL_SERVICE_NOT_OFFERED' });
    }
    expect(setDraftMailService).not.toHaveBeenCalled();
    expect(getDraftForMailService).not.toHaveBeenCalled();
  });
});

describe('set_mail_service (#625)', () => {
  it.each([
    ['certified', 'This letter now goes by USPS Certified Mail once sent.'],
    ['certified_return_receipt', 'This letter now goes by USPS Certified Mail with an electronic return receipt once sent.']
  ])('sets %s, prices the draft as Pay & Send whatever the balance, and says so', async (service, sentence) => {
    vi.mocked(getDraftForMailService).mockResolvedValue(draft({ mail_service: service }));
    const result = await set({ draftId: DRAFT_ID, mailService: service }, context(10));

    expect(setDraftMailService).toHaveBeenCalledWith(DRAFT_ID, 'auth0|owner', service, NOW);
    expect(getDraftForMailService).toHaveBeenCalledWith(DRAFT_ID, 'auth0|owner');
    expect(result).toMatchObject({
      draftId: DRAFT_ID,
      mailService: service,
      canSendNow: false,
      reasonCannotSend: CERTIFIED_PAID_PER_SEND_REASON
    });
    expect(result.message).toContain(sentence);
    expect(result.message).toContain('paid with Pay & Send, never a letter pack or a gift letter');
    expect(result.message).toContain('Nothing has been sent.');
    // Priced as the checkout will read the draft row.
    expect(vi.mocked(getSendEligibility).mock.calls.at(-1)![2]).toEqual({ mailType: 'letter', mailService: service });
  });

  it('sets standard, and then the balance pays for a one-page letter again', async () => {
    vi.mocked(getDraftForMailService).mockResolvedValue(draft());
    const result = await set({ draftId: DRAFT_ID, mailService: 'standard' }, context(10));

    expect(setDraftMailService).toHaveBeenCalledWith(DRAFT_ID, 'auth0|owner', 'standard', NOW);
    expect(result).not.toHaveProperty('mailService');
    expect(result.canSendNow).toBe(true);
    expect(result.message).toBe('This letter now goes as ordinary first-class mail once sent. Nothing has been sent.');
    expect(vi.mocked(getSendEligibility).mock.calls.at(-1)![2]).toEqual({ mailType: 'letter' });
  });

  it('prices a standard letter by the credits it needs: a balance short of them cannot send it', async () => {
    vi.mocked(getDraftForMailService).mockResolvedValue(draft({ required_credits: 2 }));
    const result = await set({ draftId: DRAFT_ID, mailService: 'standard' }, context(1));
    expect(result.canSendNow).toBe(false);
    expect(vi.mocked(getSendEligibility).mock.calls.at(-1)!.slice(0, 2)).toEqual([1, 2]);
  });

  it('prices a certified letter of three pages by its service, as the send does', async () => {
    vi.mocked(getDraftForMailService).mockResolvedValue(draft({ mail_service: 'certified', pages: 3 }));
    await set({ draftId: DRAFT_ID, mailService: 'certified' });
    expect(vi.mocked(getSendEligibility).mock.calls.at(-1)![2]).toEqual({ mailType: 'letter', pages: 3, mailService: 'certified' });
  });

  it('answers by what the draft holds once the change is made, not by what was asked for', async () => {
    // Another change got in between: the draft now says standard, and so does the answer.
    vi.mocked(getDraftForMailService).mockResolvedValue(draft({ mail_service: 'standard' }));
    const result = await set({ draftId: DRAFT_ID, mailService: 'certified' }, context(10));
    expect(result).not.toHaveProperty('mailService');
    expect(result.message).toBe('This letter now goes as ordinary first-class mail once sent. Nothing has been sent.');
    expect(vi.mocked(getSendEligibility).mock.calls.at(-1)![2]).toEqual({ mailType: 'letter' });
  });

  it('prices a gift letter as a gift: with no balance it can still be sent', async () => {
    vi.mocked(getDraftForMailService).mockResolvedValue(draft({ is_gift_send: true }));
    const result = await set({ draftId: DRAFT_ID, mailService: 'standard' }, context(0));
    expect(result.canSendNow).toBe(true);
  });

  it('trims the draft id it was given', async () => {
    await set({ draftId: `  ${DRAFT_ID}  `, mailService: 'certified' });
    expect(setDraftMailService).toHaveBeenCalledWith(DRAFT_ID, 'auth0|owner', 'certified', NOW);
  });

  it.each([undefined, null, '', 'Certified', ' certified', 'express', 0, ['certified']])(
    'refuses %j as a service before it reads or changes any draft',
    async mailService => {
      await expect(set({ draftId: DRAFT_ID, mailService })).rejects.toMatchObject({
        code: 'MAIL_SERVICE_INVALID',
        message: 'Name the service: standard, certified, certified_return_receipt.'
      });
      expect(getDraftForMailService).not.toHaveBeenCalled();
      expect(setDraftMailService).not.toHaveBeenCalled();
    }
  );

  it.each([undefined, null, '', 'not-a-draft', 42, DRAFT_ID.slice(1)])(
    'refuses %j as a missing preview without asking the database',
    async draftId => {
      await expect(set({ draftId, mailService: 'certified' })).rejects.toMatchObject({ code: 'DRAFT_NOT_FOUND' });
      expect(setDraftMailService).not.toHaveBeenCalled();
    }
  );
});

describe('the draft service refusing a change (#625)', () => {
  it.each([
    ['not_found', 'DRAFT_NOT_FOUND', "That preview wasn't found. Make a new preview, then try again."],
    ['sent', 'DRAFT_ALREADY_SENT', "This letter has already been sent, so how it travels can't change. list_orders shows it."],
    ['expired', 'DRAFT_EXPIRED', 'This preview has expired. Make a new preview: the letter previews take mailService themselves.'],
    [
      'checkout_pending',
      'DRAFT_CHECKOUT_PENDING',
      "This preview is tied to a Pay & Send payment, so how it travels can't change now. Finish or let that payment lapse, or make a new preview."
    ],
    [
      'not_a_letter',
      'DRAFT_NOT_A_LETTER',
      'Certified mail is for letters, and a postcard always goes as ordinary mail. Make a letter preview to send certified mail.'
    ],
    [
      'gift_send',
      'DRAFT_IS_GIFT',
      'A gift letter does not pay for certified mail. Make a new preview with mailService certified: it is paid with Pay & Send, not by a gift letter.'
    ]
  ] as const)('turns "%s" into a sentence the model can act on', async (reason, code, message) => {
    vi.mocked(setDraftMailService).mockResolvedValue(reason);
    const ctx = context();
    const error = await set({ draftId: DRAFT_ID, mailService: 'certified' }, ctx).catch(caught => caught);
    expect(error).toBeInstanceOf(MailServiceRefusedError);
    expect(error).toMatchObject({ code, message, diagnosticClass: code });
    // The draft is read once, before the change; its price is read again only once the change is made. Its id is not repeated.
    expect(getDraftForMailService).toHaveBeenCalledTimes(1);
    expect(message).not.toContain(DRAFT_ID);
    expect(vi.mocked(ctx.logger.warn).mock.calls[0][0]).toMatchObject({ event: 'draft.mail_service_refused', reason: code });
  });

  it('says a draft that is not there, or belongs to someone else, is missing, and changes nothing', async () => {
    vi.mocked(getDraftForMailService).mockResolvedValue(null);
    await expect(set({ draftId: DRAFT_ID, mailService: 'certified' })).rejects.toMatchObject({ code: 'DRAFT_NOT_FOUND' });
    expect(setDraftMailService).not.toHaveBeenCalled();
  });

  it('says a draft that vanished after the change is missing', async () => {
    vi.mocked(getDraftForMailService).mockResolvedValueOnce(draft()).mockResolvedValueOnce(null);
    await expect(set({ draftId: DRAFT_ID, mailService: 'certified' })).rejects.toMatchObject({ code: 'DRAFT_NOT_FOUND' });
  });

  it('logs the change with the service and nothing of the letter', async () => {
    const ctx = context();
    await set({ draftId: DRAFT_ID, mailService: 'certified_return_receipt' }, ctx);
    const logged = vi.mocked(ctx.logger.info).mock.calls.map(call => call[0] as Record<string, unknown>);
    expect(logged).toContainEqual({ correlationId: 'corr-1', event: 'draft.mail_service_changed', mailService: 'certified_return_receipt' });
  });

  it('answers within its declared output, certified or not', async () => {
    for (const service of ['certified', 'standard']) {
      vi.mocked(getDraftForMailService).mockResolvedValue(draft({ mail_service: service }));
      const result = await set({ draftId: DRAFT_ID, mailService: service });
      expect(setMailServiceOutputZ.safeParse(result).success, service).toBe(true);
      expect(Object.keys(setMailServiceOutputSchema.properties as object)).toEqual(expect.arrayContaining(Object.keys(result)));
    }
  });
});

describe('a postcard, a draft sent meanwhile and text that is not a service (#625)', () => {
  it.each(['standard', 'certified', 'certified_return_receipt'])(
    'refuses a postcard whatever the service is (%s), and changes nothing: it is always ordinary mail and this tool is for letters',
    async service => {
      vi.mocked(getDraftForMailService).mockResolvedValue(draft({ mail_type: 'postcard', postcard_size: '6x11' }));
      await expect(set({ draftId: DRAFT_ID, mailService: service })).rejects.toMatchObject({ code: 'DRAFT_NOT_A_LETTER' });
      expect(setDraftMailService).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['consumed', 'DRAFT_ALREADY_SENT'],
    ['cancelled', 'DRAFT_EXPIRED'],
    ['expired', 'DRAFT_EXPIRED']
  ])('refuses a draft that is %s by the time the change has been made, rather than saying nothing was sent', async (status, code) => {
    vi.mocked(getDraftForMailService).mockResolvedValueOnce(draft()).mockResolvedValueOnce(draft({ status }));
    await expect(set({ draftId: DRAFT_ID, mailService: 'certified' })).rejects.toMatchObject({ code });
  });

  it('says a draft sent just after the change went with the service it holds, not that the change was refused', async () => {
    vi.mocked(getDraftForMailService).mockResolvedValueOnce(draft()).mockResolvedValueOnce(draft({ status: 'consumed', mail_service: 'standard' }));
    const error = await set({ draftId: DRAFT_ID, mailService: 'standard' }).catch(caught => caught);
    expect(error).toMatchObject({ code: 'DRAFT_ALREADY_SENT' });
    expect(error.message).toBe('This letter was sent just after the change was made, so it went with the service it holds now. list_orders shows it.');
    expect(error.message).not.toMatch(/can.t change/);
  });

  it('says nothing of a stored service it does not know, rather than calling it ordinary mail', async () => {
    vi.mocked(getDraftForMailService).mockResolvedValueOnce(draft()).mockResolvedValueOnce(draft({ mail_service: 'express' }));
    await expect(set({ draftId: DRAFT_ID, mailService: 'standard' })).rejects.toMatchObject({ code: 'DRAFT_NOT_FOUND' });
  });

  it('keeps a call\'s own text out of every log', async () => {
    const ctx = context();
    await expect(set({ draftId: DRAFT_ID, mailService: 'drop table letters' }, ctx)).rejects.toMatchObject({ code: 'MAIL_SERVICE_INVALID' });
    const logged = JSON.stringify([...vi.mocked(ctx.logger.info).mock.calls, ...vi.mocked(ctx.logger.warn).mock.calls]);
    expect(logged).not.toContain('drop table');
  });

  it('prices a gift letter set to standard as a gift: nothing to pay', async () => {
    vi.mocked(getDraftForMailService).mockResolvedValue(draft({ is_gift_send: true }));
    const result = await set({ draftId: DRAFT_ID, mailService: 'standard' }, context(0));
    expect(result.canSendNow).toBe(true);
    expect(result.sendEligibility.payAndSend).toEqual({ available: false, unavailableReason: 'This uses a gift letter, so there is nothing to pay.' });
  });
});

describe('the gift letter note when a letter goes back to ordinary mail (#625)', () => {
  const NOTE = ' A new preview of it can use your gift letter.';
  const available = (count: number) => vi.mocked(getGiftBalance).mockResolvedValue({ available: count, next: undefined } as never);

  beforeEach(() => {
    vi.stubEnv('LETTER_IRL_GIFT_LETTERS_ENABLED', 'true');
    vi.mocked(getDraftForMailService).mockResolvedValue(draft({ required_credits: 2 }));
  });

  it('says a new preview can use the gift letter, for a one-page letter the balance cannot pay', async () => {
    available(1);
    const result = await set({ draftId: DRAFT_ID, mailService: 'standard' }, context(0));
    expect(result.canSendNow).toBe(false);
    expect(result.message).toBe(`This letter now goes as ordinary first-class mail once sent. Nothing has been sent.${NOTE}`);
  });

  it('says nothing of it without a gift letter, with gift letters off, or when the balance pays', async () => {
    available(0);
    expect((await set({ draftId: DRAFT_ID, mailService: 'standard' }, context(0))).message).not.toContain('gift letter');
    available(1);
    vi.stubEnv('LETTER_IRL_GIFT_LETTERS_ENABLED', 'false');
    expect((await set({ draftId: DRAFT_ID, mailService: 'standard' }, context(0))).message).not.toContain('gift letter');
    vi.stubEnv('LETTER_IRL_GIFT_LETTERS_ENABLED', 'true');
    expect((await set({ draftId: DRAFT_ID, mailService: 'standard' }, context(10))).message).not.toContain('gift letter');
  });

  it('says nothing of it for certified mail, a longer letter or a gift letter, which no gift can pay for or already is one', async () => {
    available(1);
    vi.mocked(getDraftForMailService).mockResolvedValue(draft({ mail_service: 'certified', required_credits: 2 }));
    expect((await set({ draftId: DRAFT_ID, mailService: 'certified' }, context(0))).message).not.toContain('use your gift letter');
    vi.mocked(getDraftForMailService).mockResolvedValue(draft({ pages: 2, required_credits: 2 }));
    expect((await set({ draftId: DRAFT_ID, mailService: 'standard' }, context(0))).message).not.toContain('use your gift letter');
    vi.mocked(getDraftForMailService).mockResolvedValue(draft({ is_gift_send: true, required_credits: 2 }));
    expect((await set({ draftId: DRAFT_ID, mailService: 'standard' }, context(0))).message).not.toContain('use your gift letter');
  });

  it('answers without it when the gift balance cannot be read', async () => {
    vi.mocked(getGiftBalance).mockRejectedValue(new Error('down'));
    const result = await set({ draftId: DRAFT_ID, mailService: 'standard' }, context(0));
    expect(result.message).toBe('This letter now goes as ordinary first-class mail once sent. Nothing has been sent.');
  });
});
