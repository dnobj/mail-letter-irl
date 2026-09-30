import LineBreaker from 'linebreak';
import { visualOrder } from './bidi.js';
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

export interface LayoutPage {
  items: Array<TextRun | ImageBox>;
  linesUsed: number;
  linesAvailable: number;
}

export interface Layout {
  width: number;
  height: number;
  pages: LayoutPage[];
  /** How many lines the text runs past the page; 0 when it fits. */
  overflowLines: number;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** The legacy HTML showed an image at most at its intrinsic CSS size: 96 px per inch. */
const POINTS_PER_CSS_PIXEL = 72 / 96;

/** Tabs have no glyph in Tinos; a tab becomes four spaces. */
const TAB = '    ';

function fitImage(image: RenderImage, maxHeight: number): { width: number; height: number } {
  const scale = Math.min(CONTENT_WIDTH / image.width, maxHeight / image.height, POINTS_PER_CSS_PIXEL);
  return { width: image.width * scale, height: image.height * scale };
}

/**
 * Breaks one paragraph (no newlines) into lines no wider than `width`, at
 * Unicode line-break opportunities, greedily, as CSS `white-space: pre-wrap`
 * with `word-wrap: break-word` does: spaces before a break hang and are not
 * drawn, leading spaces are kept, and a word wider than the line breaks
 * between grapheme clusters.
 */
export function wrapParagraph(paragraph: string, width: number, measure: (text: string) => number): string[] {
  if (paragraph.trim() === '') return [''];
  const breaks: number[] = [];
  const breaker = new LineBreaker(paragraph);
  for (let next = breaker.nextBreak(); next; next = breaker.nextBreak()) breaks.push(next.position);

  const lines: string[] = [];
  let start = 0;
  let index = 0;
  while (start < paragraph.length) {
    let fit = -1;
    for (; index < breaks.length; index++) {
      const end = breaks[index];
      if (end <= start) continue;
      if (measure(paragraph.slice(start, end).trimEnd()) > width) break;
      fit = end;
    }
    if (fit === -1) {
      // The next piece alone is wider than the line: take as many whole
      // grapheme clusters as fit, and at least one.
      const end = breaks[index] ?? paragraph.length;
      let taken = 0;
      for (const { segment } of graphemes.segment(paragraph.slice(start, end))) {
        if (taken > 0 && measure(paragraph.slice(start, start + taken + segment.length)) > width) break;
        taken += segment.length;
      }
      lines.push(paragraph.slice(start, start + taken));
      start += taken;
      continue;
    }
    lines.push(paragraph.slice(start, fit).trimEnd());
    start = fit;
  }
  return lines;
}

/**
 * Lays out a one-page letter in the three layouts the legacy HTML printed:
 * text only; a header image above the text; or the text with the enclosed
 * image after it. Positions are PDF points from the page's top-left corner.
 * Lines past the page are still laid out, so `overflowLines` can say by how
 * much a letter is too long.
 */
export function layoutLetter(content: LetterContent): Layout {
  const fontName: FontName = 'Tinos-Regular';
  const font = loadFont(fontName);
  const size = BODY_FONT_SIZE;
  const scale = size / font.unitsPerEm;
  const measure = (text: string) => shape(font, visualOrder(text)).advanceWidth * scale;
  // As CSS places a baseline inside a line box: half the leading, then the ascent.
  const baselineOffset = (LINE_PITCH - (font.ascent - font.descent) * scale) / 2 + font.ascent * scale;

  const items: Array<TextRun | ImageBox> = [];
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

  const lines = content.text
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, TAB)
    .split('\n')
    .flatMap(paragraph => wrapParagraph(paragraph, CONTENT_WIDTH, measure));

  lines.forEach((source, index) => {
    const text = visualOrder(source);
    if (text.trim() === '') return;
    items.push({ kind: 'text', font: fontName, size, x: SIDE_MARGIN, baseline: textTop + index * LINE_PITCH + baselineOffset, text, source });
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
