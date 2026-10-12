/**
 * The letter-preview pipeline (#689): the three letter-preview tools run one sequence, and
 * its order is the contract. Every check that costs nothing runs before the picture is
 * fetched (#526, #535); the gift is known before what prints is checked (#534); the
 * provider is asked last. Each step is a spy here, so the order is read directly; what
 * each step does is tested beside it (arriveByPreview, certifiedPreview, letterSignature,
 * printableMail, roomToWrite, letterPreviewRenderer).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { order, step, syncStep } = vi.hoisted(() => {
  const order: string[] = [];
  return {
    order,
    step: <T>(name: string, value?: T) => vi.fn(async () => { order.push(name); return value; }),
    syncStep: <T>(name: string, value?: T) => vi.fn(() => { order.push(name); return value; })
  };
});

vi.mock('../../../src/tools/arriveByInput.js', () => ({ previewSchedule: syncStep('schedule', { arriveBy: '2026-11-02' }) }));
vi.mock('../../../src/tools/mailServiceInput.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/tools/mailServiceInput.js')>()),
  chooseMailService: syncStep('mailService', null)
}));
vi.mock('../../../src/services/previewImageSource.js', () => ({
  resolvePreviewImageSource: vi.fn(async () => { order.push('imageSource'); return { kind: 'url', url: 'https://example.test/a.png' }; })
}));
vi.mock('../../../src/tools/stationeryInput.js', () => ({ chooseStationery: step('stationery', undefined) }));
vi.mock('../../../src/tools/signatureInput.js', () => ({ chooseSignature: step('signature', { image: undefined }) }));
vi.mock('../../../src/config/printRenderer.js', () => ({ printRenderer: () => 'pdf' }));
vi.mock('../../../src/services/imageService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/imageService.js')>()),
  downloadAndProcessLetterImageWithPreview: vi.fn(async () => {
    order.push('processImage');
    return { base64DataUri: 'data:image/png;base64,FULL', previewDataUri: 'data:image/png;base64,SMALL', originalWidth: 1, originalHeight: 1, processedWidth: 1, processedHeight: 1 };
  })
}));
vi.mock('../../../src/tools/letterHelpers.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/tools/letterHelpers.js')>()),
  prepareSender: vi.fn(async (input: { sender?: unknown }) => {
    order.push('sender');
    return { sender: input.sender, usedSavedReturnAddress: false, savedReturnAddressNote: undefined };
  }),
  validateAddresses: syncStep('addresses'),
  earlyGiftChoice: step('earlyGift', undefined),
  validateCharacterLimitForLayout: syncStep('characterCap'),
  validatePrintableLetter: syncStep('printable'),
  layoutLetterForPreview: syncStep('layout', { pages: [] }),
  letterRunsPast: vi.fn(() => false),
  giftForLayout: step('giftLayout', { kind: 'none' }),
  validateAddressesWithProvider: step('provider', { senderValidation: undefined, recipientValidation: undefined, addressWarnings: [] }),
  createLetterDraftAndBuildOutput: step('draft', { draftId: 'd1' })
}));

import * as helpers from '../../../src/tools/letterHelpers.js';
import { validatePrintableLetter } from '../../../src/tools/letterHelpers.js';
import { downloadAndProcessLetterImageWithPreview } from '../../../src/services/imageService.js';
import { resolvePreviewImageSource } from '../../../src/services/previewImageSource.js';
import { previewSchedule } from '../../../src/tools/arriveByInput.js';
import { chooseSignature } from '../../../src/tools/signatureInput.js';
import { quoteAndPreviewLetterTextOnlyTool } from '../../../src/tools/quoteAndPreviewLetterTextOnly.js';
import { quoteAndPreviewLetterWithHeaderImageTool } from '../../../src/tools/quoteAndPreviewLetterWithHeaderImage.js';
import { quoteAndPreviewLetterWithImageTool } from '../../../src/tools/quoteAndPreviewLetterWithImage.js';
import { MOBILE_IMAGE_ERRORS } from '../../../src/utils/mobileDetection.js';
import type { Address, ToolContext } from '../../../src/contracts/types.js';

const address: Address = { name: 'Ada Lovelace', addressLine1: '1 Main St', city: 'Springfield', state: 'IL', postalCode: '62701', country: 'US' };
const input = { sender: address, recipient: address, bodyText: 'Hello there.', signOff: 'Yours, Ada' };

function context(isMobile = false): ToolContext {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { correlationId: 'c1', isMobile, user: { userId: 'u1' }, logger } as unknown as ToolContext;
}

const SHARED_BEFORE = ['schedule', 'mailService'];
const CHECKS = ['sender', 'addresses', 'earlyGift', 'stationery', 'signature', 'characterCap', 'printable'];
const AFTER = ['layout', 'giftLayout', 'provider', 'draft'];

// The words each image tool's log lines always used: its events and how it names the picture.
const LOG_WORDS = {
  header: { events: 'quote.letter.header_image', start: 'Processing quote_and_preview_letter_with_header_image', noun: 'header image', Noun: 'Header image' },
  inline: { events: 'quote.letter.image', start: 'Processing quote_and_preview_letter_with_image', noun: 'image', Noun: 'Image' }
};

/** Each line the tool logged at a level, as its event and message. */
const logLines = (ctx: ToolContext, level: 'info' | 'warn' = 'info') =>
  vi.mocked(ctx.logger[level]).mock.calls.map(([fields, message]) => [(fields as unknown as { event: string }).event, message]);

