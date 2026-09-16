/**
 * Image Service for Letter IRL
 *
 * Handles image processing for postcards and letters:
 * - Download from OpenAI URLs
 * - Validate size, type, and dimensions
 * - Resize for print (postcard: 1800x2700 for 6x9 at 300 DPI)
 * - Letter header: 1950x600 (6.5" x 2" at 300 DPI)
 * - Letter inline: 1950x900 (6.5" x 3" at 300 DPI)
 * - Convert to base64 data URI
 *
 * Every byte this service opens is customer-controlled, and decoding is where
 * bytes become large allocations. So every image is opened under a pixel
 * ceiling that sharp enforces when it reads the header, the format is checked
 * from the bytes rather than the Content-Type header, each image is decoded
 * once, decodes and downloads run through small concurrency gates, and a
 * download has one deadline that covers the body as well as the headers.
 *
 * User Stories:
 * - US-POSTCARD-01: Preview a Postcard
 * - US-POSTCARD-03: Postcard Image Processing
 * - US-LAYOUT-01: Preview Letter with Header Image
 * - US-LAYOUT-02: Preview Letter with Inline Image
 * - US-LAYOUT-04: Letter Layout Image Processing
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import sharp, { type Metadata, type Sharp } from 'sharp';
import type { ImageFileParam, ProcessedImage, PostcardSize, LetterImageType } from './types.js';
import { getImage as getTempImage } from './tempImageStore.js';
import { ConcurrencyGateError, createConcurrencyGate, type ConcurrencyGate } from '../utils/concurrencyGate.js';

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  maxFileSize: 10 * 1024 * 1024, // 10 MB for postcards
  minWidth: 100,   // Lowered - Sharp will upscale to print size
  minHeight: 100,  // Lowered - Sharp will upscale to print size
  jpegQuality: 85,
  allowedTypes: ['image/png', 'image/jpeg', 'image/webp'] as const,
  // PostGrid uses landscape orientation (width x height)
  // Our internal names (6x4, 6x9, 6x11) refer to the PostGrid size names
  // PostGrid 6x4 = 6" wide x 4" tall (landscape)
  // PostGrid 9x6 = 9" wide x 6" tall (landscape) - we call it '6x9' internally
  // PostGrid 11x6 = 11" wide x 6" tall (landscape) - we call it '6x11' internally
  sizes: {
    '6x4': { width: 1800, height: 1200 },   // 6x4 at 300 DPI (6" x 4")
    '6x9': { width: 2700, height: 1800 },   // 9x6 at 300 DPI (9" x 6") - landscape
    '6x11': { width: 3300, height: 1800 },  // 11x6 at 300 DPI (11" x 6") - landscape
  } as const,
} as const;

/**
 * Ceiling on the declared pixel count of any image this service opens. sharp
 * checks it when it reads the header, so an image over the ceiling is refused
 * before a single pixel is decoded. 50 megapixels is about 7000 x 7000: well
 * beyond the largest print target here (3300 x 1800) and above what current
 * phone cameras produce. sharp's own default is five times higher, at which a
 * 10 MB file can decode to about a gigabyte.
 */
const MAX_INPUT_PIXELS = 50_000_000;

const TOO_MANY_PIXELS_MESSAGE =
  `Image is too large. Please use an image under ${MAX_INPUT_PIXELS / 1_000_000} megapixels.`;

/**
 * The three formats this service decodes, recognised by their first bytes
 * before sharp is asked anything. The Content-Type header is only a hint a
 * server can omit or fake, and sharp's own header read is the loader's parse
 * (for SVG, a full XML parse), so the signature check is what keeps SVG, GIF,
 * TIFF and AVIF bytes away from the bundled loaders entirely.
 */
type DecodableFormat = 'jpeg' | 'png' | 'webp';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const UNSUPPORTED_FORMAT_MESSAGE = 'Unsupported image format. Please use PNG, JPEG, or WebP.';

