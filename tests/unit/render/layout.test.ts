/**
 * The renderer's layout (#534): one page, the three legacy layouts, measured
 * line breaks, and nothing under PostGrid's address boxes.
 */

import { describe, expect, it, vi } from 'vitest';
import LineBreaker from 'linebreak';
import { drawsGrapheme, layoutLetter, LINE_BUDGET_PER_PAGE, paragraphMeasure, wrapParagraph, type Layout, type TextRun } from '../../../src/render/layout.js';
import { isInvisible, mirrorOf } from '../../../src/render/bidi.js';

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
    // Laid out to its line budget and no further (#694): the start of the run, line by line.
    expect(layout.truncated).toBe(true);
    expect(layout.pages[0].linesUsed).toBe(LINE_BUDGET_PER_PAGE);
    const drawn = runs(layout).map(run => run.source).join('');
    expect('i'.repeat(20000).startsWith(drawn)).toBe(true);
    expect(drawn.length).toBeGreaterThan(0);
    const shaped = vi.mocked(shape).mock.calls.map(([, text]) => text.length);
    expect(Math.max(...shaped)).toBeLessThan(400);
    // A binary search per line, not a shaping per letter.
    expect(shaped.length).toBeLessThan(layout.pages[0].linesUsed * 12);
  });

  it('shapes no line candidate far past the line in text the face cannot draw (#694 review round 4)', () => {
    // A character the face lacks is drawn as its fallback glyph; counted as nothing, the fit limit ran
    // to the paragraph's end and each line's search shaped thousands of characters. The previews refuse
    // such text first (the printable check); the layout must not depend on that.
    vi.mocked(shape).mockClear();
    layoutLetter({ text: '\u6f22'.repeat(30_000), layoutType: 'text_only', stationery: { theme: 'handwritten' } }, { maxPages: 3 });
    const shaped = vi.mocked(shape).mock.calls.map(([, text]) => text.length);
    expect(Math.max(...shaped)).toBeLessThan(400);
  });

  it('bounds the shaping a hostile letter costs: one-letter words to the character cap, in Handwritten (#694)', () => {
    // The audit's worst case: 30,000 characters of one-letter words, Handwritten, three pages.
    // Before #694 this shaped once per word on every line, and every line of the text.
    vi.mocked(shape).mockClear();
    const text = 'a '.repeat(15000);
    const layout = layoutLetter({ text, layoutType: 'text_only', stationery: { theme: 'handwritten' } }, { maxPages: 3 });
    expect(layout.truncated).toBe(true);
    expect(layout.overflowLines).toBeGreaterThan(0);
    const lines = layout.pages.reduce((count, page) => count + page.linesUsed, 0);
    expect(lines).toBe(3 * LINE_BUDGET_PER_PAGE);
    // At most a few shapings for each line it lays out (a binary search over its breaks), and no
    // more lines than the budget: a count, not a time, so the test is the same on any machine.
    const shapings = vi.mocked(shape).mock.calls.length;
    // About 10 a line today (a search over the line's breaks, then the line drawn): 12 is the gate.
    expect(shapings).toBeLessThan(lines * 12);
  });

  it('stops at the budget exactly when the text is many short paragraphs (#694)', () => {
    const layout = layoutLetter({ text: Array.from({ length: 500 }, (_, index) => `Line ${index + 1}`).join('\n'), layoutType: 'text_only' });
    expect(layout.truncated).toBe(true);
    // Not one line more, not even an empty one for the paragraph that did not fit.
    expect(layout.pages[0].linesUsed).toBe(LINE_BUDGET_PER_PAGE);
    expect(runs(layout).map(run => run.source).at(-1)).toBe(`Line ${LINE_BUDGET_PER_PAGE}`);
    // A letter that ends exactly at the budget is whole, not truncated.
    // Trailing blank space past the budget is not more letter.
    const whole = layoutLetter({ text: Array.from({ length: LINE_BUDGET_PER_PAGE }, (_, index) => `Line ${index + 1}`).join('\n') + '\n  ', layoutType: 'text_only' });
    expect(whole.truncated).toBeUndefined();
  });

  it('lays out the same text again from the lines it already wrapped (#694)', () => {
    vi.mocked(shape).mockClear();
    const content = { text: 'b '.repeat(4000), layoutType: 'text_only' as const, stationery: { theme: 'typewriter' as const } };
    const first = layoutLetter(content, { maxPages: 2 });
    const once = vi.mocked(shape).mock.calls.length;
    vi.mocked(shape).mockClear();
    expect(layoutLetter(content, { maxPages: 2 })).toEqual(first);
    // The second layout shapes only what it draws, none of the wrapping's candidates.
    expect(vi.mocked(shape).mock.calls.length).toBeLessThan(once / 2);
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

describe('what the renderer draws as written (#534)', () => {
  const at = (...codePoints: number[]) => String.fromCodePoint(...codePoints);

  it('draws what the font has a glyph for', () => {
    // Latin with an accent, Greek, Hebrew, the non-breaking hyphen, the
    // narrow no-break space, and the shekel sign.
    for (const grapheme of ['a', 'Z', at(0xe9), at(0x3ba), at(0x5e9), at(0x2011), at(0x202f), at(0x20aa)]) {
      expect(drawsGrapheme(grapheme)).toBe(true);
    }
  });

  it('counts what the renderer handles itself as drawn: line breaks, tabs, and characters that print nothing', () => {
    // Line breaks start new lines, a tab becomes spaces, and a zero-width
    // joiner, a variation selector and the Arabic letter mark are dropped.
    for (const grapheme of [at(0x0a), at(0x0d, 0x0a), at(0x09), at(0x200d), at(0x61, 0xfe0f), at(0x61c)]) {
      expect(drawsGrapheme(grapheme)).toBe(true);
    }
  });

  it('refuses a character the font has no glyph for', () => {
    // An emoji, a CJK character, and an Arabic letter.
    for (const grapheme of [at(0x1f389), at(0x738b), at(0x633)]) expect(drawsGrapheme(grapheme)).toBe(false);
  });

  it('refuses characters that are never drawn, whatever glyph the font maps them to (#540 review round 1)', () => {
    // Tinos draws U+2028, U+2029, U+205F and private-use U+F001 as a box, and
    // maps U+0000 to an empty glyph PostgreSQL will not store. Also: a C1
    // control, a deprecated format character, private use without a glyph,
    // and a lone surrogate.
    for (const codePoint of [0x2028, 0x2029, 0x205f, 0xf001, 0x0000, 0x0085, 0x206a, 0xe000]) {
      expect(drawsGrapheme(at(codePoint)), codePoint.toString(16)).toBe(false);
    }
    expect(drawsGrapheme(String.fromCharCode(0xd800))).toBe(false);
  });

  it('accepts no control, format, separator or space character that would draw something', () => {
    // Every such character the font maps: accepted only if it draws nothing.
    // Line breaks and tabs never reach the shaper, and invisible characters
    // are removed before it.
    const special = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}\p{Co}]/u;
    const drawn: string[] = [];
    let checked = 0;
    for (const codePoint of font.characterSet) {
      const character = at(codePoint);
      if (!special.test(character) || [0x09, 0x0a, 0x0d].includes(codePoint) || isInvisible(character)) continue;
      checked += 1;
      if (!drawsGrapheme(character)) continue;
      if (shape(font, character).glyphs.some(glyph => glyph.path.commands.length > 0)) drawn.push(codePoint.toString(16));
    }
    expect(checked).toBeGreaterThan(10);
    expect(drawn).toEqual([]);
  });

  it('refuses a character whose mirror the font lacks, since a right-to-left run draws the mirror (#540 review round 2)', () => {
    // Tinos has U+2215 and U+221F, but not their mirrors U+29F5 and U+2BFE.
    expect(mirrorOf(at(0x2215))).toBe(at(0x29f5));
    expect(drawsGrapheme(at(0x2215))).toBe(false);
    expect(drawsGrapheme(at(0x221f))).toBe(false);
    // Every accepted character that mirrors, between Hebrew words, draws no
    // .notdef box (glyph 0).
    const shalom = at(0x5e9, 0x5dc, 0x5d5, 0x5dd);
    const boxed: string[] = [];
    let mirrored = 0;
    for (const codePoint of font.characterSet) {
      const character = at(codePoint);
      if (!mirrorOf(character) || !drawsGrapheme(character)) continue;
      mirrored += 1;
      const [run] = runs(layoutLetter({ text: `${shalom} ${character} ${shalom}`, layoutType: 'text_only' }));
      if (shape(font, run.text).glyphs.some(glyph => glyph.id === 0)) boxed.push(codePoint.toString(16));
    }
    expect(mirrored).toBeGreaterThan(10);
    expect(boxed).toEqual([]);
  });

  it('draws four marks on a letter and refuses a fifth, which the layout would drop', () => {
    const acute = at(0x301);
    expect(drawsGrapheme(at(0x65) + acute.repeat(4))).toBe(true);
    expect(drawsGrapheme(at(0x65) + acute.repeat(5))).toBe(false);
  });
});

