import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { crc32, deflateSync } from 'node:zlib';
import {
  _testing,
  downloadAndProcessCollageWithPreview,
  ImageProcessingError,
} from '../../../src/services/imageService.js';
import { ConcurrencyGateError } from '../../../src/utils/concurrencyGate.js';

vi.mock('../../../src/services/tempImageStore.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/tempImageStore.js')>()),
  getUploadedPhoto: vi.fn(),
  getImage: vi.fn(),
}));

import { getImage, getUploadedPhoto, UPLOADED_PHOTO_REFERENCE } from '../../../src/services/tempImageStore.js';

/**
 * Postcard collages (#616): two to four photos downloaded and drawn on one
 * front, in the arrangement their number calls for. Real bytes and no sharp
 * mock, with fetch stubbed per photo address. A cell is checked at its centre,
 * a margin and a gutter at points that are white, so every claim is about
 * pixels of what would print.
 */

// Public, non-reserved address literals: no DNS lookup happens, and fetch is stubbed.
const URLS = [1, 2, 3, 4, 5].map((n) => `https://93.184.216.34/photo-${n}.jpg`);

type Rgb = [number, number, number];
const RED: Rgb = [255, 0, 0];
const GREEN: Rgb = [0, 160, 0];
const BLUE: Rgb = [0, 0, 255];
const YELLOW: Rgb = [255, 220, 0];
const WHITE: Rgb = [255, 255, 255];

async function solid(rgb: Rgb, width = 600, height = 400, format: 'jpeg' | 'png' = 'jpeg'): Promise<Buffer> {
  const base = sharp({ create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } });
  return format === 'jpeg' ? base.jpeg({ quality: 95 }).toBuffer() : base.png().toBuffer();
}

/** 300 x 200: red on the left half, blue on the right half, optionally tagged with an EXIF orientation. */
async function halves(orientation?: 6): Promise<Buffer> {
  const red = await sharp({ create: { width: 150, height: 200, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const blue = await sharp({ create: { width: 150, height: 200, channels: 3, background: '#0000ff' } }).png().toBuffer();
  const base = sharp({ create: { width: 300, height: 200, channels: 3, background: '#000000' } })
    .composite([
      { input: red, left: 0, top: 0 },
      { input: blue, left: 150, top: 0 },
    ])
    .jpeg({ quality: 95 });
  return (orientation === undefined ? base : base.withMetadata({ orientation })).toBuffer();
}

/**
 * Red, green and blue in three equal bands, across (left to right) or down (top to bottom). Cropped to the
 * middle, a cell shows mostly the middle band; stretched, or cropped from an edge, it shows another.
 */
async function bands(direction: 'across' | 'down', width: number, height: number): Promise<Buffer> {
  const colours = ['#ff0000', '#00a000', '#0000ff'];
  const across = direction === 'across';
  const length = (across ? width : height) / 3;
  const tiles = await Promise.all(
    colours.map(async (background, i) => ({
      input: await sharp({
        create: { width: across ? length : width, height: across ? height : length, channels: 3, background },
      })
        .png()
        .toBuffer(),
      left: across ? i * length : 0,
      top: across ? 0 : i * length,
    }))
  );
  return sharp({ create: { width, height, channels: 3, background: '#000000' } }).composite(tiles).jpeg({ quality: 95 }).toBuffer();
}

/** A transparent picture with an opaque red square in the middle. */
async function squareOnClear(): Promise<Buffer> {
  const square = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#ff0000' } }).png().toBuffer();
  return sharp({ create: { width: 400, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: square, left: 150, top: 100 }])
    .png()
    .toBuffer();
}

/** A PNG whose IHDR declares w x h with a tiny IDAT: the decompression-bomb shape. */
function pngHeaderBomb(width: number, height: number, interlaced = false): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData) >>> 0);
    return Buffer.concat([length, typeAndData, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[12] = interlaced ? 1 : 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(13))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function bodyOf(bytes: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

/** What each photo address answers: bytes, or a failure to download. */
type Files = Record<string, Buffer | 'offline'>;

const fetchMock = vi.fn();

function responseFor(files: Files, url: string): Response {
  const file = files[url];
  if (file === undefined || file === 'offline') throw new TypeError('fetch failed');
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: bodyOf(file),
  } as unknown as Response;
}

function serve(files: Files): void {
  fetchMock.mockImplementation(async (url: string) => responseFor(files, url));
}

/** The latest hold(), released after a test that did not finish it. */
let lastHold: { release: () => void } | undefined;

/** Every photo answers only when released, so a test can stand a collage at any download. */
function hold(files: Files) {
  const pending: Array<() => void> = [];
  fetchMock.mockImplementation(
    (url: string) =>
      new Promise<Response>((resolve, reject) => {
        pending.push(() => {
          try {
            resolve(responseFor(files, url));
          } catch (error) {
            reject(error);
          }
        });
      })
  );
  const held = {
    /** Answers every download asked for so far. */
    release: () => pending.splice(0).forEach((answer) => answer()),
    asked: () => pending.length,
  };
  lastHold = held;
  return held;
}

async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Releases the downloads as they are asked for until every call has settled. */
async function finish(held: ReturnType<typeof hold>, ...calls: Array<Promise<unknown>>) {
  let done = false;
  const settled = Promise.allSettled(calls).then((results) => {
    done = true;
    return results;
  });
  // Sharp does its work off the main thread, so wait in real time between releases.
  const deadline = Date.now() + 8_000;
  while (!done && Date.now() < deadline) {
    held.release();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return settled;
}

const COLOURS: Rgb[] = [RED, GREEN, BLUE, YELLOW];

/** The first `count` photo addresses, each a solid colour. */
async function palette(count: number): Promise<Files> {
  const files: Files = {};
  for (let i = 0; i < count; i += 1) files[URLS[i]] = await solid(COLOURS[i]);
  return files;
}

async function rejection(promise: Promise<unknown>): Promise<ImageProcessingError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ImageProcessingError) return error;
    throw new Error(`expected an ImageProcessingError, got ${String(error)}`);
  }
  throw new Error('expected a rejection');
}

