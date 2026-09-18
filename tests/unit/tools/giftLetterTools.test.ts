import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ToolContext } from '../../../src/contracts/types.js';

/**
 * The tool surface of gift letters (docs/gift-letters.md): what the preview
 * decides and shows, what the served schemas declare, and what the redeem and
 * balance tools report.
 */

const mocks = vi.hoisted(() => ({
  createDraft: vi.fn(),
  getGiftBalance: vi.fn(),
  getSendEligibility: vi.fn(),
  redeemCode: vi.fn(),
  findUser: vi.fn()
}));

vi.mock('../../../src/services/draftService.js', () => ({ createDraft: mocks.createDraft }));
vi.mock('../../../src/services/giftLetterService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/giftLetterService.js')>()),
  getGiftBalance: mocks.getGiftBalance
}));
vi.mock('../../../src/services/commerceService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/commerceService.js')>()),
  getSendEligibility: mocks.getSendEligibility
}));
vi.mock('../../../src/services/codeRedemptionService.js', () => ({ redeemCode: mocks.redeemCode }));
vi.mock('../../../src/services/userService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/userService.js')>()),
  findUser: mocks.findUser
}));

import { createLetterDraftAndBuildOutput } from '../../../src/tools/letterHelpers.js';
import { redeemPromoCodeTool } from '../../../src/tools/redeemPromoCode.js';
import { friendlyCheckoutError } from '../../../src/tools/createMailCheckout.js';
import { friendlyDraftError } from '../../../src/tools/draftErrors.js';
import { getZodInputShape, getZodOutputShape } from '../../../src/mcp/registerTools.js';

function context(creditsRemaining: number): ToolContext {
  return {
    user: { userId: 'user-1', creditsRemaining, orders: [] },
    correlationId: 'test',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
    now: () => new Date('2026-09-17T12:00:00Z'),
    persist: vi.fn()
  } as unknown as ToolContext;
}

const address = {
  name: 'Sarah Johnson',
  addressLine1: '1 Main St',
  city: 'Austin',
  state: 'TX',
  postalCode: '78701',
  country: 'US'
};

async function preview(creditsRemaining: number, sendAsGift?: boolean) {
  return createLetterDraftAndBuildOutput({
    sender: address,
    recipient: { ...address, name: 'Grandma' },
    bodyText: 'Hello from Austin',
    signOff: 'Love, Sarah',
    layoutType: 'text_only',
    usedSavedReturnAddress: false,
    sendAsGift,
    context: context(creditsRemaining)
  });
}

describe('letter preview: the gift decision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.LETTER_IRL_GIFT_LETTERS_ENABLED = 'true';
    mocks.createDraft.mockResolvedValue({ draftId: 'draft-1', expiresAt: new Date('2026-09-18T12:00:00Z') });
    mocks.getGiftBalance.mockResolvedValue({ available: 1, next: { giftId: 'gift-1', cardState: 'funded' } });
    mocks.getSendEligibility.mockReturnValue({
      payAndSend: { available: true, amountCents: 499 },
      letterPack: { available: true, purchaseUrl: 'https://letterirl.com' }
    });
  });

  afterEach(() => {
    delete process.env.LETTER_IRL_GIFT_LETTERS_ENABLED;
  });

  it('uses the gift letter when the balance cannot pay, and says so', async () => {
    const output = await preview(0);
    expect(output.canSendNow).toBe(true);
    expect(output.reasonCannotSend).toBeUndefined();
    expect(output.giftCard?.state).toBe('funded');
    expect(output.giftCard?.description).toMatch(/extra page/);
    expect(output.giftLettersAvailable).toBe(1);
    expect(mocks.createDraft).toHaveBeenCalledWith(expect.objectContaining({ isGiftSend: true }));
    // Nothing to pay on a gift draft, so Pay & Send is not offered.
    expect(output.sendEligibility.payAndSend.available).toBe(false);
  });

  it('draws the extra page into the preview without disturbing what the card parses', async () => {
    const output = await preview(0);
    expect(output.previewHtml).toContain('gift-page');
    expect(output.previewHtml).toContain('••••-••••');
    // LetterPreviewCard extracts these two with first-match regexes.
    expect(output.previewHtml.match(/<div class="letter-body">([\s\S]*?)<\/div>/)?.[1]).toBe('Hello from Austin');
    expect(output.previewHtml.match(/<div class="sign-off">([\s\S]*?)<\/div>/)?.[1]).toBe('Love, Sarah');
  });

  it('never switches someone who can pay to a gift without being asked', async () => {
    const output = await preview(8);
    expect(output.giftCard).toBeUndefined();
    expect(output.giftLettersAvailable).toBe(1);
    expect(output.previewHtml).not.toContain('gift-page');
    expect(mocks.createDraft).toHaveBeenCalledWith(expect.objectContaining({ isGiftSend: false }));
    expect(output.sendEligibility.payAndSend.available).toBe(true);
  });

  it('sends as a gift when asked, even with balance', async () => {
    const output = await preview(8, true);
    expect(output.giftCard?.state).toBe('funded');
    expect(mocks.createDraft).toHaveBeenCalledWith(expect.objectContaining({ isGiftSend: true }));
  });

  it('shows the plain card when the next gift letter has no budget', async () => {
    mocks.getGiftBalance.mockResolvedValue({ available: 1, next: { giftId: 'gift-1', cardState: 'unfunded' } });
    const output = await preview(0);
    expect(output.giftCard?.state).toBe('unfunded');
    expect(output.previewHtml).toContain('Sent with Letter IRL');
  });

  it('refuses sendAsGift without a gift letter, and while the programme is off', async () => {
    mocks.getGiftBalance.mockResolvedValue({ available: 0 });
    await expect(preview(0, true)).rejects.toThrow(/no gift letter/);
    expect(mocks.createDraft).not.toHaveBeenCalled();

    process.env.LETTER_IRL_GIFT_LETTERS_ENABLED = 'false';
    await expect(preview(0, true)).rejects.toThrow(/not available/);
  });

  it('behaves exactly as before while the programme is off', async () => {
    process.env.LETTER_IRL_GIFT_LETTERS_ENABLED = 'false';
    const output = await preview(0);
    expect(output.canSendNow).toBe(false);
    expect(output.giftCard).toBeUndefined();
    expect(output.giftLettersAvailable).toBeUndefined();
    expect(mocks.getGiftBalance).not.toHaveBeenCalled();
  });
});

