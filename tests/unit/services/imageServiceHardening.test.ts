import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { crc32, deflateSync } from 'node:zlib';
import {
  _testing,
  downloadAndProcessImage,
  downloadAndProcessLetterImageWithPreview,
  downloadAndProcessPostcardImageWithPreview,
  ImageProcessingError,
} from '../../../src/services/imageService.js';
import { ConcurrencyGateError } from '../../../src/utils/concurrencyGate.js';

/**
 * Real bytes, no sharp mock. imageService.test.ts mocks sharp and fetch's
 * body, which is how an unbounded decode, a header-only format check and a
 * body read with no deadline all survived. Everything here hands sharp the
 * bytes a customer's server could send.
 */

// A public, non-reserved address literal: validateRemoteImageUrl skips DNS for
// IP hosts, so no lookup happens and nothing is fetched (fetch is stubbed).
const REMOTE = 'https://93.184.216.34/photo.png';

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
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: RGB
  const idat = deflateSync(Buffer.alloc(1 + 3 * 4));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function solid(format: 'png' | 'jpeg' | 'webp' | 'gif', width: number, height: number): Promise<Buffer> {
  const base = sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } } });
  if (format === 'png') return base.png().toBuffer();
  if (format === 'jpeg') return base.jpeg().toBuffer();
  if (format === 'webp') return base.webp().toBuffer();
  return base.gif().toBuffer();
}

const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="blue"/></svg>'
);

function bodyOf(bytes: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

function responseWith(
  body: ReadableStream<Uint8Array> | null,
  headers: Record<string, string>,
  status = 200
): Response {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    body,
  } as unknown as Response;
}

