/**
 * Stationery (#563): themes drawn by our renderer. Classic is today's page;
 * every other theme prints a date line and draws only in the corner beside
 * the envelope window (probe P12) and, for Celebration's headline, above the
 * body, which then starts lower. The PDF and the preview draw the same paths.
 */

import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { loadFont } from '../../../src/render/fonts.js';
import { ADDRESS_ZONE, BODY_TOP, LINE_PITCH, PAGE_WIDTH, SIDE_MARGIN } from '../../../src/render/geometry.js';
import { placeGlyphs, shape } from '../../../src/render/glyphs.js';
import type { RenderImage } from '../../../src/render/images.js';
import { layoutLetter, type Layout, type LayoutItem, type PathItem, type TextRun } from '../../../src/render/layout.js';
import { renderPdf } from '../../../src/render/pdf.js';
import { renderPreviewSvg } from '../../../src/render/preview.js';
import {
  HEADLINE_LINES, headlineSize, layoutStationery, slotText, STATIONERY_CORNER, STATIONERY_THEMES, StationeryOverflow,
  type Stationery, type StationeryTheme
} from '../../../src/render/stationery.js';

const TEXT = 'Dear Sam,\n\nHappy birthday! I hope this year brings you everything you have been hoping for.\n\nWith love,\nAda';
const SLOTS = { dateLine: 'October 1, 2026', monogram: 'AL', headline: 'Happy Birthday, Sam!' };
const THEMED = STATIONERY_THEMES.filter((theme): theme is Exclude<StationeryTheme, 'classic'> => theme !== 'classic');

const image = (width: number, height: number): RenderImage => ({ bytes: Buffer.alloc(0), mime: 'image/jpeg', width, height });
const letter = (stationery?: Stationery, layoutType: 'text_only' | 'header_image' | 'inline_image' = 'text_only') =>
  layoutLetter({ text: TEXT, layoutType, image: layoutType === 'text_only' ? undefined : image(1200, 800), stationery });
const items = (layout: Layout) => layout.pages[0].items;
const paths = (layout: Layout) => items(layout).filter((item): item is PathItem => item.kind === 'path');
const runs = (layout: Layout) => items(layout).filter((item): item is TextRun => item.kind === 'text');
/** The body's own lines: what Classic lays out, and nothing a theme adds. */
const body = (layout: Layout) => items(layout).filter(item => item.kind === 'image' || (item.kind === 'text' && item.size === 12 && item.baseline > BODY_TOP));

const font = loadFont('Tinos-Regular');
const runWidth = (run: TextRun) => (shape(font, run.text).advanceWidth * run.size) / font.unitsPerEm;

