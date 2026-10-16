/**
 * Where each photo of a postcard collage goes (#616): the cells of two, three
 * or four photos on the postcard's front, as pixel rectangles at the print
 * size. Pure arithmetic: no image is opened here, so every arrangement can be
 * checked as geometry, and src/services/imageService.ts draws the photos into
 * the cells it returns.
 *
 * The cells are the postcard's own proportions at every size, so one rule
 * serves a 4x6, a 6x9 and an 11x6. A white margin runs round the front and a
 * white gutter between photos, both COLLAGE_GUTTER_PX wide. The photos are in
 * the order the person gave them, reading left to right and top to bottom; the
 * large photo of three comes first.
 */

/** The fewest and most photos a collage takes. */
export const COLLAGE_MIN_PHOTOS = 2;
export const COLLAGE_MAX_PHOTOS = 4;

/** The white margin round the front and the gutter between photos: 0.08 in at 300 DPI. */
export const COLLAGE_GUTTER_PX = 24;

/** A photo's place on the front, in pixels from its top left corner. */
export interface CollageCell {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The front's size in pixels. */
export interface CollageCanvas {
  width: number;
  height: number;
}

/**
 * Splits a length into two parts with a gutter between, the first the given
 * share of what is left and the second the rest, so the two and the gutter
 * add up to the length exactly.
 */
function split(length: number, share: number): [number, number] {
  const free = length - COLLAGE_GUTTER_PX;
  const first = Math.floor(free * share);
  return [first, free - first];
}

/**
 * The cells for `count` photos on a front of the given size:
 * - 2: side by side, equal;
 * - 3: one large on the left, two thirds of the width, and two stacked on the right;
 * - 4: two by two, equal.
 *
 * @throws RangeError when count is not a whole number from 2 to 4, or the front is too small to leave a cell
 */
export function collageCells(count: number, canvas: CollageCanvas): CollageCell[] {
  if (!Number.isInteger(count) || count < COLLAGE_MIN_PHOTOS || count > COLLAGE_MAX_PHOTOS) {
    throw new RangeError(`A collage takes ${COLLAGE_MIN_PHOTOS} to ${COLLAGE_MAX_PHOTOS} photos, not ${count}.`);
  }
  const g = COLLAGE_GUTTER_PX;
  const width = canvas.width - 2 * g;
  const height = canvas.height - 2 * g;
  // The smallest front that leaves every cell a pixel: 3 free pixels across (the two-thirds split) and 2 down.
  if (!(width - g >= 3) || !(height - g >= 2)) {
    throw new RangeError(`A ${canvas.width} x ${canvas.height} front is too small for a collage.`);
  }

  if (count === 2) {
    const [left, right] = split(width, 1 / 2);
    return [
      { left: g, top: g, width: left, height },
      { left: g + left + g, top: g, width: right, height },
    ];
  }

  const [top, bottom] = split(height, 1 / 2);
  if (count === 3) {
    const [large, column] = split(width, 2 / 3);
    return [
      { left: g, top: g, width: large, height },
      { left: g + large + g, top: g, width: column, height: top },
      { left: g + large + g, top: g + top + g, width: column, height: bottom },
    ];
  }

  const [left, right] = split(width, 1 / 2);
  return [
    { left: g, top: g, width: left, height: top },
    { left: g + left + g, top: g, width: right, height: top },
    { left: g, top: g + top + g, width: left, height: bottom },
    { left: g + left + g, top: g + top + g, width: right, height: bottom },
  ];
}