/**
 * Images that libvips must hold whole rather than stream (interlaced PNG,
 * progressive JPEG) are bounded by their decoded size as well as by pixels.
 * Measured through this pipeline at one libvips thread (pinned below): a
 * 49 MP baseline JPEG or plain 8-bit PNG peaks near 60 MB resident and a
 * plain 16-bit RGBA PNG near 130 MB, all streamed; an interlaced or
 * progressive image at this budget peaks near 140 to 165 MB. Without the
 * budget, a 49 MP interlaced 16-bit PNG, a 4 MB file that passes every
 * other check, measured near 500 MB.
 */
const MAX_FULL_DECODE_BYTES = 100_000_000;

const BYTES_PER_SAMPLE: Record<string, number> = {
  char: 1, uchar: 1, short: 2, ushort: 2, int: 4, uint: 4, float: 4, complex: 8, double: 8, dpcomplex: 16,
};

/** Names the size that would fit, for this image's channels and depth. */
function tooLargeToDecodeMessage(bytesPerPixel: number): string {
  const megapixels = Math.floor(MAX_FULL_DECODE_BYTES / bytesPerPixel / 1_000_000);
  return `Image is too large to process. Please use an image under ${megapixels} megapixels, or save it without interlacing or progressive encoding.`;
}

const REMOTE_IMAGE_FETCH_CONFIG = {
  /** One deadline for the whole transfer: redirects, headers and body. */
  deadlineMs: 20_000,
  maxRedirects: 3
};

/**
 * Concurrency gates. A decode is bounded per image by the pixel ceiling and
 * the full-decode budget (near 165 MB resident at worst, at one libvips
 * thread) and a download buffer by the file-size caps, so the gates bound the
 * multiplier: without them one account's request allowance could hold dozens
 * of decodes in flight at once. Worst case with these numbers is three
 * decodes, fifteen held input buffers and eight download buffers of at most
 * 10 MB: about 725 MB. Waiting callers fail fast with SERVICE_BUSY once the
 * queue is full or the wait is up, and one account may hold at most two
 * callers in each gate, so a single account cannot fill a gate for everyone
 * else.
 */
const GATE_CONFIG = {
  decode: { limit: 3, maxQueue: 12, queueTimeoutMs: 15_000, perKeyLimit: 2 },
  download: { limit: 8, maxQueue: 24, queueTimeoutMs: 15_000, perKeyLimit: 2 },
} as const;

const decodeGate = createConcurrencyGate({ name: 'image-decode', ...GATE_CONFIG.decode });
const downloadGate = createConcurrencyGate({ name: 'image-download', ...GATE_CONFIG.download });

const SERVICE_BUSY_MESSAGE = 'The image service is busy right now. Please try again in a moment.';
const ACCOUNT_BUSY_MESSAGE = 'You have other images still processing. Please wait for them to finish and try again.';
const DOWNLOAD_FAILED_MESSAGE = "Couldn't download the image. Please try again.";

// Letter image configuration (US-LAYOUT-04)
const LETTER_IMAGE_CONFIG = {
  maxFileSize: 5 * 1024 * 1024, // 5 MB for letter images
  jpegQuality: 85,
  allowedTypes: ['image/png', 'image/jpeg', 'image/webp'] as const,
  // Letter page is 8.5" x 11" with 1" margins on sides
  // Content area is 6.5" wide (1950px at 300 DPI)
  sizes: {
    header: { width: 1950, height: 600 },   // 6.5" x 2" at 300 DPI (header/letterhead)
    inline: { width: 1950, height: 900 },   // 6.5" x 3" at 300 DPI (inline after signature)
  } as const,
} as const;

// ============================================================================
// Error Classes
// ============================================================================

export class ImageProcessingError extends Error {
  constructor(
    public readonly code:
      | 'IMAGE_TOO_LARGE'
      | 'UNSUPPORTED_FORMAT'
      | 'IMAGE_TOO_SMALL'
      | 'DOWNLOAD_FAILED'
      | 'PROCESSING_FAILED'
      | 'SERVICE_BUSY',
    public readonly userMessage: string,
    originalError?: Error
  ) {
    super(userMessage);
    this.name = 'ImageProcessingError';
    if (originalError) {
      this.stack = `${this.stack}\nCaused by: ${originalError.stack}`;
    }
  }
}

