import { visualOrder } from './bidi.js';
import { loadFont, type FontName } from './fonts.js';
import { shape } from './glyphs.js';
import { CONTENT_WIDTH, LINE_PITCH, PAGE_WIDTH, POINTS_PER_INCH, SIDE_MARGIN } from './geometry.js';
import type { LayoutItem, PathItem, TextRun } from './layout.js';
import { clampMarks } from './marks.js';

/**
 * Stationery (#563): themes that restyle a letter's page, drawn by this
 * renderer, so a theme looks the same in the preview and on paper.
 *
 * Classic is today's page and draws nothing here. Every other theme prints a
 * date line, and draws only in the top-right corner beside the envelope window
 * and, for Celebration's headline, above the body. Nothing a theme draws
 * reaches the body's lines, so the body lays out as in Classic, below a
 * headline when there is one.
 *
 * Ink is black and greys only: letters print with `color: false`. Probe P12
 * printed every grey it tried, from #000 to #aaa, and every tint exactly as
 * drawn; the themes' #222 lies among them. Lines are 0.5 pt and up: P12
 * printed 0.5 to 1 pt strokes cleanly, while a 0.25 pt rule came back lighter.
 *
 * A slot (the date line, the initials, the headline) prints as one line: see
 * slotText. Each has a rule for text that will not fit: the date line and the
 * initials shrink to a floor, the headline shrinks to its own, and past that
 * the layout throws StationeryOverflow, which a preview turns into a refusal.
 */

export const STATIONERY_THEMES = ['classic', 'monogram', 'botanical', 'celebration'] as const;
export type StationeryTheme = (typeof STATIONERY_THEMES)[number];

/** A letter's theme and what it prints. */
export interface Stationery {
  theme: StationeryTheme;
  /** The date line as it prints, such as "October 1, 2026". Every theme but Classic prints it. */
  dateLine?: string;
  /** Monogram's initials, one to three letters. */
  monogram?: string;
  /** Celebration's headline, on one line above the body. */
  headline?: string;
}

/** The longest slot text a stored theme may carry: far past anything that prints. */
const STORED_SLOT_MAX_LENGTH = 200;

/**
 * A theme read back from storage (a draft's stationery column, a letter's
 * content): the object if its theme is one this build draws and each slot is
 * absent or a string of sensible length, else null. Classic is stored as no
 * theme at all, so a stored 'classic' is not a stored theme either.
 */
export function stationeryOf(value: unknown): Stationery | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const theme = record.theme;
  if (typeof theme !== 'string' || theme === 'classic' || !(STATIONERY_THEMES as readonly string[]).includes(theme)) {
    return null;
  }
  const stationery: Stationery = { theme: theme as StationeryTheme };
  for (const slot of ['dateLine', 'monogram', 'headline'] as const) {
    const text = record[slot];
    if (text === undefined || text === null) continue;
    if (typeof text !== 'string' || text.length > STORED_SLOT_MAX_LENGTH) return null;
    stationery[slot] = text;
  }
  return stationery;
}

/** What a theme adds to a page, and how far it moves the body down. */
export interface StationeryLayout {
  items: LayoutItem[];
  /** How far below BODY_TOP the body starts: a headline's room, or 0. */
  bodyOffset: number;
}

const inch = (inches: number): number => inches * POINTS_PER_INCH;

/**
 * The top-right corner, beside the envelope window, where a theme draws.
 * Probe P12 (PostGrid test mode, 2026-10-01, letter_k7rHRrWmsn28GJy64cSLHt)
 * printed a date line, a monogram and a dashed outline of this whole area,
 * with PostGrid's address stamp, white boxes and frame clear of all of it.
 */
export const STATIONERY_CORNER = { left: inch(4), top: inch(0.35), right: inch(8), bottom: inch(2.85) } as const;

const FONT: FontName = 'Tinos-Regular';
/** Where the corner's drawing lines up: the body's right edge, 7.5 in. */
const RIGHT = PAGE_WIDTH - SIDE_MARGIN;
const INK = '#222222';
const LINE_WIDTH = 0.75;

const DATE_SIZE = 12;
const DATE_MIN_SIZE = 9;
const DATE_BASELINE = inch(0.9);

