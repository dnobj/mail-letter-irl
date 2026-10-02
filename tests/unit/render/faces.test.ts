/**
 * Typewriter and Handwritten (#563 PR 8): themes that set the whole letter in
 * a face of their own, Cousine and Caveat, on Classic's line pitch. They print
 * a date line in their face, and Handwritten rules a faint line under each of
 * the page's lines. Offered and stored like the others since PR 8b (046).
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { FONT_FILES, loadFont, type FontName } from '../../../src/render/fonts.js';
import { BODY_BOTTOM, BODY_TOP, CONTENT_WIDTH, LINE_PITCH, PAGE_WIDTH, SIDE_MARGIN } from '../../../src/render/geometry.js';
import { placeGlyphs, shape } from '../../../src/render/glyphs.js';
import type { RenderImage } from '../../../src/render/images.js';
import {
  baselineOffset, drawsGrapheme, drawsGraphemeIn, inFace, layoutLetter, wrapText, type ImageBox, type Layout, type PathItem, type TextRun
} from '../../../src/render/layout.js';
import { rendererVersionFor, renderPdf, STATIONERY_RENDERER_VERSION } from '../../../src/render/pdf.js';
import { renderPreviewSvg } from '../../../src/render/preview.js';
import {
  bodyFace, layoutStationery, ruledLines, STATIONERY_CORNER, STATIONERY_THEMES, stationeryOf, type Stationery
} from '../../../src/render/stationery.js';

const TEXT = 'Dear Sam,\n\nHappy birthday! I hope this year brings you everything you have been hoping for.\n\nWith love,\nAda';
const DATE = 'October 1, 2026';

const image = (width: number, height: number): RenderImage => ({ bytes: Buffer.alloc(0), mime: 'image/jpeg', width, height });
const letter = (stationery?: Stationery, layoutType: 'text_only' | 'header_image' | 'inline_image' = 'text_only', text = TEXT) =>
  layoutLetter({ text, layoutType, image: layoutType === 'text_only' ? undefined : image(1200, 800), stationery });
const items = (layout: Layout) => layout.pages[0].items;
const runs = (layout: Layout) => items(layout).filter((item): item is TextRun => item.kind === 'text');
const paths = (layout: Layout) => items(layout).filter((item): item is PathItem => item.kind === 'path');
const images = (layout: Layout) => items(layout).filter((item): item is ImageBox => item.kind === 'image');
const bodyRuns = (layout: Layout) => runs(layout).filter(run => run.baseline > BODY_TOP);
const runWidth = (run: TextRun) => {
  const font = loadFont(run.font);
  return (shape(font, run.text).advanceWidth * run.size) / font.unitsPerEm;
};
/** Each rule as [x1, y, x2]: the path's M x y L x y pairs. */
const rules = (path: PathItem) =>
  [...path.d.matchAll(/M(-?[\d.]+) (-?[\d.]+)L(-?[\d.]+) (-?[\d.]+)/g)].map(([, x1, y1, x2, y2]) => {
    expect(y2).toBe(y1);
    return [Number(x1), Number(y1), Number(x2)];
  });

describe('the fonts (#563 PR 8)', () => {
  it('ship Cousine and Caveat beside Tinos, each with its licence', () => {
    expect(Object.keys(FONT_FILES)).toEqual(['Tinos-Regular', 'Cousine-Regular', 'Caveat-Regular']);
    for (const [name, file] of Object.entries(FONT_FILES)) {
      const family = name.split('-')[0];
      const licence = new URL(`../../../assets/fonts/${family}-OFL.txt`, import.meta.url);
      expect(existsSync(licence), `${family}-OFL.txt`).toBe(true);
      expect(readFileSync(licence, 'utf8')).toContain('SIL Open Font License, Version 1.1');
      expect(readFileSync(licence, 'utf8')).toContain(`The ${family} Project Authors`);
      const font = loadFont(name as FontName);
      expect(font.familyName, file).toBe(family);
      expect(font.subfamilyName).toBe('Regular');
    }
  });

  it('give each face its own glyph keys, so a preview never draws one face with another\'s outline', () => {
    const keys = (font: FontName, size: number) =>
      placeGlyphs({ kind: 'text', font, size, x: 0, baseline: 0, text: 'ab', source: 'ab' }).map(glyph => glyph.key.split('-')[0]);
    expect(keys('Tinos-Regular', 12)).toEqual(['tr12', 'tr12']);
    expect(keys('Cousine-Regular', 11)).toEqual(['cr11', 'cr11']);
    expect(keys('Caveat-Regular', 15)).toEqual(['cv15', 'cv15']);
  });
});

