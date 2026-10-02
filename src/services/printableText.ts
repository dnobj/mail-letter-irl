/**
 * The characters printed mail can show (#526).
 *
 * PostGrid prints all our mail in Open Sans, whatever font the print HTML
 * names, and a character Open Sans lacks prints as an empty box. The preview
 * shows every character in the viewer's own fonts, so without this check a
 * letter could preview correctly, be paid for, and print boxes.
 *
 * PRINTABLE_RANGES admits only what printed in two prints of 2026-09-30 (#526):
 * the print check (letter_gqVZqFrq4bTEy4Jn9N8AHK) and the coverage probe
 * (letter_wAEPpwHccd9gKtrUkPjNRu, about 220 characters decoded glyph by glyph),
 * or what the Open Sans that PostGrid prints with has a glyph for. That font
 * drew Hebrew, so it is the build in googlefonts/opensans, whose build.sh
 * subsets every shipped font to sources/OpenSans-glyphset.txt (1,146 glyphs;
 * PostGrid's glyph ids fit it). That list is the one that counts, not the
 * larger design master beside it. Characters that print nothing (joiners,
 * direction marks, variation selectors) are admitted without glyphs. The
 * prints drew emoji, Chinese, Japanese, Korean, Arabic, Hindi and Thai, arrows,
 * stars, check marks, the hyphen and the non-breaking hyphen as boxes. A
 * character left out here is refused even if the font may have it: a refusal
 * costs a rewrite, a box costs a letter. Widen a range only after a test print
 * or that list shows it.
 *
 * A character outside the ranges still prints when its canonical decomposition
 * is made of characters inside them: the renderer draws the parts. The probe
 * drew ǎ as a and a caron, ṛ as r and a dot below, ὰ as alpha and a grave, the
 * angstrom sign as Å, and yod with hiriq as its two parts. The text itself is
 * checked as it is stored and printed, not normalized.
 *
 * A letter drawn by our own renderer (#534) prints its text in the renderer's
 * font instead, so its text is checked against that font (drawsGrapheme in
 * src/render/layout.ts). Its addresses are still stamped by PostGrid in Open
 * Sans and are checked here.
 */

const PRINTABLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0009, 0x000a], // tab, line feed
  [0x000d, 0x000d], // carriage return
  [0x0020, 0x007e], // Basic Latin
  [0x00a0, 0x017f], // Latin-1 Supplement and Latin Extended-A
  [0x0192, 0x0192], // ƒ
  [0x01a0, 0x01a1], // Ơ ơ (Vietnamese)
  [0x01af, 0x01b0], // Ư ư (Vietnamese)
  [0x0218, 0x021b], // Ș ș Ț ț (Romanian)
  [0x0259, 0x0259], // ə (the probe printed it; the capital, U+018F, came out a box)
  [0x02bc, 0x02bc], // ʼ, the modifier apostrophe (not ʻ, U+02BB: a box)
  [0x02c6, 0x02c7], // spacing accents the probe printed:
  [0x02c9, 0x02c9], //   ˆ ˇ ˉ
  [0x02d8, 0x02dd], //   ˘ ˙ ˚ ˛ ˜ ˝
  [0x0300, 0x0304], // combining accents the shipped font has as marks: grave to macron,
  [0x0306, 0x030c], // breve to caron (not the overline),
  [0x0323, 0x0323], // dot below,
  [0x0327, 0x0328], // cedilla and ogonek (not the horn or comma below: ơ ư ș ț come precomposed)
  [0x0384, 0x038a], // modern Greek, from the tonos...
  [0x038c, 0x038c],
  [0x038e, 0x03a1],
  [0x03a3, 0x03ce], // ...to ώ
  [0x03d1, 0x03d1], // ϑ and
  [0x03d6, 0x03d6], //   ϖ, which the probe printed (not ϐ or ϕ: boxes)
  [0x0400, 0x0486], // Cyrillic, without U+0487...
  [0x0488, 0x04ff],
  [0x0500, 0x0513], // Cyrillic Supplement as far as the font has it (the probe printed Ԁ ԁ; Ԛ on, boxes)
  [0x05b0, 0x05be], // Hebrew points and maqaf,
  [0x05c1, 0x05c2], // shin and sin dots,
  [0x05c7, 0x05c7], // qamats qatan
  [0x05d0, 0x05ea], // Hebrew letters
  [0x1e9e, 0x1e9e], // ẞ, the capital sharp s
  [0x1ea0, 0x1ef9], // Vietnamese letters
  [0x2000, 0x200b], // fixed-width spaces and the zero-width space, which the font has
  [0x200c, 0x200f], // joiners and direction marks, which print nothing
  [0x2013, 0x2015], // en and em dash, horizontal bar (not U+2010 or U+2011: boxes)
  [0x2017, 0x201e], // ‗, and the quotation marks ‘ ’ ‚ ‛ “ ” „ (not ‟: a box)
  [0x2020, 0x2022], // † ‡ •
  [0x2026, 0x2026], // …
  [0x202f, 0x202f], // narrow no-break space: no glyph, but the print draws a space
  [0x2030, 0x2030], // ‰
  [0x2032, 0x2033], // ′ ″
  [0x2039, 0x203a], // ‹ ›
  [0x2044, 0x2044], // fraction slash
  [0x205f, 0x205f], // medium mathematical space: drawn as a space too
  [0x2070, 0x2070], // superscript 0,
  [0x2074, 0x2079], //   4 to 9,
  [0x207f, 0x207f], //   and n
  [0x2080, 0x2089], // subscript digits
  [0x20aa, 0x20ac], // ₪ ₫ € (not ₴ ₽ ₹ ₺ ₿ ₩ ₦ ₱ ₲ ₡: boxes)
  [0x2105, 0x2105], // ℅
  [0x2113, 0x2113], // ℓ
  [0x2116, 0x2116], // №
  [0x2120, 0x2120], // ℠
  [0x2122, 0x2122], // ™
  [0x212e, 0x212e], // ℮
  [0x215b, 0x215e], // ⅛ ⅜ ⅝ printed, and ⅞ is on the font's list (not ⅓ or ⅔: boxes)
  [0x2202, 0x2202], // the math signs the probe printed: ∂
  [0x2206, 0x2206], //   ∆
  [0x220f, 0x220f], //   ∏
  [0x2211, 0x2212], //   ∑ −
  [0x221a, 0x221a], //   √
  [0x221e, 0x221e], //   ∞
  [0x222b, 0x222b], //   ∫
  [0x2248, 0x2248], //   ≈
  [0x2260, 0x2260], //   ≠
  [0x2264, 0x2265], //   ≤ ≥
  [0x25ca, 0x25ca], // ◊ (every other shape and arrow was a box)
  [0xfb00, 0xfb04], // the ligatures ﬀ ﬁ ﬂ ﬃ ﬄ
  [0xfe00, 0xfe0f], // variation selectors: after ❤ the print drew nothing for one
  [0xfeff, 0xfeff], // zero-width no-break space
];

