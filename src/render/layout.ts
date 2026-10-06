import LineBreaker from 'linebreak';
import { isInvisible, mirrorOf, paragraphBidi } from './bidi.js';
import { loadFont, type FontName } from './fonts.js';
import { shape } from './glyphs.js';
import {
  BODY_BOTTOM, BODY_TOP, CONTENT_WIDTH, CONTINUATION_TOP, HEADER_IMAGE_MAX_HEIGHT, IMAGE_GAP,
  INLINE_IMAGE_MAX_HEIGHT, LINE_PITCH, MAX_LETTER_PAGES, PAGE_HEIGHT, PAGE_WIDTH, SIDE_MARGIN,
  SIGNATURE_LINES, SIGNATURE_MAX_WIDTH, SIGNATURE_PADDING
} from './geometry.js';
import type { RenderImage } from './images.js';
import { clampMarks, MARK, MAX_MARKS_PER_LETTER } from './marks.js';
import { bodyFace, layoutStationery, ruledLines, type Band, type Stationery } from './stationery.js';
import type { LetterLayoutType } from '../contracts/types.js';

export interface LetterContent {
  /** The letter as it prints: body and sign-off (`letterPrintText`). */
  text: string;
  layoutType: LetterLayoutType;
  /** The header image or the enclosed image; ignored by `text_only`. */
  image?: RenderImage;
  /** The letter's theme and what it prints (#563); without one, Classic: today's page. */
  stationery?: Stationery;
  /**
   * The person's signature (#608), drawn in a band of SIGNATURE_LINES lines
   * after the sign-off's first line. `closingParagraph` is that line's
   * paragraph in `text`: the body's paragraphs come first, so it is how many
   * the body has. Without one, the page is exactly the page without it.
   */
  signature?: { image: RenderImage; closingParagraph: number };
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
  /**
   * A hex colour: a postcard front's lettering (#594). Black when left out.
   * The preview writes it into an attribute as it is, so only a hex colour
   * may be one.
   */
  fill?: `#${string}`;
}

