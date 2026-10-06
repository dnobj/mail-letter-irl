import { visualOrder } from './bidi.js';
import { loadFont, type FontName } from './fonts.js';
import { shape } from './glyphs.js';
import { BODY_FONT_SIZE, CONTENT_WIDTH, LINE_PITCH, PAGE_WIDTH, POINTS_PER_INCH, SIDE_MARGIN } from './geometry.js';
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
 * headline when there is one. Typewriter and Handwritten set the body in a
 * face of their own instead (bodyFace), on Classic's line pitch, and
 * Handwritten rules a faint line under each of the page's lines.
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
 *
 * A saved design (#649) is not a theme of its own but four choices, each made
 * only of what the themes already draw and P12 printed: the body's face (one of
 * the three), the corner's ornament (Monogram's ring, Botanical's sprig,
 * Celebration's confetti, or none), Handwritten's rules under any face, and the
 * ornament's grey, one of the four P12 printed exactly. It prints the date line
 * and may print a headline, as Celebration does. A draft stores it as the
 * `custom` theme with its design, so the page never depends on a design that
 * was changed or deleted since.
 */

/**
 * The themes: Classic, three that draw in the corner in Tinos, and Typewriter
 * and Handwritten, which set the whole letter in a face of their own (#563
 * PR 8, migration 046).
 */
export const STATIONERY_THEMES = ['classic', 'monogram', 'botanical', 'celebration', 'typewriter', 'handwritten'] as const;
export type StationeryTheme = (typeof STATIONERY_THEMES)[number];

/** The theme a saved design (#649) is drawn as: not one of STATIONERY_THEMES, which the previews offer by name. */
export const CUSTOM_THEME = 'custom';

/** A design's faces (#649): Classic's Tinos, Typewriter's Cousine and Handwritten's Caveat. */
export const STATIONERY_FACES = ['serif', 'typewriter', 'handwritten'] as const;
export type StationeryFace = (typeof STATIONERY_FACES)[number];

/** A design's corner ornaments (#649): none, or what Monogram, Botanical or Celebration draws there. */
export const STATIONERY_ORNAMENTS = ['none', 'monogram', 'sprig', 'confetti'] as const;
export type StationeryOrnament = (typeof STATIONERY_ORNAMENTS)[number];

/** A design's ornament greys (#649): the four P12 printed exactly, darkest first. */
export const STATIONERY_TONES = ['black', 'dark', 'medium', 'light'] as const;
export type StationeryTone = (typeof STATIONERY_TONES)[number];

/** A saved design's four choices (#649). */
export interface StationeryDesign {
  face: StationeryFace;
  ornament: StationeryOrnament;
  /** Faint rules under each line, as Handwritten's. */
  ruled: boolean;
  tone: StationeryTone;
}

/** The longest name a design may have (#649): the account's own label for it, never printed. */
export const STATIONERY_DESIGN_NAME_MAX_LENGTH = 40;

/** Line breaks and tabs, which a name keeps as a space. */
const NAME_BREAKS = /[\t\n\v\f\r\p{Zl}\p{Zp}]/gu;
/** Controls, broken halves of a pair, and characters with no meaning (unassigned, private use): taken out. */
const NAME_NONSENSE = /[\p{Cc}\p{Cs}\p{Cn}\p{Co}]/gu;
/**
 * The other characters that only format text (bidi controls and marks, zero-width
 * spaces, byte order marks): taken out. The joiners and the emoji tags stay, as
 * names need them: a family emoji, a Persian word's non-joiner, a flag's tags.
 * Set subtraction needs the v flag, which ES2022's regular expression literals lack.
 */
const NAME_FORMATTING = new RegExp('[\\p{Cf}--[\\p{Join_Control}\\p{Emoji_Component}]]', 'gv');
/**
 * Emoji tag characters, kept only where they make one of the three flags
 * Unicode recommends for general use, England's, Scotland's and Wales's (a
 * black flag, its tags, a cancel tag): anywhere else, a made-up flag's
 * included, they are text the person cannot see but a model reads, and a
 * saved name is read back to the chat (#649 review rounds 3 and 4).
 */