function inRanges(codePoint: number): boolean {
  return PRINTABLE_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high);
}

/**
 * Whether a code point prints rather than as an empty box: it is in the ranges,
 * or its canonical decomposition is made of characters that are, which the
 * renderer draws in its place.
 */
export function isPrintableCodePoint(codePoint: number): boolean {
  if (inRanges(codePoint)) return true;
  const character = String.fromCodePoint(codePoint);
  const decomposed = character.normalize('NFD');
  return decomposed !== character && [...decomposed].every(part => inRanges(part.codePointAt(0)!));
}

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** Whether a grapheme cluster prints as written, in one font. */
export type PrintsGrapheme = (grapheme: string) => boolean;

/** PostGrid's Open Sans: the legacy HTML letters, postcards and every address block. */
export const printsInOpenSans: PrintsGrapheme = grapheme =>
  [...grapheme].every(character => isPrintableCodePoint(character.codePointAt(0)!));

/**
 * The characters in `text` that would not print as written, each once, in
 * the order they first appear. A character is a whole grapheme, so an emoji
 * sequence (a family, a flag, a skin tone) is reported as the one symbol it
 * shows.
 */
export function unprintableCharacters(text: string, prints: PrintsGrapheme = printsInOpenSans): string[] {
  const found = new Set<string>();
  for (const { segment } of graphemes.segment(text)) {
    if (!found.has(segment) && !prints(segment)) found.add(segment);
  }
  return [...found];
}

/** A piece of printed text, and how the refusal names where it is. */
export interface PrintedText {
  /** For the log: which input the text came from. */
  field: string;
  /** For the refusal: "in the text", "in the recipient's address". */
  where: string;
  text: string | null | undefined;
  /** The font it prints in; Open Sans unless given. */
  prints?: PrintsGrapheme;
}

export interface UnprintableField {
  field: string;
  where: string;
  characters: string[];
  /** The font the text prints in, which the refusal names characters by; Open Sans unless given. */
  prints?: PrintsGrapheme;
}

/** Each piece of text that holds characters the print cannot show. */
export function findUnprintable(texts: PrintedText[]): UnprintableField[] {
  return texts
    .map(({ field, where, text, prints }) => ({
      field,
      where,
      characters: unprintableCharacters(text ?? '', prints),
      ...(prints ? { prints } : {})
    }))
    .filter(({ characters }) => characters.length > 0);
}

const MOST_LISTED = 8;

