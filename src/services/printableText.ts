/**
 * The characters printed mail can show (#526).
 *
 * PostGrid prints all our mail in Open Sans, whatever font the print HTML
 * names, and a character Open Sans lacks prints as an empty box. The preview
 * shows every character in the viewer's own fonts, so without this check a
 * letter could preview correctly, be paid for, and print boxes.
 *
 * PRINTABLE_RANGES admits only what printed in the print check of 2026-09-30
 * (#526, letter_gqVZqFrq4bTEy4Jn9N8AHK), or what the Open Sans that PostGrid
 * prints with has a glyph for. That font drew Hebrew, so it is the build in
 * googlefonts/opensans, not the classic one without Hebrew; its sources list
 * its glyphs. The check printed emoji, Chinese, Japanese, Korean, Arabic, Hindi
 * and Thai as boxes. A character left out here is refused even if the font may
 * have it: a refusal costs a rewrite, a box costs a letter. Widen a range only
 * after a test print or the font's glyph list shows it.
 *
 * The text is checked as it is stored and printed, not normalized: a
 * canonical equivalent (the angstrom sign for Å) prints only if the renderer
 * substitutes it, which no print has shown.
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
  [0x0300, 0x030c], // combining accents the font has as marks, grave to caron,
  [0x031b, 0x031b], // horn,
  [0x0323, 0x0323], // dot below,
  [0x0327, 0x0328], // cedilla and ogonek (not the comma below: ș ț come precomposed)
  [0x0384, 0x038a], // modern Greek, from the tonos...
  [0x038c, 0x038c],
  [0x038e, 0x03a1],
  [0x03a3, 0x03ce], // ...to ώ
  [0x0400, 0x04ff], // Cyrillic
  [0x05b0, 0x05c7], // Hebrew points and punctuation
  [0x05d0, 0x05ea], // Hebrew letters
  [0x1ea0, 0x1ef9], // Vietnamese letters
  [0x2000, 0x200a], // fixed-width spaces, which the font has
  [0x200b, 0x200f], // zero-width space, joiners and direction marks, which print nothing
  [0x2010, 0x2011], // hyphen and non-breaking hyphen, which assistants write
  [0x2013, 0x2014], // – —
  [0x2018, 0x201a], // ‘ ’ ‚
  [0x201c, 0x201e], // “ ” „
  [0x2020, 0x2022], // † ‡ •
  [0x2026, 0x2026], // …
  [0x202f, 0x202f], // narrow no-break space, which assistants put before AM and PM
  [0x2030, 0x2030], // ‰
  [0x2032, 0x2033], // ′ ″
  [0x2039, 0x203a], // ‹ ›
  [0x2044, 0x2044], // fraction slash
  [0x20ac, 0x20ac], // €
  [0x2122, 0x2122], // ™
  [0x2212, 0x2212], // minus sign
  [0xfb01, 0xfb02], // ﬁ ﬂ: the print draws its own ﬁ
  [0xfe00, 0xfe0f], // variation selectors: after ❤ the print drew nothing for one
  [0xfeff, 0xfeff], // zero-width no-break space
];

/** Whether a code point prints as itself rather than as an empty box. */
export function isPrintableCodePoint(codePoint: number): boolean {
  return PRINTABLE_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high);
}

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/**
 * The characters in `text` that would print as boxes, each once, in the order
 * they first appear. A character is a whole grapheme, so an emoji sequence
 * (a family, a flag, a skin tone) is reported as the one symbol it shows.
 */
export function unprintableCharacters(text: string): string[] {
  const found = new Set<string>();
  for (const { segment } of graphemes.segment(text)) {
    if (found.has(segment)) continue;
    for (const character of segment) {
      if (!isPrintableCodePoint(character.codePointAt(0)!)) {
        found.add(segment);
        break;
      }
    }
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
}

export interface UnprintableField {
  field: string;
  where: string;
  characters: string[];
}

/** Each piece of text that holds characters the print cannot show. */
export function findUnprintable(texts: PrintedText[]): UnprintableField[] {
  return texts
    .map(({ field, where, text }) => ({ field, where, characters: unprintableCharacters(text ?? '') }))
    .filter(({ characters }) => characters.length > 0);
}

const MOST_LISTED = 8;

// Spaces, controls and format characters show nothing, so the refusal names
// them. The names are for the ones assistants and pasted text carry.
const INVISIBLE = /^[\p{White_Space}\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]+$/u;
const INVISIBLE_NAMES: ReadonlyArray<readonly [number, number, string]> = [
  [0x0000, 0x001f, 'a control character'],
  [0x007f, 0x009f, 'a control character'],
  [0x2028, 0x2028, 'a line separator'],
  [0x2029, 0x2029, 'a paragraph separator'],
  [0x202a, 0x202e, 'a direction override'],
  [0x2060, 0x2060, 'a word joiner'],
  [0x2066, 0x2069, 'a direction isolate'],
];
const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u;
// Scripts whose characters can look like ones that print: a character from one
// of them is listed with its code point, so the model can tell which it is.
const LOOK_ALIKE =
  /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Hebrew}\p{Script=Common}\p{Script=Inherited}]$/u;

function codePoint(character: string): string {
  return `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
}

function invisibleName(character: string): string {
  const value = character.codePointAt(0)!;
  const named = INVISIBLE_NAMES.find(([low, high]) => value >= low && value <= high);
  const name = named ? named[2] : /\p{White_Space}/u.test(character) ? 'a special space' : 'an invisible character';
  return `${name} (${codePoint(character)})`;
}

/**
 * How the refusal shows a character: invisible ones by name and code point,
 * emoji as they are, and a character that may look like one that prints (a
 * non-breaking hyphen is not a hyphen) with the code points that do not print.
 */
function shown(grapheme: string): string {
  const characters = [...grapheme];
  if (INVISIBLE.test(grapheme)) return characters.map(invisibleName).join(', ');
  if (EMOJI.test(grapheme) || !LOOK_ALIKE.test(characters[0])) return grapheme;
  const refused = characters.filter(character => !isPrintableCodePoint(character.codePointAt(0)!));
  return `${grapheme} (${refused.map(codePoint).join(' ')})`;
}

function listed(characters: string[]): string {
  const list = characters.slice(0, MOST_LISTED).map(shown).join(', ');
  const more = characters.length - MOST_LISTED;
  return more > 0 ? `${list} and ${more} more` : list;
}

/**
 * The sentence a preview refuses with, naming each character that would print
 * as a box and where it is.
 */
export function unprintableRefusal(mail: 'letter' | 'postcard', found: UnprintableField[]): string {
  const where = found.map(({ where, characters }) => `${listed(characters)} ${where}`).join('; ');
  return (
    `Letter IRL can't print some characters in this ${mail}: ${where}. ` +
    `Printed mail shows Latin letters with common accents, modern Greek, Cyrillic, Hebrew ` +
    `and common punctuation, and no emoji. ` +
    `Take those characters out or write them in plain letters, then preview again.`
  );
}
