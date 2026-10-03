import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import {
  downloadAndProcessImage,
  downloadAndProcessLetterImage,
  downloadAndProcessLetterImageWithPreview,
  downloadAndProcessPostcardImageWithPreview,
  reprocessPostcardImage,
} from '../../../src/services/imageService.js';

/**
 * Photos are printed upright (#617). A phone stores a portrait photo's pixels as the sensor read them and
 * records the turn in an EXIF Orientation tag, which every print path drops when it re-encodes: unless the
 * path turns the picture first, the tag is lost and the picture prints turned by 90 degrees.
 *
 * Real bytes, no sharp mock. The fixture is 300 x 200 pixels, red on the left and blue on the right, tagged
 * with an orientation. What a viewer sees, and so what must print, is the picture turned by the tag:
 *
 *   tag      turn            sees (top left, top right, bottom left, bottom right)
 *   none, 1  none            red, blue, red, blue
 *   3        180 degrees     blue, red, blue, red
 *   6        90 clockwise    red, red, blue, blue
 *   8        90 anticlockwise blue, blue, red, red
 */

// A public, non-reserved address literal: no DNS lookup happens, and fetch is stubbed.
const REMOTE = 'https://93.184.216.34/photo.jpg';

type Orientation = 1 | 3 | 6 | 8;
type Colour = 'R' | 'B' | '?';
type Corner = 'R' | 'G' | 'B' | 'Y';

async function halves(format: 'jpeg' | 'webp', orientation?: Orientation): Promise<Buffer> {
  const red = await sharp({ create: { width: 150, height: 200, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const blue = await sharp({ create: { width: 150, height: 200, channels: 3, background: '#0000ff' } }).png().toBuffer();
  const base = sharp({ create: { width: 300, height: 200, channels: 3, background: '#000000' } }).composite([
    { input: red, left: 0, top: 0 },
    { input: blue, left: 150, top: 0 },
  ]);
  const encoded = format === 'jpeg' ? base.jpeg({ quality: 95 }) : base.webp({ quality: 95 });
  return (orientation === undefined ? encoded : encoded.withMetadata({ orientation })).toBuffer();
}

/** The colours at the middle of each quarter of a processed picture: top left, top right, bottom left, bottom right. */
async function quarters(dataUri: string): Promise<Colour[]> {
  const { data, info } = await sharp(Buffer.from(dataUri.split(',')[1], 'base64')).raw().toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number): Colour => {
    const i = (Math.floor(y * info.height) * info.width + Math.floor(x * info.width)) * info.channels;
    const [r, , b] = [data[i], data[i + 1], data[i + 2]];
    if (r > 150 && b < 100) return 'R';
    if (b > 150 && r < 100) return 'B';
    return '?';
  };
  return [at(0.25, 0.25), at(0.75, 0.25), at(0.25, 0.75), at(0.75, 0.75)];
}

const SEEN: Record<string, Colour[]> = {
  none: ['R', 'B', 'R', 'B'],
  '1': ['R', 'B', 'R', 'B'],
  '3': ['B', 'R', 'B', 'R'],
  '6': ['R', 'R', 'B', 'B'],
  '8': ['B', 'B', 'R', 'R'],
};

function bodyOf(bytes: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

function respond(bytes: Buffer, type: string): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? type : null) },
    body: bodyOf(bytes),
  } as unknown as Response;
}

/** 300 x 200: red top left, green top right, blue bottom left, yellow bottom right, optionally tagged. */
async function quadrants(format: 'jpeg' | 'webp' | 'png', orientation?: number): Promise<Buffer> {
  const tile = (background: string) => sharp({ create: { width: 150, height: 100, channels: 3, background } }).png().toBuffer();
  const base = sharp({ create: { width: 300, height: 200, channels: 3, background: '#000000' } }).composite([
    { input: await tile('#ff0000'), left: 0, top: 0 },
    { input: await tile('#00ff00'), left: 150, top: 0 },
    { input: await tile('#0000ff'), left: 0, top: 100 },
    { input: await tile('#ffff00'), left: 150, top: 100 },
  ]);
  const encoded = format === 'jpeg' ? base.jpeg({ quality: 95 }) : format === 'webp' ? base.webp({ quality: 95 }) : base.png();
  return (orientation === undefined ? encoded : encoded.withMetadata({ orientation })).toBuffer();
}

/** The nearest of red, green, blue and yellow at the middle of each quarter: top left, top right, bottom left, bottom right. */
async function corners(dataUri: string): Promise<string> {
  const { data, info } = await sharp(Buffer.from(dataUri.split(',')[1], 'base64')).raw().toBuffer({ resolveWithObject: true });
  const palette: Array<[Corner, [number, number, number]]> = [
    ['R', [255, 0, 0]],
    ['G', [0, 255, 0]],
    ['B', [0, 0, 255]],
    ['Y', [255, 255, 0]],
  ];
  const nearest = (x: number, y: number): Corner => {
    const i = (Math.floor(y * info.height) * info.width + Math.floor(x * info.width)) * info.channels;
    const distance = ([r, g, b]: [number, number, number]) => (data[i] - r) ** 2 + (data[i + 1] - g) ** 2 + (data[i + 2] - b) ** 2;
    return palette.reduce((best, entry) => (distance(entry[1]) < distance(best[1]) ? entry : best))[0];
  };
  return [nearest(0.25, 0.25), nearest(0.75, 0.25), nearest(0.25, 0.75), nearest(0.75, 0.75)].join('');
}