describe('the faces (#563 PR 8)', () => {
  it('are Tinos at 12 pt for Classic and the corner themes, Cousine at 11 for Typewriter, Caveat at 15 for Handwritten', () => {
    for (const theme of ['classic', 'monogram', 'botanical', 'celebration'] as const) {
      expect(bodyFace(theme)).toEqual({ font: 'Tinos-Regular', size: 12 });
    }
    expect(bodyFace('typewriter')).toEqual({ font: 'Cousine-Regular', size: 11 });
    expect(bodyFace('handwritten')).toEqual({ font: 'Caveat-Regular', size: 15 });
    expect(STATIONERY_THEMES).toEqual(['classic', 'monogram', 'botanical', 'celebration', 'typewriter', 'handwritten']);
  });

  it("fit each face's ascent and descent inside the line pitch, so no line touches the next (#574 review round 1)", () => {
    for (const theme of STATIONERY_THEMES) {
      const { font, size } = bodyFace(theme);
      const face = loadFont(font);
      expect(((face.ascent - face.descent) * size) / face.unitsPerEm, theme).toBeLessThanOrEqual(LINE_PITCH);
    }
  });

  it("set the body in the theme's face, on Classic's lines: same pitch, same room, more lines where the face is wider", () => {
    const classic = letter();
    for (const theme of ['typewriter', 'handwritten'] as const) {
      const { font, size } = bodyFace(theme);
      const layout = letter({ theme, dateLine: DATE });
      const body = bodyRuns(layout);
      expect(body.length).toBeGreaterThan(3);
      const baseline = baselineOffset(size, LINE_PITCH, font);
      body.forEach(run => {
        expect(run).toMatchObject({ font, size, x: SIDE_MARGIN });
        // Every line on the pitch from the body's top.
        const index = Math.round((run.baseline - BODY_TOP - baseline) / LINE_PITCH);
        expect(run.baseline).toBeCloseTo(BODY_TOP + index * LINE_PITCH + baseline, 6);
        expect(runWidth(run)).toBeLessThanOrEqual(CONTENT_WIDTH + 1e-6);
      });
      expect(layout.pages[0].linesAvailable).toBe(classic.pages[0].linesAvailable);
    }
    // Cousine is wider than Tinos: the same letter takes more lines.
    const long = 'All work and no play makes a letter long. '.repeat(30);
    expect(letter({ theme: 'typewriter' }, 'text_only', long).pages[0].linesUsed)
      .toBeGreaterThan(letter(undefined, 'text_only', long).pages[0].linesUsed);
  });

  it("refuse a theme this build does not know before reading its face, prototype keys included", () => {
    for (const theme of ['floral', 'constructor', '__proto__', 'toString']) {
      expect(() => bodyFace(theme as Stationery['theme']), theme).toThrow(`Unknown stationery theme: ${theme}`);
      expect(() => letter({ theme: theme as Stationery['theme'] }), theme).toThrow(`Unknown stationery theme: ${theme}`);
    }
  });

  it("sit each face's baseline by its own ascent and descent, as CSS does", () => {
    for (const [font, size] of [['Cousine-Regular', 11], ['Caveat-Regular', 15]] as const) {
      const face = loadFont(font);
      const scale = size / face.unitsPerEm;
      const expected = (LINE_PITCH - (face.ascent - face.descent) * scale) / 2 + face.ascent * scale;
      expect(baselineOffset(size, LINE_PITCH, font), font).toBeCloseTo(expected, 6);
      expect(baselineOffset(size, LINE_PITCH, font)).not.toBeCloseTo(baselineOffset(size, LINE_PITCH), 2);
    }
  });

  it('wrap Typewriter as a typewriter would: 70 characters to a line', () => {
    const lines = wrapText('x'.repeat(150), 11, CONTENT_WIDTH, 'Cousine-Regular');
    expect(lines.map(line => line.source.length)).toEqual([70, 70, 10]);
  });

  it("wrap Handwritten as wide as Caveat's letters allow, measured in Caveat", () => {
    // Caveat's contextual alternates vary its letters, but the three forms of
    // x share one advance, so a run of x's has one width for each length.
    const caveat = loadFont('Caveat-Regular');
    const advance = (caveat.glyphForCodePoint('x'.codePointAt(0)!).advanceWidth * 15) / caveat.unitsPerEm;
    const perLine = Math.floor(CONTENT_WIDTH / advance);
    const lines = wrapText('x'.repeat(perLine * 2 + 5), 15, CONTENT_WIDTH, 'Caveat-Regular');
    expect(lines.map(line => line.source.length)).toEqual([perLine, perLine, 5]);
  });

  it('say by how much a letter runs past the page in its face', () => {
    const long = 'All work and no play makes a letter long. '.repeat(70);
    const layout = letter({ theme: 'typewriter' }, 'text_only', long);
    expect(layout.overflowLines).toBe(layout.pages[0].linesUsed - layout.pages[0].linesAvailable);
    expect(layout.overflowLines).toBeGreaterThan(letter(undefined, 'text_only', long).overflowLines);
  });

  it('print the date line in the face, with its right edge on the body\'s, in the corner', () => {
    for (const [theme, font, size] of [['typewriter', 'Cousine-Regular', 11], ['handwritten', 'Caveat-Regular', 16]] as const) {
      const [date] = runs(letter({ theme, dateLine: DATE })).filter(run => run.source === DATE);
      expect(date).toMatchObject({ font, size });
      expect(date.x + runWidth(date)).toBeCloseTo(PAGE_WIDTH - SIDE_MARGIN, 6);
      expect(date.baseline).toBeCloseTo(0.9 * 72, 6);
      expect(date.x).toBeGreaterThan(STATIONERY_CORNER.left);
      // Nothing else in the corner.
      expect(layoutStationery({ theme, dateLine: DATE }, BODY_TOP)).toEqual({ items: [date], bodyOffset: 0 });
    }
    expect(layoutStationery({ theme: 'typewriter' }, BODY_TOP)).toEqual({ items: [], bodyOffset: 0 });
  });

  it('shrink a long date line to fit the corner, Handwritten no further than 12 pt', () => {
    const long = 'Wednesday the first of October, two thousand and twenty-six';
    const [date] = runs(letter({ theme: 'handwritten', dateLine: long.slice(0, 48) })).filter(run => run.baseline < BODY_TOP);
    expect(date.size).toBeLessThan(16);
    expect(date.size).toBeGreaterThanOrEqual(12);
    expect(date.x).toBeGreaterThanOrEqual(STATIONERY_CORNER.left - 1e-6);
    expect(() => letter({ theme: 'handwritten', dateLine: `${long} ${long}` })).toThrow(/dateLine/);

    // One that would fit at 10 pt is still refused: Handwritten's floor is 12.
    const caveat = loadFont('Caveat-Regular');
    const room = PAGE_WIDTH - SIDE_MARGIN - STATIONERY_CORNER.left;
    const at = (text: string, size: number) => (shape(caveat, text).advanceWidth * size) / caveat.unitsPerEm;
    let text = 'x';
    while (at(text, 12) <= room) text += 'x';
    expect(at(text, 10)).toBeLessThanOrEqual(room);
    expect(() => letter({ theme: 'handwritten', dateLine: text })).toThrow(/dateLine/);
    // And Typewriter's is 9, as the Tinos themes': a line that fits at 9.5
    // shrinks to it, and one that would fit only below 9 is refused
    // (#574 review round 1).
    const cousine = loadFont('Cousine-Regular');
    const typedAt = (text: string, size: number) => (shape(cousine, text).advanceWidth * size) / cousine.unitsPerEm;
    const typed = 'x'.repeat(Math.floor(room / ((cousine.glyphForCodePoint(120).advanceWidth * 9.5) / cousine.unitsPerEm)));
    const [small] = runs(letter({ theme: 'typewriter', dateLine: typed })).filter(run => run.baseline < BODY_TOP);
    expect(small).toMatchObject({ font: 'Cousine-Regular', size: 9.5 });
    let tooLong = 'x';
    while (typedAt(tooLong, 9) <= room) tooLong += 'x';
    expect(typedAt(tooLong, 8.5)).toBeLessThanOrEqual(room);
    expect(() => letter({ theme: 'typewriter', dateLine: tooLong })).toThrow(/dateLine/);
    // And one that fits at 9 but not at 9.5 prints at 9, the floor itself (#575 review round 3).
    const atFloor = tooLong.slice(0, -1);
    expect(typedAt(atFloor, 9)).toBeLessThanOrEqual(room);
    expect(typedAt(atFloor, 9.5)).toBeGreaterThan(room);
    const [floor] = runs(letter({ theme: 'typewriter', dateLine: atFloor })).filter(run => run.baseline < BODY_TOP);
    expect(floor).toMatchObject({ font: 'Cousine-Regular', size: 9 });
  });

  it('refuse a theme this build does not know in the corner too', () => {
    expect(() => layoutStationery({ theme: 'floral' } as unknown as Stationery, BODY_TOP)).toThrow('Unknown stationery theme: floral');
  });
});

