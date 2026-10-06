/**
 * Saved stationery designs (#649), as the renderer draws them: a design is
 * four choices (a face, a corner ornament, rules, the ornament's grey), each
 * made only of what the themes already draw and probe P12 printed. A design in
 * black with a theme's pieces draws exactly that theme's page; a grey moves
 * only the ornament's ink; a stored design reads back only as this build draws
 * it.
 */

import { describe, expect, it } from 'vitest';
import { ADDRESS_ZONE, BODY_TOP, LINE_PITCH } from '../../../src/render/geometry.js';
import { placeGlyphs } from '../../../src/render/glyphs.js';
import { layoutLetter, type Layout, type LayoutItem, type PathItem, type TextRun } from '../../../src/render/layout.js';
import { rendererVersionFor, renderPdf, STATIONERY_RENDERER_VERSION } from '../../../src/render/pdf.js';
import { renderPreviewSvg } from '../../../src/render/preview.js';
import {
  CUSTOM_THEME,
  designOf,
  HEADLINE_LINES,
  isRuled,
  layoutStationery,
  printsHeadline,
  printsInitials,
  STATIONERY_CORNER,
  STATIONERY_DESIGN_NAME_MAX_LENGTH,
  STATIONERY_FACES,
  STATIONERY_ORNAMENTS,
  STATIONERY_THEMES,
  STATIONERY_TONES,
  stationeryFace,
  stationeryOf,
  StationeryOverflow,
  type Stationery,
  type StationeryDesign
} from '../../../src/render/stationery.js';
import { ownFaceTheme } from '../../../src/tools/letterHelpers.js';

const TEXT = 'Dear Sam,\n\nHappy birthday! I hope this year brings you everything you have been hoping for.\n\nWith love,\nAda';
const DATE = 'October 1, 2026';
const PLAIN: StationeryDesign = { face: 'serif', ornament: 'none', ruled: false, tone: 'black' };
const custom = (design: Partial<StationeryDesign> = {}, slots: Partial<Stationery> = {}): Stationery => ({
  theme: CUSTOM_THEME,
  design: { ...PLAIN, ...design },
  name: 'Mine',
  dateLine: DATE,
  ...slots
});
const letter = (stationery?: Stationery) => layoutLetter({ text: TEXT, layoutType: 'text_only', stationery });
const items = (layout: Layout) => layout.pages[0].items;
const paths = (layout: Layout) => items(layout).filter((item): item is PathItem => item.kind === 'path');
const runs = (layout: Layout) => items(layout).filter((item): item is TextRun => item.kind === 'text');
const bodyRuns = (layout: Layout) => runs(layout).filter(run => run.baseline > BODY_TOP);
/** The corner's drawing: what the stationery adds above the body, but the date line. */
const corner = (stationery: Stationery) => layoutStationery(stationery, BODY_TOP).items.filter(item => !(item.kind === 'text' && item.source === DATE));
const inks = (item: LayoutItem): string[] =>
  item.kind === 'path'
    ? [item.fill, item.stroke].filter((ink): ink is string => ink !== undefined && ink !== 'none')
    : item.kind === 'text' ? [item.fill ?? 'black'] : [];

