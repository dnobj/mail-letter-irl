import {
  POSTCARD_FONT_SIZE, POSTCARD_HEIGHT, POSTCARD_LINE_PITCH, POSTCARD_MESSAGE, POSTCARD_WIDTH
} from './geometry.js';
import type { RenderImage } from './images.js';
import { baselineOffset, wrapText, type Layout, type LayoutItem } from './layout.js';

export interface PostcardContent {
  /** The message on the back. */
  message: string;
  /** The front image, already cropped to the card's 3:2 by imageService. */
  image: RenderImage;
}

/**
 * Lays out a 9x6 postcard as PostGrid prints it from a PDF (geometry.ts): the
 * front image covering the whole first page, bleed included, and the message
 * in the left half of the back, where the legacy back put it. The right half
 * stays empty: PostGrid stamps the addresses and postage there, and cancels a
 * postcard with anything drawn in their region. Trailing blank lines draw
 * nothing and are not counted. Lines past the message half are still laid
 * out, so `overflowLines` can say by how much a message is too long.
 */
export function layoutPostcard(content: PostcardContent): Layout {
  const { image } = content;
  // Cover: the image fills the page, cropped evenly on its long side.
  const scale = Math.max(POSTCARD_WIDTH / image.width, POSTCARD_HEIGHT / image.height);
  const [width, height] = [image.width * scale, image.height * scale];
  const front: LayoutItem[] = [
    { kind: 'image', x: (POSTCARD_WIDTH - width) / 2, top: (POSTCARD_HEIGHT - height) / 2, width, height, image }
  ];

  const lines = wrapText(content.message.replace(/\s+$/u, ''), POSTCARD_FONT_SIZE, POSTCARD_MESSAGE.width);
  const offset = baselineOffset(POSTCARD_FONT_SIZE, POSTCARD_LINE_PITCH);
  const back: LayoutItem[] = [];
  lines.forEach(({ source, drawn }, index) => {
    if (drawn.trim() === '') return;
    back.push({
      kind: 'text',
      font: 'Tinos-Regular',
      size: POSTCARD_FONT_SIZE,
      x: POSTCARD_MESSAGE.left,
      baseline: POSTCARD_MESSAGE.top + index * POSTCARD_LINE_PITCH + offset,
      text: drawn,
      source
    });
  });
  const linesAvailable = Math.floor((POSTCARD_MESSAGE.height + 1e-6) / POSTCARD_LINE_PITCH);

  return {
    width: POSTCARD_WIDTH,
    height: POSTCARD_HEIGHT,
    pages: [
      { items: front, linesUsed: 0, linesAvailable: 0 },
      { items: back, linesUsed: lines.length, linesAvailable }
    ],
    overflowLines: Math.max(0, lines.length - linesAvailable)
  };
}