const NAME_TAGS = /(\u{1F3F4}\u{E0067}\u{E0062}(?:\u{E0065}\u{E006E}\u{E0067}|\u{E0073}\u{E0063}\u{E0074}|\u{E0077}\u{E006C}\u{E0073})\u{E007F})|[\u{E0020}-\u{E007F}]/gu;
/**
 * What a name must hold at least one of: a letter, a digit, punctuation or a
 * symbol (emoji among them), but not the blank fillers that look like nothing
 * (the Hangul fillers, the blank Braille pattern).
 */
const NAME_VISIBLE = new RegExp('[[\\p{L}\\p{N}\\p{P}\\p{S}]--[\\u{115F}\\u{1160}\\u{3164}\\u{FFA0}\\u{2800}]]', 'v');

/**
 * A design's name as it is kept (#649): line breaks and tabs a space; controls,
 * broken surrogate halves, unassigned and private-use characters, and the
 * characters that only format text taken out, but the joiners real names need
 * and the tags of a flag; at most four marks on a letter, as in the body (and so
 * stable when kept again); each run of white space one space; the ends trimmed.
 * Null when that leaves nothing visible, or more than
 * STATIONERY_DESIGN_NAME_MAX_LENGTH characters, counted as PostgreSQL counts
 * them (code points). Saving keeps a name by this rule and reading one back
 * holds it to the same, so no name saved is ever dropped on the way back. The
 * name is shown to the person, never printed.
 */
export function designNameOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = clampMarks(
    value
      .replace(NAME_BREAKS, ' ')
      .replace(NAME_NONSENSE, '')
      .replace(NAME_FORMATTING, '')
      .replace(NAME_TAGS, (_tag, flag: string | undefined) => flag ?? '')
  )
    .replace(/\s+/gu, ' ')
    .trim();
  const length = [...name].length;
  return length >= 1 && length <= STATIONERY_DESIGN_NAME_MAX_LENGTH && NAME_VISIBLE.test(name) ? name : null;
}

/** A letter's theme and what it prints. */
export interface Stationery {
  theme: StationeryTheme | typeof CUSTOM_THEME;
  /** The custom theme's design (#649), and the name it was saved under. */
  design?: StationeryDesign;
  name?: string;
  /** The date line as it prints, such as "October 1, 2026". Every theme but Classic prints it. */
  dateLine?: string;
  /** Monogram's initials, one to three letters. */
  monogram?: string;
  /** Celebration's headline, on one line above the body. */
  headline?: string;
}

/** A built-in theme's stationery (#563): what the previews take by name and their outputs say. */
export type ThemeStationery = Omit<Stationery, 'theme' | 'design' | 'name'> & { theme: StationeryTheme };

/** A typeface at a size. */
export interface Face {
  font: FontName;
  size: number;
}

const TINOS_BODY: Face = { font: 'Tinos-Regular', size: BODY_FONT_SIZE };

/**
 * The face each theme sets its body in. Every theme keeps Classic's line
 * pitch, so a page holds as many lines in each, and a letter that fits Classic
 * but not a theme is refused by its line count.
 * - The Tinos themes keep Classic's 12 pt.
 * - Typewriter sets Cousine at 11 pt: 6.6 pt a character, so 70 to a line,
 *   with an x-height near Tinos's at 12 pt.
 * - Handwritten sets Caveat at 15 pt. It is a narrow face, so at 15 pt its
 *   x-height is near Tinos's at 12 pt and a line holds about as much. Its
 *   ascent and descent (18.9 pt) fit inside the pitch.
 */
const BODY_FACES: Record<StationeryTheme, Face> = {
  classic: TINOS_BODY,
  monogram: TINOS_BODY,
  botanical: TINOS_BODY,
  celebration: TINOS_BODY,
  typewriter: { font: 'Cousine-Regular', size: 11 },
  handwritten: { font: 'Caveat-Regular', size: 15 }
};

/** A theme this build does not know is an error, never a page drawn some other way. */
function knownTheme(theme: string): asserts theme is StationeryTheme {
  if (!(STATIONERY_THEMES as readonly string[]).includes(theme)) {
    throw new Error(`Unknown stationery theme: ${String(theme).slice(0, 32)}`);
  }
}