describe('served schemas', () => {
  const PREVIEW_TOOLS = [
    'quote_and_preview_letter',
    'quote_and_preview_letter_with_header_image',
    'quote_and_preview_letter_with_image',
    'quote_and_preview_postcard'
  ];

  it.each(PREVIEW_TOOLS)('%s accepts an optional sendAsGift and declares the gift outputs', name => {
    const input = getZodInputShape(name)!;
    expect(input.sendAsGift, `${name} does not serve sendAsGift`).toBeDefined();
    expect(input.sendAsGift.isOptional()).toBe(true);
    const output = z.object(getZodOutputShape(name)!);
    // The gift fields must survive output validation, or ChatGPT drops them.
    const parsed = output.partial().parse({ giftCard: { state: 'funded', description: 'x' }, giftLettersAvailable: 2 });
    expect(parsed).toMatchObject({ giftCard: { state: 'funded' }, giftLettersAvailable: 2 });
  });

  it('declares giftLetters on redeem and giftLettersRemaining on the balance', () => {
    expect(getZodOutputShape('redeem_promo_code')!.giftLetters.isOptional()).toBe(true);
    expect(getZodOutputShape('get_account_balance')!.giftLettersRemaining.isOptional()).toBe(true);
  });

  it('keeps the sendAsGift description functional, not promotional', () => {
    const description = getZodInputShape('quote_and_preview_letter')!.sendAsGift.description ?? '';
    expect(description).toMatch(/only when the user asks/);
    expect(description).not.toMatch(/refer|invite|share|earn|friends/i);
  });
});

describe('redeem_promo_code with a gift code', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUser.mockResolvedValue({ user_id: 'user-1', email: 'grandma@example.com' });
  });

  it('reports the gift letter apart from ordinary letters, never as credits', async () => {
    mocks.redeemCode.mockResolvedValue({ success: true, credits: 0, giftLetters: 1, expiresAt: new Date('2027-03-16T00:00:00Z') });
    const result = await redeemPromoCodeTool.handler({ code: 'K7M2-QX9A' }, context(0));
    expect(mocks.redeemCode).toHaveBeenCalledWith({ userId: 'user-1', email: 'grandma@example.com', code: 'K7M2-QX9A' });
    expect(result).toMatchObject({ redeemed: true, letters: 0, giftLetters: 1 });
    expect(result.message).toMatch(/^Added 1 gift letter to this account\. It expires on 2027-03-16\./);
    expect(result.message).toMatch(/card for the recipient/);
    expect(result.message).not.toMatch(/credit/i);
  });

  it('names both when a seed grants letters and a gift letter', async () => {
    mocks.redeemCode.mockResolvedValue({ success: true, credits: 4, giftLetters: 1 });
    const result = await redeemPromoCodeTool.handler({ code: 'JANE' }, context(0));
    expect(result.message).toMatch(/^Added 2 letters and 1 gift letter/);
  });

  it('relays a refused gift code as data', async () => {
    mocks.redeemCode.mockResolvedValue({ success: false, reason: 'own_code', error: 'This gift code was printed on a letter you sent, so it is for your recipient to use.' });
    const result = await redeemPromoCodeTool.handler({ code: 'K7M2QX9A' }, context(0));
    expect(result).toMatchObject({ redeemed: false });
    expect(result.message).toMatch(/for your recipient/);
  });
});

describe('customer wording for gift refusals', () => {
  it('maps the send-side codes without leaking the draft id', () => {
    for (const code of ['GIFT_LETTERS_DISABLED', 'GIFT_LETTER_UNAVAILABLE', 'GIFT_CODE_UNAVAILABLE']) {
      const error = Object.assign(new Error('Draft 11111111-2222 internal'), { code });
      const message = friendlyDraftError(error, '11111111-2222', 'letter').message;
      expect(message).not.toContain('11111111');
      expect(message).not.toMatch(/contact Letter IRL support/);
    }
  });

  it('tells a Pay & Send caller that a gift draft has nothing to pay', () => {
    const error = friendlyCheckoutError(Object.assign(new Error('Draft is a gift send'), { code: 'DRAFT_IS_GIFT' }));
    expect(error.message).toMatch(/gift letter, so there is nothing to pay/);
  });
});
