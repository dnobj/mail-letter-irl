/**
 * A signature's picture, cleaned for print (#608, concept 3).
 *
 * A person photographs their signature: ink on paper, often grey, with a
 * shadow across it, sometimes turned by the phone. What prints must be dark
 * ink on white, cropped to the ink, so the letter shows a signature and not a
 * photograph of paper. The steps:
 *
 * 1. Turn the picture upright by its EXIF orientation, put any transparency
 *    on white, and make it grey, no larger than 2000 px on its longest edge.
 * 2. Estimate the paper's light at every point: dilate the picture (each
 *    pixel takes the lightest near it), which lifts the thin strokes of ink
 *    into the paper around them, then blur what is left.
 * 3. Divide each pixel by its paper. Paper comes out near 1 wherever the light
 *    fell; ink well under it. Map 0.40 and below to black and 0.75 and above
 *    to white, so a shadow or a grey sheet goes white and the ink stays dark.
 * 4. Crop to the ink, with a small margin, and fit it inside 1200 x 400 px as
 *    a grayscale PNG.
 *
 * A picture with almost no ink after this is refused (blank paper, or light
 * ink on dark), and so is one whose ink fills more than a third of its box (a
 * photograph, not a signature). Pixels made here are opened with plain sharp:
 * they are ours and already bounded; the picture itself is opened by
 * openImage, with the pixel ceiling, under the decode gate.
 */

import sharp, { type OutputInfo } from 'sharp';
import { ImageProcessingError, openImage, readImageHeader, runImageDecode } from './imageService.js';

/** The largest signature kept: wide and short, as signatures are. */
export const SIGNATURE_MAX_SIZE = { width: 1200, height: 400 } as const;

const SIGNATURE_CLEANING = {
  /** The longest edge looked at: enough for a signature, and bounded work. */
  analysisEdge: 2000,
  /** A pixel at this share of its paper's light, or less, is black... */
  blackAt: 0.4,
  /** ...and at this share or more, white. */
  whiteAt: 0.75,
  /** Darker than this, after cleaning, is ink. */
  inkBelow: 160,
  /** Less ink than this share of the picture is no signature. */
  minInkShare: 0.002,
  /** More ink than this share of its own box is a photograph. */
  maxInkShare: 0.35,
  /** A picture smaller than this cannot hold a signature that prints well. */
  minSource: { longEdge: 150, shortEdge: 50 },
  /** Ink narrower than this prints as a smudge. */
  minInkWidth: 60,
} as const;

export type SignatureImageRefusal = 'NO_SIGNATURE_FOUND' | 'NOT_A_SIGNATURE' | 'SIGNATURE_TOO_SMALL';

/** A picture that is not a signature this can clean, in words the person can act on. */
export class SignatureImageError extends Error {
  constructor(readonly code: SignatureImageRefusal, message: string) {
    super(message);
    this.name = 'SignatureImageError';
  }
}

const NO_SIGNATURE_FOUND_MESSAGE =
  "We couldn't find a signature in that picture. Sign in dark ink on white or light paper, and photograph it flat, close up, in good light.";
const NOT_A_SIGNATURE_MESSAGE =
  'That looks like a photograph rather than a signature. Sign in dark ink on plain white paper, and photograph just the signature.';
const SIGNATURE_TOO_SMALL_MESSAGE =
  'That signature is too small to print well. Photograph it closer, so it fills most of the picture.';

export interface CleanedSignature {
  /** A grayscale PNG: dark ink on white, cropped to the ink. */
  png: Buffer;
  width: number;
  height: number;
}

/**
 * Cleans a picture of a signature for print, under the decode gate. Throws
 * SignatureImageError for a picture that holds no signature it can use, and
 * ImageProcessingError for one it cannot open.
 */
export function cleanSignatureImage(input: Buffer, actorId?: string): Promise<CleanedSignature> {
  return runImageDecode(() => cleanSignature(input), actorId);
}

async function cleanSignature(input: Buffer): Promise<CleanedSignature> {
  const header = await readImageHeader(input);
  const { longEdge, shortEdge } = SIGNATURE_CLEANING.minSource;
  if (Math.max(header.width, header.height) < longEdge || Math.min(header.width, header.height) < shortEdge) {
    throw new SignatureImageError('SIGNATURE_TOO_SMALL', SIGNATURE_TOO_SMALL_MESSAGE);
  }

  const edge = SIGNATURE_CLEANING.analysisEdge;
  let grey: { data: Buffer; info: OutputInfo };
  try {
    grey = await openImage(input)
      .rotate()
      .flatten({ background: '#ffffff' })
      .grayscale()
      .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch (error) {
    throw new ImageProcessingError(
      'PROCESSING_FAILED',
      'Image could not be processed. Please try a different image.',
      error instanceof Error ? error : undefined
    );
  }
  const { width, height, channels } = grey.info;
  if (channels !== 1) {
    throw new ImageProcessingError('PROCESSING_FAILED', 'Image could not be processed. Please try a different image.');
  }

  const paper = await sharp(grey.data, { raw: { width, height, channels: 1 } })
    .dilate(Math.max(5, Math.round(Math.min(width, height) / 40)))
    .blur(Math.max(8, Math.round(Math.min(width, height) / 25)))
    .raw()
    .toBuffer();

  const { blackAt, whiteAt, inkBelow } = SIGNATURE_CLEANING;
  const cleaned = Buffer.alloc(width * height);
  let ink = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const ratio = grey.data[i] / Math.max(1, paper[i]);
      const level = Math.round(Math.min(1, Math.max(0, (ratio - blackAt) / (whiteAt - blackAt))) * 255);
      cleaned[i] = level;
      if (level < inkBelow) {
        ink += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (ink < width * height * SIGNATURE_CLEANING.minInkShare) {
    throw new SignatureImageError('NO_SIGNATURE_FOUND', NO_SIGNATURE_FOUND_MESSAGE);
  }
  const margin = Math.round(Math.min(width, height) * 0.02) + 2;
  const left = Math.max(0, minX - margin);
  const top = Math.max(0, minY - margin);
  const boxWidth = Math.min(width, maxX + margin + 1) - left;
  const boxHeight = Math.min(height, maxY + margin + 1) - top;
  if (ink / (boxWidth * boxHeight) > SIGNATURE_CLEANING.maxInkShare) {
    throw new SignatureImageError('NOT_A_SIGNATURE', NOT_A_SIGNATURE_MESSAGE);
  }
  if (maxX - minX + 1 < SIGNATURE_CLEANING.minInkWidth) {
    throw new SignatureImageError('SIGNATURE_TOO_SMALL', SIGNATURE_TOO_SMALL_MESSAGE);
  }

  const out = await sharp(cleaned, { raw: { width, height, channels: 1 } })
    .extract({ left, top, width: boxWidth, height: boxHeight })
    .resize({
      width: SIGNATURE_MAX_SIZE.width,
      height: SIGNATURE_MAX_SIZE.height,
      fit: 'inside',
      withoutEnlargement: true,
    })
    // One grey channel: sharp writes sRGB unless told otherwise, three times the bytes.
    .toColourspace('b-w')
    .png({ compressionLevel: 9 })
    .toBuffer({ resolveWithObject: true });
  return { png: out.data, width: out.info.width, height: out.info.height };
}