/** The face a theme sets its body in: Tinos at 12 pt, as Classic, unless the theme has its own. */
export function bodyFace(theme: StationeryTheme): Face {
  knownTheme(theme);
  return BODY_FACES[theme];
}

/** The theme whose face each design face is (#649). */
const FACE_THEMES: Record<StationeryFace, StationeryTheme> = { serif: 'classic', typewriter: 'typewriter', handwritten: 'handwritten' };

/**
 * A design's four choices, checked (#649): the object if each is one this build
 * draws and nothing else is in it, else null. A stored design is read back
 * through this, so a page is never drawn from choices it does not know.
 */
export function designOf(value: unknown): StationeryDesign | null {
  // An array has keys of its own ('0', 'length' is not one), so the key check below refuses it too.
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !['face', 'ornament', 'ruled', 'tone'].includes(key))) return null;
  const { face, ornament, ruled, tone } = record;
  if (typeof face !== 'string' || !(STATIONERY_FACES as readonly string[]).includes(face)) return null;
  if (typeof ornament !== 'string' || !(STATIONERY_ORNAMENTS as readonly string[]).includes(ornament)) return null;
  if (typeof ruled !== 'boolean') return null;
  if (typeof tone !== 'string' || !(STATIONERY_TONES as readonly string[]).includes(tone)) return null;
  return { face: face as StationeryFace, ornament: ornament as StationeryOrnament, ruled, tone: tone as StationeryTone };
}

/** A custom theme's design, checked: one without a design this build draws is an error, never a page drawn some other way. */
function customDesign(stationery: Stationery): StationeryDesign {
  const design = designOf(stationery.design);
  if (!design) throw new Error('A custom stationery needs a design this build draws.');
  return design;
}

/** The built-in theme whose face a stationery sets its body in: its own, or a design's face's (#649). */
export function faceTheme(stationery: Stationery): StationeryTheme {
  if (stationery.theme === CUSTOM_THEME) return FACE_THEMES[customDesign(stationery).face];
  knownTheme(stationery.theme);
  return stationery.theme;
}

/** The face a stationery sets its body in: its theme's, or its design's (#649). */
export function stationeryFace(stationery: Stationery): Face {
  return BODY_FACES[faceTheme(stationery)];
}

/** Whether a stationery rules its lines: Handwritten, or a design that asks for rules (#649). */
export function isRuled(stationery: Stationery): boolean {
  if (stationery.theme === CUSTOM_THEME) return customDesign(stationery).ruled;
  return stationery.theme === 'handwritten';
}

/** Whether a stationery prints a headline: Celebration, or any design (#649). */
export function printsHeadline(stationery: Stationery): boolean {
  return stationery.theme === 'celebration' || stationery.theme === CUSTOM_THEME;
}

/** Whether a stationery prints initials: Monogram, or a design whose ornament is the monogram (#649). */
export function printsInitials(stationery: Stationery): boolean {
  if (stationery.theme === CUSTOM_THEME) return customDesign(stationery).ornament === 'monogram';
  return stationery.theme === 'monogram';
}

/**
 * The longest slot text a stored theme may carry: far past anything that
 * prints. A draft stores its slots as slotText makes them, and only as
 * stationeryOf reads them back (createDraft), so what is stored prints.
 */
export const STATIONERY_SLOT_MAX_LENGTH = 200;

/**
 * A theme read back from storage (a draft's stationery column, a letter's
 * content): the object if its theme is one this build draws and each slot is
 * absent or a string of sensible length, else null. Classic is stored as no
 * theme at all, so a stored 'classic' is not a stored theme either. A custom
 * theme (#649) reads back only with a design this build draws. Its name, never
 * printed, reads back only as a design name is kept (designNameOf); any other
 * is dropped, never a reason to refuse the letter.
 */
