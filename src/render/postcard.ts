import { POINTS_PER_INCH, POSTCARD_GEOMETRY, POSTCARD_MESSAGE, POSTCARD_STRIP, type PostcardSizeName } from './geometry.js';
import type { RenderImage } from './images.js';
import { baselineOffset, wrapText, type Layout, type LayoutItem, type LayoutPage } from './layout.js';
import { QUIET_ZONE_MODULES, qrMatrix, qrRuns } from './qr.js';

export interface PostcardContent {
  /** The message on the back. */
  message: string;
  /** The front image, already cropped to the card's shape by imageService. */
  image: RenderImage;
  /** A gift postcard's strip, at the foot of the message: a 6x9 postcard's only. */
  strip?: GiftStripCopy;
  /** Its size (#594): 6x9 when left out. */
  size?: PostcardSizeName;
}

/**
 * The gift strip's words (giftPostcardStripCopy in
 * src/services/giftCardRenderer.ts). Plain text.
 */
export interface GiftStripCopy {
  /** The strip's lead, on a line of its own in the larger size. */
  lead: string;
  /** Then each line in turn, the code in the largest size. */
  lines: Array<{ text: string; kind: 'plain' | 'code' }>;
  /** What the QR encodes. */
  qrUrl: string;
}

/**
 * A strip whose words run past its fixed height: a long sender's name, or a
 * seed campaign's long code. The preview refuses either, and a print holds
 * one the preview never saw.
 */
export class GiftStripOverflow extends Error {
  constructor(readonly overflow: number) {
    super(`The gift strip runs ${(overflow / POINTS_PER_INCH).toFixed(2)}in past its room.`);
    this.name = 'GiftStripOverflow';
  }
}

/** The strip's sizes and line pitches, from the legacy CSS's line-height of 1.35. */
const STRIP_STYLE = {
  lead: { size: 10, pitch: 13.5 },
  plain: { size: 9, pitch: 12.15 },
  code: { size: 12, pitch: 16.2 }
} as const;

/**
 * The strip at the foot of the message: the rule, then the QR beside its
 * words, the two centred on each other as the legacy CSS centres them.
 */
function layoutStrip(strip: GiftStripCopy): LayoutItem[] {
  const top = POSTCARD_MESSAGE.top + POSTCARD_MESSAGE.height - POSTCARD_STRIP.height;
  const rowTop = top + POSTCARD_STRIP.rule + POSTCARD_STRIP.padTop;
  const room = POSTCARD_STRIP.height - POSTCARD_STRIP.rule - POSTCARD_STRIP.padTop;
  const textLeft = POSTCARD_MESSAGE.left + POSTCARD_STRIP.qr + POSTCARD_STRIP.gap;
  const textWidth = POSTCARD_MESSAGE.width - POSTCARD_STRIP.qr - POSTCARD_STRIP.gap;

  const blocks = [{ text: strip.lead, style: STRIP_STYLE.lead }, ...strip.lines.map(line => ({ text: line.text, style: STRIP_STYLE[line.kind] }))]
    .map(block => ({ ...block, wrapped: wrapText(block.text, block.style.size, textWidth) }));
  const textHeight = blocks.reduce((total, block) => total + block.wrapped.length * block.style.pitch, 0);
  const row = Math.max(POSTCARD_STRIP.qr, textHeight);
  if (row > room + 1e-6) throw new GiftStripOverflow(row - room);

  const items: LayoutItem[] = [
    { kind: 'rects', fill: '#b9ad99', rects: [{ x: POSTCARD_MESSAGE.left, top, width: POSTCARD_MESSAGE.width, height: POSTCARD_STRIP.rule }] }
  ];
  // The QR's modules, each edge rounded once so neighbouring rows meet.
  const matrix = qrMatrix(strip.qrUrl);
  const module = POSTCARD_STRIP.qr / (matrix.count + 2 * QUIET_ZONE_MODULES);
  const qrTop = rowTop + (row - POSTCARD_STRIP.qr) / 2;
  const edge = (value: number) => Math.round(value * 100) / 100;
  items.push({
    kind: 'rects',
    fill: '#000',
    rects: qrRuns(matrix).map(run => {
      const [left, right] = [edge(POSTCARD_MESSAGE.left + run.x * module), edge(POSTCARD_MESSAGE.left + (run.x + run.width) * module)];
      const [runTop, bottom] = [edge(qrTop + run.y * module), edge(qrTop + (run.y + 1) * module)];
      return { x: left, top: runTop, width: edge(right - left), height: edge(bottom - runTop) };
    })
  });
  let y = rowTop + (row - textHeight) / 2;
  for (const block of blocks) {
    const offset = baselineOffset(block.style.size, block.style.pitch);
    block.wrapped.forEach(({ source, drawn }, index) => {
      if (drawn.trim() === '') return;
      items.push({ kind: 'text', font: 'Tinos-Regular', size: block.style.size, x: textLeft, baseline: y + index * block.style.pitch + offset, text: drawn, source });
    });
    y += block.wrapped.length * block.style.pitch;
  }
  return items;
}