describe('the line search finds the breaks the scan found (#694)', () => {
  /** wrapParagraph before #694, verbatim: each line's last break by a scan from its start. */
  function scanned(
    paragraph: string,
    width: number,
    measure: (start: number, end: number) => number,
    fitLimit: (start: number) => number = () => paragraph.length
  ): Array<{ start: number; end: number }> {
    const WHITESPACE = /\s/u;
    const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    if (paragraph.trim() === '') return [{ start: 0, end: 0 }];
    const trimmedEnd = (start: number, end: number) => {
      while (end > start && WHITESPACE.test(paragraph[end - 1])) end -= 1;
      return end;
    };
    const fits = (start: number, end: number, limit: number) => {
      const trimmed = trimmedEnd(start, end);
      return trimmed <= limit && measure(start, trimmed) <= width;
    };
    const breaks: number[] = [];
    const breaker = new LineBreaker(paragraph);
    for (let next = breaker.nextBreak(); next; next = breaker.nextBreak()) breaks.push(next.position);
    const lines: Array<{ start: number; end: number }> = [];
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

  /** A small seeded generator, so a failure names a paragraph that can be run again. */
  function random(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
  }

  // Kerning pairs and ligatures, Greek, Cyrillic, Hebrew mixed with Latin, numbers and
  // punctuation, and breaks that are not after a space: a hyphen, a slash, a soft hyphen,
  // a zero-width space, CJK, an ideographic space; and invisible marks a line drops.
  const WORDS = [
    'a', 'I', 'AV', 'To', 'Ty', 'Wa', 'fi', 'office', 'affluent', 'waffle', 'letter', 'Vowel', 'yearly', 'LT', 'P.', '—', 'well-known',
    'naïve', 'café', 'Ελλάδα', 'καλημέρα', 'Москва', 'привет', 'שלום', 'עולם', 'מכתב', '12,000', '(note)', '“quoted”', 'x',
    'and/or', 'self­reliant', 'zero​width', 'nbsp joined', '‎LRM', '‏RLM', 'ab‍cd', '漢字かな',
    'full　width', 'tab\there', 'é', 'AVAVAVAVAVAVAVAVAVAVAVAVAV'
  ];
  const SEPARATORS = [' ', ' ', ' ', '  ', ' / ', '-', '​'];

  it.each(['Tinos-Regular', 'Cousine-Regular', 'Caveat-Regular'] as const)(
    'in %s, through the measure the layout uses, over 150 paragraphs',
    fontName => {
      const next = random(694);
      // 150 a face: enough to vary every word and break, light enough not to slow the suite's other files.
      for (let sample = 0; sample < 150; sample += 1) {
        const count = 1 + Math.floor(next() * 60);
        let paragraph = '';
        for (let word = 0; word < count; word += 1) {
          if (word > 0) paragraph += SEPARATORS[Math.floor(next() * SEPARATORS.length)];
          paragraph += WORDS[Math.floor(next() * WORDS.length)];
        }
        const lineWidth = 40 + next() * 400;
        const size = [11, 12, 14][Math.floor(next() * 3)];
        const { measure, limit } = paragraphMeasure(paragraph, size, lineWidth, fontName);
        const searched = wrapParagraph(paragraph, lineWidth, measure, limit);
        expect(searched, `sample ${sample}: ${JSON.stringify(paragraph)} at ${lineWidth}, size ${size}`)
          .toEqual(scanned(paragraph, lineWidth, measure, limit));
      }
    },
    180_000
  );
});

describe('the budget is part of what a wrapping is remembered by (#694 review round 2)', () => {
  it('lays a letter out on three pages whole after the same text was laid out on one', () => {
    // A gift letter's one-page check (letterRunsPast) may run first: its stopped wrapping must
    // not be the three-page layout's.
    const text = Array.from({ length: 80 }, (_, index) => `Line ${index + 1} of a letter that runs to two pages.`).join('\n');
    expect(layoutLetter({ text, layoutType: 'text_only' }).truncated).toBe(true);
    const three = layoutLetter({ text, layoutType: 'text_only' }, { maxPages: 3 });
    expect(three.truncated).toBeUndefined();
    expect(three.overflowLines).toBe(0);
  });
});

describe('blank paragraphs past the budget (#694 review round 2)', () => {
  it('cost no more than the base did: the check for text left is made once (review round 3)', () => {
    // The budget's written lines, then blank paragraphs to the three-page character cap. A check
    // made for each blank paragraph over all those after it took seconds; the base took ~0.1 s.
    const text = 'a\n'.repeat(3 * LINE_BUDGET_PER_PAGE) + '\n'.repeat(29_000);
    const started = performance.now();
    const layout = layoutLetter({ text, layoutType: 'text_only' }, { maxPages: 3 });
    expect(layout.truncated).toBeUndefined();
    // Generous for a slow machine; quadratic was ~5 s.
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it('are laid out, so a letter whose text ends at the budget is counted exactly', () => {
    const text = Array.from({ length: LINE_BUDGET_PER_PAGE }, (_, index) => `Line ${index + 1}`).join('\n') + '\n \n';
    const layout = layoutLetter({ text, layoutType: 'text_only' });
    expect(layout.truncated).toBeUndefined();
    expect(layout.pages[0].linesUsed).toBe(LINE_BUDGET_PER_PAGE + 2);
  });
});

describe('blank lines do not spend the line budget (#694 review round 1)', () => {
  // flowPages drops blank lines at the top of each later page, so a letter that fits can wrap
  // many more lines than its pages hold. Counting them, the budget stopped such a letter and
  // dropped its end, with overflowLines 0.
  it.each([2, 3])('lays out a letter of a greeting, a long blank stretch and its words whole on %i pages', maxPages => {
    const text = `Dear Sam,${'\n'.repeat(200)}The part that matters.\n\nLove, Pat`;
    const layout = layoutLetter({ text, layoutType: 'text_only' }, { maxPages });
    expect(layout.truncated).toBeUndefined();
    expect(layout.overflowLines).toBe(0);
    const drawn = layout.pages.flatMap(page => page.items.filter((item): item is TextRun => item.kind === 'text').map(run => run.source));
    expect(drawn).toEqual(expect.arrayContaining(['Dear Sam,', 'The part that matters.', 'Love, Pat']));
  });

  it('says a truncated letter is over (its overflow is past every page, so the floor of one is a guard only)', () => {
    const layout = layoutLetter({ text: 'word '.repeat(9000), layoutType: 'text_only' }, { maxPages: 3 });
    expect(layout.truncated).toBe(true);
    expect(layout.overflowLines).toBeGreaterThan(0);
  });
});
