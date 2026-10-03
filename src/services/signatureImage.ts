/**
 * A signature's picture, cleaned for print (#608, concept 3).
 *
 * A person photographs their signature: ink on paper, often grey, with a
 * shadow across it or a desk at the edges, sometimes turned by the phone, and
 * sometimes a stray mark beside it. What prints must be dark ink on white,
 * cropped to the signature, so the letter shows a signature and not a
 * photograph of paper. The steps:
 *
 * 1. Turn the picture upright by its EXIF orientation, put any transparency
 *    on white, and make it grey, no larger than 1600 px on its longest edge.
 * 2. Estimate the paper's light at every point with a grey-level closing: a
 *    maximum filter, then a minimum filter, over a window wider than any pen
 *    stroke. Thin dark strokes vanish into the paper around them, while a
 *    shadow, a desk or a grey sheet, being larger than the window, stays as
 *    it is, edges included (van Herk and Gil-Werman's filters, linear time).
 * 3. Divide each pixel by its paper. Paper comes out near 1 wherever the light
 *    fell; ink well under it. Map 0.40 and below to black and 0.75 and above
 *    to white.
 * 4. Find the ink's connected pieces. Keep the largest and every piece near
 *    it: a speck in a corner neither stretches the crop nor falls inside it,
 *    while an i's dot stays with its word.
 * 5. Crop to what was kept, with a small margin, and fit it inside 1200 x 400
 *    px as a grayscale PNG.
 *
 * Refused: a picture with too little ink (blank paper, or light ink on dark),
 * one whose ink fills more than a third of its own box (a photograph, not a
 * signature), and a picture or a signature too small to print well. Pixels
 * made here are opened with plain sharp: they are ours and already bounded;
 * the picture itself is opened by openImage, with the pixel ceiling, under
 * the decode gate.
 */

import sharp, { type OutputInfo } from 'sharp';
import { ImageProcessingError, openImage, readImageHeader, runImageDecode } from './imageService.js';

/** The largest signature kept: wide and short, as signatures are. */
export const SIGNATURE_MAX_SIZE = { width: 1200, height: 400 } as const;

