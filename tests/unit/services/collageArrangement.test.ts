import { describe, expect, it } from 'vitest';
import {
  COLLAGE_GUTTER_PX,
  COLLAGE_MAX_PHOTOS,
  COLLAGE_MIN_PHOTOS,
  collageCells,
  type CollageCanvas,
  type CollageCell,
} from '../../../src/services/collageArrangement.js';

/**
 * Where the photos of a postcard collage go (#616). Pure geometry, so every
 * claim here is arithmetic on rectangles.
 */

const G = COLLAGE_GUTTER_PX;

// The three postcard sizes at 300 DPI (imageService CONFIG.sizes).
const SIZES: Record<string, CollageCanvas> = {
  '4x6': { width: 1800, height: 1200 },
  '6x9': { width: 2700, height: 1800 },
  '11x6': { width: 3300, height: 1800 },
};

const rect = (left: number, top: number, width: number, height: number): CollageCell => ({ left, top, width, height });

/**
 * The cells and their gutters tile the front exactly. Grow every cell by half a
 * gutter on each side: the grown rectangles must then fill the front, inset by
 * half a gutter, with no overlap and no gap. That holds only if every margin is
 * one gutter wide and every two neighbouring cells are exactly one gutter apart.
 */
function expectTiling(cells: CollageCell[], canvas: CollageCanvas): void {
  const half = G / 2;
  const grown = cells.map(c => ({ left: c.left - half, top: c.top - half, right: c.left + c.width + half, bottom: c.top + c.height + half }));
  for (const cell of cells) {
    expect(cell.width).toBeGreaterThan(0);
    expect(cell.height).toBeGreaterThan(0);
  }
  let area = 0;
  for (const [i, a] of grown.entries()) {
    expect(a.left).toBeGreaterThanOrEqual(half);
    expect(a.top).toBeGreaterThanOrEqual(half);
    expect(a.right).toBeLessThanOrEqual(canvas.width - half);
    expect(a.bottom).toBeLessThanOrEqual(canvas.height - half);
    area += (a.right - a.left) * (a.bottom - a.top);
    for (const b of grown.slice(i + 1)) {
      const overlaps = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      expect(overlaps, 'two cells overlap').toBe(false);
    }
  }
  expect(area).toBe((canvas.width - G) * (canvas.height - G));
}

describe('collageCells (#616)', () => {
  it('takes two to four photos', () => {
    expect(COLLAGE_MIN_PHOTOS).toBe(2);
    expect(COLLAGE_MAX_PHOTOS).toBe(4);
    for (const count of [2, 3, 4]) expect(collageCells(count, SIZES['6x9'])).toHaveLength(count);
  });

  it.each([[0], [1], [5], [2.5], [-3], [Number.NaN], [Number.POSITIVE_INFINITY]])('refuses %s photos', count => {
    expect(() => collageCells(count, SIZES['6x9'])).toThrow(RangeError);
  });

  it('refuses a front too small to leave every cell a pixel', () => {
    // 2G of margin and G of gutter leave nothing to share.
    expect(() => collageCells(2, { width: 3 * G, height: 600 })).toThrow(RangeError);
    expect(() => collageCells(4, { width: 600, height: 3 * G })).toThrow(RangeError);
    expect(() => collageCells(3, { width: Number.NaN, height: 600 })).toThrow(RangeError);
    // The smallest that leaves one: 3 free pixels across and 2 down.
    expect(collageCells(3, { width: 3 * G + 3, height: 3 * G + 2 })).toHaveLength(3);
    expect(() => collageCells(3, { width: 3 * G + 2, height: 3 * G + 2 })).toThrow(RangeError);
    expect(() => collageCells(3, { width: 3 * G + 3, height: 3 * G + 1 })).toThrow(RangeError);
  });

  describe('on a 6x9 front (2700 x 1800)', () => {
    const canvas = SIZES['6x9'];

    it('puts two photos side by side', () => {
      expect(collageCells(2, canvas)).toEqual([rect(24, 24, 1314, 1752), rect(1362, 24, 1314, 1752)]);
    });

    it('puts one large photo on the left of three and two stacked on the right', () => {
      expect(collageCells(3, canvas)).toEqual([
        rect(24, 24, 1752, 1752),
        rect(1800, 24, 876, 864),
        rect(1800, 912, 876, 864),
      ]);
    });

    it('puts four photos two by two, in reading order', () => {
      expect(collageCells(4, canvas)).toEqual([
        rect(24, 24, 1314, 864),
        rect(1362, 24, 1314, 864),
        rect(24, 912, 1314, 864),
        rect(1362, 912, 1314, 864),
      ]);
    });
  });

  describe('on a 4x6 front (1800 x 1200)', () => {
    const canvas = SIZES['4x6'];

    it('keeps the postcard\'s proportions in every arrangement', () => {
      expect(collageCells(2, canvas)).toEqual([rect(24, 24, 864, 1152), rect(912, 24, 864, 1152)]);
      expect(collageCells(3, canvas)).toEqual([
        rect(24, 24, 1152, 1152),
        rect(1200, 24, 576, 564),
        rect(1200, 612, 576, 564),
      ]);
      expect(collageCells(4, canvas)).toEqual([
        rect(24, 24, 864, 564),
        rect(912, 24, 864, 564),
        rect(24, 612, 864, 564),
        rect(912, 612, 864, 564),
      ]);
    });
  });

  describe('on an 11x6 front (3300 x 1800)', () => {
    const canvas = SIZES['11x6'];

    it('gives the large photo of three two thirds of the width', () => {
      const [large, topRight, bottomRight] = collageCells(3, canvas);
      expect(large).toEqual(rect(24, 24, 2152, 1752));
      expect(topRight).toEqual(rect(2200, 24, 1076, 864));
      expect(bottomRight).toEqual(rect(2200, 912, 1076, 864));
    });
  });

  describe.each(Object.entries(SIZES))('tiles a %s front', (_name, canvas) => {
    it.each([[2], [3], [4]])('with %i photos, with margins and gutters of exactly one gutter', count => {
      expectTiling(collageCells(count, canvas), canvas);
    });
  });

  it.each([
    [{ width: 2701, height: 1801 }],
    [{ width: 1799, height: 1201 }],
    [{ width: 997, height: 703 }],
    [{ width: 160, height: 120 }],
  ])('tiles a front whose sides do not divide evenly: %j', canvas => {
    for (const count of [2, 3, 4]) expectTiling(collageCells(count, canvas), canvas);
  });

  it('leaves the odd pixel to the second cell of a split, never to a gutter', () => {
    // 2701 - 48 = 2653 wide; 2653 - 24 = 2629 shared: 1314 and 1315.
    const [first, second] = collageCells(2, { width: 2701, height: 1800 });
    expect([first.width, second.width]).toEqual([1314, 1315]);
    expect(second.left - (first.left + first.width)).toBe(G);
  });
});
