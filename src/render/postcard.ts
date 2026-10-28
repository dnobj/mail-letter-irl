import { loadFont, type FontName } from './fonts.js';
import {
  POINTS_PER_INCH, POSTCARD_BLEED, POSTCARD_FRONT, POSTCARD_GEOMETRY, POSTCARD_MESSAGE, POSTCARD_STRIP,
  type PostcardGeometry, type PostcardLayoutName, type PostcardSizeName
} from './geometry.js';
import { shape } from './glyphs.js';
import type { RenderImage } from './images.js';
import { baselineOffset, wrapText, type ImageBox, type Layout, type LayoutItem, type LayoutPage, type TextRun } from './layout.js';
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
  /** Its front's layout (#594): the photo across the whole front when left out. */
  layout?: PostcardLayoutName;
  /** A bordered front's caption, under the photo, on one line. */
  caption?: string;
  /** A greetings front's place, in capitals, on one line. */
  place?: string;
}

/** The longest caption or place a stored front may hold (#594): far past what either line draws. */
export const POSTCARD_FRONT_TEXT_MAX_LENGTH = 120;

/**
 * A front other than full bleed (#594), as a draft and a letter store it
 * (migration 048): the photo in a border over its caption, or Greetings from
 * a place.
 */
export type PostcardFront = { layout: 'border'; caption?: string } | { layout: 'greetings'; place: string };

/**
 * The front a stored value describes, or null when it is not one this build
 * draws: not an object, an unknown layout, a greeting without its place, a
 * caption on a greeting or a place on a border, or text that is not text or
 * is too long. The print reads a 'pdf-3' postcard's front with this, and
 * holds one it cannot read rather than printing it full bleed.
 */
export function postcardFrontOf(value: unknown): PostcardFront | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  // undefined when absent, null when present but not text this build draws.
  const textOf = (key: 'caption' | 'place'): string | undefined | null => {
    const text = record[key];
    if (text === undefined || text === null) return undefined;
    return typeof text === 'string' && text.length <= POSTCARD_FRONT_TEXT_MAX_LENGTH ? text : null;
  };
  const caption = textOf('caption');
  const place = textOf('place');
  if (caption === null || place === null) return null;
  if (record.layout === 'border') {
    if (place !== undefined) return null;
    return caption === undefined ? { layout: 'border' } : { layout: 'border', caption };
  }
  if (record.layout === 'greetings') {
    if (caption !== undefined || place === undefined || place.trim() === '') return null;
    return { layout: 'greetings', place };
  }
  return null;
}

/**
 * Words on a postcard's front that run past their room (#594): a caption
 * wider than the photo, or a place too long to draw at the smallest size
 * allowed. The preview refuses either, and a print holds one it never saw.
 */
export class PostcardFrontOverflow extends Error {
  constructor(readonly part: 'caption' | 'place', readonly overflow: number) {
    super(`The ${part} runs ${(overflow / POINTS_PER_INCH).toFixed(2)}in past its room on the front.`);
    this.name = 'PostcardFrontOverflow';
  }
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
  const size = content.size ?? '6x9';
  const page = POSTCARD_GEOMETRY[size];
  const front = layoutPostcardFront(content, page);

  const back = layoutPostcardBack(content.message, content.strip, size);

  return {
    width: page.width,
    height: page.height,
    title: 'Postcard',
    pages: [{ items: front, linesUsed: 0, linesAvailable: 0, title: 'The front of the postcard' }, back.page],
    overflowLines: back.overflowLines
  };
}

/** A box on the page, from its top left corner. */
interface Box {
  x: number;
  top: number;
  width: number;
  height: number;
}

/** The image covering a box, cropped evenly on its long side, never squeezed. */
function cover(image: RenderImage, box: Box): ImageBox {
  const scale = Math.max(box.width / image.width, box.height / image.height);
  const [width, height] = [image.width * scale, image.height * scale];
  return { kind: 'image', x: box.x + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height, image };
}