/** The box an item's ink can reach: a path's every point (a cubic stays inside its points), or a run's glyph outlines. */
function reach(item: LayoutItem): { left: number; top: number; right: number; bottom: number } {
  let xs: number[] = [];
  let ys: number[] = [];
  const add = (d: string, dx = 0, dy = 0) => {
    const numbers = [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map(match => Number(match[0]));
    xs = xs.concat(numbers.filter((_, index) => index % 2 === 0).map(value => value + dx));
    ys = ys.concat(numbers.filter((_, index) => index % 2 === 1).map(value => value + dy));
  };
  if (item.kind === 'path') {
    // A miter join reaches at most the miter limit (4) times half the width.
    const half = (item.strokeWidth ?? 0) * 2;
    add(item.d);
    return { left: Math.min(...xs) - half, top: Math.min(...ys) - half, right: Math.max(...xs) + half, bottom: Math.max(...ys) + half };
  }
  if (item.kind !== 'text') throw new Error(`no reach for ${item.kind}`);
  for (const glyph of placeGlyphs(item)) add(glyph.outline, glyph.x, glyph.y);
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

describe('Classic (#563)', () => {
  it('is exactly the page without a theme, whatever slots it is given, in every layout', () => {
    for (const layoutType of ['text_only', 'header_image', 'inline_image'] as const) {
      expect(letter({ theme: 'classic', ...SLOTS }, layoutType)).toEqual(letter(undefined, layoutType));
    }
    expect(layoutStationery({ theme: 'classic', ...SLOTS }, BODY_TOP)).toEqual({ items: [], bodyOffset: 0 });
  });
});

describe('the themes (#563)', () => {
  it('leave the body where Classic puts it, in every layout, when there is no headline', () => {
    for (const theme of THEMED) {
      for (const layoutType of ['text_only', 'header_image', 'inline_image'] as const) {
        const themed = letter({ theme, dateLine: SLOTS.dateLine, monogram: SLOTS.monogram }, layoutType);
        const classic = letter(undefined, layoutType);
        expect(body(themed)).toEqual(body(classic));
        expect(themed.pages[0].linesAvailable).toBe(classic.pages[0].linesAvailable);
        expect(themed.overflowLines).toBe(classic.overflowLines);
      }
    }
  });

  it('draw only in the corner beside the envelope window, clear of the address zone', () => {
    for (const theme of THEMED) {
      const layout = letter({ theme, dateLine: SLOTS.dateLine, monogram: SLOTS.monogram });
      const added = items(layout).filter(item => !body(layout).includes(item));
      expect(added.length).toBeGreaterThan(theme === 'monogram' ? 3 : 5);
      for (const item of added) {
        const box = reach(item);
        expect(box.left).toBeGreaterThanOrEqual(STATIONERY_CORNER.left);
        expect(box.right).toBeLessThanOrEqual(STATIONERY_CORNER.right);
        expect(box.top).toBeGreaterThanOrEqual(STATIONERY_CORNER.top);
        expect(box.bottom).toBeLessThanOrEqual(STATIONERY_CORNER.bottom);
        expect(box.left).toBeGreaterThan(ADDRESS_ZONE.right);
      }
    }
  });

  it('print the date line with its right edge on the body\'s, near the top', () => {
    for (const theme of THEMED) {
      const [date] = runs(letter({ theme, dateLine: SLOTS.dateLine })).filter(run => run.source === SLOTS.dateLine);
      expect(date.size).toBe(12);
      expect(date.x + runWidth(date)).toBeCloseTo(PAGE_WIDTH - SIDE_MARGIN, 6);
      expect(date.baseline).toBeCloseTo(0.9 * 72, 6);
    }
    // No date given, none drawn.
    expect(runs(letter({ theme: 'botanical' })).some(run => run.baseline < BODY_TOP)).toBe(false);
  });

  it('draw with M, L, C and Z only, in black and greys, as the card keeps and P12 printed', () => {
    for (const theme of THEMED) {
      for (const path of paths(letter({ theme, ...SLOTS }))) {
        expect(path.d).toMatch(/^[MLCZ\d.\s-]+$/);
        for (const ink of [path.fill, path.stroke].filter((value): value is string => value !== undefined && value !== 'none')) {
          const [, r, g, b] = /^#(..)(..)(..)$/.exec(ink)!;
          expect(r === g && g === b).toBe(true);
        }
        if (path.stroke) expect(path.strokeWidth).toBeGreaterThanOrEqual(0.5);
      }
    }
  });

  it('keep a slot to the theme that prints it: a headline only on Celebration, initials only on Monogram', () => {
    expect(runs(letter({ theme: 'botanical', ...SLOTS })).some(run => run.source === SLOTS.headline)).toBe(false);
    expect(runs(letter({ theme: 'celebration', ...SLOTS })).some(run => run.source === SLOTS.monogram)).toBe(false);
    expect(runs(letter({ theme: 'monogram', ...SLOTS })).some(run => run.source === SLOTS.headline)).toBe(false);
  });
});

describe('Monogram (#563)', () => {
  const ring = (layout: Layout) => {
    const [outer] = paths(layout);
    return reach(outer);
  };

  it('centres the initials in a double ring at full size', () => {
    const layout = letter({ theme: 'monogram', monogram: 'AL' });
    const [initials] = runs(layout).filter(run => run.source === 'AL');
    const box = ring(layout);
    expect(paths(layout)).toHaveLength(2);
    expect(initials.size).toBe(26);
    expect(initials.x + runWidth(initials) / 2).toBeCloseTo((box.left + box.right) / 2, 1);
    // Centred on the capitals: as far above the centre as the baseline is below it.
    const capitals = (font.capHeight * initials.size) / font.unitsPerEm;
    expect(initials.baseline - capitals / 2).toBeCloseTo((box.top + box.bottom) / 2, 1);
  });

  it('shrinks wide initials to fit inside the ring', () => {
    const layout = letter({ theme: 'monogram', monogram: 'WWW' });
    const [initials] = runs(layout).filter(run => run.source === 'WWW');
    const box = ring(layout);
    expect(initials.size).toBeLessThan(26);
    expect(initials.size * 2).toBe(Math.round(initials.size * 2));
    expect(runWidth(initials)).toBeLessThanOrEqual(0.7 * (box.right - box.left));
    const ink = reach(initials);
    expect(ink.left).toBeGreaterThan(box.left);
    expect(ink.right).toBeLessThan(box.right);
  });

  it('draws no ring without initials', () => {
    expect(paths(letter({ theme: 'monogram', dateLine: SLOTS.dateLine }))).toEqual([]);
  });
});

describe("Celebration's headline (#563)", () => {
  it('sits centred above the body, which starts three lines lower and holds three fewer', () => {
    const plain = letter(undefined);
    const layout = letter({ theme: 'celebration', ...SLOTS });
    const [headline] = runs(layout).filter(run => run.source === SLOTS.headline);
    expect(headline.size).toBe(28);
    expect(headline.x + runWidth(headline) / 2).toBeCloseTo(PAGE_WIDTH / 2, 6);
    expect(headline.baseline).toBeGreaterThan(BODY_TOP);
    const shift = HEADLINE_LINES * LINE_PITCH;
    expect(HEADLINE_LINES).toBe(3);
    // The same lines, each `shift` lower (to rounding: the sums associate differently).
    const lines = body(layout) as TextRun[];
    const plainLines = body(plain) as TextRun[];
    expect(lines.map(({ baseline, ...rest }) => rest)).toEqual(plainLines.map(({ baseline, ...rest }) => rest));
    lines.forEach((line, index) => expect(line.baseline).toBeCloseTo(plainLines[index].baseline + shift, 9));
    expect(reach(headline).bottom).toBeLessThan(Math.min(...runs(layout).filter(run => body(layout).includes(run)).map(run => reach(run).top)));
    expect(layout.pages[0].linesAvailable).toBe(plain.pages[0].linesAvailable - 3);
  });

  it('moves an image below it too', () => {
    const plain = letter(undefined, 'header_image');
    const layout = letter({ theme: 'celebration', headline: 'Congratulations!' }, 'header_image');
    const top = (layout: Layout) => items(layout).find(item => item.kind === 'image')!;
    expect((top(layout) as { top: number }).top).toBeCloseTo((top(plain) as { top: number }).top + HEADLINE_LINES * LINE_PITCH, 6);
  });

  it('prints at full size when it fits, smaller to fit one line, and not at all past the smallest', () => {
    expect(headlineSize('Happy Birthday!')).toBe(28);
    const long = 'Happy seventieth birthday, Grandma Josephine!';
    const size = headlineSize(long)!;
    expect(size).toBeLessThan(28);
    expect(size).toBeGreaterThanOrEqual(18);
    expect(size * 2).toBe(Math.round(size * 2));
    const [headline] = runs(letter({ theme: 'celebration', headline: long })).filter(run => run.source === long);
    expect(headline.size).toBe(size);
    expect(runWidth(headline)).toBeLessThanOrEqual(PAGE_WIDTH - 2 * SIDE_MARGIN);
    expect(runWidth({ ...headline, size: size + 0.5 })).toBeGreaterThan(PAGE_WIDTH - 2 * SIDE_MARGIN);

    const tooLong = 'Congratulations on your graduation and your new job in the city, from all of us!';
    expect(headlineSize(tooLong)).toBeNull();
    expect(() => letter({ theme: 'celebration', headline: tooLong })).toThrow(StationeryOverflow);
    expect(() => letter({ theme: 'celebration', headline: tooLong })).toThrow(expect.objectContaining({ slot: 'headline' }));
  });
});

describe("the themes' outputs (#563)", () => {
  it('draw each path in the preview, with its stroke', () => {
    for (const theme of THEMED) {
      const layout = letter({ theme, ...SLOTS });
      const [svg] = renderPreviewSvg(layout);
      for (const path of paths(layout)) {
        const stroke = path.stroke ? ` stroke="${path.stroke}" stroke-width="${path.strokeWidth}"` : '';
        expect(svg).toContain(`<path d="${path.d}" fill="${path.fill}"${stroke}/>`);
      }
    }
  });

  it('stroke the PDF\'s lines with the preview\'s miter limit, and fill its shapes', async () => {
    for (const theme of THEMED) {
      const layout = letter({ theme, ...SLOTS });
      const pdf = await pdfjs.getDocument({ data: new Uint8Array(await renderPdf(layout)), disableFontFace: true, isEvalSupported: false }).promise;
      const ops = await (await pdf.getPage(1)).getOperatorList();
      // pdfjs folds the paint operator into constructPath as its first argument.
      const painted = (paint: number) => ops.fnArray.filter((fn, index) => fn === pdfjs.OPS.constructPath && ops.argsArray[index][0] === paint).length;
      const glyphs = runs(layout).flatMap(run => placeGlyphs(run)).length;
      const lines = paths(layout).filter(path => path.stroke && path.fill === 'none').length;
      const shapes = paths(layout).filter(path => !path.stroke).length;
      expect(painted(pdfjs.OPS.stroke)).toBe(lines);
      expect(painted(pdfjs.OPS.fill)).toBe(glyphs + shapes);
      const limits = ops.fnArray.flatMap((fn, index) => (fn === pdfjs.OPS.setMiterLimit ? [ops.argsArray[index][0]] : []));
      expect(limits).toEqual(Array(lines).fill(4));
    }
  });

  it("set each theme path's paint before the path, as PDF requires", async () => {
    for (const theme of THEMED) {
      const layout = letter({ theme, ...SLOTS });
      const pdf = (await renderPdf(layout)).toString('latin1');
      const content = [...pdf.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)]
        .map(match => {
          const bytes = Buffer.from(match[1], 'latin1');
          try {
            return inflateSync(bytes).toString('latin1');
          } catch {
            return '';
          }
        })
        .join('\n');
      // Inside a path object (from its first m to its painting operator) only
      // path operators may appear. Glyphs set their fill inside, one colour
      // each, as since #534 (P5 onward printed so); so every fill colour
      // inside is a glyph's, and no theme path sets any state inside.
      let inside = false;
      let strokeState = 0;
      let fillColours = 0;
      for (const line of content.split('\n').map(text => text.trim())) {
        if (/ m$/.test(line)) inside = true;
        else if (/^(S|s|f|f\*|F|B|B\*|b|b\*|n)$/.test(line)) inside = false;
        else if (inside && / (w|M|SCN|RG|CS)$/.test(line)) strokeState++;
        else if (inside && / scn$/.test(line)) fillColours++;
      }
      expect(strokeState).toBe(0);
      expect(fillColours).toBe(runs(layout).flatMap(run => placeGlyphs(run)).length);
      // The theme's own filled shapes (berries, confetti) are among them.
      if (theme !== 'monogram') expect(paths(layout).some(path => path.fill !== 'none')).toBe(true);
    }
  });

  it('paint a filled and stroked path with both, and skip a path with nothing to paint', async () => {
    const d = 'M100 100L200 100L200 200Z';
    const page = {
      items: [
        { kind: 'path', d, fill: '#555555', stroke: '#222222', strokeWidth: 1 } as PathItem,
        { kind: 'path', d: 'M300 300L400 400', fill: 'none' } as PathItem
      ],
      linesUsed: 0,
      linesAvailable: 0
    };
    const layout: Layout = { width: 612, height: 792, pages: [page], overflowLines: 0 };
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(await renderPdf(layout)), disableFontFace: true, isEvalSupported: false }).promise;
    const ops = await (await pdf.getPage(1)).getOperatorList();
    const paths = ops.fnArray.flatMap((fn, index) => (fn === pdfjs.OPS.constructPath ? [ops.argsArray[index][0]] : []));
    expect(paths).toEqual([pdfjs.OPS.fillStroke]);
    const [svg] = renderPreviewSvg(layout);
    expect(svg).toContain(`<path d="${d}" fill="#555555" stroke="#222222" stroke-width="1"/>`);
  });
});