async function dimensionsOf(dataUri: string): Promise<{ width?: number; height?: number; format?: string }> {
  const meta = await sharp(Buffer.from(dataUri.split(',')[1], 'base64')).metadata();
  return { width: meta.width, height: meta.height, format: meta.format };
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

describe('image pipeline hardening', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fetchMock.mockReset();
  });

  describe('pixel ceiling', () => {
    it('refuses a file whose header declares more than the ceiling before decoding it', async () => {
      // 64 megapixels: under sharp's own default, over this service's ceiling.
      const bomb = pngHeaderBomb(8000, 8000);
      expect(bomb.length).toBeLessThan(200);
      fetchMock.mockResolvedValueOnce(responseWith(bodyOf(bomb), { 'content-type': 'image/png' }));

      const error = await rejection(downloadAndProcessImage({ url: REMOTE }));
      expect(error.code).toBe('IMAGE_TOO_LARGE');
      expect(error.userMessage).toBe('Image is too large. Please use an image under 50 megapixels.');
    });

    it('opens every image under the ceiling, including the metadata read', async () => {
      const bomb = pngHeaderBomb(8000, 8000);
      // The raw opener with no service-level check: sharp itself refuses the header.
      await expect(_testing.openImage(bomb).metadata()).rejects.toThrow(/exceeds pixel limit/);
      // Plain sharp would have read it (64 MP is under the library default).
      await expect(sharp(bomb).metadata()).resolves.toMatchObject({ width: 8000, height: 8000 });
      expect(_testing.MAX_INPUT_PIXELS).toBe(50_000_000);
    });

    it('validateDimensions keeps the ceiling as a readable contract', () => {
      expect(() => _testing.validateDimensions(7000, 7000)).not.toThrow();
      expect(() => _testing.validateDimensions(8000, 8000)).toThrow(ImageProcessingError);
      try {
        _testing.validateDimensions(8000, 8000);
      } catch (error) {
        expect((error as ImageProcessingError).code).toBe('IMAGE_TOO_LARGE');
      }
      expect(() => _testing.validateDimensions(50, 4000)).toThrow(/too small/);
    });
  });

  describe('format is checked from the bytes', () => {
    it('rejects an SVG served under a PNG content type', async () => {
      fetchMock.mockResolvedValueOnce(responseWith(bodyOf(SVG), { 'content-type': 'image/png' }));
      const error = await rejection(downloadAndProcessImage({ url: REMOTE }));
      expect(error.code).toBe('UNSUPPORTED_FORMAT');
      expect(error.userMessage).toBe('Unsupported image format. Please use PNG, JPEG, or WebP.');
    });

    it('rejects a GIF served with no content type at all', async () => {
      fetchMock.mockResolvedValueOnce(responseWith(bodyOf(await solid('gif', 320, 240)), {}));
      const error = await rejection(downloadAndProcessImage({ url: REMOTE }));
      expect(error.code).toBe('UNSUPPORTED_FORMAT');
    });

    for (const format of ['png', 'jpeg', 'webp'] as const) {
      it(`still accepts a real ${format}`, async () => {
        fetchMock.mockResolvedValueOnce(responseWith(bodyOf(await solid(format, 640, 480)), {}));
        const result = await downloadAndProcessImage({ url: REMOTE });
        expect(result).toMatchObject({ originalWidth: 640, originalHeight: 480, processedWidth: 2700, processedHeight: 1800 });
        await expect(dimensionsOf(result.base64DataUri)).resolves.toEqual({ width: 2700, height: 1800, format: 'jpeg' });
      });
    }

    it('lists exactly the three documented formats', () => {
      expect([..._testing.DECODABLE_FORMATS].sort()).toEqual(['jpeg', 'png', 'webp']);
    });
  });

  describe('one download deadline covers the body', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('aborts a download whose body stalls past the deadline', async () => {
      let signalSeen: AbortSignal | undefined;
      let cancelled = false;
      const stalled = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(1024));
          // and then nothing, ever
        },
        cancel() {
          cancelled = true;
        },
      });
      fetchMock.mockImplementationOnce(async (_url: string, init: RequestInit) => {
        signalSeen = init.signal ?? undefined;
        return responseWith(stalled, { 'content-type': 'image/jpeg' });
      });

      const pending = downloadAndProcessImage({ url: REMOTE });
      const settled = pending.then(() => 'resolved', (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(_testing.REMOTE_IMAGE_FETCH_CONFIG.deadlineMs);

      const outcome = await settled;
      expect(outcome).toBeInstanceOf(ImageProcessingError);
      expect((outcome as ImageProcessingError).code).toBe('DOWNLOAD_FAILED');
      expect(signalSeen?.aborted).toBe(true);
      expect(cancelled).toBe(true);
    });

  });

  it('caps a body-less response the same way as a streamed one', async () => {
    const oversized = {
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'image/jpeg' : null) },
      body: null,
      arrayBuffer: async () => new ArrayBuffer(_testing.CONFIG.maxFileSize + 1),
    } as unknown as Response;
    fetchMock.mockResolvedValueOnce(oversized);

    const error = await rejection(downloadAndProcessImage({ url: REMOTE }));
    expect(error.code).toBe('IMAGE_TOO_LARGE');
    expect(error.userMessage).toBe('Image is too large. Please use an image under 10MB.');
  });

  it('uses the same signal, and so the same deadline, for every redirect hop', async () => {
    const signals: Array<AbortSignal | undefined> = [];
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      signals.push(init.signal ?? undefined);
      if (signals.length === 1) {
        return responseWith(null, { location: 'https://93.184.216.34/moved.png' }, 302);
      }
      return responseWith(bodyOf(await solid('png', 300, 300)), { 'content-type': 'image/png' });
    });

    await expect(downloadAndProcessImage({ url: REMOTE })).resolves.toMatchObject({ originalWidth: 300 });
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBeDefined();
    expect(signals[1]).toBe(signals[0]);
  });

  describe('concurrency gates', () => {
    it('runs decoding through the decode gate and downloads through the download gate', async () => {
      const decodeRun = vi.spyOn(_testing.decodeGate, 'run');
      const downloadRun = vi.spyOn(_testing.downloadGate, 'run');
      fetchMock.mockResolvedValueOnce(responseWith(bodyOf(await solid('jpeg', 640, 480)), { 'content-type': 'image/jpeg' }));

      await downloadAndProcessPostcardImageWithPreview({ url: REMOTE });

      expect(decodeRun).toHaveBeenCalledTimes(1);
      expect(downloadRun).toHaveBeenCalledTimes(1);
    });

    it('reports SERVICE_BUSY when the decode gate refuses', async () => {
      vi.spyOn(_testing.decodeGate, 'run').mockRejectedValueOnce(new ConcurrencyGateError('image-decode', 'queue_full'));
      fetchMock.mockResolvedValueOnce(responseWith(bodyOf(await solid('jpeg', 640, 480)), { 'content-type': 'image/jpeg' }));

      const error = await rejection(downloadAndProcessImage({ url: REMOTE }));
      expect(error.code).toBe('SERVICE_BUSY');
      expect(error.userMessage).toBe('The image service is busy right now. Please try again in a moment.');
    });

    it('reports SERVICE_BUSY when the download gate times out', async () => {
      vi.spyOn(_testing.downloadGate, 'run').mockRejectedValueOnce(new ConcurrencyGateError('image-download', 'queue_timeout'));

      const error = await rejection(downloadAndProcessImage({ url: REMOTE }));
      expect(error.code).toBe('SERVICE_BUSY');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('bounds decodes to a handful and downloads to a few more', () => {
      expect(_testing.GATE_CONFIG.decode).toEqual({ limit: 3, maxQueue: 12, queueTimeoutMs: 15_000 });
      expect(_testing.GATE_CONFIG.download).toEqual({ limit: 8, maxQueue: 24, queueTimeoutMs: 15_000 });
      expect(_testing.decodeGate.snapshot()).toMatchObject({ limit: 3, maxQueue: 12 });
      expect(_testing.downloadGate.snapshot()).toMatchObject({ limit: 8, maxQueue: 24 });
    });
  });

  describe('the preview is derived from the processed image', () => {
    it('postcard: preview is the processed image scaled down', async () => {
      fetchMock.mockResolvedValueOnce(responseWith(bodyOf(await solid('png', 640, 480)), { 'content-type': 'image/png' }));
      const result = await downloadAndProcessPostcardImageWithPreview({ url: REMOTE });
      await expect(dimensionsOf(result.base64DataUri)).resolves.toMatchObject({ width: 2700, height: 1800 });
      await expect(dimensionsOf(result.previewDataUri)).resolves.toMatchObject({ width: 400, height: 267 });
    });

    it('letter: a small original is upscaled for print and the preview follows the print image', async () => {
      // Decoding the original a second time would keep the preview at 300 wide
      // (withoutEnlargement); deriving it from the 1950-wide processed image
      // gives the preview its full 400 width.
      fetchMock.mockResolvedValueOnce(responseWith(bodyOf(await solid('png', 300, 100)), { 'content-type': 'image/png' }));
      const result = await downloadAndProcessLetterImageWithPreview({ url: REMOTE }, 'inline');
      expect(result.processedWidth).toBe(1950);
      expect(result.processedHeight).toBe(650);
      await expect(dimensionsOf(result.previewDataUri)).resolves.toMatchObject({ width: 400, height: 133 });
    });
  });
});