// ============================================================================
// Opening images and running gated work
// ============================================================================

/**
 * One libvips thread for the whole process. Every memory figure this module
 * is sized by was measured at one thread. sharp defaults to one on the glibc
 * build the API runs, but switches to the core count under MALLOC_ARENA_MAX
 * or a musl or jemalloc base image, where the same decodes measured two to
 * three times larger. Pinning it makes the bound a property of this code
 * rather than of the container.
 */
sharp.concurrency(1);

/**
 * The one way this module (and generateImageForMail) opens image bytes: the
 * pixel ceiling travels with every call, including metadata reads, so no site
 * can forget it.
 */
export function openImage(input: Buffer): Sharp {
  return sharp(input, { limitInputPixels: MAX_INPUT_PIXELS });
}

/** Per-call options shared by every processing entry point. */
export interface ImageProcessingOptions {
  /**
   * The account the image is processed for. It names the caller's share of
   * each gate (perKeyLimit), so one account cannot fill a gate for everyone.
   */
  actorId?: string;
}

async function runGated<T>(gate: ConcurrencyGate, work: () => Promise<T>, key?: string): Promise<T> {
  try {
    return await gate.run(work, key);
  } catch (error) {
    if (error instanceof ConcurrencyGateError) {
      throw new ImageProcessingError(
        'SERVICE_BUSY',
        error.reason === 'key_limit' ? ACCOUNT_BUSY_MESSAGE : SERVICE_BUSY_MESSAGE,
        error
      );
    }
    throw error;
  }
}

/** Runs decode or resize work under the shared decode gate. */
export function runImageDecode<T>(work: () => Promise<T>, actorId?: string): Promise<T> {
  return runGated(decodeGate, work, actorId);
}

async function validateRemoteImageUrl(url: string): Promise<URL> {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new ImageProcessingError('DOWNLOAD_FAILED', DOWNLOAD_FAILED_MESSAGE);
  }

  if (parsed.protocol !== 'https:') {
    throw new ImageProcessingError('DOWNLOAD_FAILED', DOWNLOAD_FAILED_MESSAGE);
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isUnsafeIpAddress(host)) {
    throw new ImageProcessingError('DOWNLOAD_FAILED', DOWNLOAD_FAILED_MESSAGE);
  }

  if (!isIP(host)) {
    const addresses = await lookup(host, { all: true, verbatim: true });
    if (addresses.length === 0 || addresses.some(({ address }) => isUnsafeIpAddress(address))) {
      throw new ImageProcessingError('DOWNLOAD_FAILED', DOWNLOAD_FAILED_MESSAGE);
    }
  }

  return parsed;
}

function isUnsafeIpAddress(address: string): boolean {
  const ipv4Mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Mapped) {
    return isUnsafeIpv4Address(ipv4Mapped[1]);
  }

  const ipVersion = isIP(address);
  if (ipVersion === 4) {
    return isUnsafeIpv4Address(address);
  }
  if (ipVersion === 6) {
    return isUnsafeIpv6Address(address);
  }
  return false;
}

function isUnsafeIpv4Address(address: string): boolean {
  const parts = address.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function isUnsafeIpv6Address(address: string): boolean {
  const normalized = address.toLowerCase();
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('::ffff:') ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith('ff') ||
    normalized.startsWith('2001:db8')
  );
}

/**
 * Follows up to maxRedirects manual redirects, validating every hop. The
 * caller owns the abort signal and its deadline, so the same clock covers
 * every hop and the body read that follows.
 */
