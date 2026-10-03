/**
 * The postcard preview with the real compositor and the real gates (#616, review of #621).
 *
 * postcardCollage.test.ts mocks the compositor, so the account the preview names
 * never met the download gate, whose share of two refused a collage's third photo
 * at once: three and four photos failed for every signed-in person, and no test
 * saw it. Here only the network and the draft store are stubbed; the photos are
 * real bytes, downloaded and drawn by the service the tool calls.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

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
import { _testing } from '../../../src/services/imageService.js';
import { getGiftBalance } from '../../../src/services/giftLetterService.js';
import { getSendEligibility } from '../../../src/services/commerceService.js';
import { quoteAndPreviewPostcardTool } from '../../../src/tools/quoteAndPreviewPostcard.js';
import type { Address, ToolContext } from '../../../src/contracts/types.js';

type Rgb = [number, number, number];
const RED: Rgb = [255, 0, 0];
const GREEN: Rgb = [0, 160, 0];
const BLUE: Rgb = [0, 0, 255];
const YELLOW: Rgb = [255, 220, 0];
const COLOURS: Rgb[] = [RED, GREEN, BLUE, YELLOW];

// Public, non-reserved address literals: no DNS lookup happens, and fetch is stubbed.
const LINKS = [1, 2, 3, 4].map(n => `https://93.184.216.34/photo-${n}.jpg`);

const fetchMock = vi.fn();

async function stubPhotos(count: number): Promise<void> {
  const photos = new Map<string, Buffer>();
  for (let i = 0; i < count; i += 1) {
    const [r, g, b] = COLOURS[i];
    photos.set(
      LINKS[i],
      await sharp({ create: { width: 600, height: 400, channels: 3, background: { r, g, b } } }).jpeg({ quality: 95 }).toBuffer()
    );
  }
  fetchMock.mockImplementation(async (url: string) => {
    const bytes = photos.get(url);
    if (!bytes) throw new TypeError('fetch failed');
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(bytes));
          controller.close();
        }
      })
    } as unknown as Response;
  });
}

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
  return { name: 'Sam Rivera', addressLine1: '350 Fifth Ave', city: 'New York', state: 'NY', postalCode: '10118', country: 'US', ...overrides };
}

type Handler = (input: unknown, ctx: ToolContext) => Promise<Record<string, unknown>>;
function run(input: Record<string, unknown>) {
  return (quoteAndPreviewPostcardTool.handler as unknown as Handler)(
    {
      sender: address({ name: 'Pat Example', addressLine1: '1600 Pennsylvania Ave NW', city: 'Washington', state: 'DC', postalCode: '20500' }),
      recipient: address(),
      message: 'Greetings from the coast!',
      ...input
    },
    context()
  );
}

/** The picture the draft was stored with: its size, and the colour at each point. */
async function storedPicture() {
  expect(createPostcardDraft).toHaveBeenCalledTimes(1);
  const draft = vi.mocked(createPostcardDraft).mock.calls[0][0];
  const bytes = Buffer.from(String(draft.frontImageData).split(',')[1], 'base64');
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  return {
    draft,
    format: (await sharp(bytes).metadata()).format,
    width: info.width,
    height: info.height,
    at: (x: number, y: number): Rgb => {
      const i = (y * info.width + x) * info.channels;
      return [data[i], data[i + 1], data[i + 2]];
    }
  };
}

const near = (actual: Rgb, expected: Rgb) => actual.every((channel, i) => Math.abs(channel - expected[i]) <= 40);

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
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
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('a postcard collage through the real compositor and gates (#616)', () => {
  // The cell centres on a 6x9 front (2700 x 1800) for each count, in the order given.
  const CELLS: Record<number, Array<[number, number]>> = {
    2: [[681, 900], [2019, 900]],
    3: [[900, 900], [2238, 456], [2238, 1344]],
    4: [[681, 456], [2019, 456], [681, 1344], [2019, 1344]]
  };

  it.each([2, 3, 4])('draws %i links for the signed-in account and stores one composite', async count => {
    await stubPhotos(count);
    const result = await run({ imageUrls: LINKS.slice(0, count) });

    expect(fetchMock).toHaveBeenCalledTimes(count);
    const picture = await storedPicture();
    expect([picture.width, picture.height, picture.format]).toEqual([2700, 1800, 'jpeg']);
    CELLS[count].forEach(([x, y], i) => {
      expect(near(picture.at(x, y), COLOURS[i]), `photo ${i + 1} at (${x}, ${y}) is ${picture.at(x, y)}`).toBe(true);
    });
    expect(picture.draft.frontImageUrl).toBeNull();
    expect(result.collagePhotos).toBe(count);
    expect(result.draftId).toBe('draft-1');

    // The account's share of every gate is given back.
    for (const gate of [_testing.collageGate, _testing.downloadGate, _testing.decodeGate]) {
      expect(gate.snapshot(), gate.name).toMatchObject({ active: 0, queued: 0, keys: 0 });
    }
  });

  it('says which photo would not download, and drafts nothing', async () => {
    await stubPhotos(2);
    await expect(run({ imageUrls: [LINKS[0], LINKS[1], LINKS[2]] })).rejects.toThrow("The third photo: Couldn't download the image. Please try again.");
    expect(createPostcardDraft).not.toHaveBeenCalled();
    for (const gate of [_testing.collageGate, _testing.downloadGate, _testing.decodeGate]) {
      expect(gate.snapshot(), gate.name).toMatchObject({ active: 0, queued: 0, keys: 0 });
    }
  });
});
