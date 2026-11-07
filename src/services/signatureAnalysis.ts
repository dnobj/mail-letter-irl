/**
 * The pixel work of cleaning a signature (#608), steps 2 to 4 of
 * signatureImage.ts: the paper's light by a grey-level closing, each pixel
 * divided by it, and the ink's pieces kept or dropped. Plain arithmetic over a
 * grey image of up to 1600 px a side, which takes a quarter of a second or so:
 * on the server it runs on a worker thread (signatureAnalysisWorker.ts), so
 * the event loop serves other requests meanwhile (#730). Nothing here imports
 * anything, so the worker loads only this.
 */

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
  /** Light ink on a dark sheet (#611, inkIsSheet): the kept ink grows through neighbours whose grey differs from its mean by at most this share of it... */
  sheetStep: 0.07,
  /** ...or by this many levels, whichever is more (a JPEG's noise)... */
  sheetStepFloor: 5,
  /** ...and a region more than this many times the kept ink is the sheet, not ink... */
  sheetSpread: 3,
  /** ...when, too, less than this share of the kept box is light: a sheet's light is its thin strokes... */
  sheetLightShare: 0.5,
  /** ...and at least this share of the kept ink is within the step of its mean: a sheet is one grey. */
  sheetOneGrey: 0.6,
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

/** What the analysis found: where to crop the cleaned grey image, or why there is nothing to print. */
export type SignatureAnalysis =
  | { ok: true; cleaned: Uint8Array; left: number; top: number; width: number; height: number }
  | { ok: false; refusal: 'NO_SIGNATURE_FOUND' | 'NOT_A_SIGNATURE' | 'SIGNATURE_TOO_SMALL' };

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

/**
 * Whether the light in the kept box is thin, as light strokes on a dark sheet
 * are: less than sheetLightShare of the box is within 85% of its light level
 * (the 95th percentile of its grey). Paper with a signature on it, a card's
 * and a shadowed sheet's lit part included, fills most of its box with light.
 */
function lightIsThin(grey: Uint8Array, width: number, box: { minX: number; minY: number; maxX: number; maxY: number }): boolean {
  const counts = new Uint32Array(256);
  for (let y = box.minY; y <= box.maxY; y += 1) {
    for (let x = box.minX; x <= box.maxX; x += 1) counts[grey[y * width + x]] += 1;
  }
  const total = (box.maxX - box.minX + 1) * (box.maxY - box.minY + 1);
  let level = 255;
  for (let below = total; level > 0; level -= 1) {
    below -= counts[level];
    if (below < total * 0.95) break;
  }
  let light = 0;
  for (let value = Math.ceil(level * 0.85); value <= 255; value += 1) light += counts[value];
  return light < total * SIGNATURE_CLEANING.sheetLightShare;
}

/**
 * Whether what was kept is light ink on a dark sheet (#611), not a signature.
 * The closing takes light strokes narrower than its window for paper, so the
 * dark sheet in the bends between them reads as ink, and those shapes would be
 * kept. Each is a piece of the sheet: open on a side, it runs on, at the same
 * grey, into the sheet beyond the strokes, where the paper is the sheet's own
 * and nothing reads as ink. Real ink is bounded by paper lighter than it, on a
 * card over a desk and in a lit strip inside a shadow alike.
 *
 * So the region the kept ink grows into, through neighbours whose grey is
 * within sheetStep of the ink's mean grey, is measured against the kept ink.
 * Measured against the mean, not pixel to pixel, a stroke's edge cannot be
 * climbed step by step into its paper: ink stays inside its strokes, a
 * pencil's and a grey pen's too, and a shadow's paper is a different grey.
 * The sheet's region spreads past sheetSpread times the ink. So may real ink's,
 * where its grey is a shadow's paper's or a desk's and a stroke runs into
 * it; but real ink lies on paper, which fills most of its box with light,
 * while light strokes on a sheet fill little of theirs (lightIsThin). And the
 * sheet's pockets are one grey, the sheet's, while ink that runs from the light
 * into a shadow is two, its mean neither (sheetOneGrey). All three together are
 * refused as no signature found. Two kinds are left to the person, who sees the
 * saved picture in the letter's preview before anything prints: a light stroke
 * drawn as a closed loop, which encloses its sheet so it grows no further, and
 * light strokes as wide as the closing's window or wider (a broad paint marker),
 * which are paper to the closing and fill their box with light.
 */