export function stationeryOf(value: unknown): Stationery | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const theme = record.theme;
  let stationery: Stationery;
  if (theme === CUSTOM_THEME) {
    const design = designOf(record.design);
    if (!design) return null;
    stationery = { theme: CUSTOM_THEME, design };
    const name = record.name;
    if (typeof name === 'string' && designNameOf(name) === name) stationery.name = name;
  } else if (typeof theme !== 'string' || theme === 'classic' || !(STATIONERY_THEMES as readonly string[]).includes(theme)) {
    return null;
  } else {
    stationery = { theme: theme as StationeryTheme };
  }
  for (const slot of ['dateLine', 'monogram', 'headline'] as const) {
    const text = record[slot];
    if (text === undefined || text === null) continue;
    if (typeof text !== 'string' || text.length > STATIONERY_SLOT_MAX_LENGTH) return null;
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
/** A hex colour, as the renderer's items take one. */
type Ink = `#${string}`;
const LINE_WIDTH = 0.75;

const DATE_SIZE = 12;
const DATE_MIN_SIZE = 9;
const DATE_BASELINE = inch(0.9);

/**
 * The date line's face, and the smallest size it shrinks to: the Tinos
 * themes' 12 pt, down to 9; Typewriter's in its body face, down to 9; and
 * Handwritten's in Caveat a little larger than its body, down to 12, about
 * Tinos's 9 pt in height.
 */
const DATE_FACES: Record<StationeryTheme, { face: Face; floor: number }> = {
  // Classic prints no date line; a design in its face (#649) prints the corner themes' Tinos date line.
  classic: { face: { font: FONT, size: DATE_SIZE }, floor: DATE_MIN_SIZE },
  monogram: { face: { font: FONT, size: DATE_SIZE }, floor: DATE_MIN_SIZE },
  botanical: { face: { font: FONT, size: DATE_SIZE }, floor: DATE_MIN_SIZE },
  celebration: { face: { font: FONT, size: DATE_SIZE }, floor: DATE_MIN_SIZE },
  typewriter: { face: BODY_FACES.typewriter, floor: 9 },
  handwritten: { face: { font: 'Caveat-Regular', size: 16 }, floor: 12 }
};

/**
 * A design's ornament greys (#649): the text's #222, and the three greys P12
 * printed its 0.75 pt sprigs in, each distinct and crisp.
 */
const TONE_INKS: Record<StationeryTone, Ink> = { black: '#222222', dark: '#555555', medium: '#888888', light: '#aaaaaa' };

/**
 * Handwritten's rules: one under each line, faint so the writing stands out.
 * P12 printed #aaa and 0.5 pt lines as drawn. The writing rests on its rule,
 * RULE_DROP below the baseline.
 */
const RULE_INK = '#aaaaaa';
const RULE_WIDTH = 0.5;
const RULE_DROP = 1.5;

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
function width(drawn: string, size: number, fontName: FontName = FONT): number {
  const font = loadFont(fontName);
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

function run(source: string, size: number, x: number, baseline: number, font: FontName = FONT): TextRun {
  return { kind: 'text', font, size, x, baseline, text: visualOrder(source), source };
}

/**
 * The size `drawn` prints at to fit `room`: `size` if it fits, else the
 * largest half point that does, or null below `floor`. Widths scale with the
 * size, so the half point found always fits.
 */
function fitted(drawn: string, size: number, room: number, floor: number, font: FontName = FONT): number | null {
  const full = width(drawn, size, font);
  if (full <= room) return size;
  const smaller = Math.floor(((size * room) / full) * 2) / 2;
  return smaller >= floor ? smaller : null;
}

/** The date line in its face's theme's face, its right edge on the body's, shrunk to fit the corner if it must. */
function dateLine(text: string, theme: StationeryTheme): TextRun {
  const { face, floor } = DATE_FACES[theme];
  const drawn = visualOrder(text);
  const size = fitted(drawn, face.size, RIGHT - STATIONERY_CORNER.left, floor, face.font);
  if (size === null) throw new StationeryOverflow('dateLine');
  return run(text, size, RIGHT - width(drawn, size, face.font), DATE_BASELINE, face.font);
}

/** A stretch of the page an image covers, from its top to its bottom. */
export interface Band {
  top: number;
  bottom: number;
}

/**
 * Handwritten's rules (#563): one under each line the page has room for, from
 * `top` down to `bottom` every LINE_PITCH, across the body's width, as one
 * path. A line whose band meets an image in `covered` has none, so no rule
 * crosses a picture. `baseline` is where a line's baseline sits below its top.
 */
export function ruledLines(top: number, bottom: number, baseline: number, covered: Band[] = []): PathItem | null {
  let d = '';
  for (let lineTop = top; lineTop + LINE_PITCH <= bottom + 1e-6; lineTop += LINE_PITCH) {
    if (covered.some(band => band.top < lineTop + LINE_PITCH && band.bottom > lineTop)) continue;
    const y = lineTop + baseline + RULE_DROP;
    d += `M${at([SIDE_MARGIN, y])}L${at([RIGHT, y])}`;
  }
  return d ? { kind: 'path', d, fill: 'none', stroke: RULE_INK, strokeWidth: RULE_WIDTH } : null;
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

function line(d: string, ink: Ink = INK): PathItem {
  return { kind: 'path', d, fill: 'none', stroke: ink, strokeWidth: LINE_WIDTH };
}

/**
 * The initials in a double ring, centred on their capitals, as large as fits
 * up to MONOGRAM_SIZE. The inner ring is 0.5 pt, which P12 printed exactly.
 */
function monogram(letters: string, ink: Ink = INK): LayoutItem[] {
  if ([...graphemes.segment(letters)].length > MONOGRAM_MAX_LETTERS) throw new StationeryOverflow('monogram');
  const font = loadFont(FONT);
  const drawn = visualOrder(letters);
  // Three letters always fit at 12 pt or more, so this never comes back null.
  const size = fitted(drawn, MONOGRAM_SIZE, MONOGRAM_FILL * 2 * MONOGRAM_RADIUS, 0)!;
  const [cx, cy] = MONOGRAM_CENTER;
  const baseline = cy + (font.capHeight * size) / font.unitsPerEm / 2;
  const initials = run(letters, size, cx - width(drawn, size) / 2, baseline);
  return [
    line(circle(MONOGRAM_CENTER, MONOGRAM_RADIUS), ink),
    { ...line(circle(MONOGRAM_CENTER, MONOGRAM_RADIUS - 3.5), ink), strokeWidth: 0.5 },
    // The initials in the ring's grey (#649); the themes' own are the text's ink, as before.
    ink === INK ? initials : { ...initials, fill: ink }
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
function sprig(ink: Ink = INK): LayoutItem[] {
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
    fill: ink
  }));
  return [
    line(`M${at(stem[0])}C${at(stem[1])} ${at(stem[2])} ${at(stem[3])}`, ink),
    ...leaves.map(leafPath => line(leafPath, ink)),
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
 *
 * Typewriter and Handwritten draw only their date line here; their body's
 * face (bodyFace) and Handwritten's rules (ruledLines) are the layout's.
 *
 * A design (#649) draws its ornament in its grey, the date line in its face,
 * initials when its ornament is the monogram, and a headline.
 */
export function layoutStationery(stationery: Stationery, bodyTop: number): StationeryLayout {
  const custom = stationery.theme === CUSTOM_THEME ? customDesign(stationery) : null;
  if (!custom) knownTheme(stationery.theme);
  if (stationery.theme === 'classic') return { items: [], bodyOffset: 0 };
  const slot = (text: string | undefined) => {
    const printed = slotText(text ?? '');
    return shows(printed) ? printed : null;
  };
  const ornament: StationeryOrnament = custom
    ? custom.ornament
    : stationery.theme === 'monogram' ? 'monogram' : stationery.theme === 'botanical' ? 'sprig' : stationery.theme === 'celebration' ? 'confetti' : 'none';
  const ink = custom ? TONE_INKS[custom.tone] : INK;
  const items: LayoutItem[] = [];
  if (ornament === 'sprig') items.push(...sprig(ink));
  if (ornament === 'confetti') items.push(...CONFETTI.map(confettiPiece));
  const date = slot(stationery.dateLine);
  if (date) items.push(dateLine(date, faceTheme(stationery)));
  const initials = ornament === 'monogram' ? slot(stationery.monogram) : null;
  if (initials) items.push(...monogram(initials, ink));
  const occasion = printsHeadline(stationery) ? slot(stationery.headline) : null;
  if (occasion) {
    items.push(headline(occasion, bodyTop));
    return { items, bodyOffset: HEADLINE_LINES * LINE_PITCH };
  }
  return { items, bodyOffset: 0 };
}