const inputs = (count: number) => URLS.slice(0, count).map((url) => ({ url }));

async function pixelsOf(dataUri: string): Promise<{ at: (x: number, y: number) => Rgb; width: number; height: number; format?: string }> {
  const bytes = Buffer.from(dataUri.split(',')[1], 'base64');
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  const meta = await sharp(bytes).metadata();
  return {
    width: info.width,
    height: info.height,
    format: meta.format,
    at: (x, y) => {
      const i = (y * info.width + x) * info.channels;
      return [data[i], data[i + 1], data[i + 2]];
    },
  };
}

/** Whether a pixel is near a colour: a JPEG is lossy, so each channel within a margin. */
function near(actual: Rgb, expected: Rgb, margin = 40): boolean {
  return actual.every((channel, i) => Math.abs(channel - expected[i]) <= margin);
}

async function expectCell(
  picture: Awaited<ReturnType<typeof pixelsOf>>,
  x: number,
  y: number,
  colour: Rgb,
  what: string
): Promise<void> {
  expect(near(picture.at(x, y), colour), `${what} at (${x}, ${y}) is ${picture.at(x, y)}, not near ${colour}`).toBe(true);
}

describe('postcard collages (#616)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(getUploadedPhoto).mockReset();
    vi.mocked(getImage).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fetchMock.mockReset();
  });

  describe('on a 6x9 front', () => {
    it('draws two photos side by side, with white margins and gutter', async () => {
      serve({ [URLS[0]]: await solid(RED), [URLS[1]]: await solid(BLUE) });
      const result = await downloadAndProcessCollageWithPreview(inputs(2), '6x9');
      const picture = await pixelsOf(result.base64DataUri);
      expect([picture.width, picture.height, picture.format]).toEqual([2700, 1800, 'jpeg']);
      await expectCell(picture, 681, 900, RED, 'the first cell');
      await expectCell(picture, 2019, 900, BLUE, 'the second cell');
      await expectCell(picture, 1350, 900, WHITE, 'the gutter');
      await expectCell(picture, 10, 10, WHITE, 'the top left margin');
      await expectCell(picture, 2690, 1790, WHITE, 'the bottom right margin');
      await expectCell(picture, 681, 10, WHITE, 'the top margin');
    });

    it('draws three: one large on the left and two stacked on the right', async () => {
      serve({ [URLS[0]]: await solid(RED), [URLS[1]]: await solid(GREEN), [URLS[2]]: await solid(BLUE) });
      const picture = await pixelsOf((await downloadAndProcessCollageWithPreview(inputs(3), '6x9')).base64DataUri);
      await expectCell(picture, 900, 900, RED, 'the large cell');
      await expectCell(picture, 2238, 456, GREEN, 'the upper right cell');
      await expectCell(picture, 2238, 1344, BLUE, 'the lower right cell');
      // The gutter between the large cell and the column, and the one between the column's cells.
      await expectCell(picture, 1788, 900, WHITE, 'the vertical gutter');
      await expectCell(picture, 2238, 900, WHITE, 'the horizontal gutter in the right column');
      // The large cell runs the whole height, from the margin to the margin: the column's gutter does not cut it.
      await expectCell(picture, 900, 40, RED, 'the top of the large cell');
      await expectCell(picture, 900, 1760, RED, 'the bottom of the large cell');
    });

    it('draws four two by two, in reading order', async () => {
      serve({
        [URLS[0]]: await solid(RED),
        [URLS[1]]: await solid(GREEN),
        [URLS[2]]: await solid(BLUE),
        [URLS[3]]: await solid(YELLOW),
      });
      const picture = await pixelsOf((await downloadAndProcessCollageWithPreview(inputs(4), '6x9')).base64DataUri);
      await expectCell(picture, 681, 456, RED, 'the top left');
      await expectCell(picture, 2019, 456, GREEN, 'the top right');
      await expectCell(picture, 681, 1344, BLUE, 'the bottom left');
      await expectCell(picture, 2019, 1344, YELLOW, 'the bottom right');
      await expectCell(picture, 1350, 456, WHITE, 'the vertical gutter');
      await expectCell(picture, 681, 900, WHITE, 'the horizontal gutter');
      await expectCell(picture, 1350, 900, WHITE, 'the crossing of the gutters');
    });

    it('follows the order the photos are given in', async () => {
      serve({ [URLS[0]]: await solid(RED), [URLS[1]]: await solid(BLUE) });
      const swapped = [{ url: URLS[1] }, { url: URLS[0] }];
      const picture = await pixelsOf((await downloadAndProcessCollageWithPreview(swapped, '6x9')).base64DataUri);
      await expectCell(picture, 681, 900, BLUE, 'the first cell');
      await expectCell(picture, 2019, 900, RED, 'the second cell');
    });
  });

  describe('at the other sizes', () => {
    it('draws on a 4x6 front (1800 x 1200)', async () => {
      serve({ [URLS[0]]: await solid(RED), [URLS[1]]: await solid(BLUE) });
      const result = await downloadAndProcessCollageWithPreview(inputs(2), '6x4');
      const picture = await pixelsOf(result.base64DataUri);
      expect([picture.width, picture.height]).toEqual([1800, 1200]);
      expect([result.processedWidth, result.processedHeight]).toEqual([1800, 1200]);
      await expectCell(picture, 456, 600, RED, 'the first cell');
      await expectCell(picture, 1344, 600, BLUE, 'the second cell');
      await expectCell(picture, 900, 600, WHITE, 'the gutter');
    });

    it('draws on an 11x6 front (3300 x 1800)', async () => {
      serve({ [URLS[0]]: await solid(RED), [URLS[1]]: await solid(GREEN), [URLS[2]]: await solid(BLUE) });
      const result = await downloadAndProcessCollageWithPreview(inputs(3), '6x11');
      const picture = await pixelsOf(result.base64DataUri);
      expect([picture.width, picture.height]).toEqual([3300, 1800]);
      await expectCell(picture, 1100, 900, RED, 'the large cell');
      await expectCell(picture, 2738, 456, GREEN, 'the upper right cell');
      await expectCell(picture, 2738, 1344, BLUE, 'the lower right cell');
    });
  });

  describe('each photo fills its cell', () => {
    it('crops a landscape photo to the middle of a portrait cell', async () => {
      // Red left, blue right, in a 1314 x 1752 cell: the middle of the photo is its seam.
      serve({ [URLS[0]]: await halves(), [URLS[1]]: await solid(GREEN) });
      const picture = await pixelsOf((await downloadAndProcessCollageWithPreview(inputs(2), '6x9')).base64DataUri);
      await expectCell(picture, 352, 900, RED, 'the left quarter of the first cell');
      await expectCell(picture, 1009, 900, BLUE, 'the right quarter of the first cell');
    });

    it('crops to the middle, not by stretching the whole photo into the cell', async () => {
      // Thirds across, in a 1314 x 1752 cell: the middle half of the photo shows, so the cell's quarter points
      // fall in the green middle band. Stretched, the same points would be red and blue.
      serve({ [URLS[0]]: await bands('across', 600, 400), [URLS[1]]: await solid(GREEN) });
      const picture = await pixelsOf((await downloadAndProcessCollageWithPreview(inputs(2), '6x9')).base64DataUri);
      await expectCell(picture, 352, 900, GREEN, 'the left quarter of the cell');
      await expectCell(picture, 1009, 900, GREEN, 'the right quarter of the cell');
      await expectCell(picture, 40, 900, RED, 'the left edge of the cell');
      await expectCell(picture, 1310, 900, BLUE, 'the right edge of the cell');
    });

    it('crops to the middle down a tall photo too, not from its top', async () => {
      // Thirds down, in a 1314 x 864 cell (the top left of four): the middle 44% of the photo shows, so the cell's
      // quarter points fall in the green middle band. Cropped from the top they would be red.
      serve({
        [URLS[0]]: await bands('down', 400, 600),
        [URLS[1]]: await solid(GREEN),
        [URLS[2]]: await solid(BLUE),
        [URLS[3]]: await solid(YELLOW),
      });
      const picture = await pixelsOf((await downloadAndProcessCollageWithPreview(inputs(4), '6x9')).base64DataUri);
      await expectCell(picture, 681, 240, GREEN, 'the upper quarter of the cell');
      await expectCell(picture, 681, 672, GREEN, 'the lower quarter of the cell');
    });

    it('turns a photo upright by its EXIF orientation before it is cropped', async () => {
      // Tagged 6, a viewer sees it with the red on top and the blue at the bottom.
      serve({ [URLS[0]]: await halves(6), [URLS[1]]: await solid(GREEN) });
      const picture = await pixelsOf((await downloadAndProcessCollageWithPreview(inputs(2), '6x9')).base64DataUri);
      await expectCell(picture, 681, 462, RED, 'the top quarter of the first cell');
      await expectCell(picture, 681, 1338, BLUE, 'the bottom quarter of the first cell');
    });

    it('lays a transparent picture on white, not black', async () => {
      serve({ [URLS[0]]: await squareOnClear(), [URLS[1]]: await solid(GREEN) });
      const picture = await pixelsOf((await downloadAndProcessCollageWithPreview(inputs(2), '6x9')).base64DataUri);
      await expectCell(picture, 100, 100, WHITE, 'the clear part of the first cell');
      await expectCell(picture, 681, 900, RED, 'the square in the middle of the first cell');
    });

    it('mixes formats', async () => {
      serve({ [URLS[0]]: await solid(RED, 500, 500, 'png'), [URLS[1]]: await solid(BLUE, 400, 700, 'jpeg') });
      const picture = await pixelsOf((await downloadAndProcessCollageWithPreview(inputs(2), '6x9')).base64DataUri);
      await expectCell(picture, 681, 900, RED, 'the png');
      await expectCell(picture, 2019, 900, BLUE, 'the jpeg');
    });
  });

  describe('what it takes', () => {
    it('takes a WebP, and a file parameter as it takes a link', async () => {
      const webp = await sharp({ create: { width: 500, height: 400, channels: 3, background: '#ff0000' } }).webp().toBuffer();
      serve({ [URLS[0]]: webp, [URLS[1]]: await solid(BLUE) });
      const file = { download_url: URLS[1], file_id: 'file-2' };
      const picture = await pixelsOf((await downloadAndProcessCollageWithPreview([{ url: URLS[0] }, file], '6x9')).base64DataUri);
      await expectCell(picture, 681, 900, RED, 'the webp');
      await expectCell(picture, 2019, 900, BLUE, 'the file parameter');
    });
  });

  describe('photos that are not links', () => {
    it('takes the account\'s uploaded photo and a picture in the temp store as it takes a link, fetching neither', async () => {
      vi.mocked(getUploadedPhoto).mockResolvedValue(await solid(RED));
      vi.mocked(getImage).mockResolvedValue((await solid(BLUE)).toString('base64'));
      const stored = 'https://letterirl.example/api/temp-image/0123456789abcdef0123456789abcdef';
      const result = await downloadAndProcessCollageWithPreview(
        [{ url: UPLOADED_PHOTO_REFERENCE }, { url: stored }],
        '6x9',
        { actorId: 'account-a' }
      );
      const picture = await pixelsOf(result.base64DataUri);
      await expectCell(picture, 681, 900, RED, 'the uploaded photo');
      await expectCell(picture, 2019, 900, BLUE, 'the temp store photo');
      expect(getUploadedPhoto).toHaveBeenCalledWith('account-a');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('names an uploaded photo that has expired, or that has no account to belong to, by its place', async () => {
      vi.mocked(getUploadedPhoto).mockResolvedValue(null);
      serve({ [URLS[0]]: await solid(RED) });
      const expired = await rejection(
        downloadAndProcessCollageWithPreview([{ url: URLS[0] }, { url: UPLOADED_PHOTO_REFERENCE }], '6x9', { actorId: 'account-a' })
      );
      expect(expired.code).toBe('DOWNLOAD_FAILED');
      expect(expired.userMessage).toBe(
        'The second photo: That uploaded photo has expired: uploads are kept for 15 minutes. Please upload it again.'
      );

      vi.mocked(getUploadedPhoto).mockResolvedValue(await solid(RED));
      const nobody = await rejection(
        downloadAndProcessCollageWithPreview([{ url: UPLOADED_PHOTO_REFERENCE }, { url: URLS[0] }], '6x9')
      );
      expect(nobody.userMessage).toMatch(/^The first photo: That uploaded photo has expired/);
    });
  });

  describe('what it returns', () => {
    it('gives the preview a derived small copy, and the first photo\'s own size', async () => {
      serve({ [URLS[0]]: await solid(RED, 640, 480), [URLS[1]]: await solid(BLUE, 800, 600) });
      const result = await downloadAndProcessCollageWithPreview(inputs(2), '6x9');
      expect(result).toMatchObject({ originalWidth: 640, originalHeight: 480, processedWidth: 2700, processedHeight: 1800 });
      expect(result.base64DataUri.startsWith('data:image/jpeg;base64,')).toBe(true);
      const preview = await pixelsOf(result.previewDataUri);
      expect([preview.width, preview.height, preview.format]).toEqual([400, 267, 'jpeg']);
      // The preview is the composite made small: the first cell's colour is where the composite has it.
      await expectCell(preview, 101, 133, RED, 'the first cell in the preview');
      await expectCell(preview, 299, 133, BLUE, 'the second cell in the preview');
    });
  });

  describe('refusals', () => {
    it.each([[0], [1], [5]])('takes two to four photos: not %i', async (count) => {
      serve({});
      const error = await rejection(downloadAndProcessCollageWithPreview(inputs(count), '6x9'));
      expect(error.code).toBe('PROCESSING_FAILED');
      expect(error.userMessage).toBe('A collage takes 2 to 4 photos.');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('names a photo that is not a PNG, JPEG or WebP, by its place', async () => {
      const gif = await sharp({ create: { width: 320, height: 240, channels: 3, background: '#ff0000' } }).gif().toBuffer();
      serve({ [URLS[0]]: await solid(RED), [URLS[1]]: gif, [URLS[2]]: await solid(BLUE) });
      const error = await rejection(downloadAndProcessCollageWithPreview(inputs(3), '6x9'));
      expect(error.code).toBe('UNSUPPORTED_FORMAT');
      expect(error.userMessage).toBe('The second photo: Unsupported image format. Please use PNG, JPEG, or WebP.');
    });

    it('names a photo too small to print', async () => {
      serve({ [URLS[0]]: await solid(RED), [URLS[1]]: await solid(GREEN), [URLS[2]]: await solid(BLUE, 50, 50) });
      const error = await rejection(downloadAndProcessCollageWithPreview(inputs(3), '6x9'));
      expect(error.code).toBe('IMAGE_TOO_SMALL');
      expect(error.userMessage).toMatch(/^The third photo: Image is too small for print quality\./);
    });

    it('names a photo that would not download', async () => {
      serve({ [URLS[0]]: 'offline', [URLS[1]]: await solid(BLUE) });
      const error = await rejection(downloadAndProcessCollageWithPreview(inputs(2), '6x9'));
      expect(error.code).toBe('DOWNLOAD_FAILED');
      expect(error.userMessage).toBe("The first photo: Couldn't download the image. Please try again.");
    });

    it('names a photo over the pixel ceiling', async () => {
      serve({ [URLS[0]]: await solid(RED), [URLS[1]]: pngHeaderBomb(8000, 8000) });
      const error = await rejection(downloadAndProcessCollageWithPreview(inputs(2), '6x9'));
      expect(error.code).toBe('IMAGE_TOO_LARGE');
      expect(error.userMessage).toBe('The second photo: Image is too large. Please use an image under 50 megapixels.');
    });

    it('names a photo whose bytes will not decode', async () => {
      // A real JPEG with its entropy-coded data replaced: the header reads, the decode fails.
      const good = await solid(RED, 600, 400);
      const broken = Buffer.concat([good.subarray(0, 700), Buffer.alloc(good.length - 700, 0x5a)]);
      serve({ [URLS[0]]: broken, [URLS[1]]: await solid(BLUE) });
      const error = await rejection(downloadAndProcessCollageWithPreview(inputs(2), '6x9'));
      expect(error.code).toBe('PROCESSING_FAILED');
      expect(error.userMessage).toBe('The first photo: Image could not be processed. Please try a different image.');
    });

    it('names a photo too large to decode whole, by the size that would fit', async () => {
      // 6000 x 6000 interlaced RGB: 36 MP, under the pixel ceiling, but 108 MB decoded.
      serve({ [URLS[0]]: await solid(RED), [URLS[1]]: pngHeaderBomb(6000, 6000, true) });
      const error = await rejection(downloadAndProcessCollageWithPreview(inputs(2), '6x9'));
      expect(error.code).toBe('IMAGE_TOO_LARGE');
      expect(error.userMessage).toBe(
        'The second photo: Image is too large to process. Please use an image under 33 megapixels, or save it without interlacing or progressive encoding.'
      );
    });

    it('names a photo whose bytes will not decode by its own place', async () => {
      const good = await solid(RED, 600, 400);
      const broken = Buffer.concat([good.subarray(0, 700), Buffer.alloc(good.length - 700, 0x5a)]);
      serve({ [URLS[0]]: await solid(BLUE), [URLS[1]]: await solid(GREEN), [URLS[2]]: broken });
      const error = await rejection(downloadAndProcessCollageWithPreview(inputs(3), '6x9'));
      expect(error.code).toBe('PROCESSING_FAILED');
      expect(error.userMessage).toBe('The third photo: Image could not be processed. Please try a different image.');
    });

    it('checks every photo before drawing any: a later one too small is said before an earlier one that will not decode', async () => {
      const good = await solid(RED, 600, 400);
      const broken = Buffer.concat([good.subarray(0, 700), Buffer.alloc(good.length - 700, 0x5a)]);
      serve({ [URLS[0]]: broken, [URLS[1]]: await solid(GREEN), [URLS[2]]: await solid(BLUE), [URLS[3]]: await solid(YELLOW, 50, 50) });
      const error = await rejection(downloadAndProcessCollageWithPreview(inputs(4), '6x9'));
      expect(error.userMessage).toMatch(/^The fourth photo: Image is too small for print quality\./);
    });

    it('says the lowest place that would not download when several do not', async () => {
      serve({ [URLS[0]]: await solid(RED), [URLS[1]]: 'offline', [URLS[2]]: await solid(GREEN), [URLS[3]]: 'offline' });
      const error = await rejection(downloadAndProcessCollageWithPreview(inputs(4), '6x9'));
      expect(error.userMessage).toMatch(/^The second photo: Couldn't download/);
    });

    it('says the lowest place whose picture cannot be used when several cannot', async () => {
      const gif = await sharp({ create: { width: 320, height: 240, channels: 3, background: '#ff0000' } }).gif().toBuffer();
      serve({ [URLS[0]]: await solid(RED), [URLS[1]]: gif, [URLS[2]]: await solid(GREEN), [URLS[3]]: await solid(BLUE, 50, 50) });
      const error = await rejection(downloadAndProcessCollageWithPreview(inputs(4), '6x9'));
      expect(error.userMessage).toMatch(/^The second photo: Unsupported image format/);
    });

    it('checks downloads before pictures: a photo that would not download is said before an earlier one that cannot be used', async () => {
      const gif = await sharp({ create: { width: 320, height: 240, channels: 3, background: '#ff0000' } }).gif().toBuffer();
      serve({ [URLS[0]]: gif, [URLS[1]]: await solid(GREEN), [URLS[2]]: 'offline' });
      const error = await rejection(downloadAndProcessCollageWithPreview(inputs(3), '6x9'));
      expect(error.userMessage).toMatch(/^The third photo: Couldn't download/);
    });

    it('does not name a photo for a busy service', () => {
      const busy = new ImageProcessingError('SERVICE_BUSY', 'The image service is busy right now. Please try again in a moment.');
      expect(_testing.namedPhoto(busy, 2)).toBe(busy);
      const other = new Error('boom');
      expect(_testing.namedPhoto(other, 0)).toBe(other);
      const named = _testing.namedPhoto(new ImageProcessingError('IMAGE_TOO_LARGE', 'Too big.'), 3) as ImageProcessingError;
      expect([named.code, named.userMessage]).toEqual(['IMAGE_TOO_LARGE', 'The fourth photo: Too big.']);
    });
  });

  describe('under the gates (#616 review)', () => {
    const idle = { active: 0, queued: 0, keys: 0 };
    const expectIdle = (): void => {
      expect(_testing.collageGate.snapshot()).toMatchObject(idle);
      expect(_testing.downloadGate.snapshot()).toMatchObject(idle);
      expect(_testing.decodeGate.snapshot()).toMatchObject(idle);
    };

    const gatesIdle = (): boolean =>
      [_testing.collageGate, _testing.downloadGate, _testing.decodeGate].every((gate) => {
        const { active, queued } = gate.snapshot();
        return active === 0 && queued === 0;
      });

    afterEach(async () => {
      // A test that fails with downloads held would leave the module's gates held for the rest of the file.
      const until = Date.now() + 5_000;
      while (Date.now() < until && !gatesIdle()) {
        lastHold?.release();
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      lastHold = undefined;
    });

    it('bounds collages to two at a time and one per account, with four to wait', () => {
      expect(_testing.GATE_CONFIG.collage).toEqual({ limit: 2, maxQueue: 4, queueTimeoutMs: 15_000, perKeyLimit: 1 });
      expect(_testing.COLLAGE_DOWNLOAD_BUDGET_MS).toBe(30_000);
      expect(_testing.collageGate.snapshot()).toMatchObject({ limit: 2, maxQueue: 4, perKeyLimit: 1 });
    });

    it.each([3, 4])('takes %i remote photos for a named account, which holds one share of each gate at a time', async (count) => {
      serve(await palette(count));
      await expect(downloadAndProcessCollageWithPreview(inputs(count), '6x9', { actorId: 'account-a' })).resolves.toMatchObject({
        processedWidth: 2700,
      });
      expect(fetchMock).toHaveBeenCalledTimes(count);
      expectIdle();
    });

    it('passes the account to each gate, the downloads one photo at a time', async () => {
      const collageRun = vi.spyOn(_testing.collageGate, 'run');
      const downloadRun = vi.spyOn(_testing.downloadGate, 'run');
      const decodeRun = vi.spyOn(_testing.decodeGate, 'run');
      serve(await palette(3));
      await downloadAndProcessCollageWithPreview(inputs(3), '6x9', { actorId: 'account-a' });
      expect(collageRun).toHaveBeenCalledTimes(1);
      expect(collageRun).toHaveBeenCalledWith(expect.any(Function), 'account-a');
      expect(downloadRun).toHaveBeenCalledTimes(3);
      for (const call of downloadRun.mock.calls) expect(call[1]).toBe('account-a');
      expect(decodeRun).toHaveBeenCalledTimes(1);
      expect(decodeRun).toHaveBeenCalledWith(expect.any(Function), 'account-a');
    });

    it('downloads the photos one at a time, in the order given', async () => {
      const files = await palette(4);
      let inFlight = 0;
      let most = 0;
      const order: string[] = [];
      fetchMock.mockImplementation(async (url: string) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        order.push(url);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return responseFor(files, url);
      });
      await downloadAndProcessCollageWithPreview(inputs(4), '6x9');
      expect(order).toEqual(URLS.slice(0, 4));
      expect(most).toBe(1);
    });

    it('stops at the first photo that will not download, and fetches none after it', async () => {
      serve({ ...(await palette(4)), [URLS[1]]: 'offline' });
      const error = await rejection(downloadAndProcessCollageWithPreview(inputs(4), '6x9', { actorId: 'account-a' }));
      expect(error.userMessage).toBe("The second photo: Couldn't download the image. Please try again.");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expectIdle();
    });

    it('gives the photos one budget for their downloads, not a deadline each', async () => {
      vi.useFakeTimers();
      try {
        const files = await palette(3);
        // The first photo answers after 19 s, inside its own 20 s; the second never does, and has the 11 s of the
        // 30 s that are left, not its own 20 s.
        fetchMock.mockImplementation(
          (url: string, init: RequestInit) =>
            new Promise<Response>((resolve, reject) => {
              (init.signal as AbortSignal).addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
              if (url === URLS[0]) setTimeout(() => resolve(responseFor(files, url)), 19_000);
            })
        );
        let outcome: unknown = 'pending';
        const call = downloadAndProcessCollageWithPreview(inputs(3), '6x9', { actorId: 'account-a' }).then(
          () => { outcome = 'resolved'; },
          (error: unknown) => { outcome = error; }
        );
        await vi.advanceTimersByTimeAsync(19_000);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(outcome).toBe('pending');
        await vi.advanceTimersByTimeAsync(11_000);
        expect(outcome).toBeInstanceOf(ImageProcessingError);
        expect((outcome as ImageProcessingError).userMessage).toBe("The second photo: Couldn't download the image. Please try again.");
        // Nothing is fetched after it.
        expect(fetchMock).toHaveBeenCalledTimes(2);
        await vi.runAllTimersAsync();
        await call;
      } finally {
        vi.useRealTimers();
      }
      expectIdle();
    });

    it('keeps a photo\'s own 20 s deadline when the budget has more left', async () => {
      vi.useFakeTimers();
      try {
        fetchMock.mockImplementation(
          (_url: string, init: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              (init.signal as AbortSignal).addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
            })
        );
        let outcome: unknown = 'pending';
        const call = downloadAndProcessCollageWithPreview(inputs(2), '6x9', { actorId: 'account-a' }).then(
          () => { outcome = 'resolved'; },
          (error: unknown) => { outcome = error; }
        );
        await vi.advanceTimersByTimeAsync(19_999);
        expect(outcome).toBe('pending');
        await vi.advanceTimersByTimeAsync(1);
        expect(outcome).toBeInstanceOf(ImageProcessingError);
        expect((outcome as ImageProcessingError).userMessage).toBe("The first photo: Couldn't download the image. Please try again.");
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await vi.runAllTimersAsync();
        await call;
      } finally {
        vi.useRealTimers();
      }
      expectIdle();
    });

    it('does not start a transfer once the budget is spent, and starts one with what is left', async () => {
      // A transfer can find the budget spent after it waited for a download slot. The clock is held still, so
      // "0 s left" is exactly 0.
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        serve({ [URLS[0]]: await solid(RED) });
        for (const left of [0, -1, -60_000]) {
          fetchMock.mockClear();
          const error = await rejection(_testing.downloadImage(URLS[0], { deadlineAt: Date.now() + left }));
          expect([error.code, error.userMessage], String(left)).toEqual(['DOWNLOAD_FAILED', "Couldn't download the image. Please try again."]);
          expect(fetchMock, String(left)).not.toHaveBeenCalled();
        }
        expectIdle();
        fetchMock.mockClear();
        await expect(_testing.downloadImage(URLS[0], { deadlineAt: Date.now() + 10_000 })).resolves.toBeInstanceOf(Buffer);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expectIdle();
      } finally {
        vi.useRealTimers();
      }
    });

    it('refuses a second collage from an account that has one under way, fetching nothing for it', async () => {
      const held = hold(await palette(2));
      const first = downloadAndProcessCollageWithPreview(inputs(2), '6x9', { actorId: 'account-a' });
      await flush();
      expect(held.asked()).toBe(1);
      expect(_testing.collageGate.snapshot()).toMatchObject({ active: 1, queued: 0, keys: 1 });

      const second = await rejection(downloadAndProcessCollageWithPreview(inputs(2), '6x9', { actorId: 'account-a' }));
      expect([second.code, second.userMessage]).toEqual([
        'SERVICE_BUSY',
        'You have other images still processing. Please wait for them to finish and try again.',
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Another account's collage runs beside it.
      const other = downloadAndProcessCollageWithPreview(inputs(2), '6x9', { actorId: 'account-b' });
      await flush();
      expect(_testing.collageGate.snapshot()).toMatchObject({ active: 2, keys: 2 });

      const settled = await finish(held, first, other);
      expect(settled.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
      expectIdle();
    });

    it('holds a third collage until one is done, with nothing fetched for it, and refuses a seventh', async () => {
      const held = hold(await palette(2));
      const calls = Array.from({ length: 6 }, (_, i) => downloadAndProcessCollageWithPreview(inputs(2), '6x9', { actorId: `account-${i}` }));
      await flush();
      // Two run, each at its first photo; four wait, and have fetched nothing.
      expect(_testing.collageGate.snapshot()).toMatchObject({ active: 2, queued: 4 });
      expect(held.asked()).toBe(2);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const seventh = await rejection(downloadAndProcessCollageWithPreview(inputs(2), '6x9', { actorId: 'account-6' }));
      expect([seventh.code, seventh.userMessage]).toEqual(['SERVICE_BUSY', 'The image service is busy right now. Please try again in a moment.']);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const settled = await finish(held, ...calls);
      expect(settled.map((outcome) => outcome.status)).toEqual(Array(6).fill('fulfilled'));
      expectIdle();
    });

    it('says a busy service, naming no photo, when a gate refuses', async () => {
      serve(await palette(2));
      vi.spyOn(_testing.collageGate, 'run').mockRejectedValueOnce(new ConcurrencyGateError('image-collage', 'queue_timeout'));
      const waited = await rejection(downloadAndProcessCollageWithPreview(inputs(2), '6x9'));
      expect([waited.code, waited.userMessage]).toEqual(['SERVICE_BUSY', 'The image service is busy right now. Please try again in a moment.']);
      expect(fetchMock).not.toHaveBeenCalled();

      // The decode gate, after the downloads: still no photo's fault.
      vi.spyOn(_testing.decodeGate, 'run').mockRejectedValueOnce(new ConcurrencyGateError('image-decode', 'queue_full'));
      const full = await rejection(downloadAndProcessCollageWithPreview(inputs(2), '6x9'));
      expect([full.code, full.userMessage]).toEqual(['SERVICE_BUSY', 'The image service is busy right now. Please try again in a moment.']);
      expectIdle();
    });
  });
});
