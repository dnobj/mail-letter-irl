/**
 * The postcard preview takes a collage (#616): two to four photos, as
 * attachments or as links, drawn as one front. The services are mocked; what is
 * checked is what the preview hands the compositor, what it stores, what it
 * answers, and what it refuses before anything is fetched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/providers/index.js', () => ({
  getLetterProvider: vi.fn()
}));

vi.mock('../../../src/services/draftService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/draftService.js')>()),
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
  downloadAndProcessPostcardImageWithPreview: vi.fn(),
  downloadAndProcessCollageWithPreview: vi.fn()
}));

vi.mock('../../../src/services/giftLetterService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/giftLetterService.js')>()),
  getGiftBalance: vi.fn()
}));

vi.mock('../../../src/services/commerceService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/commerceService.js')>()),
  getSendEligibility: vi.fn()
}));

import { getLetterProvider } from '../../../src/services/providers/index.js';
import { createPostcardDraft } from '../../../src/services/draftService.js';
import { getRecentUploadedImage } from '../../../src/services/recentUploadStore.js';
import { getReturnAddress } from '../../../src/services/returnAddressService.js';
import {
  downloadAndProcessCollageWithPreview,
  downloadAndProcessPostcardImageWithPreview,
  ImageProcessingError
} from '../../../src/services/imageService.js';
import { getGiftBalance } from '../../../src/services/giftLetterService.js';
import { getSendEligibility } from '../../../src/services/commerceService.js';
import { quoteAndPreviewPostcardTool } from '../../../src/tools/quoteAndPreviewPostcard.js';
import type { Address, ToolContext } from '../../../src/contracts/types.js';

/** A PNG's signature and header: enough for the renderer to read its size. */
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

// The composite at 300 dpi, 9 x 6in, and its small copy; and a single photo's crop, which differs.
const COMPOSITE = png(2700, 1800);
const SINGLE = png(2700, 1801);
const SMALL = png(540, 360);

function context(): ToolContext {
  return {
    user: { userId: 'user-1', creditsRemaining: 10 } as ToolContext['user'],
    correlationId: 'corr-1',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never,
    now: () => new Date('2026-10-01T12:00:00Z'),
    persist: vi.fn(),
    isMobile: false
  } as unknown as ToolContext;
}

function address(overrides: Partial<Address> = {}): Address {
  return {
    name: 'Sam Rivera',
    addressLine1: '350 Fifth Ave',
    city: 'New York',
    state: 'NY',
    postalCode: '10118',
    country: 'US',
    ...overrides
  };
}

const link = (n: number) => `https://photos.example/${n}.jpg`;
const file = (n: number) => ({ download_url: `https://files.example/${n}.jpg`, file_id: `file-${n}` });

type Handler = (input: unknown, ctx: ToolContext) => Promise<Record<string, unknown>>;
function run(input: Record<string, unknown> = {}, ctx: ToolContext = context()) {
  return (quoteAndPreviewPostcardTool.handler as unknown as Handler)(
    {
      sender: address({ name: 'Pat Example', addressLine1: '1600 Pennsylvania Ave NW', city: 'Washington', state: 'DC', postalCode: '20500' }),
      recipient: address(),
      message: 'Greetings from the coast!',
      ...input
    },
    ctx
  );
}