// Spaces, controls, format, private-use and unassigned characters show
// nothing a reader could name, so the refusal names them. The names are for
// the ones assistants and pasted text carry.
const INVISIBLE_CLASSES = '\\p{White_Space}\\p{Cc}\\p{Cf}\\p{Cs}\\p{Co}\\p{Cn}';
const INVISIBLE = new RegExp(`^[${INVISIBLE_CLASSES}]+$`, 'u');
const INVISIBLE_START = new RegExp(`^[${INVISIBLE_CLASSES}]`, 'u');
const INVISIBLE_NAMES: ReadonlyArray<readonly [number, number, string]> = [
  [0x0000, 0x001f, 'a control character'],
  [0x007f, 0x009f, 'a control character'],
  [0x2028, 0x2028, 'a line separator'],
  [0x2029, 0x2029, 'a paragraph separator'],
  [0x202a, 0x202e, 'a direction override'],
  [0x2060, 0x2060, 'a word joiner'],
  [0x2066, 0x2069, 'a direction isolate'],
  [0x3000, 0x3000, 'an ideographic space'],
];
const INVISIBLE_KINDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\p{Cs}/u, 'a broken character'],
  [/\p{Co}/u, 'a private-use character'],
  [/\p{Cn}/u, 'an unassigned character'],
  [/\p{White_Space}/u, 'a special space'],
];
// An emoji shows as itself: a character drawn as an emoji by default (a flag
// is two of them), or a pictograph in an emoji sequence (❤\uFE0F is ❤ with the
// emoji variation selector). A lone text symbol such as ★ or ‼, one in text
// presentation (✔\uFE0E) or one with a mark may look like characters that print,
// so it is listed as a look-alike.
const EMOJI = /\p{Emoji_Presentation}/u;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const EMOJI_SEQUENCE_PART = /^[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji_Modifier}\u{E0020}-\u{E007F}]$/u;
const EMOJI_JOINERS = new Set(['\uFE0F', '\u200D']);
// Scripts whose characters can look like ones that print: a character from one
// of them is listed with its code point, so the model can tell which it is.
const LOOK_ALIKE =
  /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Hebrew}\p{Script=Common}\p{Script=Inherited}]/u;

function codePoint(character: string): string {
  return `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
}

function invisibleName(character: string): string {
  const value = character.codePointAt(0)!;
  const named = INVISIBLE_NAMES.find(([low, high]) => value >= low && value <= high);
  const kind = INVISIBLE_KINDS.find(([pattern]) => pattern.test(character));
  const name = named ? named[2] : kind ? kind[1] : 'an invisible character';
  return `${name} (${codePoint(character)})`;
}

/**
 * How the refusal shows a character: invisible ones by name and code point,
 * emoji and other scripts as they are, and a character that may look like one
 * that prints (a non-breaking hyphen is not a hyphen) with the code points
 * that do not print in the text's font. A cluster whose every character
 * prints, refused only as a whole, carries too many marks (#534).
 */
function shown(grapheme: string, prints: PrintsGrapheme): string {
  const characters = [...grapheme];
  const refused = characters.filter(character => !prints(character));
  if (INVISIBLE.test(grapheme)) return (refused.length > 0 ? refused : characters).map(invisibleName).join(', ');
  const emoji =
    EMOJI.test(grapheme) ||
    (characters.length > 1 &&
      PICTOGRAPHIC.test(grapheme) &&
      characters.every(character => EMOJI_JOINERS.has(character) || EMOJI_SEQUENCE_PART.test(character)));
  if (emoji || !(LOOK_ALIKE.test(grapheme) || INVISIBLE_START.test(grapheme))) return grapheme;
  if (refused.length === 0) return `${grapheme} (too many marks on one letter)`;
  return `${grapheme} (${refused.map(codePoint).join(' ')})`;
}

function listed(characters: string[], prints: PrintsGrapheme = printsInOpenSans): string {
  const list = characters.slice(0, MOST_LISTED).map(grapheme => shown(grapheme, prints)).join(', ');
  const more = characters.length - MOST_LISTED;
  return more > 0 ? `${list} and ${more} more` : list;
}

/**
 * A theme whose own typeface printed the text (#563): which theme, and the
 * fields it prints, so a refusal of one of them says that another stationery
 * may print what this one cannot.
 */
export interface ThemedFace {
  theme: string;
  fields: readonly string[];
  /**
   * Whether Classic's face draws a character: another stationery is
   * suggested only when it draws every one refused in `fields` (an emoji
   * prints in none).
   */
  drawnInClassic: (grapheme: string) => boolean;
  /** Where the theme came from, when the call did not name it (rememberedPrefix); else empty. */
  remembered?: string;
}

/**
 * The sentence a preview refuses with, naming each character that would print
 * as a box and where it is.
 */
export function unprintableRefusal(mail: 'letter' | 'postcard', found: UnprintableField[], themed?: ThemedFace): string {
  const where = found.map(({ where, characters, prints }) => `${listed(characters, prints)} ${where}`).join('; ');
  // The fields the theme's own face refused: the refusal says where the
  // theme came from, and suggests another only when Classic draws them all.
  const face = themed && found.some(({ field }) => themed.fields.includes(field)) ? themed : undefined;
  const elsewhere = face !== undefined &&
    found.filter(({ field }) => face.fields.includes(field)).every(({ characters }) => characters.every(face.drawnInClassic));
  return (
    (face?.remembered ?? '') +
    `Letter IRL can't print some characters in this ${mail}: ${where}. ` +
    `Printed mail shows Latin letters with common accents, modern Greek, Cyrillic, Hebrew ` +
    `and common punctuation, and no emoji. ` +
    (face && elsewhere
      ? `The ${face.theme} stationery sets the text in its own typeface, which has fewer: choose another ` +
        `stationery, or take those characters out or write them in plain letters, then preview again.`
      : `Take those characters out or write them in plain letters, then preview again.`)
  );
}