function inkIsSheet(
  grey: Uint8Array,
  cleaned: Uint8Array,
  ink: Uint8Array,
  width: number,
  height: number,
  box: { minX: number; minY: number; maxX: number; maxY: number },
  area: number
): boolean {
  const { sheetStep, sheetStepFloor, sheetSpread, sheetOneGrey, inkBelow } = SIGNATURE_CLEANING;
  const limit = Math.ceil(area * sheetSpread);
  // The kept ink: every piece found is marked 2 (pieces), and a noise speck's pixels were whitened.
  const isInk = (i: number) => ink[i] === 2 && cleaned[i] < inkBelow;
  // The ink's own grey, which every pixel grown into must match.
  let inkSum = 0;
  let inkCount = 0;
  for (let y = box.minY; y <= box.maxY; y += 1) {
    for (let x = box.minX; x <= box.maxX; x += 1) {
      const i = y * width + x;
      if (isInk(i)) {
        inkSum += grey[i];
        inkCount += 1;
      }
    }
  }
  if (inkCount === 0) return false;
  const mean = inkSum / inkCount;
  const step = Math.max(sheetStepFloor, mean * sheetStep);
  // A sheet's pockets are one grey, the sheet's; ink of two (a stroke running from the light into a shadow) is not.
  let inBand = 0;
  for (let y = box.minY; y <= box.maxY; y += 1) {
    for (let x = box.minX; x <= box.maxX; x += 1) {
      const i = y * width + x;
      if (isInk(i) && Math.abs(grey[i] - mean) <= step) inBand += 1;
    }
  }
  if (inBand < inkCount * sheetOneGrey) return false;
  const reached = new Uint8Array(width * height);
  const stack = new Int32Array(Math.min(limit, width * height) + 1);
  let grown = 0;
  let top = 0;
  for (let y = box.minY; y <= box.maxY; y += 1) {
    for (let x = box.minX; x <= box.maxX; x += 1) {
      const i = y * width + x;
      if (!isInk(i) || reached[i]) continue;
      reached[i] = 1;
      grown += 1;
      if (grown > limit) return lightIsThin(grey, width, box);
      stack[top++] = i;
      while (top > 0) {
        const at = stack[--top];
        const ax = at % width;
        const ay = (at - ax) / width;
        for (let ny = Math.max(0, ay - 1); ny <= Math.min(height - 1, ay + 1); ny += 1) {
          for (let nx = Math.max(0, ax - 1); nx <= Math.min(width - 1, ax + 1); nx += 1) {
            const next = ny * width + nx;
            if (reached[next] || Math.abs(grey[next] - mean) > step) continue;
            reached[next] = 1;
            grown += 1;
            if (grown > limit) return lightIsThin(grey, width, box);
            stack[top++] = next;
          }
        }
      }
    }
  }
  return false;
}

/** Steps 2 to 4 on a grey `width` x `height` image: the cleaned pixels and the crop, or a refusal. */
export function analyseSignature(grey: Uint8Array, width: number, height: number): SignatureAnalysis {
  const longest = Math.max(width, height);
  const window = Math.max(SIGNATURE_CLEANING.minWindow, Math.round(longest * SIGNATURE_CLEANING.windowShare)) | 1;
  const paper = closing(grey, width, height, window);

  const { blackAt, whiteAt, inkBelow, paperFloor } = SIGNATURE_CLEANING;
  const cleaned = new Uint8Array(width * height);
  const ink = new Uint8Array(width * height);
  for (let i = 0; i < cleaned.length; i += 1) {
    // One more on each side, so crushed blacks divide as near-blacks do.
    const ratio = paper[i] < paperFloor ? 1 : (grey[i] + 1) / (paper[i] + 1);
    const level = Math.round(Math.min(1, Math.max(0, (ratio - blackAt) / (whiteAt - blackAt))) * 255);
    cleaned[i] = level;
    if (level < inkBelow) ink[i] = 1;
  }

  const real = pieces(ink, cleaned, width, height, SIGNATURE_CLEANING.noiseArea);
  if (real.length === 0) return { ok: false, refusal: 'NO_SIGNATURE_FOUND' };
  const { box, area } = signaturePieces(real, Math.round(longest * SIGNATURE_CLEANING.reachShare));
  if (area < SIGNATURE_CLEANING.minInk) return { ok: false, refusal: 'NO_SIGNATURE_FOUND' };
  if (inkIsSheet(grey, cleaned, ink, width, height, box, area)) return { ok: false, refusal: 'NO_SIGNATURE_FOUND' };
  // A piece left out is further than `reach` from what is kept, and the crop's
  // margin is narrower than that, so a stray mark never reaches the crop.

  const margin = Math.round(Math.min(width, height) * 0.02) + 2;
  const left = Math.max(0, box.minX - margin);
  const top = Math.max(0, box.minY - margin);
  const boxWidth = Math.min(width, box.maxX + margin + 1) - left;
  const boxHeight = Math.min(height, box.maxY + margin + 1) - top;
  if (area / (boxWidth * boxHeight) > SIGNATURE_CLEANING.maxInkShare) {
    return { ok: false, refusal: 'NOT_A_SIGNATURE' };
  }
  if (box.maxX - box.minX + 1 < SIGNATURE_CLEANING.minInkWidth) {
    return { ok: false, refusal: 'SIGNATURE_TOO_SMALL' };
  }

  return { ok: true, cleaned, left, top, width: boxWidth, height: boxHeight };
}