/**
 * The back alone: the message in its left part, a gift postcard's strip at
 * its foot, and how many lines the message runs past. A preview measures it
 * before the front image is fetched. A strip that runs past its room throws
 * GiftStripOverflow. Each size has its own message box, size and pitch
 * (POSTCARD_GEOMETRY, #594); a gift postcard is 6x9 only (#579), so a strip
 * on another size is refused.
 */
export function layoutPostcardBack(
  message: string,
  strip?: GiftStripCopy,
  size: PostcardSizeName = '6x9'
): { page: LayoutPage; overflowLines: number } {
  if (strip && size !== '6x9') throw new Error(`A gift postcard is 6x9: a ${size} postcard has no room for its strip.`);
  const geometry = POSTCARD_GEOMETRY[size];
  const lines = wrapText(message.replace(/\s+$/u, ''), geometry.fontSize, geometry.message.width);
  const offset = baselineOffset(geometry.fontSize, geometry.linePitch);
  // The strip is laid out first, so one that runs past its room refuses
  // before anything else; its items follow the message's, which a page's
  // title reads first.
  const stripItems = strip ? layoutStrip(strip) : [];
  const items: LayoutItem[] = [];
  lines.forEach(({ source, drawn }, index) => {
    if (drawn.trim() === '') return;
    items.push({
      kind: 'text',
      font: 'Tinos-Regular',
      size: geometry.fontSize,
      x: geometry.message.left,
      baseline: geometry.message.top + index * geometry.linePitch + offset,
      text: drawn,
      source
    });
  });
  items.push(...stripItems);
  const room = geometry.message.height - (strip ? POSTCARD_STRIP.height : 0);
  const linesAvailable = Math.floor((room + 1e-6) / geometry.linePitch);
  return {
    page: { items, linesUsed: lines.length, linesAvailable },
    overflowLines: Math.max(0, lines.length - linesAvailable)
  };
}

/**
 * Lays out a postcard as PostGrid prints it from a PDF (geometry.ts), at its
 * size (#594; 9x6 when none is given): the front image covering the whole
 * first page, bleed included, and the message in the left part of the back,
 * where the legacy back put it at 9x6. The rest stays empty: PostGrid stamps
 * the addresses and postage there, and cancels a postcard with anything drawn
 * in their region. Trailing blank lines draw nothing and are not counted.
 * Lines past the message box are still laid out, so `overflowLines` can say
 * by how much a message is too long.
 */
export function layoutPostcard(content: PostcardContent): Layout {
  const { image } = content;
  const size = content.size ?? '6x9';
  const page = POSTCARD_GEOMETRY[size];
  // Cover: the image fills the page, cropped evenly on its long side.
  const scale = Math.max(page.width / image.width, page.height / image.height);
  const [width, height] = [image.width * scale, image.height * scale];
  const front: LayoutItem[] = [
    { kind: 'image', x: (page.width - width) / 2, top: (page.height - height) / 2, width, height, image }
  ];

  const back = layoutPostcardBack(content.message, content.strip, size);

  return {
    width: page.width,
    height: page.height,
    title: 'Postcard',
    pages: [{ items: front, linesUsed: 0, linesAvailable: 0, title: 'The front of the postcard' }, back.page],
    overflowLines: back.overflowLines
  };
}