/**
 * What a viewer sees for each EXIF Orientation of the quadrants fixture, as its corners read: top left, top
 * right, bottom left, bottom right (EXIF 2.3, tag Orientation): 2 mirrors left to right, 3 turns it 180 degrees,
 * 4 mirrors top to bottom, 5 is a transpose, 6 turns it 90 degrees clockwise, 7 is a transverse, 8 turns it 90
 * degrees anticlockwise.
 */
const UPRIGHT: Record<string, string> = {
  none: 'RGBY',
  '1': 'RGBY',
  '2': 'GRYB',
  '3': 'YBGR',
  '4': 'BYRG',
  '5': 'RBGY',
  '6': 'BRYG',
  '7': 'YGBR',
  '8': 'GYRB',
};

describe('photos are printed upright (#617)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fetchMock.mockReset();
  });

  const tags: Array<[string, Orientation | undefined]> = [
    ['none', undefined],
    ['1', 1],
    ['3', 3],
    ['6', 6],
    ['8', 8],
  ];

  describe.each([
    ['jpeg', 'image/jpeg'],
    ['webp', 'image/webp'],
  ] as const)('a %s', (format, type) => {
    describe.each(tags)('tagged %s', (tag, orientation) => {
      const seen = SEEN[tag];

      it('prints upright on a postcard, with its preview', async () => {
        fetchMock.mockResolvedValueOnce(respond(await halves(format, orientation), type));
        const result = await downloadAndProcessPostcardImageWithPreview({ url: REMOTE }, '6x9');
        await expect(quarters(result.base64DataUri)).resolves.toEqual(seen);
        await expect(quarters(result.previewDataUri)).resolves.toEqual(seen);
      });

      it('prints upright on a postcard through the plain path', async () => {
        fetchMock.mockResolvedValueOnce(respond(await halves(format, orientation), type));
        const result = await downloadAndProcessImage({ url: REMOTE }, '6x9');
        await expect(quarters(result.base64DataUri)).resolves.toEqual(seen);
      });

      it('prints upright as a letter\'s header image', async () => {
        fetchMock.mockResolvedValueOnce(respond(await halves(format, orientation), type));
        const result = await downloadAndProcessLetterImage({ url: REMOTE }, 'header');
        await expect(quarters(result.base64DataUri)).resolves.toEqual(seen);
      });

      it('prints upright as a letter\'s inline image, with its preview', async () => {
        fetchMock.mockResolvedValueOnce(respond(await halves(format, orientation), type));
        const result = await downloadAndProcessLetterImageWithPreview({ url: REMOTE }, 'inline');
        await expect(quarters(result.base64DataUri)).resolves.toEqual(seen);
        await expect(quarters(result.previewDataUri)).resolves.toEqual(seen);
      });
    });
  });

  describe.each([
    ['jpeg', 'image/jpeg'],
    ['webp', 'image/webp'],
    ['png', 'image/png'],
  ] as const)('every orientation a %s can carry', (format, type) => {
    it.each(Object.entries(UPRIGHT))('tagged %s prints as a viewer sees it', async (tag, expected) => {
      fetchMock.mockResolvedValueOnce(respond(await quadrants(format, tag === 'none' ? undefined : Number(tag)), type));
      const result = await downloadAndProcessPostcardImageWithPreview({ url: REMOTE }, '6x9');
      await expect(corners(result.base64DataUri)).resolves.toBe(expected);
    });
  });

  it('crops a postcard again, from its source or from the copy it stored, to the same upright picture', async () => {
    const photo = await halves('jpeg', 6);
    fetchMock.mockResolvedValueOnce(respond(photo, 'image/jpeg'));
    const first = await downloadAndProcessPostcardImageWithPreview({ url: REMOTE }, '6x9');
    expect(await quarters(first.base64DataUri)).toEqual(SEEN['6']);

    // From its source: the tagged original is turned again.
    fetchMock.mockResolvedValueOnce(respond(photo, 'image/jpeg'));
    const fromSource = await reprocessPostcardImage({ url: REMOTE, stored: first.base64DataUri }, '6x11');
    expect(fromSource.from).toBe('source');
    expect(await quarters(fromSource.base64DataUri)).toEqual(SEEN['6']);

    // From the stored copy, which is upright and carries no tag: turning it again leaves it as it is.
    const fromStored = await reprocessPostcardImage({ url: null, stored: first.base64DataUri }, '6x4');
    expect(fromStored.from).toBe('stored');
    expect(await quarters(fromStored.base64DataUri)).toEqual(SEEN['6']);
  });

  it('leaves no orientation tag on what it prints, so nothing turns it twice', async () => {
    fetchMock.mockResolvedValueOnce(respond(await halves('jpeg', 6), 'image/jpeg'));
    const result = await downloadAndProcessPostcardImageWithPreview({ url: REMOTE }, '6x9');
    const metadata = await sharp(Buffer.from(result.base64DataUri.split(',')[1], 'base64')).metadata();
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
  });
});