async function fetchRemoteImage(
  url: string,
  signal: AbortSignal,
  redirectsRemaining = REMOTE_IMAGE_FETCH_CONFIG.maxRedirects
): Promise<Response> {
  const parsed = await validateRemoteImageUrl(url);
  const response = await fetch(parsed.toString(), {
    redirect: 'manual',
    signal,
  });

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (!location || redirectsRemaining <= 0) {
      throw new ImageProcessingError('DOWNLOAD_FAILED', DOWNLOAD_FAILED_MESSAGE);
    }
    return fetchRemoteImage(new URL(location, parsed).toString(), signal, redirectsRemaining - 1);
  }

  return response;
}

type BodyReader = ReadableStreamDefaultReader<Uint8Array>;

/**
 * One chunk, or a DOWNLOAD_FAILED rejection the moment the signal aborts. The
 * abort is watched here rather than trusted to the body stream, so a deadline
 * ends a stalled read whatever the stream implementation does with it.
 */
function readOrAbort(reader: BodyReader, signal: AbortSignal): Promise<Awaited<ReturnType<BodyReader['read']>>> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new ImageProcessingError('DOWNLOAD_FAILED', DOWNLOAD_FAILED_MESSAGE));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function readResponseBufferWithLimit(
  response: Response,
  maxBytes: number,
  tooLargeMessage: string,
  signal: AbortSignal
): Promise<Buffer> {
  if (!response.body) {
    const whole = Buffer.from(await response.arrayBuffer());
    if (whole.length > maxBytes) {
      throw new ImageProcessingError('IMAGE_TOO_LARGE', tooLargeMessage);
    }
    return whole;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await readOrAbort(reader, signal);
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        throw new ImageProcessingError('IMAGE_TOO_LARGE', tooLargeMessage);
      }
      chunks.push(value);
    }
  } catch (error) {
    // Stop the producer whatever ended the read: the deadline, the size cap or
    // a broken stream. Nothing should keep pulling bytes for a failed request.
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released by the cancel above.
    }
  }

  return Buffer.concat(chunks);
}

interface DownloadPolicy {
  maxFileSize: number;
  allowedTypes: readonly string[];
  tooLargeMessage: string;
}

/**
 * Downloads a remote image under one deadline and one download slot. The
 * Content-Length and Content-Type headers are checked as early hints; the
 * byte cap is enforced on the body itself and the format on the bytes later.
 */
async function downloadRemoteImage(
  url: string,
  policy: DownloadPolicy,
  options: ImageProcessingOptions
): Promise<Buffer> {
  return runGated(downloadGate, async () => {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), REMOTE_IMAGE_FETCH_CONFIG.deadlineMs);

    try {
      const response = await fetchRemoteImage(url, controller.signal);

      if (!response.ok) {
        throw new ImageProcessingError('DOWNLOAD_FAILED', DOWNLOAD_FAILED_MESSAGE);
      }

      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > policy.maxFileSize) {
        throw new ImageProcessingError('IMAGE_TOO_LARGE', policy.tooLargeMessage);
      }

      const contentType = response.headers.get('content-type');
      if (contentType && !isAllowedContentType(contentType, policy.allowedTypes)) {
        throw new ImageProcessingError('UNSUPPORTED_FORMAT', UNSUPPORTED_FORMAT_MESSAGE);
      }

      // The cap holds even when Content-Length is missing, and the deadline
      // holds through the body read.
      return await readResponseBufferWithLimit(
        response,
        policy.maxFileSize,
        policy.tooLargeMessage,
        controller.signal
      );
    } catch (error) {
      if (error instanceof ImageProcessingError) {
        throw error;
      }
      throw new ImageProcessingError(
        'DOWNLOAD_FAILED',
        DOWNLOAD_FAILED_MESSAGE,
        error instanceof Error ? error : undefined
      );
    } finally {
      clearTimeout(deadline);
    }
  }, options.actorId);
}

// ============================================================================
// Main Processing Function
// ============================================================================

/**
 * Input type for image processing - accepts either OpenAI file param or direct URL
 */
export type ImageInput = ImageFileParam | { url: string };