describe("Handwritten's rules (#563 PR 8)", () => {
  const ruleOf = (layout: Layout) => {
    const found = paths(layout);
    expect(found).toHaveLength(1);
    return found[0];
  };

  it('rule every line of the page, faint and thin, under the writing, across the body', () => {
    const layout = letter({ theme: 'handwritten', dateLine: DATE });
    const path = ruleOf(layout);
    expect(path).toMatchObject({ fill: 'none', stroke: '#aaaaaa', strokeWidth: 0.5 });
    const lines = rules(path);
    expect(lines).toHaveLength(layout.pages[0].linesAvailable);
    const baseline = baselineOffset(15, LINE_PITCH, 'Caveat-Regular');
    lines.forEach(([x1, y, x2], index) => {
      expect(x1).toBe(SIDE_MARGIN);
      expect(x2).toBe(PAGE_WIDTH - SIDE_MARGIN);
      expect(y).toBeCloseTo(BODY_TOP + index * LINE_PITCH + baseline + 1.5, 1);
      expect(y).toBeLessThan(BODY_BOTTOM);
    });
    // Drawn first, so the writing lies on top of its rules.
    expect(items(layout).indexOf(path)).toBeLessThan(items(layout).indexOf(bodyRuns(layout)[0]));
    // Each line of writing sits just above its rule.
    for (const run of bodyRuns(layout)) expect(lines.some(([, y]) => Math.abs(y - run.baseline - 1.5) < 0.01)).toBe(true);
  });

  it('start below a header image, and leave out the lines an enclosed image covers', () => {
    const header = letter({ theme: 'handwritten' }, 'header_image');
    const [top] = images(header);
    expect(rules(ruleOf(header))[0][1]).toBeGreaterThan(top.top + top.height);

    const inline = letter({ theme: 'handwritten' }, 'inline_image');
    const [box] = images(inline);
    const lines = rules(ruleOf(inline));
    expect(lines.some(([, y]) => y > box.top + box.height)).toBe(true);
    for (const [, y] of lines) expect(y > box.top - LINE_PITCH && y < box.top + box.height + LINE_PITCH).toBe(false);
  });

  it('draw no rule where there is no room for a line', () => {
    expect(ruledLines(BODY_BOTTOM - LINE_PITCH / 2, BODY_BOTTOM, 10)).toBeNull();
    expect(ruledLines(BODY_TOP, BODY_BOTTOM, 10, [{ top: BODY_TOP, bottom: BODY_BOTTOM }])).toBeNull();
  });

  it('are Handwritten\'s alone', () => {
    for (const theme of STATIONERY_THEMES.filter(name => name !== 'handwritten')) {
      expect(paths(letter({ theme })).some(path => path.stroke === '#aaaaaa' && path.strokeWidth === 0.5), theme).toBe(false);
    }
  });
});

