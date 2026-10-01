import LineBreaker from 'linebreak';
import { isInvisible, mirrorOf, paragraphBidi } from './bidi.js';
import { loadFont, type FontName } from './fonts.js';
import { shape } from './glyphs.js';
import {
  BODY_BOTTOM, BODY_FONT_SIZE, BODY_TOP, CONTENT_WIDTH, HEADER_IMAGE_MAX_HEIGHT, IMAGE_GAP,
  INLINE_IMAGE_MAX_HEIGHT, LINE_PITCH, PAGE_HEIGHT, PAGE_WIDTH, SIDE_MARGIN
} from './geometry.js';
import type { RenderImage } from './images.js';
import type { LetterLayoutType } from '../contracts/types.js';

export interface LetterContent {
  /** The letter as it prints: body and sign-off (`letterPrintText`). */
  text: string;
  layoutType: LetterLayoutType;
  /** The header image or the enclosed image; ignored by `text_only`. */
  image?: RenderImage;
}

/** One line of text, drawn from `x` along `baseline`, in visual order. */
export interface TextRun {
  kind: 'text';
  font: FontName;
  size: number;
  x: number;
  baseline: number;
  /** What is drawn, left to right: bidi-reordered, invisible characters removed. */
  text: string;
  /** The same line as written, for text extraction and tests. */
  source: string;
}

export interface ImageBox {
  kind: 'image';
  x: number;
  top: number;
  width: number;
  height: number;
  image: RenderImage;
}

/** A rounded rectangle's outline, as the gift card's border. */
export interface BoxItem {
  kind: 'box';
  x: number;
  top: number;
  width: number;
  height: number;
  radius: number;
  /** A hex colour. */
  stroke: string;
  strokeWidth: number;
}

/** Filled rectangles in one colour, as a QR code's modules. */
export interface RectsItem {
  kind: 'rects';
  /** A hex colour. */
  fill: string;
  rects: Array<{ x: number; top: number; width: number; height: number }>;
}

export type LayoutItem = TextRun | ImageBox | BoxItem | RectsItem;

export interface LayoutPage {
  items: LayoutItem[];
  linesUsed: number;
  linesAvailable: number;
}

export interface Layout {
  width: number;
  height: number;
  pages: LayoutPage[];
  /** The PDF's title; a letter's when absent. */
  title?: string;
  /** How many lines the text runs past the page; 0 when it fits. */
  overflowLines: number;
}

/** A line of a paragraph: code units [start, end), trailing spaces excluded. */
export interface LineRange {
  start: number;
  end: number;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const MARK = /\p{M}/u;
const WHITESPACE = /\s/u;

/** The legacy HTML showed an image at most at its intrinsic CSS size: 96 px per inch. */
const POINTS_PER_CSS_PIXEL = 72 / 96;

/** Tabs have no glyph in Tinos; a tab becomes four spaces. */
const TAB = '    ';

/** The letter's typeface. */
const BODY_FONT: FontName = 'Tinos-Regular';

/**
 * Combining marks kept on one letter. Hebrew can carry four (a dagesh, a shin
 * dot, a vowel and a meteg); more stack upward, 2.6pt each on a capital, and
 * the first line's would reach the address boxes. Previews refuse such text
 * (drawsGrapheme); clampMarks only keeps the layout's promise.
 */
const MAX_MARKS_PER_LETTER = 4;

/**
 * Characters never drawn, whatever the font maps them to: controls other than
 * line breaks and tabs, format characters that are not dropped as invisible,
 * line and paragraph separators, private use, surrogates and unassigned code
 * points. Tinos maps some of them to a visible "control picture" box (U+2028,
 * U+2029, and private-use U+F001-U+F00E), and U+0000 to an empty glyph that
 * PostgreSQL then refuses to store (#540 review round 1).
 */
const NEVER_DRAWN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Cs}]/u;
const SPACE = /\p{Zs}/u;

/**
 * Whether the renderer draws a grapheme cluster as written: each character
 * is a line break, a tab, a character that prints nothing, or one the
 * letter's font has a glyph for (a space's glyph drawing nothing: Tinos draws
 * U+205F as a box), and the cluster carries at most MAX_MARKS_PER_LETTER
 * combining marks. A preview refuses text holding a cluster that fails,
 * rather than printing a box or dropping a mark.
 */