describe("a theme's slots (#563)", () => {
  const placedIds = (run: TextRun) => placeGlyphs(run).map(glyph => glyph.key.split('-').pop());

  it('print as one line: tabs and line breaks become spaces, never the missing-glyph box', () => {
    expect(slotText('  Happy\nBirthday,\t\tSam!\r\n')).toBe('Happy Birthday, Sam!');
    expect(slotText('A\u2028B\u2029C\u0085D')).toBe('A B C D');
    for (const [theme, slot] of [['monogram', 'dateLine'], ['monogram', 'monogram'], ['celebration', 'headline']] as const) {
      const text = slot === 'monogram' ? 'A\tL' : 'Happy\nBirthday\tSam';
      const layout = letter({ theme, [slot]: text });
      const printed = runs(layout).find(run => run.source === slotText(text))!;
      expect(printed).toBeDefined();
      expect(runs(layout).some(run => run.source === text)).toBe(false);
      // Glyph 0 is Tinos's missing-glyph box.
      expect(placedIds(printed)).not.toContain('0');
    }
  });

  it('keep at most four marks on a letter, so nothing climbs out of the corner', () => {
    const stacked = 'A' + '\u0301'.repeat(10);
    expect([...slotText(stacked)].length).toBe(5);
    for (const stationery of [
      { theme: 'monogram', monogram: stacked },
      { theme: 'botanical', dateLine: stacked }
    ] as const) {
      const layout = letter(stationery);
      for (const item of items(layout).filter(item => !body(layout).includes(item))) {
        const box = reach(item);
        expect(box.top).toBeGreaterThanOrEqual(STATIONERY_CORNER.top);
        expect(box.left).toBeGreaterThanOrEqual(STATIONERY_CORNER.left);
      }
    }
  });

  it('take a blank headline, date line or initials as none', () => {
    const plain = letter(undefined);
    for (const blank of ['   ', '\u200b', '\n\t']) {
      const layout = letter({ theme: 'celebration', headline: blank, dateLine: blank });
      expect(body(layout)).toEqual(body(plain));
      expect(runs(layout).filter(run => !body(layout).includes(run))).toEqual([]);
      expect(paths(letter({ theme: 'monogram', monogram: blank }))).toEqual([]);
    }
  });

  it('shrink a long date line to fit the corner, and refuse one that cannot fit at 9 pt', () => {
    const long = 'Written on Wednesday, the thirtieth of September, 2026';
    const [date] = runs(letter({ theme: 'botanical', dateLine: long })).filter(run => run.source === long);
    expect(date.size).toBeLessThan(12);
    expect(date.size).toBeGreaterThanOrEqual(9);
    expect(date.x).toBeGreaterThanOrEqual(STATIONERY_CORNER.left);
    expect(date.x + runWidth(date)).toBeCloseTo(PAGE_WIDTH - SIDE_MARGIN, 6);

    const tooLong = 'Written at the kitchen table on the evening of Wednesday, the thirtieth of September';
    expect(() => letter({ theme: 'botanical', dateLine: tooLong })).toThrow(expect.objectContaining({ slot: 'dateLine' }));
  });

  it('refuse more than three initials', () => {
    expect(() => letter({ theme: 'monogram', monogram: 'ABCD' })).toThrow(StationeryOverflow);
    expect(() => letter({ theme: 'monogram', monogram: 'ABCD' })).toThrow(expect.objectContaining({ slot: 'monogram' }));
    expect(() => letter({ theme: 'monogram', monogram: 'ÅÑÉ' })).not.toThrow();
  });

  it('refuse a theme this build does not know, rather than draw another page', () => {
    expect(() => letter({ theme: 'typewriter' as StationeryTheme })).toThrow(/Unknown stationery theme: typewriter/);
  });
});