describe("a face's characters (#563 PR 8)", () => {
  it("checks text against the face it prints in: Caveat has no Greek or Hebrew, Tinos and Cousine have Greek", () => {
    const caveat = drawsGraphemeIn('Caveat-Regular');
    const cousine = drawsGraphemeIn('Cousine-Regular');
    const tinos = drawsGraphemeIn('Tinos-Regular');
    for (const grapheme of ['a', 'Z', '\u00e9', '\u00f1', '\u00df', '\u20ac', '\u00a3', '\u201c', '\u2014', '!', '7']) {
      expect(caveat(grapheme), grapheme).toBe(true);
      expect(cousine(grapheme), grapheme).toBe(true);
    }
    for (const grapheme of ['\u03c0', '\u03a9', '\u05e9']) expect(caveat(grapheme), grapheme).toBe(false);
    expect(cousine('\u03c0')).toBe(true);
    expect(tinos('\u03c0')).toBe(true);
  });

  it('keeps Classic\'s check as it was, and works as a callback', () => {
    for (const grapheme of ['a', '\u03c0', '\u05e9', '\u2028', '\u{1F600}']) expect(drawsGrapheme(grapheme)).toBe(drawsGraphemeIn('Tinos-Regular')(grapheme));
    expect(['a', 'b', 'c'].every(drawsGraphemeIn('Caveat-Regular'))).toBe(true);
    expect(['a', '\u03c0'].every(drawsGraphemeIn('Caveat-Regular'))).toBe(false);
  });
});