/** Words the front draws on one line: every run of white space one space. */
function oneLine(text: string | undefined): string {
  return (text ?? '').replace(/\s+/gu, ' ').trim();
}

/** One line of lettering centred on `centre`, and how wide it is drawn. */
function centredLine(text: string, source: string, font: FontName, size: number, centre: number, baseline: number, fill: `#${string}`) {
  const [line] = wrapText(text, size, Number.MAX_SAFE_INTEGER, font);
  const face = loadFont(font);
  const width = shape(face, line.drawn).advanceWidth * (size / face.unitsPerEm);
  const run: TextRun = { kind: 'text', font, size, x: centre - width / 2, baseline, text: line.drawn, source, fill };
  return { run, width };
}

/**
 * The front (#594), on the page with its bleed: the photo covering the
 * whole page (full_bleed, the front every postcard had before), cut to a box
 * inside a white border with its caption below (border), or covering the
 * page under "Greetings from" a place (greetings). POSTCARD_FRONT holds the
 * proportions. A caption or place that runs past its room throws
 * PostcardFrontOverflow.
 */
function layoutPostcardFront(content: PostcardContent, page: PostcardGeometry): LayoutItem[] {
  const trim: Box = {
    x: POSTCARD_BLEED,
    top: POSTCARD_BLEED,
    width: page.width - 2 * POSTCARD_BLEED,
    height: page.height - 2 * POSTCARD_BLEED
  };
  const layout = content.layout ?? 'full_bleed';
  if (layout === 'border') {
    const border = POSTCARD_FRONT.border;
    const margin = border.margin * trim.width;
    const strip = border.strip * trim.height;
    const photo: Box = {
      x: trim.x + margin,
      top: trim.top + margin,
      width: trim.width - 2 * margin,
      height: trim.height - margin - border.gap * trim.height - strip
    };
    const items: LayoutItem[] = [{ ...cover(content.image, photo), clip: photo }];
    const caption = oneLine(content.caption);
    if (caption) {
      const size = border.captionSize * strip;
      const stripTop = trim.top + trim.height - strip;
      const { run, width } = centredLine(
        caption, caption, 'Caveat-Regular', size, trim.x + trim.width / 2,
        stripTop + baselineOffset(size, strip, 'Caveat-Regular'), border.captionColor
      );
      if (width > photo.width + 1e-6) throw new PostcardFrontOverflow('caption', width - photo.width);
      items.push(run);
    }
    return items;
  }

  const items: LayoutItem[] = [cover(content.image, { x: 0, top: 0, width: page.width, height: page.height })];
  if (layout === 'greetings') {
    const greetings = POSTCARD_FRONT.greetings;
    const centre = page.width / 2;
    const lead = 'Greetings from';
    items.push(centredLine(
      lead, lead, 'Caveat-Regular', greetings.leadSize * trim.height, centre,
      trim.top + greetings.leadBaseline * trim.height, greetings.leadColor
    ).run);
    const place = oneLine(content.place);
    if (place) {
      const drawn = place.toUpperCase();
      const largest = greetings.placeMaxSize * trim.height;
      const room = greetings.placeWidth * trim.width;
      const atLargest = centredLine(drawn, place, 'Tinos-Regular', largest, centre, 0, greetings.placeColor).width;
      const size = Math.min(largest, (largest * room) / atLargest);
      const smallest = greetings.placeMinSize * trim.height;
      if (size < smallest - 1e-9) throw new PostcardFrontOverflow('place', (atLargest * smallest) / largest - room);
      const baseline = trim.top + greetings.placeBaseline * trim.height;
      const offset = greetings.shadowOffset * trim.height;
      // The shadow first, unspoken; then the place, which a screen reader reads as written.
      items.push(
        centredLine(drawn, '', 'Tinos-Regular', size, centre + offset, baseline + offset, greetings.shadowColor).run,
        centredLine(drawn, place, 'Tinos-Regular', size, centre, baseline, greetings.placeColor).run
      );
    }
  }
  return items;
}