/** The box an item's ink can reach, as stationery.test.ts measures it. */
function reach(item: LayoutItem): { left: number; top: number; right: number; bottom: number } {
  let xs: number[] = [];
  let ys: number[] = [];
  const add = (d: string, dx = 0, dy = 0) => {
    const numbers = [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map(match => Number(match[0]));
    xs = xs.concat(numbers.filter((_, index) => index % 2 === 0).map(value => value + dx));
    ys = ys.concat(numbers.filter((_, index) => index % 2 === 1).map(value => value + dy));
  };
  if (item.kind === 'path') {
    const half = (item.strokeWidth ?? 0) * 2;
    add(item.d);
    return { left: Math.min(...xs) - half, top: Math.min(...ys) - half, right: Math.max(...xs) + half, bottom: Math.max(...ys) + half };
  }
  if (item.kind !== 'text') throw new Error(`no reach for ${item.kind}`);
  for (const glyph of placeGlyphs(item)) add(glyph.outline, glyph.x, glyph.y);
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

describe('a design (#649)', () => {
  it('is four choices, each one this build draws, and nothing else', () => {
    expect(designOf(PLAIN)).toEqual(PLAIN);
    for (const face of STATIONERY_FACES) expect(designOf({ ...PLAIN, face })?.face).toBe(face);
    for (const ornament of STATIONERY_ORNAMENTS) expect(designOf({ ...PLAIN, ornament })?.ornament).toBe(ornament);
    for (const tone of STATIONERY_TONES) expect(designOf({ ...PLAIN, tone })?.tone).toBe(tone);
    expect(designOf({ ...PLAIN, ruled: true })?.ruled).toBe(true);
    const refused: unknown[] = [
      null, undefined, 'serif', [PLAIN], {},
      { ...PLAIN, face: 'script' }, { ...PLAIN, ornament: 'border' }, { ...PLAIN, tone: 'red' }, { ...PLAIN, ruled: 'yes' },
      { ...PLAIN, face: 'Serif' }, { ...PLAIN, extra: true }, { face: 'serif', ornament: 'none', ruled: false },
      { ...PLAIN, face: 'toString' }
    ];
    for (const value of refused) expect(designOf(value), JSON.stringify(value)).toBeNull();
  });

  it('is not a theme the previews offer by name', () => {
    expect((STATIONERY_THEMES as readonly string[]).includes(CUSTOM_THEME)).toBe(false);
  });

  it('sets the body in its face, at the face\'s own size, on Classic\'s lines', () => {
    const faces = { serif: ['Tinos-Regular', 12], typewriter: ['Cousine-Regular', 11], handwritten: ['Caveat-Regular', 15] } as const;
    const classic = letter();
    for (const face of STATIONERY_FACES) {
      const [font, size] = faces[face];
      expect(stationeryFace(custom({ face }))).toEqual({ font, size });
      const layout = letter(custom({ face }));
      expect(bodyRuns(layout).every(run => run.font === font && run.size === size), face).toBe(true);
      expect(layout.pages[0].linesAvailable).toBe(classic.pages[0].linesAvailable);
    }
  });

  it('prints the date line in its face, as the theme of that face does', () => {
    const date = (stationery: Stationery) => runs(letter(stationery)).find(run => run.source === DATE)!;
    expect(date(custom({ face: 'serif' }))).toEqual(date({ theme: 'botanical', dateLine: DATE }));
    expect(date(custom({ face: 'typewriter' }))).toEqual(date({ theme: 'typewriter', dateLine: DATE }));
    expect(date(custom({ face: 'handwritten' }))).toEqual(date({ theme: 'handwritten', dateLine: DATE }));
  });

  it("draws a theme's corner exactly in black: the sprig, the confetti, the monogram's ring and initials", () => {
    const same: Array<[Partial<StationeryDesign>, Stationery]> = [
      [{ ornament: 'sprig' }, { theme: 'botanical', dateLine: DATE }],
      [{ ornament: 'confetti' }, { theme: 'celebration', dateLine: DATE }],
      [{ ornament: 'monogram' }, { theme: 'monogram', dateLine: DATE, monogram: 'AL' }]
    ];
    for (const [design, theme] of same) {
      expect(layoutStationery(custom(design, { monogram: theme.monogram }), BODY_TOP), design.ornament).toEqual(layoutStationery(theme, BODY_TOP));
    }
    // And the whole page, body and all.
    expect(letter(custom({ face: 'typewriter' }))).toEqual(letter({ theme: 'typewriter', dateLine: DATE }));
  });

  it('draws nothing in the corner but the date line with no ornament', () => {
    expect(corner(custom())).toEqual([]);
    expect(paths(letter(custom()))).toEqual([]);
  });

  it('inks the sprig and the monogram in its grey, every stroke and fill, the initials too', () => {
    const greys = { black: '#222222', dark: '#555555', medium: '#888888', light: '#aaaaaa' } as const;
    for (const tone of STATIONERY_TONES) {
      for (const ornament of ['sprig', 'monogram'] as const) {
        const drawn = corner(custom({ ornament, tone }, { monogram: 'AL' }));
        expect(drawn.length, `${ornament} ${tone}`).toBeGreaterThan(2);
        for (const item of drawn) {
          const expected = tone === 'black' && item.kind === 'text' ? 'black' : greys[tone];
          expect(inks(item), `${ornament} ${tone}`).toEqual(inks(item).map(() => expected));
          expect(inks(item).length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("keeps the confetti's own mix of greys, whatever the design's grey", () => {
    const black = corner(custom({ ornament: 'confetti', tone: 'black' }));
    for (const tone of STATIONERY_TONES) expect(corner(custom({ ornament: 'confetti', tone }))).toEqual(black);
  });

  it('draws only in the corner beside the envelope window, in every ornament, face and grey', () => {
    for (const ornament of STATIONERY_ORNAMENTS) {
      for (const face of STATIONERY_FACES) {
        for (const tone of STATIONERY_TONES) {
          for (const item of layoutStationery(custom({ ornament, face, tone }, { monogram: 'WWW' }), BODY_TOP).items) {
            const box = reach(item);
            const label = `${ornament} ${face} ${tone}`;
            expect(box.left, label).toBeGreaterThanOrEqual(STATIONERY_CORNER.left);
            expect(box.right, label).toBeLessThanOrEqual(STATIONERY_CORNER.right);
            expect(box.top, label).toBeGreaterThanOrEqual(STATIONERY_CORNER.top);
            expect(box.bottom, label).toBeLessThanOrEqual(STATIONERY_CORNER.bottom);
            expect(box.left, label).toBeGreaterThan(ADDRESS_ZONE.right);
          }
        }
      }
    }
  });

  it('rules its lines when it asks, under any face, and not otherwise, Caveat included', () => {
    const ruledPaths = (stationery: Stationery) => paths(letter(stationery)).filter(path => path.stroke === '#aaaaaa' && path.strokeWidth === 0.5);
    for (const face of STATIONERY_FACES) {
      expect(isRuled(custom({ face, ruled: true }))).toBe(true);
      expect(isRuled(custom({ face, ruled: false }))).toBe(false);
      expect(ruledPaths(custom({ face, ruled: true })), face).toHaveLength(1);
      expect(ruledPaths(custom({ face, ruled: false })), face).toHaveLength(0);
    }
    // Ruled in Caveat is Handwritten's page.
    expect(letter(custom({ face: 'handwritten', ruled: true }))).toEqual(letter({ theme: 'handwritten', dateLine: DATE }));
    expect(isRuled({ theme: 'handwritten' })).toBe(true);
    expect(isRuled({ theme: 'typewriter' })).toBe(false);
  });

  it('prints a headline above the body, whatever its ornament, as Celebration does', () => {
    const HEADLINE = 'Happy Birthday, Sam!';
    for (const ornament of STATIONERY_ORNAMENTS) {
      const stationery = custom({ ornament }, { headline: HEADLINE, monogram: 'AL' });
      expect(printsHeadline(stationery)).toBe(true);
      const layout = layoutStationery(stationery, BODY_TOP);
      expect(layout.bodyOffset, ornament).toBe(HEADLINE_LINES * LINE_PITCH);
      expect(layout.items.filter(item => item.kind === 'text' && item.source === HEADLINE), ornament).toHaveLength(1);
    }
    expect(layoutStationery(custom({}, { headline: '   ' }), BODY_TOP).bodyOffset).toBe(0);
    expect(printsHeadline({ theme: 'celebration' })).toBe(true);
    expect(printsHeadline({ theme: 'botanical' })).toBe(false);
  });

  it('prints initials only with the monogram ornament', () => {
    for (const ornament of STATIONERY_ORNAMENTS) {
      const stationery = custom({ ornament }, { monogram: 'AL' });
      expect(printsInitials(stationery), ornament).toBe(ornament === 'monogram');
      const printed = layoutStationery(stationery, BODY_TOP).items.some(item => item.kind === 'text' && item.source === 'AL');
      expect(printed, ornament).toBe(ornament === 'monogram');
    }
    expect(printsInitials({ theme: 'monogram' })).toBe(true);
    expect(printsInitials({ theme: 'celebration' })).toBe(false);
  });

  it("refuses what will not fit, as the themes do: a date line past the corner, more than three initials", () => {
    expect(() => layoutStationery(custom({}, { dateLine: 'W'.repeat(60) }), BODY_TOP)).toThrow(StationeryOverflow);
    expect(() => layoutStationery(custom({ ornament: 'monogram' }, { monogram: 'ABCD' }), BODY_TOP)).toThrow(StationeryOverflow);
  });

  it('refuses a custom stationery without a design this build draws, rather than draw another page', () => {
    const broken = [
      { theme: CUSTOM_THEME },
      { theme: CUSTOM_THEME, design: { ...PLAIN, ornament: 'border' } }
    ] as unknown as Stationery[];
    for (const stationery of broken) {
      expect(() => layoutStationery(stationery, BODY_TOP)).toThrow('A custom stationery needs a design this build draws.');
      expect(() => stationeryFace(stationery)).toThrow();
      expect(() => isRuled(stationery)).toThrow();
      expect(() => letter(stationery)).toThrow();
    }
  });

  it("names its own face for the printable check, unless it is Classic's", () => {
    expect(ownFaceTheme(custom({ face: 'serif' }))).toBeUndefined();
    expect(ownFaceTheme(custom({ face: 'typewriter' }))).toBe(CUSTOM_THEME);
    expect(ownFaceTheme(custom({ face: 'handwritten' }))).toBe(CUSTOM_THEME);
  });

  it('records the themes\' renderer version, and draws in the preview and the PDF', async () => {
    const stationery = custom({ face: 'handwritten', ornament: 'sprig', ruled: true, tone: 'medium' }, { headline: 'For Sam' });
    expect(rendererVersionFor(stationery)).toBe(STATIONERY_RENDERER_VERSION);
    const layout = letter(stationery);
    const [svg] = renderPreviewSvg(layout);
    expect(svg).toContain('#888888');
    const pdf = await renderPdf(layout);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});

describe('a stored design (#649)', () => {
  it('reads back with its design, its name and its slots', () => {
    const stored = { theme: 'custom', design: { face: 'typewriter', ornament: 'monogram', ruled: true, tone: 'dark' }, name: 'Grandma', dateLine: DATE, monogram: 'AL', headline: 'Hello' };
    expect(stationeryOf(stored)).toEqual(stored);
    expect(stationeryOf({ ...stored, name: undefined })).toEqual({ ...stored, name: undefined });
    expect(stationeryOf({ ...stored, name: null })).not.toHaveProperty('name');
  });

  it('reads back as nothing without a design this build draws, or with a name past its length', () => {
    const stored = { theme: 'custom', design: PLAIN, name: 'Grandma', dateLine: DATE };
    const refused: unknown[] = [
      { ...stored, design: undefined },
      { ...stored, design: { ...PLAIN, tone: 'blue' } },
      { ...stored, design: [PLAIN] },
      { ...stored, name: 7 },
      { ...stored, name: 'x'.repeat(STATIONERY_DESIGN_NAME_MAX_LENGTH + 1) },
      { ...stored, headline: 'x'.repeat(201) },
      { ...stored, theme: 'Custom' }
    ];
    for (const value of refused) expect(stationeryOf(value), JSON.stringify(value).slice(0, 80)).toBeNull();
    expect(stationeryOf({ ...stored, name: 'x'.repeat(STATIONERY_DESIGN_NAME_MAX_LENGTH) })).not.toBeNull();
  });

  it("keeps a theme's own read-back as it was: no design, no name", () => {
    expect(stationeryOf({ theme: 'botanical', dateLine: DATE, design: PLAIN, name: 'Mine' })).toEqual({ theme: 'botanical', dateLine: DATE });
  });
});