describe("a face's look-alikes (#575 review round 3)", () => {
  const ch = (...codePoints: number[]) => String.fromCodePoint(...codePoints);
  const NB_HYPHEN = ch(0x2011);
  const NARROW_NBSP = ch(0x202f);

  it('draw the dashes and fixed-width spaces Tinos has as the nearest each face has, one for one', () => {
    expect(inFace('Cousine-Regular', `e${NB_HYPHEN}mail${NARROW_NBSP}10 ${ch(0x2010)} ${ch(0x2009)}`))
      .toBe(`e-mail${ch(0xa0)}10 -  `);
    expect(inFace('Caveat-Regular', `e${NB_HYPHEN}mail${NARROW_NBSP}10 ${ch(0x2012)}${ch(0x2015)}${ch(0x2007)}`))
      .toBe(`e${ch(0x2010)}mail${ch(0xa0)}10 ${ch(0x2013)}${ch(0x2014)}${ch(0xa0)}`);
    // Classic draws them all as written.
    const all = ch(0x2010, 0x2011, 0x2012, 0x2015, 0x202f, 0x2007, 0x2000, 0x200a);
    expect(inFace('Tinos-Regular', all)).toBe(all);
    for (const font of ['Cousine-Regular', 'Caveat-Regular'] as const) expect(inFace(font, all)).toHaveLength(all.length);
  });

  it('let each face take what Classic takes of them, and nothing Classic refuses', () => {
    for (const font of ['Cousine-Regular', 'Caveat-Regular'] as const) {
      const draws = drawsGraphemeIn(font);
      for (const codePoint of [0x2010, 0x2011, 0x2012, 0x2015, 0x202f, 0x2007, 0x2000, 0x2003, 0x2009, 0x200a]) {
        expect(draws(ch(codePoint)), `${font} U+${codePoint.toString(16)}`).toBe(true);
      }
      // A space Tinos draws as a box is refused in every face.
      expect(draws(ch(0x205f))).toBe(false);
      expect(drawsGrapheme(ch(0x205f))).toBe(false);
    }
  });

  it('break lines as written: a non-breaking hyphen drawn as a hyphen still keeps its word whole', () => {
    // 66 x's, a space, then "ab-cd": with a breakable hyphen "ab-" would end the 70-character line.
    const text = `${'x'.repeat(66)} ab${NB_HYPHEN}cd`;
    const lines = wrapText(text, 11, CONTENT_WIDTH, 'Cousine-Regular');
    expect(lines.map(line => line.source)).toEqual(['x'.repeat(66), `ab${NB_HYPHEN}cd`]);
    expect(lines[1].drawn).toBe('ab-cd');
    // A narrow no-break space keeps its neighbours together too.
    const spaced = wrapText(`${'x'.repeat(66)} 10${NARROW_NBSP}km`, 11, CONTENT_WIDTH, 'Cousine-Regular');
    expect(spaced.map(line => line.source)).toEqual(['x'.repeat(66), `10${NARROW_NBSP}km`]);
  });

  it('draw every glyph, none of them the missing-glyph box, and keep the text as written for reading', () => {
    for (const theme of ['typewriter', 'handwritten'] as const) {
      const text = `Dear Sam,\nSee you at 10${NARROW_NBSP}am${ch(0x2009)}${ch(0x2014)} a well${NB_HYPHEN}known spot.\nPat`;
      const layout = letter({ theme }, 'text_only', text);
      const body = bodyRuns(layout);
      expect(body.some(run => run.source.includes(NB_HYPHEN) && run.source.includes(NARROW_NBSP))).toBe(true);
      for (const run of body) {
        expect(placeGlyphs(run).every(glyph => !glyph.key.endsWith('-0')), `${theme}: ${run.source}`).toBe(true);
      }
    }
  });
});

