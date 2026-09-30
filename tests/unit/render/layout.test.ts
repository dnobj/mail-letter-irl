/**
 * The renderer's layout (#534): one page, the three legacy layouts, measured
 * line breaks, and nothing under PostGrid's address boxes.
 */

import { describe, expect, it, vi } from 'vitest';
import { layoutLetter, wrapParagraph, type Layout, type TextRun } from '../../../src/render/layout.js';

// shape() is spied on, so a test can see what layoutLetter shapes; it still
// does the real work.
vi.mock('../../../src/render/glyphs.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/render/glyphs.js')>();
  return { ...actual, shape: vi.fn(actual.shape) };
});
import { placeGlyphs, shape, type PlacedGlyph } from '../../../src/render/glyphs.js';
import { loadFont } from '../../../src/render/fonts.js';
import {
  ADDRESS_ZONE, BODY_BOTTOM, BODY_TOP, CONTENT_WIDTH, EDGE_CLEARANCE, IMAGE_GAP, LINE_PITCH, PAGE_HEIGHT,
  PAGE_WIDTH, SIDE_MARGIN
} from '../../../src/render/geometry.js';
import type { RenderImage } from '../../../src/render/images.js';

const font = loadFont('Tinos-Regular');
const width = (text: string) => shape(font, text).advanceWidth * 12 / font.unitsPerEm;
/** Wraps with plain measuring, and returns the lines as strings. */
const wrap = (paragraph: string, lineWidth: number, fitLimit?: (start: number) => number) =>
  wrapParagraph(paragraph, lineWidth, (start, end) => width(paragraph.slice(start, end)), fitLimit)
    .map(({ start, end }) => paragraph.slice(start, end));
const runs = (layout: Layout) => layout.pages[0].items.filter((item): item is TextRun => item.kind === 'text');
const image = (pixelWidth: number, pixelHeight: number): RenderImage =>
  ({ bytes: Buffer.alloc(0), mime: 'image/jpeg', width: pixelWidth, height: pixelHeight });
const PARAGRAPH = 'This letter was laid out by our own renderer, and every line should wrap exactly where the preview wraps it, ' +
  'because both are drawn from one layout. '.repeat(3);