export const SIGNATURE_CLEANING = {
  /** The longest edge looked at: enough for a signature, and bounded work. */
  analysisEdge: 1600,
  /**
   * The closing's window: this share of the longest edge, and at least
   * minWindow px, always odd. A straight stroke as wide as the window is taken
   * for paper, and a dark band narrower than it near the signature (a pen's
   * shadow, a printed rule) for ink: a twentieth keeps a 5 mm marker stroke
   * at 14 px a millimetre.
   */
  windowShare: 1 / 20,
  minWindow: 15,
  /** A pixel at this share of its paper's light, or less, is black... */
  blackAt: 0.4,
  /** ...and at this share or more, white. */
  whiteAt: 0.75,
  /** Darker than this, after cleaning, is ink. */
  inkBelow: 160,
  /**
   * Paper darker than this holds no ink: a black object beside the sheet (a
   * phone), crushed by the camera, is its own paper.
   */
  paperFloor: 64,
  /** A piece of ink smaller than this, in pixels, is noise. */
  noiseArea: 8,
  /** How far, as a share of the longest edge, a piece may sit from the signature and still be part of it. */
  reachShare: 0.08,
  /** Less ink than this, in pixels, is no signature. */
  minInk: 300,
  /** More ink than this share of its own box is a photograph. */
  maxInkShare: 0.35,
  /** A picture smaller than this cannot hold a signature that prints well. */
  minSource: { longEdge: 150, shortEdge: 50 },
  /** A signature narrower than this prints as a smudge. */
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
  /** A grayscale PNG: dark ink on white, cropped to the signature. */
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

/**
 * A maximum (or minimum) over `size` pixels along each row, or each column,
 * of a `width` x `height` grey image: van Herk and Gil-Werman's filter, three
 * comparisons a pixel whatever the window. Past the edges counts as neutral:
 * nothing for a maximum, full white for a minimum.
 */
export function rankFilter(
  source: Uint8Array,
  width: number,
  height: number,
  size: number,
  along: 'rows' | 'columns',
  take: 'max' | 'min'
): Uint8Array {
  const out = new Uint8Array(source.length);
  const rows = along === 'rows';
  const length = rows ? width : height;
  const lines = rows ? height : width;
  const step = rows ? 1 : width;
  const half = size >> 1;
  const padded = length + 2 * half;
  const neutral = take === 'max' ? 0 : 255;
  const pick = take === 'max' ? Math.max : Math.min;
  const value = new Uint8Array(padded);
  const forward = new Uint8Array(padded);
  const backward = new Uint8Array(padded);
  for (let line = 0; line < lines; line += 1) {
    const base = rows ? line * width : line;
    value.fill(neutral);
    for (let i = 0; i < length; i += 1) value[i + half] = source[base + i * step];
    for (let start = 0; start < padded; start += size) {
      const end = Math.min(start + size, padded);
      forward[start] = value[start];
      for (let i = start + 1; i < end; i += 1) forward[i] = pick(forward[i - 1], value[i]);
      backward[end - 1] = value[end - 1];
      for (let i = end - 2; i >= start; i -= 1) backward[i] = pick(backward[i + 1], value[i]);
    }
    // Pixel i's window is padded [i, i + size - 1]: the backward run from its
    // start meets the forward run to its end, at most one block apart.
    for (let i = 0; i < length; i += 1) {
      const last = i + size - 1;
      out[base + i * step] = last < padded ? pick(backward[i], forward[last]) : backward[i];
    }
  }
  return out;
}

/** A grey-level closing: the maximum over a square window, then the minimum. */
export function closing(source: Uint8Array, width: number, height: number, size: number): Uint8Array {
  const lightest = rankFilter(rankFilter(source, width, height, size, 'rows', 'max'), width, height, size, 'columns', 'max');
  return rankFilter(rankFilter(lightest, width, height, size, 'rows', 'min'), width, height, size, 'columns', 'min');
}

interface Piece {
  id: number;
  area: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * The ink's 8-connected pieces of at least `noiseArea` pixels. `ink` holds 1
 * for ink, and each pixel found is marked 2, so the ink is its own record of
 * where the search has been. A smaller piece is noise: its pixels are
 * whitened in `cleaned`, so it prints as paper even inside the crop.
 */
function pieces(ink: Uint8Array, cleaned: Uint8Array, width: number, height: number, noiseArea: number): Piece[] {
  const stack = new Int32Array(ink.length);
  // A piece's first pixels: all of a piece too small to keep.
  const first = new Int32Array(noiseArea);
  const found: Piece[] = [];
  for (let start = 0; start < ink.length; start += 1) {
    if (ink[start] !== 1) continue;
    const piece: Piece = { id: found.length + 1, area: 0, minX: width, minY: height, maxX: -1, maxY: -1 };
    let top = 0;
    stack[top++] = start;
    ink[start] = 2;
    while (top > 0) {
      const at = stack[--top];
      const x = at % width;
      const y = (at - x) / width;
      if (piece.area < noiseArea) first[piece.area] = at;
      piece.area += 1;
      if (x < piece.minX) piece.minX = x;
      if (x > piece.maxX) piece.maxX = x;
      if (y < piece.minY) piece.minY = y;
      if (y > piece.maxY) piece.maxY = y;
      for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny += 1) {
        for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx += 1) {
          const next = ny * width + nx;
          if (ink[next] === 1) {
            ink[next] = 2;
            stack[top++] = next;
          }
        }
      }
    }
    if (piece.area >= noiseArea) found.push(piece);
    else for (let k = 0; k < piece.area; k += 1) cleaned[first[k]] = 255;
  }
  return found;
}