/**
 * Download and process an image for postcard printing
 *
 * @param input - OpenAI file parameter with download_url, or object with url string
 * @param size - Target postcard size (default: '6x9')
 * @returns Processed image as base64 data URI with metadata
 * @throws ImageProcessingError with user-friendly message
 */
export async function downloadAndProcessImage(
  input: ImageInput,
  size: PostcardSize = '6x9',
  options: ImageProcessingOptions = {}
): Promise<ProcessedImage> {
  // Support both OpenAI fileParams ({download_url, file_id}) and plain URLs ({url})
  const download_url = 'download_url' in input ? input.download_url : input.url;
  const targetDimensions = CONFIG.sizes[size];

  // 1. Download image
  const buffer = await downloadImage(download_url, options);

  return runGated(decodeGate, async () => {
    // 2. Get metadata and validate dimensions
    const metadata = await getImageMetadata(buffer);
    validateDimensions(metadata.width, metadata.height);

    // 3. Resize and convert to JPEG
    const processed = await openImage(buffer)
      .resize(targetDimensions.width, targetDimensions.height, {
        fit: 'cover',
        position: 'center',
      })
      .jpeg({ quality: CONFIG.jpegQuality })
      .toBuffer();

    // 4. Convert to base64 data URI
    const base64 = processed.toString('base64');
    const dataUri = `data:image/jpeg;base64,${base64}`;

    return {
      base64DataUri: dataUri,
      originalWidth: metadata.width,
      originalHeight: metadata.height,
      processedWidth: targetDimensions.width,
      processedHeight: targetDimensions.height,
    };
  }, options.actorId);
}

// ============================================================================
// Preview Image Configuration (for ChatGPT widget)
// ============================================================================

// Preview images are smaller for fast widget loading in ChatGPT
// ChatGPT filters out large base64 data from tool outputs
const PREVIEW_CONFIG = {
  // Small enough to pass through ChatGPT's widget data filtering
  maxWidth: 400,
  maxHeight: 300,
  jpegQuality: 60,  // Lower quality for smaller size
} as const;

// ============================================================================
// Postcard Image Processing with Preview
// ============================================================================

/**
 * Result type for postcard image processing with preview
 */
export interface ProcessedPostcardImage extends ProcessedImage {
  /** Small preview image for ChatGPT widget display (~10-20KB) */
  previewDataUri: string;
}

/**
 * Download and process an image for postcard printing, generating both:
 * - Full quality image for PostGrid printing (2700x1800 at 300 DPI)
 * - Smaller preview image for ChatGPT widget display (~400x300)
 *
 * The preview is derived from the processed image, never from the original:
 * the original is decoded exactly once, and the preview is always smaller
 * than the processed image, so nothing is lost.
 *
 * @param input - OpenAI file parameter with download_url, or object with url string
 * @param size - Target postcard size (default: '6x9')
 * @returns Processed images (full + preview) with metadata
 * @throws ImageProcessingError with user-friendly message
 */
export async function downloadAndProcessPostcardImageWithPreview(
  input: ImageInput,
  size: PostcardSize = '6x9',
  options: ImageProcessingOptions = {}
): Promise<ProcessedPostcardImage> {
  const download_url = 'download_url' in input ? input.download_url : input.url;
  const targetDimensions = CONFIG.sizes[size];

  // 1. Download image
  const buffer = await downloadImage(download_url, options);

  return runGated(decodeGate, async () => {
    // 2. Get metadata and validate dimensions
    const metadata = await getImageMetadata(buffer);
    validateDimensions(metadata.width, metadata.height);

    // 3. Create full-quality image for PostGrid printing
    const processed = await openImage(buffer)
      .resize(targetDimensions.width, targetDimensions.height, {
        fit: 'cover',
        position: 'center',
      })
      .jpeg({ quality: CONFIG.jpegQuality })
      .toBuffer();

    // 4. Create small preview for ChatGPT widget from the processed image.
    // Maintain aspect ratio of postcard (landscape)
    const previewWidth = PREVIEW_CONFIG.maxWidth;
    const previewHeight = Math.round(previewWidth * (targetDimensions.height / targetDimensions.width));

    const preview = await openImage(processed)
      .resize(previewWidth, previewHeight, {
        fit: 'cover',
        position: 'center',
      })
      .jpeg({ quality: PREVIEW_CONFIG.jpegQuality })
      .toBuffer();

    // 5. Convert both to base64 data URIs
    const base64Full = processed.toString('base64');
    const base64Preview = preview.toString('base64');

    return {
      base64DataUri: `data:image/jpeg;base64,${base64Full}`,
      previewDataUri: `data:image/jpeg;base64,${base64Preview}`,
      originalWidth: metadata.width,
      originalHeight: metadata.height,
      processedWidth: targetDimensions.width,
      processedHeight: targetDimensions.height,
    };
  }, options.actorId);
}