const draftParams = () => vi.mocked(helpers.createLetterDraftAndBuildOutput).mock.calls[0][0];

beforeEach(() => {
  order.length = 0;
  vi.clearAllMocks();
});

describe('one letter-preview pipeline (#689)', () => {
  it('a text-only letter runs the thirteen steps in order, with no picture', async () => {
    await quoteAndPreviewLetterTextOnlyTool.handler(input, context());

    expect(order).toEqual([...SHARED_BEFORE, ...CHECKS, ...AFTER]);
    expect(resolvePreviewImageSource).not.toHaveBeenCalled();
    expect(draftParams()).toMatchObject({ layoutType: 'text_only' });
    for (const field of ['headerImageData', 'headerImagePreview', 'headerImageUrl', 'inlineImageData', 'inlineImagePreview', 'inlineImageUrl']) {
      expect(draftParams()).not.toHaveProperty(field);
    }
    expect(vi.mocked(helpers.layoutLetterForPreview).mock.calls[0][0]).toMatchObject({ layoutType: 'text_only', imageData: undefined });
  });

  it('a text-only letter writes the start line it always wrote', async () => {
    const ctx = context();
    await quoteAndPreviewLetterTextOnlyTool.handler(input, ctx);

    expect(logLines(ctx)).toEqual([['quote.letter.text_only.start', 'Processing quote_and_preview_letter (text-only)']]);
  });

  it('a text-only letter ignores an image a client sends anyway', async () => {
    await quoteAndPreviewLetterTextOnlyTool.handler({ ...input, imageUrl: 'https://example.test/a.png' } as typeof input, context());

    expect(resolvePreviewImageSource).not.toHaveBeenCalled();
    expect(downloadAndProcessLetterImageWithPreview).not.toHaveBeenCalled();
  });

  for (const [name, tool, layoutType, processAs, prefix] of [
    ['header image', quoteAndPreviewLetterWithHeaderImageTool, 'header_image', 'header', 'header'],
    ['enclosed image', quoteAndPreviewLetterWithImageTool, 'inline_image', 'inline', 'inline']
  ] as const) {
    describe(`a letter with a ${name}`, () => {
      it('finds the picture after the free checks on date and service, and processes it only after the checks on what prints', async () => {
        await tool.handler(input, context());

        expect(order).toEqual([...SHARED_BEFORE, 'imageSource', ...CHECKS, 'processImage', ...AFTER]);
        expect(resolvePreviewImageSource).toHaveBeenCalledWith(expect.anything(), 'u1', layoutType);
        expect(downloadAndProcessLetterImageWithPreview).toHaveBeenCalledWith({ url: 'https://example.test/a.png' }, processAs, { actorId: 'u1' });
      });

      it('writes the log lines it always wrote, for each source of the picture', async () => {
        const words = LOG_WORDS[prefix];
        const ctx = context();
        await tool.handler(input, ctx);
        expect(logLines(ctx)).toEqual([
          [`${words.events}.start`, words.start],
          [`${words.events}.from_url`, `Using ${words.noun} from URL`],
          [`${words.events}.processing`, `Processing ${words.noun}`],
          [`${words.events}.processed`, `${words.Noun} processed successfully`]
        ]);

        for (const [resolved, event, message] of [
          [{ kind: 'file', url: 'https://example.test/a.png' }, 'from_fileParams', `Using ${words.noun} from OpenAI fileParams`],
          [{ kind: 'recent_upload', url: 'https://example.test/a.png', ageMs: 5, unresolvedReference: false }, 'from_recent_upload', `Using recent uploaded image fallback for letter with ${words.noun}`]
        ] as const) {
          vi.mocked(resolvePreviewImageSource).mockResolvedValueOnce(resolved as never);
          const each = context();
          await tool.handler(input, each);
          expect(logLines(each)[1]).toEqual([`${words.events}.${event}`, message]);
        }

        vi.mocked(resolvePreviewImageSource).mockResolvedValueOnce({ kind: 'none' } as never);
        const none = context();
        await expect(tool.handler(input, none)).rejects.toThrow();
        expect(logLines(none, 'warn')).toEqual([[`${words.events}.no_image`, `No ${words.noun} provided`]]);

        vi.mocked(downloadAndProcessLetterImageWithPreview).mockRejectedValueOnce(new Error('decoder'));
        const failed = context();
        await expect(tool.handler(input, failed)).rejects.toThrow();
        expect(logLines(failed, 'warn')).toEqual([[`${words.events}.failed`, `${words.Noun} processing failed`]]);
      });

      it('lays the letter out with the picture that prints, and gives the draft both versions and the source', async () => {
        await tool.handler(input, context());

        expect(vi.mocked(helpers.layoutLetterForPreview).mock.calls[0][0]).toMatchObject({ layoutType, imageData: 'data:image/png;base64,FULL' });
        expect(draftParams()).toMatchObject({
          layoutType,
          [`${prefix}ImageData`]: 'data:image/png;base64,FULL',
          [`${prefix}ImagePreview`]: 'data:image/png;base64,SMALL',
          [`${prefix}ImageUrl`]: 'https://example.test/a.png'
        });
        const other = prefix === 'header' ? 'inline' : 'header';
        expect(draftParams()).not.toHaveProperty(`${other}ImageData`);
      });

      it('asks whether a signed letter fits one page unsigned with the picture that prints (#608)', async () => {
        vi.mocked(chooseSignature).mockResolvedValueOnce({ image: 'data:image/png;base64,SIG' } as never);
        await tool.handler(input, context());

        const fitsOnePageUnsigned = vi.mocked(helpers.giftForLayout).mock.calls[0][5]!;
        expect(fitsOnePageUnsigned()).toBe(true);
        expect(helpers.letterRunsPast).toHaveBeenCalledWith(
          expect.objectContaining({ layoutType, imageData: 'data:image/png;base64,FULL', bodyText: input.bodyText, signOff: input.signOff }),
          1
        );
        expect(vi.mocked(helpers.letterRunsPast).mock.calls[0][0]).not.toHaveProperty('signatureImage');
      });

      it('says an unsigned letter does not fit one page by dropping a signature it does not have', async () => {
        await tool.handler(input, context());

        const fitsOnePageUnsigned = vi.mocked(helpers.giftForLayout).mock.calls[0][5]!;
        expect(fitsOnePageUnsigned()).toBe(false);
        expect(helpers.letterRunsPast).not.toHaveBeenCalled();
      });

      it('fetches no picture when the arrival date is refused', async () => {
        vi.mocked(previewSchedule).mockImplementationOnce(() => { throw new Error('too soon'); });

        await expect(tool.handler(input, context())).rejects.toThrow('too soon');
        expect(resolvePreviewImageSource).not.toHaveBeenCalled();
      });

      it('downloads no picture when what prints is refused', async () => {
        vi.mocked(validatePrintableLetter).mockImplementationOnce(() => { throw new Error('boxes'); });

        await expect(tool.handler(input, context())).rejects.toThrow('boxes');
        expect(downloadAndProcessLetterImageWithPreview).not.toHaveBeenCalled();
        expect(helpers.createLetterDraftAndBuildOutput).not.toHaveBeenCalled();
      });

      it('refuses a letter with no picture before any check on the addresses, in words for the device', async () => {
        vi.mocked(resolvePreviewImageSource).mockResolvedValueOnce({ kind: 'none' } as never);
        await expect(tool.handler(input, context(true))).rejects.toThrow(MOBILE_IMAGE_ERRORS.letterWithImage);
        expect(order).toEqual([...SHARED_BEFORE]);

        vi.mocked(resolvePreviewImageSource).mockResolvedValueOnce({ kind: 'none' } as never);
        await expect(tool.handler(input, context(false))).rejects.toThrow(MOBILE_IMAGE_ERRORS.desktop);
        expect(downloadAndProcessLetterImageWithPreview).not.toHaveBeenCalled();
      });

      it('says the picture could not be processed, and drafts nothing', async () => {
        vi.mocked(downloadAndProcessLetterImageWithPreview).mockRejectedValueOnce(new Error('decoder'));

        await expect(tool.handler(input, context())).rejects.toThrow(`Could not process ${name === 'header image' ? 'header image' : 'image'}. Please try a different image.`);
        expect(helpers.createLetterDraftAndBuildOutput).not.toHaveBeenCalled();
      });
    });
  }
});