function drafted() {
  expect(createPostcardDraft).toHaveBeenCalledTimes(1);
  return vi.mocked(createPostcardDraft).mock.calls[0][0];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('LETTER_IRL_PRINT_RENDERER', 'pdf');
  vi.stubEnv('LETTER_IRL_POSTCARD_COLLAGES_ENABLED', 'true');
  vi.mocked(getLetterProvider).mockReturnValue({} as never);
  vi.mocked(createPostcardDraft).mockResolvedValue({ draftId: 'draft-1', expiresAt: new Date('2026-10-02T12:00:00Z') });
  vi.mocked(getRecentUploadedImage).mockResolvedValue(null);
  vi.mocked(getReturnAddress).mockResolvedValue(null);
  vi.mocked(getGiftBalance).mockResolvedValue({ available: 0, next: undefined } as never);
  vi.mocked(getSendEligibility).mockReturnValue({
    payAndSend: { available: true, amountCents: 499 },
    letterPack: { available: true, purchaseUrl: 'https://letterirl.com/pricing' }
  } as never);
  vi.mocked(downloadAndProcessPostcardImageWithPreview).mockResolvedValue({
    base64DataUri: SINGLE,
    previewDataUri: SMALL,
    originalWidth: 2700,
    originalHeight: 1801,
    processedWidth: 2700,
    processedHeight: 1800
  } as never);
  vi.mocked(downloadAndProcessCollageWithPreview).mockResolvedValue({
    base64DataUri: COMPOSITE,
    previewDataUri: SMALL,
    originalWidth: 4032,
    originalHeight: 3024,
    processedWidth: 2700,
    processedHeight: 1800
  } as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('a postcard collage (#616)', () => {
  it('draws links in the order given, for the account, and stores the composite with no one source', async () => {
    const result = await run({ imageUrls: [link(1), link(2), link(3)] });
    expect(downloadAndProcessCollageWithPreview).toHaveBeenCalledTimes(1);
    expect(downloadAndProcessCollageWithPreview).toHaveBeenCalledWith(
      [{ url: link(1) }, { url: link(2) }, { url: link(3) }],
      '6x9',
      { actorId: 'user-1' }
    );
    expect(downloadAndProcessPostcardImageWithPreview).not.toHaveBeenCalled();
    // A collage has no one source to resolve, so the account's recent upload is not looked up.
    expect(getRecentUploadedImage).not.toHaveBeenCalled();
    const draft = drafted();
    expect(draft.frontImageData).toBe(COMPOSITE);
    expect(draft.frontImageUrl).toBeNull();
    expect(draft.postcardSize).toBe('6x9');
    expect(result.collagePhotos).toBe(3);
    expect(result.draftId).toBe('draft-1');
  });

  it('draws attached photos as they came', async () => {
    const result = await run({ images: [file(1), file(2)] });
    expect(downloadAndProcessCollageWithPreview).toHaveBeenCalledWith([file(1), file(2)], '6x9', { actorId: 'user-1' });
    expect(result.collagePhotos).toBe(2);
    expect(drafted().frontImageUrl).toBeNull();
  });

  it('draws four, and a 4x6 postcard at its size', async () => {
    // The other sizes are offered with our renderer and Pay & Send (isPostcardSizesOffered).
    vi.stubEnv('LETTER_IRL_POSTCARD_SIZES_ENABLED', 'true');
    vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
    const result = await run({ imageUrls: [link(1), link(2), link(3), link(4)], size: '6x4' });
    expect(downloadAndProcessCollageWithPreview).toHaveBeenCalledWith(expect.any(Array), '6x4', { actorId: 'user-1' });
    expect(drafted().postcardSize).toBe('6x4');
    expect(result.collagePhotos).toBe(4);
  });

  it('keeps the draft as a full bleed front: nothing downstream learns it was a collage', async () => {
    await run({ imageUrls: [link(1), link(2)] });
    const draft = drafted();
    expect(draft.postcardFront).toBeNull();
    // Our renderer drew it as it draws any full bleed postcard.
    expect(draft.rendererVersion).toBe('pdf-1');
    expect(draft.previewHtml).toContain('<svg');
  });

  it('takes a border and a caption over the collage, as it does over a photo', async () => {
    vi.stubEnv('LETTER_IRL_POSTCARD_LAYOUTS_ENABLED', 'true');
    const result = await run({ imageUrls: [link(1), link(2)], layout: 'border', caption: 'Our trip' });
    const draft = drafted();
    expect(draft.postcardFront).toEqual({ layout: 'border', caption: 'Our trip' });
    expect(draft.frontImageData).toBe(COMPOSITE);
    expect(result).toMatchObject({ layout: 'border', caption: 'Our trip', collagePhotos: 2 });
  });

  it('is drawn on the legacy print path too, with its small copy for the preview', async () => {
    vi.stubEnv('LETTER_IRL_PRINT_RENDERER', '');
    const result = await run({ imageUrls: [link(1), link(2)] });
    const draft = drafted();
    expect(draft.rendererVersion).toBeUndefined();
    expect(draft.frontImageData).toBe(COMPOSITE);
    expect(String(result.previewFrontHtml)).toContain(SMALL);
    expect(result.collagePhotos).toBe(2);
  });

  it('answers what a single photo answers, and names nothing of a collage for one', async () => {
    const result = await run({ imageUrl: link(1) });
    expect(downloadAndProcessCollageWithPreview).not.toHaveBeenCalled();
    expect(downloadAndProcessPostcardImageWithPreview).toHaveBeenCalledTimes(1);
    expect(drafted().frontImageUrl).toBe(link(1));
    expect(drafted().frontImageData).toBe(SINGLE);
    expect(result).not.toHaveProperty('collagePhotos');
  });

  it('records the link of a single attached photo, which is how a collage is told from it (#616)', async () => {
    // A collage's draft has a picture and no link (set_postcard_style refuses it another size); a photo's has its link.
    const result = await run({ image: file(1) });
    expect(drafted().frontImageUrl).toBe(file(1).download_url);
    expect(downloadAndProcessCollageWithPreview).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('collagePhotos');
  });

  it('logs its size and how the photos came, never an address', async () => {
    const ctx = context();
    await run({ imageUrls: [link(1), link(2), link(3)] }, ctx);
    const start = vi.mocked(ctx.logger.info).mock.calls.find(([fields]) => (fields as { event?: string }).event === 'quote.postcard.start');
    expect(start?.[0]).toMatchObject({ collagePhotos: 3, collageVia: 'imageUrls' });
    expect(JSON.stringify(vi.mocked(ctx.logger.info).mock.calls)).not.toContain('photos.example');
  });

  describe('refusals', () => {
    it('refuses a collage while collages are not offered, before anything is fetched or drafted', async () => {
      vi.stubEnv('LETTER_IRL_POSTCARD_COLLAGES_ENABLED', '');
      await expect(run({ imageUrls: [link(1), link(2)] })).rejects.toThrow('Collages are not offered here. Give one photo, in image or imageUrl.');
      expect(downloadAndProcessCollageWithPreview).not.toHaveBeenCalled();
      expect(downloadAndProcessPostcardImageWithPreview).not.toHaveBeenCalled();
      expect(createPostcardDraft).not.toHaveBeenCalled();
    });

    it.each([
      ['one photo', { imageUrls: [link(1)] }, 'A collage takes 2 to 4 photos; 1 was given.'],
      ['five photos', { imageUrls: [1, 2, 3, 4, 5].map(link) }, 'A collage takes 2 to 4 photos; 5 were given.'],
      ['links and attachments', { imageUrls: [link(1), link(2)], images: [file(1), file(2)] }, 'not both'],
      ['a collage beside a single photo', { imageUrls: [link(1), link(2)], imageUrl: link(9) }, 'not image or imageUrl as well'],
    ])('refuses %s before anything is fetched', async (_name, input, message) => {
      await expect(run(input)).rejects.toThrow(message);
      expect(downloadAndProcessCollageWithPreview).not.toHaveBeenCalled();
      expect(createPostcardDraft).not.toHaveBeenCalled();
    });

    it('says a photo that could not be used in the compositor\'s words, and drafts nothing', async () => {
      vi.mocked(downloadAndProcessCollageWithPreview).mockRejectedValue(
        new ImageProcessingError('UNSUPPORTED_FORMAT', 'The second photo: Unsupported image format. Please use PNG, JPEG, or WebP.')
      );
      await expect(run({ imageUrls: [link(1), link(2)] })).rejects.toThrow(
        'The second photo: Unsupported image format. Please use PNG, JPEG, or WebP.'
      );
      expect(createPostcardDraft).not.toHaveBeenCalled();
    });

    it('does not fall back to the account\'s recent upload for a collage that cannot be made', async () => {
      vi.mocked(getRecentUploadedImage).mockResolvedValue({ imageUrl: 'https://uploads.example/latest.jpg', ageMs: 1000 } as never);
      vi.mocked(downloadAndProcessCollageWithPreview).mockRejectedValue(
        new ImageProcessingError('DOWNLOAD_FAILED', "The second photo: Couldn't download the image. Please try again.")
      );
      await expect(run({ imageUrls: [link(1), link(2)] })).rejects.toThrow('The second photo');
      expect(downloadAndProcessCollageWithPreview).toHaveBeenCalledTimes(1);
      expect(getRecentUploadedImage).not.toHaveBeenCalled();
      expect(downloadAndProcessPostcardImageWithPreview).not.toHaveBeenCalled();
      expect(createPostcardDraft).not.toHaveBeenCalled();
    });

    it('reads an empty list as no collage, so a recent upload can still be the photo (hosts send [] for one left unset)', async () => {
      vi.mocked(getRecentUploadedImage).mockResolvedValue({ imageUrl: 'https://uploads.example/latest.jpg', ageMs: 1000 } as never);
      const result = await run({ images: [], imageUrls: [] });
      expect(downloadAndProcessCollageWithPreview).not.toHaveBeenCalled();
      expect(downloadAndProcessPostcardImageWithPreview).toHaveBeenCalledTimes(1);
      expect(drafted().frontImageUrl).toBe('https://uploads.example/latest.jpg');
      expect(result).not.toHaveProperty('collagePhotos');
    });
  });
});