// ============================================================================
// Letter Image Processing (US-LAYOUT-04)
// ============================================================================

/**
 * Download and process an image for letter layouts (header or inline)
 *
 * @param input - OpenAI file parameter with download_url, or object with url string
 * @param imageType - 'header' for top of letter, 'inline' for after signature
 * @returns Processed image as base64 data URI with metadata
 * @throws ImageProcessingError with user-friendly message
 */
export async function downloadAndProcessLetterImage(
  input: ImageInput,
  imageType: LetterImageType,
  options: ImageProcessingOptions = {}
): Promise<ProcessedImage> {
  const download_url = 'download_url' in input ? input.download_url : input.url;
  const targetDimensions = LETTER_IMAGE_CONFIG.sizes[imageType];

  // 1. Download image (with letter-specific size limit)
  const buffer = await downloadLetterImage(download_url, imageType, options);

  return runGated(decodeGate, async () => {
    // 2. Get metadata and validate
    const metadata = await getImageMetadata(buffer);
    validateDimensions(metadata.width, metadata.height);

    // 3. Resize to fit within dimensions while maintaining aspect ratio
    // Use 'inside' fit to ensure image doesn't exceed max dimensions
    const processed = await openImage(buffer)
      .resize(targetDimensions.width, targetDimensions.height, {
        fit: 'inside',       // Fit within bounds, don't crop
        withoutEnlargement: false, // Allow upscaling if needed
      })
      .jpeg({ quality: LETTER_IMAGE_CONFIG.jpegQuality })
      .toBuffer();

    // Get actual processed dimensions
    const processedMetadata = await openImage(processed).metadata();

    // 4. Convert to base64 data URI
    const base64 = processed.toString('base64');
    const dataUri = `data:image/jpeg;base64,${base64}`;

    return {
      base64DataUri: dataUri,
      originalWidth: metadata.width,
      originalHeight: metadata.height,
      processedWidth: processedMetadata.width || targetDimensions.width,
      processedHeight: processedMetadata.height || targetDimensions.height,
    };
  }, options.actorId);
}

/**
 * Result type for letter image processing with preview
 */
export interface ProcessedImageWithPreview extends ProcessedImage {
  /** Small preview image for ChatGPT widget display (~20-50KB) */
  previewDataUri: string;
}

/**
 * Download and process an image for letter layouts, generating both:
 * - Full quality image for PostGrid printing
 * - Smaller preview image for ChatGPT widget display
 *
 * As for postcards, the preview is derived from the processed image, so the
 * original is decoded once. A small original is upscaled for print and the
 * preview follows that upscaled image, bounded by the preview size.
 *
 * @param input - OpenAI file parameter with download_url, or object with url string
 * @param imageType - 'header' for top of letter, 'inline' for after signature
 * @returns Processed images (full + preview) with metadata
 * @throws ImageProcessingError with user-friendly message
 */