const MONOGRAM_RADIUS = inch(0.45);
const MONOGRAM_CENTER: Point = [RIGHT - MONOGRAM_RADIUS, inch(1.85)];
const MONOGRAM_SIZE = 26;
/** The initials take at most this share of the circle's width. */
const MONOGRAM_FILL = 0.7;
const MONOGRAM_MAX_LETTERS = 3;

const HEADLINE_SIZE = 28;
const HEADLINE_MIN_SIZE = 18;
/** The room a headline takes above the body, in the body's lines. */
export const HEADLINE_LINES = 3;

/**
 * A slot that cannot print as its theme draws it: a headline or a date line
 * too long for its line at the smallest size it prints at, or initials of more
 * than three letters.
 */
export class StationeryOverflow extends Error {
  constructor(readonly slot: 'dateLine' | 'monogram' | 'headline') {
    super(`The stationery's ${slot} does not fit.`);
    this.name = 'StationeryOverflow';
  }
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

type Point = [number, number];

const fixed = (value: number): string => String(Math.round(value * 100) / 100);
const at = ([x, y]: Point): string => `${fixed(x)} ${fixed(y)}`;

/** The drawn width of text already in visual order, in points, as glyphs.ts places it. */
function width(drawn: string, size: number): number {
  const font = loadFont(FONT);
  return (shape(font, drawn).advanceWidth * size) / font.unitsPerEm;
}

/**
 * A slot's text as it prints: one line. Tabs and line breaks become spaces
 * (Tinos has no glyph for either, and a slot is shaped as one line, so each
 * would print the font's missing-glyph box), runs of spaces collapse, the
 * ends are trimmed, and a letter keeps at most four combining marks, as in the
 * body. A preview checks this text, so what it checks is what prints.
 */
export function slotText(text: string): string {
  return clampMarks(text.replace(/[\t\n\v\f\r\u0085\u2028\u2029]/g, ' ').replace(/ {2,}/g, ' ').trim());
}

/** Whether a slot's text, as it prints, draws anything at all. */
function shows(text: string): boolean {
  return visualOrder(text).trim() !== '';
}

function run(source: string, size: number, x: number, baseline: number): TextRun {
  return { kind: 'text', font: FONT, size, x, baseline, text: visualOrder(source), source };
}

/**
 * The size `drawn` prints at to fit `room`: `size` if it fits, else the
 * largest half point that does, or null below `floor`. Widths scale with the
 * size, so the half point found always fits.
 */
function fitted(drawn: string, size: number, room: number, floor: number): number | null {
  const full = width(drawn, size);
  if (full <= room) return size;
  const smaller = Math.floor(((size * room) / full) * 2) / 2;
  return smaller >= floor ? smaller : null;
}

/** The date line, its right edge on the body's, shrunk to fit the corner if it must. */
function dateLine(text: string): TextRun {
  const drawn = visualOrder(text);
  const size = fitted(drawn, DATE_SIZE, RIGHT - STATIONERY_CORNER.left, DATE_MIN_SIZE);
  if (size === null) throw new StationeryOverflow('dateLine');
  return run(text, size, RIGHT - width(drawn, size), DATE_BASELINE);
}

/** A circle as four cubics: path data with M, C and Z only, as the card's sanitiser allows. */
function circle([cx, cy]: Point, r: number): string {
  const k = 0.5522847498 * r;
  return `M${at([cx + r, cy])}` +
    `C${at([cx + r, cy + k])} ${at([cx + k, cy + r])} ${at([cx, cy + r])}` +
    `C${at([cx - k, cy + r])} ${at([cx - r, cy + k])} ${at([cx - r, cy])}` +
    `C${at([cx - r, cy - k])} ${at([cx - k, cy - r])} ${at([cx, cy - r])}` +
    `C${at([cx + k, cy - r])} ${at([cx + r, cy - k])} ${at([cx + r, cy])}Z`;
}

function line(d: string): PathItem {
  return { kind: 'path', d, fill: 'none', stroke: INK, strokeWidth: LINE_WIDTH };
}

/**
 * The initials in a double ring, centred on their capitals, as large as fits
 * up to MONOGRAM_SIZE. The inner ring is 0.5 pt, which P12 printed exactly.
 */
function monogram(letters: string): LayoutItem[] {
  if ([...graphemes.segment(letters)].length > MONOGRAM_MAX_LETTERS) throw new StationeryOverflow('monogram');
  const font = loadFont(FONT);
  const drawn = visualOrder(letters);
  // Three letters always fit at 12 pt or more, so this never comes back null.
  const size = fitted(drawn, MONOGRAM_SIZE, MONOGRAM_FILL * 2 * MONOGRAM_RADIUS, 0)!;
  const [cx, cy] = MONOGRAM_CENTER;
  const baseline = cy + (font.capHeight * size) / font.unitsPerEm / 2;
  return [
    line(circle(MONOGRAM_CENTER, MONOGRAM_RADIUS)),
    { ...line(circle(MONOGRAM_CENTER, MONOGRAM_RADIUS - 3.5)), strokeWidth: 0.5 },
    run(letters, size, cx - width(drawn, size) / 2, baseline)
  ];
}

function cubicPoint([a, b, c, d]: Point[], t: number): Point {
  const u = 1 - t;
  const weights = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return [
    weights[0] * a[0] + weights[1] * b[0] + weights[2] * c[0] + weights[3] * d[0],
    weights[0] * a[1] + weights[1] * b[1] + weights[2] * c[1] + weights[3] * d[1]
  ];
}

function cubicDirection([a, b, c, d]: Point[], t: number): Point {
  const u = 1 - t;
  const dx = 3 * u * u * (b[0] - a[0]) + 6 * u * t * (c[0] - b[0]) + 3 * t * t * (d[0] - c[0]);
  const dy = 3 * u * u * (b[1] - a[1]) + 6 * u * t * (c[1] - b[1]) + 3 * t * t * (d[1] - c[1]);
  const length = Math.hypot(dx, dy);
  return [dx / length, dy / length];
}

function turn([x, y]: Point, degrees: number): Point {
  const radians = (degrees * Math.PI) / 180;
  return [x * Math.cos(radians) - y * Math.sin(radians), x * Math.sin(radians) + y * Math.cos(radians)];
}

/** An almond leaf from its base to its tip, with a vein along its middle. */
function leaf(base: Point, tip: Point, breadth: number): string {
  const [dx, dy] = [tip[0] - base[0], tip[1] - base[1]];
  const length = Math.hypot(dx, dy);
  const [nx, ny] = [(-dy / length) * breadth, (dx / length) * breadth];
  const along = (share: number, side: number): Point => [base[0] + dx * share + nx * side, base[1] + dy * share + ny * side];
  return `M${at(base)}C${at(along(1 / 3, 1))} ${at(along(2 / 3, 1))} ${at(tip)}` +
    `C${at(along(2 / 3, -1))} ${at(along(1 / 3, -1))} ${at(base)}Z` +
    `M${at(base)}L${at(along(0.75, 0))}`;
}

/** Botanical: one sprig rising to the right below the date, leaves on alternate sides, three berries at its tip. */
function sprig(): LayoutItem[] {
  const stem: Point[] = [
    [RIGHT - inch(1.3), inch(2.75)],
    [RIGHT - inch(1.1), inch(2.15)],
    [RIGHT - inch(0.55), inch(1.75)],
    [RIGHT - inch(0.12), inch(1.12)]
  ];
  const leaves = [
    { t: 0.16, side: -1, length: inch(0.42) },
    { t: 0.32, side: 1, length: inch(0.4) },
    { t: 0.48, side: -1, length: inch(0.36) },
    { t: 0.64, side: 1, length: inch(0.32) },
    { t: 0.8, side: -1, length: inch(0.26) }
  ].map(({ t, side, length }) => {
    const base = cubicPoint(stem, t);
    const [ux, uy] = turn(cubicDirection(stem, t), side * 52);
    return leaf(base, [base[0] + ux * length, base[1] + uy * length], length * 0.3);
  });
  const tip = stem[3];
  const berries = ([[4, -3], [-3, -6], [6, 4]] as Point[]).map(([dx, dy]): PathItem => ({
    kind: 'path',
    d: circle([tip[0] + dx, tip[1] + dy], 2.4),
    fill: INK
  }));
  return [
    line(`M${at(stem[0])}C${at(stem[1])} ${at(stem[2])} ${at(stem[3])}`),
    ...leaves.map(line),
    ...berries
  ];
}

const CONFETTI_GREYS = ['#222222', '#555555', '#888888', '#aaaaaa'];

/**
 * Celebration's confetti, at fixed places in the corner, clear of the date
 * line: x and y in inches, a shape, its turn in degrees, and its grey.
 */
const CONFETTI: Array<[number, number, 'strip' | 'triangle' | 'dot', number, number]> = [
  [4.35, 0.62, 'strip', 20, 0], [4.9, 1.05, 'triangle', -15, 1], [5.4, 0.55, 'dot', 0, 2],
  [5.85, 1.3, 'strip', -35, 3], [4.6, 1.6, 'dot', 0, 1], [5.2, 1.95, 'strip', 55, 0],
  [6.15, 1.75, 'triangle', 30, 2], [6.7, 1.35, 'strip', 10, 1], [7.3, 1.6, 'dot', 0, 3],
  [6.95, 2.15, 'triangle', -40, 0], [5.75, 2.45, 'dot', 0, 2], [4.4, 2.3, 'triangle', 25, 3],
  [6.35, 2.6, 'strip', -20, 2], [7.35, 2.5, 'strip', 40, 1], [5.05, 2.65, 'strip', -5, 1],
  [6.0, 0.5, 'triangle', 12, 3], [4.75, 2.05, 'dot', 0, 0], [7.0, 0.45, 'dot', 0, 2]
];

function confettiPiece([x, y, shape, degrees, grey]: (typeof CONFETTI)[number]): PathItem {
  const centre: Point = [inch(x), inch(y)];
  const fill = CONFETTI_GREYS[grey];
  if (shape === 'dot') return { kind: 'path', d: circle(centre, 2.6), fill };
  const corners: Point[] = shape === 'strip'
    ? [[-4.5, -2.25], [4.5, -2.25], [4.5, 2.25], [-4.5, 2.25]]
    : [[0, -4.2], [3.6, 2.1], [-3.6, 2.1]];
  const placed = corners.map((corner): Point => {
    const [dx, dy] = turn(corner, degrees);
    return [centre[0] + dx, centre[1] + dy];
  });
  return { kind: 'path', d: `M${placed.map(at).join('L')}Z`, fill };
}

/**
 * The size a headline prints at, on one line across the body's width: its
 * full size if it fits, else the largest half point down to the smallest
 * that does, or null when it cannot fit at all. Of the text as it prints:
 * pass it through slotText first.
 */
export function headlineSize(text: string): number | null {
  return fitted(visualOrder(text), HEADLINE_SIZE, CONTENT_WIDTH, HEADLINE_MIN_SIZE);
}

/** The headline, centred above the body, in the room HEADLINE_LINES leaves. */
function headline(text: string, top: number): TextRun {
  const size = headlineSize(text);
  if (size === null) throw new StationeryOverflow('headline');
  const x = SIDE_MARGIN + (CONTENT_WIDTH - width(visualOrder(text), size)) / 2;
  return run(text, size, x, top + 1.9 * LINE_PITCH);
}

/**
 * What a theme draws on a letter's page whose body starts at `bodyTop`, and
 * how far the body moves down for it. Classic draws nothing. A slot prints as
 * slotText makes it, and not at all when that draws nothing; a slot a theme
 * does not print (a headline outside Celebration) is ignored. A theme this
 * build does not know is an error, never a page drawn some other way.
 */
export function layoutStationery(stationery: Stationery, bodyTop: number): StationeryLayout {
  if (!(STATIONERY_THEMES as readonly string[]).includes(stationery.theme)) {
    throw new Error(`Unknown stationery theme: ${String(stationery.theme).slice(0, 32)}`);
  }
  if (stationery.theme === 'classic') return { items: [], bodyOffset: 0 };
  const slot = (text: string | undefined) => {
    const printed = slotText(text ?? '');
    return shows(printed) ? printed : null;
  };
  const items: LayoutItem[] = [];
  if (stationery.theme === 'botanical') items.push(...sprig());
  if (stationery.theme === 'celebration') items.push(...CONFETTI.map(confettiPiece));
  const date = slot(stationery.dateLine);
  if (date) items.push(dateLine(date));
  const initials = stationery.theme === 'monogram' ? slot(stationery.monogram) : null;
  if (initials) items.push(...monogram(initials));
  const occasion = stationery.theme === 'celebration' ? slot(stationery.headline) : null;
  if (occasion) {
    items.push(headline(occasion, bodyTop));
    return { items, bodyOffset: HEADLINE_LINES * LINE_PITCH };
  }
  return { items, bodyOffset: 0 };
}