export function drawsGrapheme(grapheme: string): boolean {
  const font = loadFont(BODY_FONT);
  let marks = 0;
  for (const character of grapheme) {
    if (MARK.test(character) && ++marks > MAX_MARKS_PER_LETTER) return false;
    if (character === '\n' || character === '\r' || character === '\t' || isInvisible(character)) continue;
    if (NEVER_DRAWN.test(character)) return false;
    const codePoint = character.codePointAt(0)!;
    if (!font.hasGlyphForCodePoint(codePoint)) return false;
    if (SPACE.test(character) && font.glyphForCodePoint(codePoint).path.commands.length > 0) return false;
    // In a right-to-left run the mirror is drawn instead (bidi.ts): Tinos has
    // U+2215 and U+221F but not their mirrors (#540 review round 2).
    const mirror = mirrorOf(character);
    if (mirror && !font.hasGlyphForCodePoint(mirror.codePointAt(0)!)) return false;
  }
  return true;
}

function clampMarks(text: string): string {
  if (!MARK.test(text)) return text;
  let clamped = '';
  for (const { segment } of graphemes.segment(text)) {
    let marks = 0;
    for (const character of segment) {
      if (MARK.test(character) && ++marks > MAX_MARKS_PER_LETTER) continue;
      clamped += character;
    }
  }
  return clamped;
}

function fitImage(image: RenderImage, maxHeight: number): { width: number; height: number } {
  const scale = Math.min(CONTENT_WIDTH / image.width, maxHeight / image.height, POINTS_PER_CSS_PIXEL);
  return { width: image.width * scale, height: image.height * scale };
}

/**
 * Breaks one paragraph (no newlines) into lines no wider than `width`, at
 * Unicode line-break opportunities, greedily, as CSS `white-space: pre-wrap`
 * with `word-wrap: break-word` does: spaces before a break hang and are not
 * drawn or counted, leading spaces are kept, and a piece wider than the line
 * breaks between grapheme clusters. A run of spaces that ends at a break
 * hangs too, even at a paragraph's start: an indent too wide to share a line
 * with the first word is dropped, where a browser would leave a blank line.
 *
 * `measure(start, end)` is the drawn width of the paragraph's [start, end).
 * `fitLimit(start)` is an index past which no line from `start` can fit, a
 * cheap bound; longer candidates count as too wide without being shaped, so a
 * long unbroken run costs a few shapings per line, not the whole remainder.
 */