/** A placed glyph's real ink box, from its outline's points. */
function inkBox(glyph: PlacedGlyph) {
  const numbers = [...glyph.outline.matchAll(/-?\d+(?:\.\d+)?/g)].map(match => Number(match[0]));
  const xs = numbers.filter((_, index) => index % 2 === 0).map(value => value + glyph.x);
  const ys = numbers.filter((_, index) => index % 2 === 1).map(value => value + glyph.y);
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

describe('wrapping paragraphs (#534)', () => {
  it('breaks between words, never past the content width', () => {
    const lines = wrap(PARAGRAPH.trim(), CONTENT_WIDTH);
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) {
      expect(width(line)).toBeLessThanOrEqual(CONTENT_WIDTH);
      expect(line).toBe(line.trimEnd());
    }
    expect(lines.join(' ')).toBe(PARAGRAPH.trim());
  });

  it('fills each line greedily: the next word would not have fit', () => {
    const lines = wrap(PARAGRAPH.trim(), CONTENT_WIDTH);
    for (let index = 0; index < lines.length - 1; index++) {
      const nextWord = lines[index + 1].split(' ')[0];
      expect(width(`${lines[index]} ${nextWord}`)).toBeGreaterThan(CONTENT_WIDTH);
    }
  });

  it('breaks a word longer than the line between letters, and loses nothing', () => {
    const word = 'Averyveryvery'.repeat(12);
    const lines = wrap(word, CONTENT_WIDTH);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('')).toBe(word);
    for (const line of lines) expect(width(line)).toBeLessThanOrEqual(CONTENT_WIDTH);
    // Greedy between letters too: one more letter would not have fit.
    expect(width(lines[0] + lines[1][0])).toBeGreaterThan(CONTENT_WIDTH);
  });

  it('measures a line without the space it breaks after', () => {
    // A line exactly as wide as "aaa" still holds "aaa": the space before the
    // break hangs and is not counted.
    expect(wrap('aaa aaa', width('aaa'))).toEqual(['aaa', 'aaa']);
  });

  it('keeps leading spaces, and an empty paragraph as one blank line', () => {
    expect(wrap('    indented', CONTENT_WIDTH)).toEqual(['    indented']);
    expect(wrap('', CONTENT_WIDTH)).toEqual(['']);
    expect(wrap('   ', CONTENT_WIDTH)).toEqual(['']);
  });

  it('makes no blank line of spaces that hang past a break (review round 1)', () => {
    expect(wrap(`${' '.repeat(500)}world`, CONTENT_WIDTH)).toEqual(['world']);
    // Non-breaking spaces at the end of a letter-broken line are trimmed too.
    const nbsp = String.fromCodePoint(0xa0);
    for (const line of wrap(`${'x'.repeat(200)}${nbsp.repeat(3)}${'y'.repeat(200)}`, CONTENT_WIDTH)) {
      expect(line).toBe(line.trimEnd());
    }
  });

  it('never shapes past its fit limit, so a long unbroken run stays cheap (review round 1)', () => {
    const paragraph = 'i'.repeat(5000);
    const measured: number[] = [];
    const limit = (start: number) => Math.min(paragraph.length, start + 300);
    const lines = wrapParagraph(paragraph, CONTENT_WIDTH, (start, end) => {
      measured.push(end - start);
      return width(paragraph.slice(start, end));
    }, limit).map(({ start, end }) => paragraph.slice(start, end));
    expect(lines.join('')).toBe(paragraph);
    expect(Math.max(...measured)).toBeLessThanOrEqual(300);
    // A binary search per line, not a shaping per letter.
    expect(measured.length).toBeLessThan(lines.length * 12);
  });

  it('never shapes a candidate the fit limit rules out, on a 20,000-letter unbroken run (review round 3)', () => {
    // shape() is spied on (vi.mock above): without the limit wired into
    // layoutLetter, the first candidate would be the whole 20,000 letters.
    vi.mocked(shape).mockClear();
    const layout = layoutLetter({ text: 'i'.repeat(20000), layoutType: 'text_only' });
    expect(runs(layout).map(run => run.source).join('')).toBe('i'.repeat(20000));
    const shaped = vi.mocked(shape).mock.calls.map(([, text]) => text.length);
    expect(Math.max(...shaped)).toBeLessThan(400);
    // A binary search per line, not a shaping per letter.
    expect(shaped.length).toBeLessThan(layout.pages[0].linesUsed * 12);
  });

  it('survives a very long right-to-left segment without overflowing the stack (review round 3)', () => {
    const rlm = String.fromCodePoint(0x200f);
    const alef = String.fromCodePoint(0x05d0);
    const layout = layoutLetter({ text: alef + rlm.repeat(140000), layoutType: 'text_only' });
    expect(runs(layout).map(run => run.text)).toEqual([alef]);
  });

  it('lets a long run of spaces hang past a break, not indent the next line (review round 2)', () => {
    const layout = layoutLetter({ text: `aaa${' '.repeat(240)}bbb`, layoutType: 'text_only' });
    expect(runs(layout).map(run => run.source)).toEqual(['aaa', 'bbb']);
  });
});

