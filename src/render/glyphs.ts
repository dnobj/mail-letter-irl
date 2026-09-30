import type { Font, GlyphRun } from 'fontkit';
import { loadFont } from './fonts.js';
import type { TextRun } from './layout.js';

/**
 * Shapes text that is already in visual order (bidi.ts), left to right.
 *
 * fontkit otherwise guesses the direction from the first letter's script and
 * reverses a run it takes to be right to left: a line or word that starts in
 * Hebrew would be reversed a second time. pdfkit makes it worse by shaping
 * word by word, so the PDF and the preview would disagree. Passing 'ltr'
 * keeps the order the layout decided.
 */
export function shape(font: Font, text: string): GlyphRun {
  return font.layout(text, undefined, undefined, undefined, 'ltr');
}

/** One glyph of a run: where its origin sits on the page, and its outline. */
export interface PlacedGlyph {
  /** Font, size and glyph id: the same key always means the same outline. */
  key: string;
  x: number;
  y: number;
  /** SVG path data at the run's size, y growing downward, origin on the baseline. */
  outline: string;
}

/** Short, stable codes for the font part of glyph keys. */
const FONT_CODES: Record<string, string> = { 'Tinos-Regular': 'tr' };

const outlineCache = new Map<string, string>();

/**
 * Every visible glyph of a text run, positioned. The PDF (pdf.ts) and the
 * preview (preview.ts) both draw exactly this, so they cannot disagree.
 */
export function placeGlyphs(run: TextRun): PlacedGlyph[] {
  const font = loadFont(run.font);
  const scale = run.size / font.unitsPerEm;
  const shaped = shape(font, run.text);
  const placed: PlacedGlyph[] = [];
  let x = run.x;
  shaped.glyphs.forEach((glyph, index) => {
    const position = shaped.positions[index];
    const key = `${FONT_CODES[run.font] ?? run.font}${run.size}-${glyph.id}`;
    let outline = outlineCache.get(key);
    if (outline === undefined) {
      outline = glyph.path.scale(scale, -scale).toSVG();
      outlineCache.set(key, outline);
    }
    if (outline) {
      placed.push({ key, x: x + position.xOffset * scale, y: run.baseline - position.yOffset * scale, outline });
    }
    x += position.xAdvance * scale;
  });
  return placed;
}
