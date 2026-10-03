/**
 * Certified mail on the letter previews (#625): while LETTER_IRL_CERTIFIED_MAIL_ENABLED
 * is on with Pay & Send, the three previews take mailService. The draft records
 * it, the preview prices it as Pay & Send whatever the balance, no gift letter
 * pays for it, and an ordinary letter's answer is as it was. Off, certified mail
 * is refused before anything is fetched or checked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/providers/index.js', () => ({
  getLetterProvider: vi.fn()
}));

vi.mock('../../../src/services/draftService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/draftService.js')>()),
  createDraft: vi.fn()
}));

vi.mock('../../../src/services/recentUploadStore.js', () => ({
  getRecentUploadedImage: vi.fn()
}));

vi.mock('../../../src/services/returnAddressService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/returnAddressService.js')>()),
  getReturnAddress: vi.fn()
}));

vi.mock('../../../src/services/imageService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/imageService.js')>()),
  downloadAndProcessLetterImageWithPreview: vi.fn()
}));

vi.mock('../../../src/services/giftLetterService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/giftLetterService.js')>()),
  getGiftBalance: vi.fn()
}));

vi.mock('../../../src/services/stationeryDefaultService.js', () => ({
  rememberedStationery: vi.fn(),
  rememberStationery: vi.fn()
}));

vi.mock('../../../src/services/commerceService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/commerceService.js')>()),
  getSendEligibility: vi.fn()
}));

import { getLetterProvider } from '../../../src/services/providers/index.js';
import { createDraft } from '../../../src/services/draftService.js';
import { getRecentUploadedImage } from '../../../src/services/recentUploadStore.js';
import { getReturnAddress } from '../../../src/services/returnAddressService.js';
import { downloadAndProcessLetterImageWithPreview } from '../../../src/services/imageService.js';
import { getGiftBalance } from '../../../src/services/giftLetterService.js';
import { getSendEligibility } from '../../../src/services/commerceService.js';
import { quoteAndPreviewLetterTextOnlyTool } from '../../../src/tools/quoteAndPreviewLetterTextOnly.js';
import { quoteAndPreviewLetterWithHeaderImageTool } from '../../../src/tools/quoteAndPreviewLetterWithHeaderImage.js';
import { quoteAndPreviewLetterWithImageTool } from '../../../src/tools/quoteAndPreviewLetterWithImage.js';
import { CERTIFIED_PAID_PER_SEND_REASON } from '../../../src/tools/letterHelpers.js';
import { GIFT_NOT_FOR_CERTIFIED } from '../../../src/tools/giftSendChoice.js';
import { CERTIFIED_NOT_OFFERED } from '../../../src/tools/mailServiceInput.js';
import { draftMailOption, jitProductMatching } from '../../../src/config/products.js';
import type { Address, ToolContext } from '../../../src/contracts/types.js';

function png(width: number, height: number): string {
  const bytes = Buffer.alloc(33);
  bytes.writeUInt32BE(0x89504e47, 0);
  bytes.writeUInt32BE(0x0d0a1a0a, 4);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

function context(credits = 10): ToolContext {
  return {
    user: { userId: 'user-1', creditsRemaining: credits } as ToolContext['user'],
    correlationId: 'corr-1',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never,
    now: () => new Date('2026-10-02T12:00:00Z'),
    persist: vi.fn(),
    isMobile: false
  } as unknown as ToolContext;
}

const address = (overrides: Partial<Address> = {}): Address => ({
  name: 'Sam Rivera', addressLine1: '350 Fifth Ave', city: 'New York', state: 'NY', postalCode: '10118', country: 'US', ...overrides
});

type Handler = (input: unknown, ctx: ToolContext) => Promise<Record<string, unknown>>;
const TOOLS = {
  text_only: [quoteAndPreviewLetterTextOnlyTool, {}],
  header_image: [quoteAndPreviewLetterWithHeaderImageTool, { imageUrl: 'https://files.example/a.png' }],
  inline_image: [quoteAndPreviewLetterWithImageTool, { imageUrl: 'https://files.example/a.png' }]
} as const;

function run(layout: keyof typeof TOOLS, input: Record<string, unknown> = {}, ctx: ToolContext = context()) {
  const [tool, extras] = TOOLS[layout];
  return (tool.handler as unknown as Handler)(
    { sender: address({ name: 'Pat Example' }), recipient: address(), bodyText: 'Dear Sam,', signOff: 'Pat', ...extras, ...input },
    ctx
  );
}

/** Certified mail as it is offered: the flag, and Pay & Send. */
function offer() {
  vi.stubEnv('LETTER_IRL_CERTIFIED_MAIL_ENABLED', 'true');
  vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('LETTER_IRL_PRINT_RENDERER', 'pdf');
  vi.mocked(getLetterProvider).mockReturnValue({} as never);
  vi.mocked(createDraft).mockResolvedValue({ draftId: 'draft-1', expiresAt: new Date('2026-10-03T12:00:00Z') });
  vi.mocked(getRecentUploadedImage).mockResolvedValue(null);
  vi.mocked(getReturnAddress).mockResolvedValue(null);
  vi.mocked(getGiftBalance).mockResolvedValue({ available: 0, next: undefined } as never);
  vi.mocked(getSendEligibility).mockReturnValue({
    payAndSend: { available: true, amountCents: 1199 },
    letterPack: { available: false, purchaseUrl: 'https://packs.example/pricing' },
    packPays: false
  } as never);
  vi.mocked(downloadAndProcessLetterImageWithPreview).mockResolvedValue({
    base64DataUri: png(1950, 600),
    previewDataUri: png(390, 120),
    originalWidth: 1950,
    originalHeight: 600,
    processedWidth: 1950,
    processedHeight: 600
  } as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const drafted = () => {
  expect(createDraft).toHaveBeenCalledTimes(1);
  return vi.mocked(createDraft).mock.calls[0][0];
};

describe.each(Object.keys(TOOLS) as (keyof typeof TOOLS)[])('the %s letter preview, while certified mail is offered', layout => {
  beforeEach(offer);

  it.each(['certified', 'certified_return_receipt'])(
    'records %s on the draft, prices it as Pay & Send whatever the balance, and names it',
    async service => {
      const output = await run(layout, { mailService: service }, context(10));
      const draft = drafted();
      expect(draft.mailService).toBe(service);
      expect(draft.isGiftSend).toBe(false);
      expect(output).toMatchObject({ mailService: service, canSendNow: false, reasonCannotSend: CERTIFIED_PAID_PER_SEND_REASON });
      // Priced as the checkout will read the draft row.
      const quoted = vi.mocked(getSendEligibility).mock.calls.at(-1)![2];
      expect(quoted).toEqual({ mailType: 'letter', mailService: service });
      expect(quoted).toEqual(draftMailOption({ mail_type: 'letter', pages: draft.pages, mail_service: draft.mailService }));
      expect(jitProductMatching(quoted)?.productCode).toBe(service === 'certified' ? 'jit-letter-certified' : 'jit-letter-certified-receipt');
    }
  );

  it.each([
    ['certified', 'USPS Certified Mail'],
    ['certified_return_receipt', 'USPS Certified Mail with an electronic return receipt']
  ])('says what %s is, and that it is signed for, not just First-Class', async (service, deliveryClass) => {
    const output = await run(layout, { mailService: service });
    expect(output).toMatchObject({ deliveryClass });
    expect(output.deliveryDisclaimer).toBe(
      'USPS timing varies and can take longer. Certified mail is signed for at delivery; if no one signs for it, USPS returns it to the sender.'
    );
  });

  it('keeps First-Class and its disclaimer for an ordinary letter', async () => {
    const output = await run(layout, {});
    expect(output).toMatchObject({ deliveryClass: 'USPS First-Class Mail', deliveryDisclaimer: 'USPS timing varies and can take longer.' });
  });

  it.each([[undefined], ['standard'], [null], ['']])('leaves an ordinary letter alone when the service is %j', async service => {
    const output = await run(layout, service === undefined ? {} : { mailService: service }, context(10));
    // (null, and the empty string, are how a client that sends every field says none)
    expect(drafted()).not.toHaveProperty('mailService');
    expect(output).not.toHaveProperty('mailService');
    expect(output).toMatchObject({ canSendNow: true });
    expect(getSendEligibility).toHaveBeenCalledWith(10, expect.any(Number), { mailType: 'letter' });
  });

  it('refuses a gift letter for certified mail, saying why, and makes no draft', async () => {
    vi.mocked(getGiftBalance).mockResolvedValue({ available: 2, next: undefined } as never);
    vi.stubEnv('LETTER_IRL_GIFT_LETTERS_ENABLED', 'true');
    await expect(run(layout, { mailService: 'certified', sendAsGift: true })).rejects.toThrow(GIFT_NOT_FOR_CERTIFIED);
    expect(createDraft).not.toHaveBeenCalled();
  });

  it('chooses no gift for certified mail when none was asked for, though the balance is empty and a gift letter waits', async () => {
    vi.mocked(getGiftBalance).mockResolvedValue({ available: 2, next: undefined } as never);
    vi.stubEnv('LETTER_IRL_GIFT_LETTERS_ENABLED', 'true');
    await run(layout, { mailService: 'certified' }, context(0));
    expect(drafted().isGiftSend).toBe(false);
    expect(drafted().mailService).toBe('certified');
  });

  it('refuses a service it does not sell, and makes no draft', async () => {
    await expect(run(layout, { mailService: 'registered' })).rejects.toMatchObject({ code: 'MAIL_SERVICE_INVALID' });
    expect(createDraft).not.toHaveBeenCalled();
  });
});

describe('while certified mail is not offered', () => {
  it.each(Object.keys(TOOLS) as (keyof typeof TOOLS)[])(
    'refuses certified mail on the %s preview before anything is fetched or checked, and makes no draft',
    async layout => {
      // Gift letters on, so a gift decided before the refusal would show; and a provider that
      // validates addresses, so a check that ran before it would too.
      vi.stubEnv('LETTER_IRL_GIFT_LETTERS_ENABLED', 'true');
      const validateAddress = vi.fn();
      vi.mocked(getLetterProvider).mockReturnValue({ validateAddress } as never);
      for (const service of ['certified', 'certified_return_receipt']) {
        await expect(run(layout, { mailService: service })).rejects.toMatchObject({
          message: CERTIFIED_NOT_OFFERED,
          code: 'MAIL_SERVICE_NOT_OFFERED'
        });
        // And with no sender given, which would look for the saved return address first.
        await expect(run(layout, { mailService: service, sender: undefined })).rejects.toMatchObject({
          code: 'MAIL_SERVICE_NOT_OFFERED'
        });
      }
      expect(createDraft).not.toHaveBeenCalled();
      expect(downloadAndProcessLetterImageWithPreview).not.toHaveBeenCalled();
      expect(getRecentUploadedImage).not.toHaveBeenCalled();
      expect(getReturnAddress).not.toHaveBeenCalled();
      expect(validateAddress).not.toHaveBeenCalled();
      expect(getGiftBalance).not.toHaveBeenCalled();
    }
  );

  it.each(['header_image', 'inline_image'] as const)(
    'refuses certified mail on the %s preview before it looks for a picture, though none was given',
    async layout => {
      await expect(run(layout, { mailService: 'certified', imageUrl: undefined })).rejects.toMatchObject({
        code: 'MAIL_SERVICE_NOT_OFFERED'
      });
      expect(getRecentUploadedImage).not.toHaveBeenCalled();
      expect(downloadAndProcessLetterImageWithPreview).not.toHaveBeenCalled();
    }
  );

  it.each(['registered', 'Certified', ' certified', 0, false, ['certified']])(
    'refuses %j as not offered too, so no one is told to use a value that is then refused',
    async service => {
      await expect(run('text_only', { mailService: service })).rejects.toMatchObject({
        message: CERTIFIED_NOT_OFFERED,
        code: 'MAIL_SERVICE_NOT_OFFERED'
      });
      expect(createDraft).not.toHaveBeenCalled();
    }
  );

  it('logs which service was asked for only when it is one of the two, never the text it was given', async () => {
    const ctx = context();
    await expect(run('text_only', { mailService: 'certified' }, ctx)).rejects.toThrow();
    await expect(run('text_only', { mailService: 'drop table letters' }, ctx)).rejects.toThrow();
    const logged = vi.mocked(ctx.logger.info).mock.calls.filter(([fields]) => (fields as { event?: string }).event === 'quote.letter.certified_not_offered');
    expect(logged.map(([fields]) => (fields as { mailService: string }).mailService)).toEqual(['certified', 'unrecognized']);
  });

  it.each([
    ['the flag is off', { LETTER_IRL_CERTIFIED_MAIL_ENABLED: 'false', JIT_PURCHASE_ENABLED: 'true' }],
    ['Pay & Send is off', { LETTER_IRL_CERTIFIED_MAIL_ENABLED: 'true', JIT_PURCHASE_ENABLED: 'false' }],
    ['the flag is a typo', { LETTER_IRL_CERTIFIED_MAIL_ENABLED: 'yes please', JIT_PURCHASE_ENABLED: 'true' }]
  ])('is not offered when %s', async (_name, env) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    await expect(run('text_only', { mailService: 'certified' })).rejects.toMatchObject({ code: 'MAIL_SERVICE_NOT_OFFERED' });
  });

  it('still previews an ordinary letter, with or without standard said', async () => {
    // Null and the empty string are how a client that sends every field says none: an ordinary letter here too.
    for (const input of [{}, { mailService: 'standard' }, { mailService: null }, { mailService: '' }]) {
      vi.mocked(createDraft).mockClear();
      const output = await run('text_only', input);
      expect(output).not.toHaveProperty('mailService');
      expect(drafted()).not.toHaveProperty('mailService');
    }
  });
});