export function wrapParagraph(
  paragraph: string,
  width: number,
  measure: (start: number, end: number) => number,
  fitLimit: (start: number) => number = () => paragraph.length
): LineRange[] {
  if (paragraph.trim() === '') return [{ start: 0, end: 0 }];
  const trimmedEnd = (start: number, end: number) => {
    while (end > start && WHITESPACE.test(paragraph[end - 1])) end -= 1;
    return end;
  };
  // Hanging spaces never count, so the limit applies to the trimmed end too.
  const fits = (start: number, end: number, limit: number) => {
    const trimmed = trimmedEnd(start, end);
    return trimmed <= limit && measure(start, trimmed) <= width;
  };

  const breaks: number[] = [];
  const breaker = new LineBreaker(paragraph);
  for (let next = breaker.nextBreak(); next; next = breaker.nextBreak()) breaks.push(next.position);

  const lines: LineRange[] = [];
  // Spaces before a break hang: a stretch of only spaces is not a line.
  const push = (start: number, end: number) => {
    const trimmed = trimmedEnd(start, end);
    if (trimmed > start) lines.push({ start, end: trimmed });
  };
  let start = 0;
  let index = 0;
  while (start < paragraph.length) {
    const limit = fitLimit(start);
    let fit = -1;
    for (; index < breaks.length; index++) {
      const end = breaks[index];
      if (end <= start) continue;
      if (!fits(start, end, limit)) break;
      fit = end;
    }
    if (fit !== -1) {
      push(start, fit);
      start = fit;
      continue;
    }
    // The next piece alone is wider than the line: take as many whole grapheme
    // clusters as fit, and at least one, found by binary search.
    const pieceEnd = breaks[index] ?? paragraph.length;
    const stop = Math.min(pieceEnd, limit);
    const ends: number[] = [];
    for (const { segment, index: offset } of graphemes.segment(paragraph.slice(start, pieceEnd))) {
      const end = start + offset + segment.length;
      if (ends.length > 0 && end > stop) break;
      ends.push(end);
    }
    let [low, high, best] = [1, ends.length - 1, 0];
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (fits(start, ends[middle], limit)) {
        best = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    push(start, ends[best]);
    start = ends[best];
  }
  return lines.length > 0 ? lines : [{ start: 0, end: 0 }];
}

/** Each character's own advance, in font units, per font. */
const advanceCache = new Map<string, Map<number, number>>();

/**
 * An index past which no line from `start` can fit: where the sum of the
 * characters' own advances, without kerning, passes half again the width.
 * Kerning never takes back a third of a line (review round 2: the worst
 * allow-listed line in Tinos sums to 1.28 times its shaped width), so nothing
 * that fits is cut.
 */
function advanceLimit(fontName: FontName, paragraph: string, width: number, scale: number) {
  const font = loadFont(fontName);
  let advances = advanceCache.get(fontName);
  if (!advances) advanceCache.set(fontName, (advances = new Map()));
  const cache = advances;
  const advanceOf = (codePoint: number) => {
    let units = cache.get(codePoint);
    if (units === undefined) {
      units = font.hasGlyphForCodePoint(codePoint) ? font.glyphForCodePoint(codePoint).advanceWidth : 0;
      cache.set(codePoint, units);
    }
    return units * scale;
  };
  return (start: number): number => {
    let total = 0;
    for (let index = start; index < paragraph.length;) {
      const codePoint = paragraph.codePointAt(index)!;
      const character = String.fromCodePoint(codePoint);
      if (!isInvisible(character) && !MARK.test(character)) total += advanceOf(codePoint);
      index += character.length;
      if (total > width * 1.5) return index;
    }
    return paragraph.length;
  };
}

/** One wrapped line: as written, and as drawn (bidi-reordered, invisibles removed). */
export interface WrappedLine {
  source: string;
  drawn: string;
}

/**
 * `text` wrapped to `width` at `size` in the letter's font: paragraphs at
 * line breaks, tabs as four spaces, at most four marks a letter. Bidi levels
 * are resolved for each whole paragraph, and each line is measured exactly as
 * it will be drawn.
 */
export function wrapText(text: string, size: number, width: number): WrappedLine[] {
  const font = loadFont(BODY_FONT);
  const scale = size / font.unitsPerEm;
  const lines: WrappedLine[] = [];
  const paragraphs = clampMarks(text).replace(/\r\n?/g, '\n').replace(/\t/g, TAB).split('\n');
  for (const paragraph of paragraphs) {
    const bidi = paragraphBidi(paragraph);
    const measure = (start: number, end: number) => shape(font, bidi.lineVisual(start, end)).advanceWidth * scale;
    for (const { start, end } of wrapParagraph(paragraph, width, measure, advanceLimit(BODY_FONT, paragraph, width, scale))) {
      lines.push({ source: paragraph.slice(start, end), drawn: bidi.lineVisual(start, end) });
    }
  }
  return lines;
}

/**
 * Where a baseline sits in a line box `pitch` tall, as CSS places it: half
 * the leading, then the ascent.
 */
export function baselineOffset(size: number, pitch: number): number {
  const font = loadFont(BODY_FONT);
  const scale = size / font.unitsPerEm;
  return (pitch - (font.ascent - font.descent) * scale) / 2 + font.ascent * scale;
}

/**
 * Lays out a one-page letter in the three layouts the legacy HTML printed:
 * text only; a header image above the text; or the text with the enclosed
 * image after it. Positions are PDF points from the page's top-left corner.
 * Lines past the page are still laid out, so `overflowLines` can say by how
 * much a letter is too long.
 */
export function layoutLetter(content: LetterContent): Layout {
  const fontName = BODY_FONT;
  const size = BODY_FONT_SIZE;
  const baseline = baselineOffset(size, LINE_PITCH);

  const items: LayoutItem[] = [];
  // Each branch checks the layout, so a text-only letter never places an image.
  const { image } = content;
  let textTop = BODY_TOP;
  let reserved = 0;
  if (image && content.layoutType === 'header_image') {
    const box = fitImage(image, HEADER_IMAGE_MAX_HEIGHT);
    items.push({ kind: 'image', x: SIDE_MARGIN + (CONTENT_WIDTH - box.width) / 2, top: BODY_TOP, ...box, image });
    textTop = BODY_TOP + box.height + IMAGE_GAP;
  }
  const inlineBox = image && content.layoutType === 'inline_image' ? fitImage(image, INLINE_IMAGE_MAX_HEIGHT) : undefined;
  if (inlineBox) reserved = IMAGE_GAP + inlineBox.height;

  const lines = wrapText(content.text, size, CONTENT_WIDTH);
  lines.forEach(({ source, drawn }, index) => {
    if (drawn.trim() === '') return;
    items.push({ kind: 'text', font: fontName, size, x: SIDE_MARGIN, baseline: textTop + index * LINE_PITCH + baseline, text: drawn, source });
  });

  const linesAvailable = Math.max(0, Math.floor((BODY_BOTTOM - textTop - reserved + 1e-6) / LINE_PITCH));
  if (inlineBox && image) {
    const top = textTop + lines.length * LINE_PITCH + IMAGE_GAP;
    items.push({ kind: 'image', x: SIDE_MARGIN + (CONTENT_WIDTH - inlineBox.width) / 2, top, ...inlineBox, image });
  }

  return {
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    pages: [{ items, linesUsed: lines.length, linesAvailable }],
    overflowLines: Math.max(0, lines.length - linesAvailable)
  };
}