describe('the outputs (#563 PR 8)', () => {
  it('draw each face as glyph outlines in the PDF, recorded as pdf-2, with no text handed to a font', async () => {
    for (const theme of ['typewriter', 'handwritten'] as const) {
      const layout = letter({ theme, dateLine: DATE });
      expect(rendererVersionFor({ theme })).toBe(STATIONERY_RENDERER_VERSION);
      const bytes = await renderPdf(layout, rendererVersionFor({ theme }));
      const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, isEvalSupported: false }).promise;
      const page = await pdf.getPage(1);
      expect((await page.getTextContent()).items).toEqual([]);
      const { info } = await pdf.getMetadata() as { info: { Producer?: string } };
      expect(info.Producer).toContain(STATIONERY_RENDERER_VERSION);
    }
  });

  it("draw each face's own glyphs in the preview, and Handwritten's rules", () => {
    const [typed] = renderPreviewSvg(letter({ theme: 'typewriter', dateLine: DATE }));
    expect(typed).toMatch(/id="cr11-\d+"/);
    expect(typed).not.toMatch(/id="tr12-\d+"/);
    const [written] = renderPreviewSvg(letter({ theme: 'handwritten', dateLine: DATE }));
    expect(written).toMatch(/id="cv15-\d+"/);
    expect(written).toMatch(/id="cv16-\d+"/);
    expect(written).toContain('stroke="#aaaaaa"');
  });
});

describe('stored (#563 PR 8b)', () => {
  it('reads both themes back from storage, with their date line, as the print reads the others', () => {
    for (const theme of ['typewriter', 'handwritten'] as const) {
      expect(stationeryOf({ theme, dateLine: DATE })).toEqual({ theme, dateLine: DATE });
    }
  });
});
