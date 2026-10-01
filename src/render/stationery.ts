import { visualOrder } from './bidi.js';
import { loadFont, type FontName } from './fonts.js';
import { shape } from './glyphs.js';
import { CONTENT_WIDTH, LINE_PITCH, PAGE_WIDTH, POINTS_PER_INCH, SIDE_MARGIN } from './geometry.js';
import type { LayoutItem, PathItem, TextRun } from './layout.js';

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
 * Ink is black and greys only: letters print with `color: false`, and probe
 * P12 showed every grey a theme uses kept exactly in PostGrid's flattened page.
 * Lines are 0.75 pt: P12 printed 0.5 to 1 pt strokes cleanly, while a 0.25 pt
 * rule came back lighter than drawn.
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
const DATE_BASELINE = inch(0.9);

const MONOGRAM_RADIUS = inch(0.45);
const MONOGRAM_CENTER: Point = [RIGHT - MONOGRAM_RADIUS, inch(1.85)];
const MONOGRAM_SIZE = 26;
/** The initials take at most this share of the circle's width. */
const MONOGRAM_FILL = 0.7;

const HEADLINE_SIZE = 28;
const HEADLINE_MIN_SIZE = 18;
/** The room a headline takes above the body, in the body's lines. */
export const HEADLINE_LINES = 3;

/** A headline too long for one line at the smallest size it prints at. */
export class HeadlineOverflow extends Error {
  constructor() {
    super('The headline does not fit on one line.');
    this.name = 'HeadlineOverflow';
  }
}

type Point = [number, number];

const fixed = (value: number): string => String(Math.round(value * 100) / 100);
const at = ([x, y]: Point): string => `${fixed(x)} ${fixed(y)}`;

/** The drawn width of text already in visual order, in points, as glyphs.ts places it. */
function width(drawn: string, size: number): number {
  const font = loadFont(FONT);
  return (shape(font, drawn).advanceWidth * size) / font.unitsPerEm;
}

function run(source: string, size: number, x: number, baseline: number): TextRun {
  return { kind: 'text', font: FONT, size, x, baseline, text: visualOrder(source), source };
}

/** The date line, its right edge on the body's. */
function dateLine(text: string): TextRun {
  return run(text, DATE_SIZE, RIGHT - width(visualOrder(text), DATE_SIZE), DATE_BASELINE);
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
  const font = loadFont(FONT);
  const drawn = visualOrder(letters);
  const room = MONOGRAM_FILL * 2 * MONOGRAM_RADIUS;
  const full = width(drawn, MONOGRAM_SIZE);
  const size = full <= room ? MONOGRAM_SIZE : Math.floor(((MONOGRAM_SIZE * room) / full) * 2) / 2;
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
 * that does, or null when it cannot fit at all.
 */
export function headlineSize(text: string): number | null {
  const full = width(visualOrder(text), HEADLINE_SIZE);
  if (full <= CONTENT_WIDTH) return HEADLINE_SIZE;
  const size = Math.floor(((HEADLINE_SIZE * CONTENT_WIDTH) / full) * 2) / 2;
  return size >= HEADLINE_MIN_SIZE ? size : null;
}

/** The headline, centred above the body, in the room HEADLINE_LINES leaves. */
function headline(text: string, top: number): TextRun {
  const size = headlineSize(text);
  if (size === null) throw new HeadlineOverflow();
  const x = SIDE_MARGIN + (CONTENT_WIDTH - width(visualOrder(text), size)) / 2;
  return run(text, size, x, top + 1.9 * LINE_PITCH);
}

/**
 * What a theme draws on a letter's page whose body starts at `bodyTop`, and
 * how far the body moves down for it. Classic draws nothing; a slot a theme
 * does not print (a headline outside Celebration) is ignored.
 */
export function layoutStationery(stationery: Stationery, bodyTop: number): StationeryLayout {
  if (stationery.theme === 'classic') return { items: [], bodyOffset: 0 };
  const items: LayoutItem[] = [];
  if (stationery.theme === 'botanical') items.push(...sprig());
  if (stationery.theme === 'celebration') items.push(...CONFETTI.map(confettiPiece));
  if (stationery.dateLine) items.push(dateLine(stationery.dateLine));
  if (stationery.theme === 'monogram' && stationery.monogram) items.push(...monogram(stationery.monogram));
  if (stationery.theme === 'celebration' && stationery.headline) {
    items.push(headline(stationery.headline, bodyTop));
    return { items, bodyOffset: HEADLINE_LINES * LINE_PITCH };
  }
  return { items, bodyOffset: 0 };
}