export async function downloadAndProcessLetterImageWithPreview(
  input: ImageInput,
  imageType: LetterImageType,
  options: ImageProcessingOptions = {}
): Promise<ProcessedImageWithPreview> {
  const download_url = 'download_url' in input ? input.download_url : input.url;
  const targetDimensions = LETTER_IMAGE_CONFIG.sizes[imageType];

  // 1. Download image (with letter-specific size limit)
  const buffer = await downloadLetterImage(download_url, imageType, options);

  return runGated(decodeGate, async () => {
    // 2. Get metadata and validate
    const metadata = await getImageMetadata(buffer);
    validateDimensions(metadata.width, metadata.height);

    // 3. Create full-quality image for PostGrid
    const processed = await openImage(buffer)
      .resize(targetDimensions.width, targetDimensions.height, {
        fit: 'inside',
        withoutEnlargement: false,
      })
      .jpeg({ quality: LETTER_IMAGE_CONFIG.jpegQuality })
      .toBuffer();

    const processedMetadata = await openImage(processed).metadata();

    // 4. Create small preview for ChatGPT widget from the processed image
    const preview = await openImage(processed)
      .resize(PREVIEW_CONFIG.maxWidth, PREVIEW_CONFIG.maxHeight, {
        fit: 'inside',
        withoutEnlargement: true,  // The processed image is already print size
      })
      .jpeg({ quality: PREVIEW_CONFIG.jpegQuality })
      .toBuffer();

    // 5. Convert both to base64 data URIs
    const base64Full = processed.toString('base64');
    const base64Preview = preview.toString('base64');

    return {
      base64DataUri: `data:image/jpeg;base64,${base64Full}`,
      previewDataUri: `data:image/jpeg;base64,${base64Preview}`,
      originalWidth: metadata.width,
      originalHeight: metadata.height,
      processedWidth: processedMetadata.width || targetDimensions.width,
      processedHeight: processedMetadata.height || targetDimensions.height,
    };
  }, options.actorId);
}

/**
 * Download image for letter layouts with appropriate size validation
 */
async function downloadLetterImage(
  url: string,
  imageType: LetterImageType,
  options: ImageProcessingOptions
): Promise<Buffer> {
  const localBuffer = await tryGetFromTempStore(url);
  if (localBuffer) return localBuffer;

  const label = imageType === 'header' ? 'Header' : 'Inline';
  return downloadRemoteImage(url, {
    maxFileSize: LETTER_IMAGE_CONFIG.maxFileSize,
    allowedTypes: LETTER_IMAGE_CONFIG.allowedTypes,
    tooLargeMessage: `${label} image is too large. Please use an image under 5MB.`,
  }, options);
}

/**
 * Check if content type is allowed for letter images
 */
