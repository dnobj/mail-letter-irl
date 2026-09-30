/**
 * The characters printed mail can show (#526).
 *
 * PostGrid prints all our mail in Open Sans, whatever font the print HTML
 * names, and a character Open Sans lacks prints as an empty box. The preview
 * shows every character in the viewer's own fonts, so without this check a
 * letter could preview correctly, be paid for, and print boxes.
 *
 * PRINTABLE_RANGES keeps to the scripts Open Sans covers (Latin with
 * Vietnamese, Greek, Cyrillic and Hebrew) and to common punctuation and
 * symbols. The print check of 2026-09-30 (docs/manual-tests.md, Validation
 * Errors) printed a sample of each, and printed emoji, Chinese, Japanese,
 * Korean, Arabic, Hindi and Thai as boxes. A symbol left out here is refused
 * even if Open Sans may have it: a refusal costs a rewrite, a box costs a
 * letter.
 */

const PRINTABLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0009, 0x000a], // tab, line feed
  [0x000d, 0x000d], // carriage return
  [0x0020, 0x007e], // Basic Latin
  [0x00a0, 0x024f], // Latin-1 Supplement, Latin Extended-A and -B
  [0x02bb, 0x02bc], // ʻ ʼ
  [0x02c6, 0x02c7], // ˆ ˇ
  [0x02c9, 0x02c9], // ˉ
  [0x02d8, 0x02dd], // ˘ ˙ ˚ ˛ ˜ ˝
  [0x0300, 0x036f], // combining accents that NFC leaves uncomposed
  [0x0370, 0x03ff], // Greek
  [0x0400, 0x052f], // Cyrillic and its supplement
  [0x0590, 0x05ff], // Hebrew
  [0x1e00, 0x1eff], // Latin Extended Additional, with Vietnamese
  [0x1f00, 0x1fff], // Greek Extended
  [0x2000, 0x203b], // General Punctuation: spaces, dashes, quotes, bullets...
  [0x203d, 0x2048], // ...without ‼ (U+203C)
  [0x204a, 0x206f], // ...or ⁉ (U+2049), which are emoji
  [0x20aa, 0x20ac], // ₪ ₫ €
  [0x20b4, 0x20b4], // ₴
  [0x20bd, 0x20bd], // ₽
  [0x2113, 0x2113], // ℓ
  [0x2116, 0x2116], // №
  [0x2122, 0x2122], // ™
  [0x2126, 0x2126], // Ω
  [0x212e, 0x212e], // ℮
  [0xfb01, 0xfb02], // ﬁ ﬂ
  [0xfe00, 0xfe0f], // variation selectors, drawn as nothing
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
 *
 * The text is checked in NFC: the print composes a letter and its accent into
 * the font's accented letter, as NFC does.
 */
export function unprintableCharacters(text: string): string[] {
  const found: string[] = [];
  for (const { segment } of graphemes.segment(text.normalize('NFC'))) {
    if (found.includes(segment)) continue;
    for (const character of segment) {
      if (!isPrintableCodePoint(character.codePointAt(0)!)) {
        found.push(segment);
        break;
      }
    }
  }
  return found;
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

function listed(characters: string[]): string {
  const shown = characters.slice(0, MOST_LISTED).join(' ');
  const more = characters.length - MOST_LISTED;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

/**
 * The sentence a preview refuses with, naming each character that would print
 * as a box and where it is.
 */
export function unprintableRefusal(mail: 'letter' | 'postcard', found: UnprintableField[]): string {
  const where = found.map(({ where, characters }) => `${listed(characters)} ${where}`).join('; ');
  return (
    `Letter IRL can't print some characters in this ${mail}: ${where}. ` +
    `Printed mail shows Latin, Greek, Cyrillic and Hebrew letters and common punctuation, and no emoji. ` +
    `Take those characters out or put them in words, then preview again.`
  );
}