export interface ImageBox {
  kind: 'image';
  x: number;
  top: number;
  width: number;
  height: number;
  image: RenderImage;
  /**
   * The rectangle the image is cut to, when it is drawn larger: a bordered
   * postcard front's photo (#594). The page's edge cuts it otherwise.
   */
  clip?: { x: number; top: number; width: number; height: number };
  /**
   * The person's signature (#608), not a picture of the letter's: the preview
   * marks it, so the code that swaps a letter's picture for its small copy
   * leaves it alone.
   */
  role?: 'signature';
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

/**
 * A shape from SVG path data, absolute M, L, C and Z only (what the card's
 * sanitiser keeps), as a theme's sprig or confetti (#563).
 */
export interface PathItem {
  kind: 'path';
  d: string;
  /** A hex colour, or 'none'. */
  fill: string;
  /** A hex colour; no outline without one. */
  stroke?: string;
  strokeWidth?: number;
}

export type LayoutItem = TextRun | ImageBox | BoxItem | RectsItem | PathItem;

export interface LayoutPage {
  items: LayoutItem[];
  linesUsed: number;
  linesAvailable: number;
  /** What a page without text is called, for screen readers: a postcard's front. */
  title?: string;
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
const WHITESPACE = /\s/u;

/** The legacy HTML showed an image at most at its intrinsic CSS size: 96 px per inch. */
const POINTS_PER_CSS_PIXEL = 72 / 96;

/** Tabs have no glyph in the letters' fonts; a tab becomes four spaces. */
const TAB = '    ';

/** Classic's typeface, and the one a caller that names none gets (bodyFace gives a theme's). */
const BODY_FONT: FontName = 'Tinos-Regular';

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
 * Whether the renderer draws a grapheme cluster as written in Tinos, Classic's
 * font: drawsGraphemeIn for it.
 */
export function drawsGrapheme(grapheme: string): boolean {
  return draws(BODY_FONT, grapheme);
}

/**
 * Look-alikes a theme's own face draws for dashes and spaces it lacks (#575
 * review round 3). ChatGPT's text often holds the narrow no-break space and
 * the non-breaking hyphen, and the other fixed-width spaces and dashes turn
 * up too. Tinos draws them all; Cousine and Caveat lack some. Each such
 * character is drawn as the first look-alike its face has, so these themes
 * take what Classic takes. Every entry is one UTF-16 unit for one, so a line
 * drawn with them keeps its length. Classic's Tinos needs none: its page is
 * as it was.
 */
const LOOK_ALIKES: ReadonlyArray<readonly [number, readonly number[]]> = [
  [0x2010, [0x2d]], // hyphen: hyphen-minus
  [0x2011, [0x2010, 0x2d]], // non-breaking hyphen: hyphen, or hyphen-minus
  [0x2012, [0x2013, 0x2d]], // figure dash: en dash, or hyphen-minus
  [0x2015, [0x2014]], // horizontal bar: em dash
  [0x202f, [0xa0]], // narrow no-break space: no-break space
  [0x2007, [0xa0]], // figure space: no-break space
  [0x2000, [0x20]], [0x2001, [0x20]], [0x2002, [0x20]], [0x2003, [0x20]], [0x2004, [0x20]], // the other
  [0x2005, [0x20]], [0x2006, [0x20]], [0x2008, [0x20]], [0x2009, [0x20]], [0x200a, [0x20]] //   fixed-width spaces: space
];

const lookAlikeCache = new Map<FontName, ReadonlyMap<string, string>>();

/** Each character a theme's own face lacks and draws as a look-alike, with it. None for Tinos. */
function lookAlikes(fontName: FontName): ReadonlyMap<string, string> {
  let found = lookAlikeCache.get(fontName);
  if (!found) {
    const font = loadFont(fontName);
    const map = new Map<string, string>();
    if (fontName !== BODY_FONT) {
      for (const [codePoint, alikes] of LOOK_ALIKES) {
        if (font.hasGlyphForCodePoint(codePoint)) continue;
        const alike = alikes.find(candidate => font.hasGlyphForCodePoint(candidate));
        if (alike !== undefined) map.set(String.fromCodePoint(codePoint), String.fromCodePoint(alike));
      }
    }
    lookAlikeCache.set(fontName, (found = map));
  }
  return found;
}

/**
 * `text` as `fontName` draws it: each character the face lacks and has a
 * look-alike for, replaced one for one. Lines break, and runs are ordered,
 * as the text was written (wrapText); only the drawing changes.
 */
export function inFace(fontName: FontName, text: string): string {
  const map = lookAlikes(fontName);
  if (map.size === 0) return text;
  let drawn = '';
  for (const character of text) drawn += map.get(character) ?? character;
  return drawn;
}

/**
 * The check for one font: whether the renderer draws a grapheme cluster as
 * written in it, with the face's look-alikes. A theme with its own face
 * (#563) checks its text against that face, which may draw less than Tinos:
 * Caveat has no Greek, Hebrew or Vietnamese.
 */
export function drawsGraphemeIn(fontName: FontName): (grapheme: string) => boolean {
  return grapheme => draws(fontName, grapheme);
}

/** Per font, whether a cluster of more than one character shapes cleanly. */
const shapesCache = new Map<FontName, Map<string, boolean>>();

/**
 * The most clusters kept per font. The text chooses them, so the cache is
 * emptied when it fills rather than growing without end (#575 review round
 * 5); shaping one again takes microseconds.
 */
export const SHAPES_CACHE_LIMIT = 4096;

/** How many clusters are kept for a font, for tests. */
export function shapedClusterCount(fontName: FontName): number {
  return shapesCache.get(fontName)?.size ?? 0;
}

/**
 * Whether a cluster of more than one visible character, a letter and its
 * marks, shapes in a font with no missing glyph and no failure. fontkit's
 * mark positioning throws on many of Caveat's letters with a separate
 * accent, such as "i" and U+0301 (#575 review round 4), where the layout
 * would fail; a cluster that shapes alone shapes in a line too.
 */
function shapes(fontName: FontName, cluster: string): boolean {
  let cache = shapesCache.get(fontName);
  if (!cache) shapesCache.set(fontName, (cache = new Map()));
  let clean = cache.get(cluster);
  if (clean === undefined) {
    try {
      clean = shape(loadFont(fontName), cluster).glyphs.every(glyph => glyph.id !== 0);
    } catch {
      clean = false;
    }
    if (cache.size >= SHAPES_CACHE_LIMIT) cache.clear();
    cache.set(cluster, clean);
  }
  return clean;
}

/**
 * Whether the renderer draws a grapheme cluster as written in a font: each
 * character is a line break, a tab, a character that prints nothing, or one
 * the font has a glyph for (a space's glyph drawing nothing: Tinos draws
 * U+205F as a box), and the cluster carries at most MAX_MARKS_PER_LETTER
 * combining marks, which the font can place on their letter. A preview
 * refuses text holding a cluster that fails, rather than printing a box,
 * dropping a mark or failing to lay out.
 */
function draws(fontName: FontName, grapheme: string): boolean {
  const font = loadFont(fontName);
  let marks = 0;
  const drawn = inFace(fontName, grapheme);
  const visible: string[] = [];
  for (const character of drawn) {
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
    visible.push(character);
  }
  return visible.length < 2 || shapes(fontName, visible.join(''));
}

function fitImage(image: RenderImage, maxHeight: number): { width: number; height: number } {
  const scale = Math.min(CONTENT_WIDTH / image.width, maxHeight / image.height, POINTS_PER_CSS_PIXEL);
  return { width: image.width * scale, height: image.height * scale };
}

/** A signature's box inside its band (#608): as large as fits, never past CSS pixel size, as fitImage. */
function fitSignature(image: RenderImage): { width: number; height: number } {
  const maxHeight = SIGNATURE_LINES * LINE_PITCH - 2 * SIGNATURE_PADDING;
  const scale = Math.min(SIGNATURE_MAX_WIDTH / image.width, maxHeight / image.height, POINTS_PER_CSS_PIXEL);
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
 * `text` wrapped to `width` at `size` in `fontName` (Tinos unless named):
 * paragraphs at line breaks, tabs as four spaces, at most four marks a letter.
 * Bidi levels are resolved for each whole paragraph, and each line is
 * measured exactly as it will be drawn.
 */
export function wrapText(text: string, size: number, width: number, fontName: FontName = BODY_FONT): WrappedLine[] {
  return wrapParagraphs(text, size, width, fontName).flat();
}

/** wrapText's lines, paragraph by paragraph: where a paragraph ends, for a signature's band (#608). */
function wrapParagraphs(text: string, size: number, width: number, fontName: FontName): WrappedLine[][] {
  const font = loadFont(fontName);
  const scale = size / font.unitsPerEm;
  const wrapped: WrappedLine[][] = [];
  const paragraphs = clampMarks(text).replace(/\r\n?/g, '\n').replace(/\t/g, TAB).split('\n');
  for (const paragraph of paragraphs) {
    const lines: WrappedLine[] = [];
    wrapped.push(lines);
    const bidi = paragraphBidi(paragraph);
    // A line is drawn with the face's look-alikes, but breaks and orders as
    // written: a non-breaking hyphen drawn as a hyphen still never breaks.
    const visual = (start: number, end: number) => inFace(fontName, bidi.lineVisual(start, end));
    const measure = (start: number, end: number) => shape(font, visual(start, end)).advanceWidth * scale;
    const limit = advanceLimit(fontName, inFace(fontName, paragraph), width, scale);
    for (const { start, end } of wrapParagraph(paragraph, width, measure, limit)) {
      lines.push({ source: paragraph.slice(start, end), drawn: visual(start, end) });
    }
  }
  return wrapped;
}

/**
 * Where a baseline sits in a line box `pitch` tall, as CSS places it: half
 * the leading, then the ascent, of `fontName` (Tinos unless named).
 */
export function baselineOffset(size: number, pitch: number, fontName: FontName = BODY_FONT): number {
  const font = loadFont(fontName);
  const scale = size / font.unitsPerEm;
  return (pitch - (font.ascent - font.descent) * scale) / 2 + font.ascent * scale;
}

export interface LayoutOptions {
  /**
   * The most pages the letter may fill (#586): 1, as every letter has been,
   * up to MAX_LETTER_PAGES. A letter that fits one page is laid out exactly
   * as it always was, whatever the limit.
   */
  maxPages?: number;
}

/** What the layout of a letter starts from: its face, its first page's top, its wrapped lines. */
interface PreparedLetter {
  stationery: Stationery;
  fontName: FontName;
  size: number;
  baseline: number;
  /** What the theme and a header image draw on the first page, above the text. */
  firstPageItems: LayoutItem[];
  /** Where the text starts on the first page. */
  textTop: number;
  image?: RenderImage;
  /** The enclosed image's box, for an inline_image letter with its image. */
  inlineBox?: { width: number; height: number };
  lines: LetterLine[];
  /** The signature and its box, when the letter has one (#608). */
  signature?: { image: RenderImage; width: number; height: number };
}

/** A wrapped line, or one of the lines a signature's band takes, which hold no text (#608). */
type LetterLine = WrappedLine & { signature?: true };

function prepareLetter(content: LetterContent): PreparedLetter {
  const stationery = content.stationery ?? { theme: 'classic' };
  const { font: fontName, size } = bodyFace(stationery.theme);
  const baseline = baselineOffset(size, LINE_PITCH, fontName);

  const theme = layoutStationery(stationery, BODY_TOP);
  const firstPageItems: LayoutItem[] = [...theme.items];
  const bodyTop = BODY_TOP + theme.bodyOffset;
  // Each branch checks the layout, so a text-only letter never places an image.
  const { image } = content;
  let textTop = bodyTop;
  if (image && content.layoutType === 'header_image') {
    const box = fitImage(image, HEADER_IMAGE_MAX_HEIGHT);
    firstPageItems.push({ kind: 'image', x: SIDE_MARGIN + (CONTENT_WIDTH - box.width) / 2, top: bodyTop, ...box, image });
    textTop = bodyTop + box.height + IMAGE_GAP;
  }
  const inlineBox = image && content.layoutType === 'inline_image' ? fitImage(image, INLINE_IMAGE_MAX_HEIGHT) : undefined;
  const paragraphs = wrapParagraphs(content.text, size, CONTENT_WIDTH, fontName);
  const lines: LetterLine[] = paragraphs.flat();
  let signature: PreparedLetter['signature'];
  if (content.signature) {
    // After the closing's last line: every line through its paragraph, all of them for one past the text.
    const after = paragraphs
      .slice(0, Math.max(0, content.signature.closingParagraph) + 1)
      .reduce((count, paragraph) => count + paragraph.length, 0);
    const band: LetterLine[] = Array.from({ length: SIGNATURE_LINES }, () => ({ source: '', drawn: '', signature: true }));
    lines.splice(after, 0, ...band);
    signature = { image: content.signature.image, ...fitSignature(content.signature.image) };
  }
  return { stationery, fontName, size, baseline, firstPageItems, textTop, image, inlineBox, lines, signature };
}

/**
 * A page break never parts a signature from the closing it is under (#608):
 * when the page would end after the closing line but before the band's last
 * line, the closing and the band start the next page. `count` lines from
 * `start` are the page as it would be; the page as it is is returned.
 */
function keepSignatureWithClosing(lines: LetterLine[], start: number, count: number): number {
  const band = lines.findIndex(line => line.signature);
  if (band < 1) return count;
  const closing = band - 1;
  const end = start + count;
  return closing > start && end > closing && end < band + SIGNATURE_LINES ? closing - start : count;
}

/** How many whole lines fit between two heights on a page. */
function linesBetween(top: number, bottom: number): number {
  return Math.max(0, Math.floor((bottom - top + 1e-6) / LINE_PITCH));
}

/**
 * One page's items: Handwritten's rules (none where an image or the
 * signature sits), the text from `top`, the signature in its band, then the
 * enclosed image if it is on this page.
 */
function pageItems(
  letter: PreparedLetter,
  start: LayoutItem[],
  top: number,
  lines: LetterLine[],
  inlineTop?: number
): LayoutItem[] {
  const items = [...start];
  const { fontName, size, baseline, inlineBox, image, signature } = letter;
  // The signature's band, when it is on this page: all of it is, after keepSignatureWithClosing.
  const band = signature ? lines.findIndex(line => line.signature) : -1;
  const bandTop = top + band * LINE_PITCH;
  if (letter.stationery.theme === 'handwritten') {
    const covered: Band[] = inlineBox && inlineTop !== undefined ? [{ top: inlineTop, bottom: inlineTop + inlineBox.height }] : [];
    // A hair inside its lines: the band's edges fall exactly on two lines' edges, and
    // floating point would otherwise cover the lines above and below it too.
    if (band >= 0) covered.push({ top: bandTop + 1e-6, bottom: bandTop + SIGNATURE_LINES * LINE_PITCH - 1e-6 });
    const rules = ruledLines(top, BODY_BOTTOM, baseline, covered);
    if (rules) items.push(rules);
  }
  lines.forEach(({ source, drawn }, index) => {
    if (drawn.trim() === '') return;
    items.push({ kind: 'text', font: fontName, size, x: SIDE_MARGIN, baseline: top + index * LINE_PITCH + baseline, text: drawn, source });
  });
  if (signature && band >= 0) {
    items.push({
      kind: 'image',
      x: SIDE_MARGIN,
      top: bandTop + SIGNATURE_PADDING,
      width: signature.width,
      height: signature.height,
      image: signature.image,
      role: 'signature'
    });
  }
  if (inlineBox && image && inlineTop !== undefined) {
    items.push({ kind: 'image', x: SIDE_MARGIN + (CONTENT_WIDTH - inlineBox.width) / 2, top: inlineTop, ...inlineBox, image });
  }
  return items;
}

/**
 * Lays out a letter in the three layouts the legacy HTML printed: text only;
 * a header image above the text; or the text with the enclosed image after
 * it. Positions are PDF points from the page's top-left corner.
 *
 * A theme (stationery.ts) draws first, in the corner and above the body; the
 * body then starts below anything it put there, in the theme's face. Classic
 * draws nothing, so its page is exactly the page without a theme. Handwritten
 * rules each line the page has room for, except where an image sits.
 *
 * With `maxPages` above 1 (#586), a letter that does not fit one page flows on
 * to further pages. Lines past the last page allowed are still laid out, on
 * that page, so `overflowLines` can say by how much a letter is too long.
 */
export function layoutLetter(content: LetterContent, options: LayoutOptions = {}): Layout {
  const maxPages = options.maxPages ?? 1;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_LETTER_PAGES) {
    throw new RangeError(`A letter lays out on 1 to ${MAX_LETTER_PAGES} pages, not ${maxPages}`);
  }
  const letter = prepareLetter(content);
  const single = layoutOnePage(letter);
  return maxPages === 1 || single.overflowLines === 0 ? single : flowPages(letter, maxPages);
}

/**
 * One page, as every letter was laid out before #586: the lines from the
 * text's top, the enclosed image after them, room kept for that image.
 */
function layoutOnePage(letter: PreparedLetter): Layout {
  const { textTop, inlineBox, lines } = letter;
  const reserved = inlineBox ? IMAGE_GAP + inlineBox.height : 0;
  const inlineTop = inlineBox ? textTop + lines.length * LINE_PITCH + IMAGE_GAP : undefined;
  const linesAvailable = Math.max(0, Math.floor((BODY_BOTTOM - textTop - reserved + 1e-6) / LINE_PITCH));
  return {
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    pages: [{ items: pageItems(letter, letter.firstPageItems, textTop, lines, inlineTop), linesUsed: lines.length, linesAvailable }],
    overflowLines: Math.max(0, lines.length - linesAvailable)
  };
}

/**
 * A letter too long for one page, over up to `maxPages` pages (#586). The
 * theme and a header image stay on the first page; later pages start at
 * CONTINUATION_TOP, never with the blank lines between paragraphs. The
 * enclosed image follows the last line where it fits on that page, or starts
 * the next page; it is never split. Lines past the last page allowed stay on
 * it, counted in `overflowLines`, as does an image with no page left for it.
 */
function flowPages(letter: PreparedLetter, maxPages: number): Layout {
  const { lines, inlineBox } = letter;
  const placed: Array<{ top: number; lines: LetterLine[] }> = [];
  let overflowLines = 0;
  let next = 0;
  for (let index = 0; index < maxPages && next < lines.length; index += 1) {
    if (index > 0) while (next < lines.length && lines[next].drawn.trim() === '' && !lines[next].signature) next += 1;
    if (next >= lines.length) break;
    const top = index === 0 ? letter.textTop : CONTINUATION_TOP;
    const capacity = linesBetween(top, BODY_BOTTOM);
    const last = index === maxPages - 1;
    const count = last ? lines.length - next : keepSignatureWithClosing(lines, next, Math.min(capacity, lines.length - next));
    placed.push({ top, lines: lines.slice(next, next + count) });
    next += count;
    if (last) overflowLines = Math.max(0, count - capacity);
  }

  // The enclosed image: after the last line, or at the top of a page of its own.
  let imagePage = -1;
  let imageTop = 0;
  if (inlineBox) {
    const end = placed[placed.length - 1];
    const after = end.top + end.lines.length * LINE_PITCH + IMAGE_GAP;
    if (overflowLines === 0 && after + inlineBox.height <= BODY_BOTTOM + 1e-6) {
      [imagePage, imageTop] = [placed.length - 1, after];
    } else if (overflowLines === 0 && placed.length < maxPages) {
      placed.push({ top: CONTINUATION_TOP, lines: [] });
      [imagePage, imageTop] = [placed.length - 1, CONTINUATION_TOP];
    } else {
      // No page left for it: laid out after the last line, past the page. The
      // letter is over by the lines past the room that page keeps for the
      // image, as one page counts it (#587 review round 1).
      [imagePage, imageTop] = [placed.length - 1, after];
      overflowLines = Math.max(0, end.lines.length - linesBetween(end.top, BODY_BOTTOM - (IMAGE_GAP + inlineBox.height)));
    }
  }

  return {
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    pages: placed.map(({ top, lines: pageLines }, index) => {
      const withImage = index === imagePage && inlineBox !== undefined;
      const reserved = withImage ? IMAGE_GAP + inlineBox.height : 0;
      return {
        items: pageItems(letter, index === 0 ? letter.firstPageItems : [], top, pageLines, withImage ? imageTop : undefined),
        linesUsed: pageLines.length,
        linesAvailable: linesBetween(top, BODY_BOTTOM - reserved)
      };
    }),
    overflowLines
  };
}

/** What a letter's pages hold, and the room left on its last: for the card's fit meter (#586). */
export interface PageFit {
  /** The most pages the letter may run to now, where the card's words editor shows it (#647): 1 without room to write. */
  maxPages?: number;
  /** The letter's pages, a gift page not among them. */
  pages: number;
  /** Sheets of paper: a letter of more than one page prints on both sides. */
  sheets: number;
  doubleSided: boolean;
  /** Each page's lines: used, and how many it holds. */
  lines: Array<{ used: number; available: number }>;
  /**
   * Lines still free on the last page; none for a letter that runs past its
   * pages. Only the last page's: when the enclosed image sits alone there, the
   * page before may hold more lines too, so the letter has more room than this.
   */
  roomLines: number;
  /** About how many characters those lines hold, at the face's average width. */
  roomCharacters: number;
  /** About how many characters a line holds, at the face's average width. */
  charactersPerLine: number;
}

/** Prose to average a face's character width over: letters, with their spaces. */
const AVERAGE_SAMPLE = 'the quick brown fox jumps over the lazy dog while letters wait to be written';

/**
 * How full a letter's layout is (#586): `layout` as layoutLetter returned
 * it, before any gift page is added; `stationery` the letter's, for its face.
 */
export function pageFit(layout: Layout, stationery?: Stationery): PageFit {
  const { font: fontName, size } = bodyFace((stationery ?? { theme: 'classic' }).theme);
  const font = loadFont(fontName);
  const average = (shape(font, AVERAGE_SAMPLE).advanceWidth * size) / font.unitsPerEm / AVERAGE_SAMPLE.length;
  const charactersPerLine = Math.floor(CONTENT_WIDTH / average);
  const pages = layout.pages.length;
  const last = layout.pages[pages - 1];
  const roomLines = layout.overflowLines > 0 || !last ? 0 : Math.max(0, last.linesAvailable - last.linesUsed);
  return {
    pages,
    sheets: pages > 1 ? Math.ceil(pages / 2) : 1,
    doubleSided: pages > 1,
    lines: layout.pages.map(page => ({ used: page.linesUsed, available: page.linesAvailable })),
    roomLines,
    roomCharacters: roomLines * charactersPerLine,
    charactersPerLine
  };
}
