/**
 * Every preview tool refuses characters the print shows as empty boxes (#526),
 * in the text and in either address. The refusal comes before PostGrid checks
 * the addresses, before any picture is downloaded, and before a draft is made.
 * src/services/printableText.ts decides what prints; this file proves each
 * tool asks it, and when.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/providers/index.js', () => ({
  getLetterProvider: vi.fn()
}));

vi.mock('../../../src/services/draftService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/draftService.js')>()),
  createDraft: vi.fn(),
  createPostcardDraft: vi.fn()
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
  downloadAndProcessLetterImageWithPreview: vi.fn(),
  downloadAndProcessPostcardImageWithPreview: vi.fn()
}));

vi.mock('../../../src/tools/giftSendChoice.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/tools/giftSendChoice.js')>()),
  resolveGiftSendChoice: vi.fn()
}));

import { getLetterProvider } from '../../../src/services/providers/index.js';
import { createDraft, createPostcardDraft } from '../../../src/services/draftService.js';
import { getRecentUploadedImage } from '../../../src/services/recentUploadStore.js';
import { getReturnAddress } from '../../../src/services/returnAddressService.js';
import {
  downloadAndProcessLetterImageWithPreview,
  downloadAndProcessPostcardImageWithPreview
} from '../../../src/services/imageService.js';
import { resolveGiftSendChoice } from '../../../src/tools/giftSendChoice.js';
import { quoteAndPreviewLetterTextOnlyTool } from '../../../src/tools/quoteAndPreviewLetterTextOnly.js';
import { quoteAndPreviewLetterWithHeaderImageTool } from '../../../src/tools/quoteAndPreviewLetterWithHeaderImage.js';
import { quoteAndPreviewLetterWithImageTool } from '../../../src/tools/quoteAndPreviewLetterWithImage.js';
import { quoteAndPreviewPostcardTool } from '../../../src/tools/quoteAndPreviewPostcard.js';
import type { Address, ToolContext } from '../../../src/contracts/types.js';

const PROVIDER_REACHED = new Error('the provider was reached');
const DOWNLOAD_REACHED = new Error('the picture download was reached');

function context(): ToolContext {
  return {
    user: { userId: 'user-1', creditsRemaining: 10 } as ToolContext['user'],
    correlationId: 'corr-1',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never,
    now: () => new Date('2026-09-30T12:00:00Z'),
    persist: vi.fn(),
    isMobile: false
  } as unknown as ToolContext;
}

function address(overrides: Partial<Address> = {}): Address {
  return {
    name: 'Sam Rivera',
    addressLine1: '350 Fifth Ave',
    addressLine2: 'Suite 3300',
    city: 'New York',
    state: 'NY',
    postalCode: '10118',
    country: 'US',
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getLetterProvider).mockImplementation(() => {
    throw PROVIDER_REACHED;
  });
  vi.mocked(getRecentUploadedImage).mockResolvedValue(null);
  vi.mocked(getReturnAddress).mockResolvedValue(null);
  vi.mocked(downloadAndProcessLetterImageWithPreview).mockResolvedValue({
    base64DataUri: 'data:image/jpeg;base64,AAAA',
    previewDataUri: 'data:image/jpeg;base64,AAAA',
    originalWidth: 1,
    originalHeight: 1,
    processedWidth: 1,
    processedHeight: 1
  } as never);
  vi.mocked(downloadAndProcessPostcardImageWithPreview).mockRejectedValue(DOWNLOAD_REACHED);
  vi.mocked(resolveGiftSendChoice).mockResolvedValue({ isGift: false, giftLettersAvailable: 0 });
});

type Handler = (input: unknown, ctx: ToolContext) => Promise<unknown>;

const LETTER_TOOLS = [
  ['quote_and_preview_letter', quoteAndPreviewLetterTextOnlyTool, {}, false],
  ['quote_and_preview_letter_with_header_image', quoteAndPreviewLetterWithHeaderImageTool, { imageUrl: 'https://files.example/a.jpg' }, true],
  ['quote_and_preview_letter_with_image', quoteAndPreviewLetterWithImageTool, { imageUrl: 'https://files.example/a.jpg' }, true]
] as const;

describe.each(LETTER_TOOLS)('%s', (_name, tool, extras, hasPicture) => {
  const run = (input: Record<string, unknown>, ctx: ToolContext = context()) =>
    (tool.handler as Handler)(
      { sender: address({ name: 'Pat Example' }), recipient: address(), bodyText: 'Dear Sam,', signOff: 'Pat', ...extras, ...input },
      ctx
    );

  function expectNothingDone() {
    expect(downloadAndProcessLetterImageWithPreview).not.toHaveBeenCalled();
    expect(getLetterProvider).not.toHaveBeenCalled();
    expect(createDraft).not.toHaveBeenCalled();
  }

  it('refuses an emoji in the text before the picture, the addresses and the draft', async () => {
    await expect(run({ bodyText: 'Happy birthday! 🎉' })).rejects.toThrow(
      "Letter IRL can't print some characters in this letter: 🎉 in the text."
    );
    expectNothingDone();
  });

  it('refuses as a validation error, and logs where and how many, never the characters', async () => {
    const ctx = context();
    const error = await run({ bodyText: 'Happy birthday! 🎉🎂' }, ctx).catch(e => e);
    expect(error).toMatchObject({ diagnosticClass: 'validation_error' });
    const warn = vi.mocked(ctx.logger.warn);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'quote.letter.unprintable_characters',
        fields: [{ field: 'bodyText', count: 2 }]
      }),
      expect.any(String)
    );
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/🎉|🎂|birthday/);
  });

  it('refuses one in the sign-off', async () => {
    await expect(run({ signOff: 'Love, Pat ❤️' })).rejects.toThrow('❤️ in the sign-off');
    expectNothingDone();
  });

  it("refuses a name the address block can't print", async () => {
    await expect(run({ recipient: address({ name: '王小明' }) })).rejects.toThrow(
      "王 小 明 in the recipient's address"
    );
    expectNothingDone();
  });

  it("refuses one in the sender's address", async () => {
    await expect(run({ sender: address({ addressLine2: 'Rear unit → left' }) })).rejects.toThrow(
      "→ (U+2192) in the sender's address"
    );
    expectNothingDone();
  });

  it('names the saved return address when the request gave no sender', async () => {
    vi.mocked(getReturnAddress).mockResolvedValue(address({ name: 'Pat 🌻 Example' }));
    await expect(run({ sender: undefined })).rejects.toThrow('🌻 in your saved return address');
    expect(getReturnAddress).toHaveBeenCalledWith('user-1');
    expectNothingDone();
  });

  it(
    hasPicture
      ? 'lets printable text through to the picture and then the address check'
      : 'lets printable text through to the address check',
    async () => {
      await expect(run({ bodyText: 'Dear Zoë, “thank you” — see you in Kraków.' })).rejects.toThrow(
        PROVIDER_REACHED.message
      );
      expect(downloadAndProcessLetterImageWithPreview).toHaveBeenCalledTimes(hasPicture ? 1 : 0);
    }
  );
});

describe('quote_and_preview_postcard', () => {
  const run = (input: Record<string, unknown>) =>
    (quoteAndPreviewPostcardTool.handler as Handler)(
      {
        sender: address({ name: 'Pat Example' }),
        recipient: address(),
        message: 'Greetings from the coast!',
        imageUrl: 'https://files.example/a.jpg',
        ...input
      },
      context()
    );

  function expectNothingDone() {
    expect(downloadAndProcessPostcardImageWithPreview).not.toHaveBeenCalled();
    expect(getLetterProvider).not.toHaveBeenCalled();
    expect(createPostcardDraft).not.toHaveBeenCalled();
  }

  it('refuses an emoji in the message before the picture is fetched', async () => {
    await expect(run({ message: 'Wish you were here 🌊' })).rejects.toThrow(
      "Letter IRL can't print some characters in this postcard: 🌊 in the message."
    );
    expectNothingDone();
  });

  it("refuses a name the address block can't print", async () => {
    await expect(run({ recipient: address({ name: 'سارة' }) })).rejects.toThrow("in the recipient's address");
    expectNothingDone();
  });

  it('names the saved return address when the request gave no sender', async () => {
    vi.mocked(getReturnAddress).mockResolvedValue(address({ name: 'Pat 李' }));
    await expect(run({ sender: undefined })).rejects.toThrow('李 in your saved return address');
    expectNothingDone();
  });

  it('lets printable text through to the picture', async () => {
    await expect(run({ message: 'Grüße aus Köln — bis bald!' })).rejects.toThrow(DOWNLOAD_REACHED.message);
    expect(downloadAndProcessPostcardImageWithPreview).toHaveBeenCalledTimes(1);
  });
});