function isAllowedLetterType(contentType: string): boolean {
  return isAllowedContentType(contentType, LETTER_IMAGE_CONFIG.allowedTypes);
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Resolve a Letter IRL temp image URL directly from the configured store.
 * This avoids an HTTP round-trip through the public API.
 */
async function tryGetFromTempStore(url: string): Promise<Buffer | null> {
  const match = url.match(/\/api\/temp-image\/([a-f0-9]{32})$/);
  if (!match) return null;
  const base64Data = await getTempImage(match[1]);
  if (!base64Data) return null;
  return Buffer.from(base64Data, 'base64');
}

/**
 * Download image from URL with validation
 */
async function downloadImage(url: string, options: ImageProcessingOptions): Promise<Buffer> {
  const localBuffer = await tryGetFromTempStore(url);
  if (localBuffer) return localBuffer;

  return downloadRemoteImage(url, {
    maxFileSize: CONFIG.maxFileSize,
    allowedTypes: CONFIG.allowedTypes,
    tooLargeMessage: 'Image is too large. Please use an image under 10MB.',
  }, options);
}

/**
 * The format from the first bytes. libvips picks its loader by these same
 * signatures, so only bytes that would reach the PNG, JPEG or WebP loader
 * are ever handed to sharp; everything else is refused without a parse.
 */
function sniffFormat(buffer: Buffer): DecodableFormat | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (
    buffer.length >= 12 &&
    buffer.toString('latin1', 0, 4) === 'RIFF' &&
    buffer.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

function isPixelLimitError(error: unknown): boolean {
  return error instanceof Error && /exceeds pixel limit/i.test(error.message);
}

/**
 * Get image metadata using Sharp, behind three byte-level checks that decode
 * no pixel: the first bytes must carry a PNG, JPEG or WebP signature before
 * sharp is asked anything; the declared size must be under the pixel ceiling
 * (sharp refuses the header read itself when it is not); and an interlaced or
 * progressive image, which libvips must hold whole, must fit the full-decode
 * budget.
 */
async function getImageMetadata(buffer: Buffer): Promise<{ width: number; height: number; format: string }> {
  const format = sniffFormat(buffer);
  if (!format) {
    throw new ImageProcessingError('UNSUPPORTED_FORMAT', UNSUPPORTED_FORMAT_MESSAGE);
  }

  let metadata: Metadata;
  try {
    metadata = await openImage(buffer).metadata();
  } catch (error) {
    if (isPixelLimitError(error)) {
      throw new ImageProcessingError('IMAGE_TOO_LARGE', TOO_MANY_PIXELS_MESSAGE, error as Error);
    }
    throw new ImageProcessingError(
      'PROCESSING_FAILED',
      'Image could not be processed. Please try a different image.',
      error instanceof Error ? error : undefined
    );
  }

  if (!metadata.width || !metadata.height) {
    throw new ImageProcessingError(
      'PROCESSING_FAILED',
      'Image could not be processed. Please try a different image.'
    );
  }

  if (metadata.isProgressive) {
    const bytesPerPixel = (metadata.channels ?? 4) * (BYTES_PER_SAMPLE[metadata.depth ?? ''] ?? 2);
    if (metadata.width * metadata.height * bytesPerPixel > MAX_FULL_DECODE_BYTES) {
      throw new ImageProcessingError('IMAGE_TOO_LARGE', tooLargeToDecodeMessage(bytesPerPixel));
    }
  }

  return {
    width: metadata.width,
    height: metadata.height,
    format,
  };
}

/**
 * Validate image dimensions: at least the print minimum, and under the pixel
 * ceiling. sharp enforces the ceiling when the header is read, so the second
 * check is reached only if that ever changes; it keeps the contract readable
 * in one place.
 */
function validateDimensions(width: number, height: number): void {
  if (width < CONFIG.minWidth || height < CONFIG.minHeight) {
    throw new ImageProcessingError(
      'IMAGE_TOO_SMALL',
      `Image is too small for print quality. Please use at least ${CONFIG.minWidth}x${CONFIG.minHeight} pixels.`
    );
  }
  if (width * height > MAX_INPUT_PIXELS) {
    throw new ImageProcessingError('IMAGE_TOO_LARGE', TOO_MANY_PIXELS_MESSAGE);
  }
}

function isAllowedContentType(contentType: string, allowedTypes: readonly string[]): boolean {
  // Handle content types like "image/jpeg; charset=utf-8"
  const type = contentType.split(';')[0].trim().toLowerCase();
  return allowedTypes.includes(type);
}

/**
 * Check if content type is allowed
 */
function isAllowedType(contentType: string): boolean {
  return isAllowedContentType(contentType, CONFIG.allowedTypes);
}

// ============================================================================
// Exports for Testing
// ============================================================================

export const _testing = {
  CONFIG,
  LETTER_IMAGE_CONFIG,
  MAX_INPUT_PIXELS,
  MAX_FULL_DECODE_BYTES,
  GATE_CONFIG,
  REMOTE_IMAGE_FETCH_CONFIG,
  decodeGate,
  downloadGate,
  openImage,
  sniffFormat,
  downloadImage,
  downloadLetterImage,
  getImageMetadata,
  validateDimensions,
  isAllowedType,
  isAllowedLetterType,
  validateRemoteImageUrl,
  isUnsafeIpAddress,
  readResponseBufferWithLimit,
};
