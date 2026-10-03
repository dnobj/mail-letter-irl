import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { crc32, deflateSync } from 'node:zlib';
import {
  _testing,
  downloadAndProcessCollageWithPreview,
  ImageProcessingError,
} from '../../../src/services/imageService.js';

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
function pngHeaderBomb(width: number, height: number): Buffer {
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

function serve(files: Files): void {
  fetchMock.mockImplementation(async (url: string) => {
    const file = files[url];
    if (file === undefined || file === 'offline') throw new TypeError('fetch failed');
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: bodyOf(file),
    } as unknown as Response;
  });
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
      // The large cell runs the whole height: nothing white where the column's gutter would be.
      await expectCell(picture, 900, 900, RED, 'the large cell across the column\'s gutter');
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
    const rejection = async (promise: Promise<unknown>): Promise<ImageProcessingError> => {
      try {
        await promise;
      } catch (error) {
        if (error instanceof ImageProcessingError) return error;
        throw new Error(`expected an ImageProcessingError, got ${String(error)}`);
      }
      throw new Error('expected a rejection');
    };

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

    it('names a photo over the pixel ceiling before decoding any', async () => {
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
});