describe('laying out a letter (#534)', () => {
  it('starts the text at the body top, one line pitch apart, at the left margin', () => {
    const layout = layoutLetter({ text: 'One\nTwo\n\nFour', layoutType: 'text_only' });
    const [one, two, four] = runs(layout);
    expect(one.x).toBe(SIDE_MARGIN);
    // As CSS places a baseline in a 19.2pt line box: half the leading, then the ascent.
    const scale = 12 / font.unitsPerEm;
    const halfLeading = (LINE_PITCH - (font.ascent - font.descent) * scale) / 2;
    expect(halfLeading).toBeGreaterThan(2);
    expect(one.baseline).toBeCloseTo(BODY_TOP + halfLeading + font.ascent * scale, 6);
    expect(two.baseline - one.baseline).toBeCloseTo(LINE_PITCH, 6);
    expect(four.baseline - one.baseline).toBeCloseTo(3 * LINE_PITCH, 6);
    expect(layout.pages[0].linesUsed).toBe(4);
  });

  it('fits 26 lines on a text-only page, and says by how much a longer letter overflows', () => {
    const lines = (count: number) => Array.from({ length: count }, (_, index) => `Line ${index + 1}`).join('\n');
    expect(layoutLetter({ text: lines(25), layoutType: 'text_only' }).overflowLines).toBe(0);
    const full = layoutLetter({ text: lines(26), layoutType: 'text_only' });
    expect(full.pages[0].linesAvailable).toBe(26);
    expect(full.overflowLines).toBe(0);
    expect(layoutLetter({ text: lines(27), layoutType: 'text_only' }).overflowLines).toBe(1);
    expect(layoutLetter({ text: lines(29), layoutType: 'text_only' }).overflowLines).toBe(3);
  });

  it('turns a tab into four spaces', () => {
    const [run] = runs(layoutLetter({ text: 'a\tb', layoutType: 'text_only' }));
    expect(run.text).toBe('a    b');
  });

  it('keeps at most four combining marks on a letter, so accents cannot stack into the address boxes', () => {
    const acute = String.fromCodePoint(0x0301);
    const [zalgo] = runs(layoutLetter({ text: `Z${acute.repeat(8)} and more`, layoutType: 'text_only' }));
    expect(zalgo.text).toBe(`Z${acute.repeat(4)} and more`);
    // Hebrew's four (dagesh, shin dot, vowel, meteg) all stay.
    const shin = String.fromCodePoint(0x05e9, 0x05bc, 0x05c1, 0x05b8, 0x05bd);
    const [hebrew] = runs(layoutLetter({ text: shin, layoutType: 'text_only' }));
    expect(hebrew.source).toBe(shin);
  });

  it('puts a header image above the text, centred, capped at 2in and its intrinsic size', () => {
    const layout = layoutLetter({ text: 'Hello', layoutType: 'header_image', image: image(1800, 1200) });
    const [box] = layout.pages[0].items.filter(item => item.kind === 'image');
    if (box.kind !== 'image') throw new Error('no image');
    expect(box.top).toBe(BODY_TOP);
    expect(box.height).toBeCloseTo(144, 6);
    expect(box.width).toBeCloseTo(216, 6);
    expect(box.x + box.width / 2).toBeCloseTo(PAGE_WIDTH / 2, 6);
    const [text] = runs(layout);
    expect(text.baseline).toBeGreaterThan(BODY_TOP + box.height + IMAGE_GAP);
    expect(layout.pages[0].linesAvailable).toBe(Math.floor((BODY_BOTTOM - BODY_TOP - box.height - IMAGE_GAP) / LINE_PITCH));
  });

  it('does not enlarge a small image past its intrinsic size (96 px per inch)', () => {
    const layout = layoutLetter({ text: 'Hello', layoutType: 'header_image', image: image(96, 48) });
    const [box] = layout.pages[0].items.filter(item => item.kind === 'image');
    if (box.kind !== 'image') throw new Error('no image');
    expect(box.width).toBeCloseTo(72, 6);
    expect(box.height).toBeCloseTo(36, 6);
  });

  it('puts an enclosed image after the text, and counts its room against the lines', () => {
    const layout = layoutLetter({ text: 'One\nTwo', layoutType: 'inline_image', image: image(1200, 1800) });
    const [box] = layout.pages[0].items.filter(item => item.kind === 'image');
    if (box.kind !== 'image') throw new Error('no image');
    expect(box.height).toBeCloseTo(216, 6);
    expect(box.top).toBeCloseTo(BODY_TOP + 2 * LINE_PITCH + IMAGE_GAP, 6);
    expect(layout.pages[0].linesAvailable).toBe(Math.floor((BODY_BOTTOM - BODY_TOP - IMAGE_GAP - box.height) / LINE_PITCH));
  });

  it('ignores an image on a text-only letter', () => {
    const layout = layoutLetter({ text: 'Hello', layoutType: 'text_only', image: image(100, 100) });
    expect(layout.pages[0].items.every(item => item.kind === 'text')).toBe(true);
  });

  it('draws no ink under the address boxes or near the edge, in every layout', () => {
    const acute = String.fromCodePoint(0x0301);
    const ringAcute = String.fromCodePoint(0x01fa);
    const text = `${ringAcute}Z${acute.repeat(8)} tall capitals first\n${PARAGRAPH}\n${'Averyverylongword'.repeat(8)}\n\nWarmly,\nTest`;
    for (const layoutType of ['text_only', 'header_image', 'inline_image'] as const) {
      const layout = layoutLetter({ text, layoutType, image: image(1800, 1200) });
      for (const item of layout.pages[0].items) {
        const boxes = item.kind === 'image'
          ? [{ left: item.x, top: item.top, right: item.x + item.width, bottom: item.top + item.height }]
          : placeGlyphs(item).map(inkBox);
        for (const box of boxes) {
          const overlapsZone = box.left < ADDRESS_ZONE.right && box.right > ADDRESS_ZONE.left &&
            box.top < ADDRESS_ZONE.bottom && box.bottom > ADDRESS_ZONE.top;
          expect(overlapsZone, `${layoutType} ${JSON.stringify(box)}`).toBe(false);
          expect(box.left).toBeGreaterThanOrEqual(EDGE_CLEARANCE);
          expect(box.right).toBeLessThanOrEqual(PAGE_WIDTH - EDGE_CLEARANCE);
          expect(box.bottom).toBeLessThanOrEqual(PAGE_HEIGHT - EDGE_CLEARANCE);
        }
      }
    }
  });

  it('places no glyph for a space, and every placed glyph has an outline', () => {
    const [run] = runs(layoutLetter({ text: 'a b', layoutType: 'text_only' }));
    const glyphs = placeGlyphs(run);
    expect(glyphs).toHaveLength(2);
    for (const glyph of glyphs) expect(glyph.outline.length).toBeGreaterThan(0);
  });

  it('draws outlines upright: a capital H rises above its baseline', () => {
    const [run] = runs(layoutLetter({ text: 'H', layoutType: 'text_only' }));
    const [glyph] = placeGlyphs(run);
    // Outlines use SVG's y-down space with the origin on the baseline, so a
    // capital's points run from about -cap height up to 0.
    const ys = [...glyph.outline.matchAll(/-?\d+(?:\.\d+)?/g)].map(match => Number(match[0])).filter((_, index) => index % 2 === 1);
    expect(Math.min(...ys)).toBeLessThan(-7);
    expect(Math.max(...ys)).toBeLessThanOrEqual(0.01);
  });

  it('advances each glyph by its width: a line ends where it measures', () => {
    const [run] = runs(layoutLetter({ text: 'Hello, World', layoutType: 'text_only' }));
    const glyphs = placeGlyphs(run);
    for (let index = 1; index < glyphs.length; index++) expect(glyphs[index].x).toBeGreaterThan(glyphs[index - 1].x);
    const last = shape(font, 'd').advanceWidth * 12 / font.unitsPerEm;
    expect(glyphs[glyphs.length - 1].x + last).toBeCloseTo(SIDE_MARGIN + width('Hello, World'), 6);
  });

  it('shapes a line that starts in Hebrew in the order given, never reversing it again', () => {
    const shalom = String.fromCodePoint(0x05e9, 0x05dc, 0x05d5, 0x05dd);
    const [run] = runs(layoutLetter({ text: shalom, layoutType: 'text_only' }));
    // fontkit would reverse a run it takes to be right to left; forced left
    // to right, glyph n is the glyph of drawn character n.
    const expected = [...run.text].map(character => shape(font, character).glyphs[0].id);
    expect(placeGlyphs(run).map(glyph => Number(glyph.key.split('-').pop()))).toEqual(expected);
  });

  it('draws right-to-left text in visual order and keeps the written line as the source', () => {
    const shalom = String.fromCodePoint(0x05e9, 0x05dc, 0x05d5, 0x05dd);
    const [run] = runs(layoutLetter({ text: `Hi ${shalom}`, layoutType: 'text_only' }));
    expect(run.source).toBe(`Hi ${shalom}`);
    expect(run.text).toBe(`Hi ${[...shalom].reverse().join('')}`);
  });
});