/** The largest piece and every piece within `reach` of what is kept, growing until none is near. */
function signaturePieces(found: Piece[], reach: number): { box: Omit<Piece, 'id' | 'area'>; area: number } {
  const largest = found.reduce((best, piece) => (piece.area > best.area ? piece : best));
  const kept = new Set([largest.id]);
  const box = { minX: largest.minX, minY: largest.minY, maxX: largest.maxX, maxY: largest.maxY };
  let area = largest.area;
  for (let grew = true; grew; ) {
    grew = false;
    for (const piece of found) {
      if (kept.has(piece.id)) continue;
      const gapX = Math.max(0, piece.minX - box.maxX, box.minX - piece.maxX);
      const gapY = Math.max(0, piece.minY - box.maxY, box.minY - piece.maxY);
      if (gapX > reach || gapY > reach) continue;
      kept.add(piece.id);
      area += piece.area;
      box.minX = Math.min(box.minX, piece.minX);
      box.minY = Math.min(box.minY, piece.minY);
      box.maxX = Math.max(box.maxX, piece.maxX);
      box.maxY = Math.max(box.maxY, piece.maxY);
      grew = true;
    }
  }
  return { box, area };
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

  const longest = Math.max(width, height);
  const window = Math.max(SIGNATURE_CLEANING.minWindow, Math.round(longest * SIGNATURE_CLEANING.windowShare)) | 1;
  const paper = closing(grey.data, width, height, window);

  const { blackAt, whiteAt, inkBelow, paperFloor } = SIGNATURE_CLEANING;
  const cleaned = Buffer.alloc(width * height);
  const ink = new Uint8Array(width * height);
  for (let i = 0; i < cleaned.length; i += 1) {
    // One more on each side, so crushed blacks divide as near-blacks do.
    const ratio = paper[i] < paperFloor ? 1 : (grey.data[i] + 1) / (paper[i] + 1);
    const level = Math.round(Math.min(1, Math.max(0, (ratio - blackAt) / (whiteAt - blackAt))) * 255);
    cleaned[i] = level;
    if (level < inkBelow) ink[i] = 1;
  }

  const real = pieces(ink, cleaned, width, height, SIGNATURE_CLEANING.noiseArea);
  if (real.length === 0) throw new SignatureImageError('NO_SIGNATURE_FOUND', NO_SIGNATURE_FOUND_MESSAGE);
  const { box, area } = signaturePieces(real, Math.round(longest * SIGNATURE_CLEANING.reachShare));
  if (area < SIGNATURE_CLEANING.minInk) throw new SignatureImageError('NO_SIGNATURE_FOUND', NO_SIGNATURE_FOUND_MESSAGE);
  // Ink is darker than the paper around it, by the contrast each ink pixel
  // met against its own paper. Light ink on a dark sheet fails: the closing
  // takes its light strokes for paper, and what reads as ink is their edges,
  // lighter than the sheet. Around what was kept, a window beyond it on each
  // side, where nothing left out lies (the window is narrower than the reach),
  // so a desk in the rest of the picture does not count (#609 rounds 3 and 4).
  const around = {
    minX: Math.max(0, box.minX - window),
    minY: Math.max(0, box.minY - window),
    maxX: Math.min(width - 1, box.maxX + window),
    maxY: Math.min(height - 1, box.maxY + window),
  };
  let inkGrey = 0;
  let inkCount = 0;
  let paperGrey = 0;
  let paperCount = 0;
  for (let y = around.minY; y <= around.maxY; y += 1) {
    for (let x = around.minX; x <= around.maxX; x += 1) {
      const i = y * width + x;
      if (ink[i]) {
        inkGrey += grey.data[i];
        inkCount += 1;
      } else {
        paperGrey += grey.data[i];
        paperCount += 1;
      }
    }
  }
  const inkContrast = blackAt + (whiteAt - blackAt) * (inkBelow / 255);
  if (paperCount === 0 || inkGrey / inkCount > inkContrast * (paperGrey / paperCount)) {
    throw new SignatureImageError('NO_SIGNATURE_FOUND', NO_SIGNATURE_FOUND_MESSAGE);
  }
  // A piece left out is further than `reach` from what is kept, and the crop's
  // margin is narrower than that, so a stray mark never reaches the crop.

  const margin = Math.round(Math.min(width, height) * 0.02) + 2;
  const left = Math.max(0, box.minX - margin);
  const top = Math.max(0, box.minY - margin);
  const boxWidth = Math.min(width, box.maxX + margin + 1) - left;
  const boxHeight = Math.min(height, box.maxY + margin + 1) - top;
  if (area / (boxWidth * boxHeight) > SIGNATURE_CLEANING.maxInkShare) {
    throw new SignatureImageError('NOT_A_SIGNATURE', NOT_A_SIGNATURE_MESSAGE);
  }
  if (box.maxX - box.minX + 1 < SIGNATURE_CLEANING.minInkWidth) {
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
