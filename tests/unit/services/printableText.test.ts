/**
 * What printed mail can show (#526).
 *
 * PostGrid prints all our mail in Open Sans, and a character the font lacks
 * prints as an empty box. The print check of 2026-09-30 (#526,
 * letter_gqVZqFrq4bTEy4Jn9N8AHK) printed every line of PRINTED, and printed
 * every character of BOXES as a box. What no print has shown is refused.
 */

import { describe, expect, it } from 'vitest';
import {
  findUnprintable,
  isPrintableCodePoint,
  unprintableCharacters,
  unprintableRefusal
} from '../../../src/services/printableText.js';

const PRINTED = [
  'Print check for fonts and wrapping (#77).',
  'This paragraph is ordinary prose in mixed case, written to measure how many characters fit.',
  'THIS PARAGRAPH IS THE SAME KIND OF PROSE IN CAPITAL LETTERS, BECAUSE SOME PEOPLE WRITE THAT WAY.',
  'Accents: café, naïve, jalapeño, Zoë, Nguyễn, façade',
  'Greek and Cyrillic: Γειά σου κόσμε / Привет, мир',
  'Hebrew: שלום עולם',
  'Symbols: € £ ¥ © ® ™ \u2014 \u2013 “double” ‘single’ … •',
  'Test'
];

const BOXES: Array<[string, string]> = [
  ['emoji', '🎉 🎂 ❤\uFE0F 👍 😊'],
  ['Chinese', '你好，世界'],
  ['Japanese', 'こんにちは'],
  ['Korean', '안녕하세요'],
  ['Arabic', 'مرحبا بالعالم'],
  ['Hindi', 'नमस\u094Dत\u0947 द\u0941निया'],
  ['Thai', 'สว\u0E31สด\u0E35ชาวโลก']
];

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** Each grapheme of the text but its spaces, once, in order. */
function distinctGraphemes(text: string): string[] {
  const out: string[] = [];
  for (const { segment } of segmenter.segment(text)) {
    if (segment.trim() !== '' && !out.includes(segment)) out.push(segment);
  }
  return out;
}

describe('characters printed mail can show (#526)', () => {
  it('prints every line the print check printed', () => {
    for (const line of PRINTED) {
      expect(unprintableCharacters(line), line).toEqual([]);
    }
  });

  it.each(BOXES)('refuses every %s character, which printed as a box', (_script, text) => {
    const expected = distinctGraphemes(text);
    expect(expected.length).toBeGreaterThan(0);
    expect(unprintableCharacters(text)).toEqual(expected);
  });

  it('reports an emoji sequence as the one symbol it shows', () => {
    const family = '\u{1F469}\u200D\u{1F469}\u200D\u{1F467}';
    const flag = '\u{1F1FA}\u{1F1F8}';
    const thumb = '\u{1F44D}\u{1F3FD}';
    expect(unprintableCharacters(`A ${family}, a ${flag} and a ${thumb}.`)).toEqual([family, flag, thumb]);
  });

  it('keeps line breaks, tabs, and accents written as combining marks', () => {
    expect(unprintableCharacters('Line one\r\nLine two\tend\n')).toEqual([]);
    expect(unprintableCharacters('cafe\u0301 nai\u0308ve Nguye\u0302\u0303n c\u0327a')).toEqual([]);
  });

  it('keeps the characters that print nothing: joiners, direction marks, variation selectors', () => {
    expect(unprintableCharacters('©\uFE0F ™\uFE0E a\u200Db \uFEFF \u200F')).toEqual([]);
  });

  it('refuses a canonical equivalent that no print has shown', () => {
    // The angstrom and kelvin signs print only if the renderer substitutes Å and K.
    expect(unprintableCharacters('5 Å, 300 K')).toEqual(['Å', 'K']);
  });

  it('refuses letters no print has shown: pinyin tones, Sanskrit dots, polytonic Greek', () => {
    expect(unprintableCharacters('Nǐ hǎo')).toEqual(['ǐ', 'ǎ']);
    expect(unprintableCharacters('Kṛṣṇa')).toEqual(['ṛ', 'ṣ', 'ṇ']);
    expect(unprintableCharacters('γνῶθι')).toEqual(['ῶ']);
  });

  it('refuses controls, direction overrides and line separators', () => {
    expect(unprintableCharacters('bell\u0007')).toEqual(['\u0007']);
    expect(unprintableCharacters('Pay to \u202Ecba')).toEqual(['\u202E']);
    expect(unprintableCharacters('one\u2028two')).toEqual(['\u2028']);
  });

  it('refuses symbols no print has shown', () => {
    expect(unprintableCharacters('→ ✓ ★ ♥ ‼ 1\u20122')).toEqual(['→', '✓', '★', '♥', '‼', '\u2012']);
  });

  it('refuses the hyphens and the narrow no-break space the shipped font has no glyph for', () => {
    expect(unprintableCharacters('A follow\u2011up at 7:00\u202FPM, well\u2010known.')).toEqual([
      '\u2011',
      '\u202F',
      '\u2010'
    ]);
  });

  it('lists each character once, in the order it first appears', () => {
    expect(unprintableCharacters('🎉 a 🎂 b 🎉 c 🎂')).toEqual(['🎉', '🎂']);
  });

  it('draws its ranges at the edges it names', () => {
    expect(isPrintableCodePoint(0x017f)).toBe(true); // ſ, the last of Latin Extended-A
    expect(isPrintableCodePoint(0x0180)).toBe(false); // ƀ, Latin Extended-B
    expect(isPrintableCodePoint(0x0192)).toBe(true); // ƒ
    expect(isPrintableCodePoint(0x1e9f)).toBe(false); // ẟ, just before the Vietnamese letters
    expect(isPrintableCodePoint(0x1ea0)).toBe(true); // Ạ
    expect(isPrintableCodePoint(0x1ef9)).toBe(true); // ỹ
    expect(isPrintableCodePoint(0x03ce)).toBe(true); // ώ
    expect(isPrintableCodePoint(0x03cf)).toBe(false); // Ϗ
    expect(isPrintableCodePoint(0x05ea)).toBe(true); // ת
    expect(isPrintableCodePoint(0x05f3)).toBe(false); // geresh, not shown to print
    expect(isPrintableCodePoint(0x2011)).toBe(false); // non-breaking hyphen: no glyph in the shipped font
    expect(isPrintableCodePoint(0x2012)).toBe(false); // figure dash, not shown to print
    expect(isPrintableCodePoint(0x202e)).toBe(false); // right-to-left override
    expect(isPrintableCodePoint(0x202f)).toBe(false); // narrow no-break space: no glyph either
    expect(isPrintableCodePoint(0x200b)).toBe(true); // zero-width space, which the font has
    expect(isPrintableCodePoint(0x0304)).toBe(true); // combining macron
    expect(isPrintableCodePoint(0x0305)).toBe(false); // combining overline: no glyph
    expect(isPrintableCodePoint(0x0306)).toBe(true); // combining breve
    expect(isPrintableCodePoint(0x031b)).toBe(false); // combining horn: no glyph
    expect(isPrintableCodePoint(0x0486)).toBe(true); // Cyrillic psili pneumata
    expect(isPrintableCodePoint(0x0487)).toBe(false); // Cyrillic pokrytie: no glyph
    expect(isPrintableCodePoint(0x05be)).toBe(true); // maqaf
    expect(isPrintableCodePoint(0x05bf)).toBe(false); // rafe: no glyph
    expect(isPrintableCodePoint(0x05c0)).toBe(false); // paseq: no glyph
    expect(isPrintableCodePoint(0x05c1)).toBe(true); // shin dot
    expect(isPrintableCodePoint(0x05c2)).toBe(true); // sin dot
    expect(isPrintableCodePoint(0x05c3)).toBe(false); // sof pasuq: no glyph
    expect(isPrintableCodePoint(0x05c6)).toBe(false); // nun hafukha: no glyph
    expect(isPrintableCodePoint(0x05c7)).toBe(true); // qamats qatan
    expect(isPrintableCodePoint(0x2212)).toBe(true); // minus sign
    expect(isPrintableCodePoint(0x20ac)).toBe(true); // €
    expect(isPrintableCodePoint(0x20b9)).toBe(false); // ₹, not shown to print
    expect(isPrintableCodePoint(0x0008)).toBe(false); // backspace
    expect(isPrintableCodePoint(0x007f)).toBe(false); // delete
  });
});

describe('the refusal', () => {
  it('names each character and where it is', () => {
    const found = findUnprintable([
      { field: 'bodyText', where: 'in the text', text: 'Happy birthday! 🎉🎂' },
      { field: 'signOff', where: 'in the sign-off', text: 'Love, Mom' },
      { field: 'recipient', where: "in the recipient's address", text: '王小明\n350 Fifth Ave' }
    ]);

    expect(found.map(f => f.field)).toEqual(['bodyText', 'recipient']);
    expect(unprintableRefusal('letter', found)).toBe(
      "Letter IRL can't print some characters in this letter: 🎉, 🎂 in the text; " +
        "王, 小, 明 in the recipient's address. " +
        'Printed mail shows Latin letters with common accents, modern Greek, Cyrillic, Hebrew ' +
        'and common punctuation, and no emoji. ' +
        'Take those characters out or write them in plain letters, then preview again.'
    );
  });

  it('names invisible characters, and gives look-alikes their code point', () => {
    const found = findUnprintable([
      {
        field: 'bodyText',
        where: 'in the text',
        text: 'At 7:00\u2060PM,\u2028a 1\u20122 score → Hawaiʻi, Ａ\u205F.'
      }
    ]);
    expect(unprintableRefusal('letter', found)).toContain(
      'in this letter: a word joiner (U+2060), a line separator (U+2028), \u2012 (U+2012), ' +
        '→ (U+2192), ʻ (U+02BB), Ａ (U+FF21), a medium mathematical space (U+205F) in the text.'
    );
  });

  it('shows every kind of character in the way that lets a model find it', () => {
    const found = findUnprintable([
      // Emoji as they are: by default presentation, a flag, a sequence.
      { field: 'emoji', where: 'in A', text: '\u{1F389} \u{1F1FA}\u{1F1F8} ❤\uFE0F' },
      // A lone text symbol, and letters of the look-alike scripts, with code points.
      { field: 'lookAlike', where: 'in B', text: '★ ‼ ῶ ԁ ׳ \u0000' },
      // A symbol in text presentation, or with a mark, is no emoji: code points.
      { field: 'textSymbol', where: 'in B2', text: '✔\uFE0E ★\u0301' },
      // A lone mark (Inherited), with its code point.
      { field: 'mark', where: 'in C', text: '\u034F' },
      // Invisible characters by name.
      { field: 'invisible', where: 'in D', text: 'a\u2029b\u202Ec\u2066d\u2062e\u202Ff\u3000g' },
      // Private-use with a joiner (not named), unassigned with a mark, and alone:
      // an unassigned character and a broken one (a lone surrogate).
      { field: 'other', where: 'in E', text: '\uE000\u200D \u0378\u0301 \uFFFE \uD83D' }
    ]);
    const refusal = unprintableRefusal('letter', found);
    expect(refusal).toContain(': \u{1F389}, \u{1F1FA}\u{1F1F8}, ❤\uFE0F in A;');
    expect(refusal).toContain(
      '; ★ (U+2605), ‼ (U+203C), ῶ (U+1FF6), ԁ (U+0501), ׳ (U+05F3), ' +
        'a control character (U+0000) in B;'
    );
    expect(refusal).toContain('; ✔\uFE0E (U+2714), ★\u0301 (U+2605) in B2;');
    expect(refusal).toContain('; \u034F (U+034F) in C;');
    expect(refusal).toContain(
      '; a paragraph separator (U+2029), a direction override (U+202E), a direction isolate (U+2066), ' +
        'an invisible character (U+2062), a narrow no-break space (U+202F), an ideographic space (U+3000) in D;'
    );
    expect(refusal).toContain(
      '; a private-use character (U+E000), \u0378\u0301 (U+0378), an unassigned character (U+FFFE), ' +
        'a broken character (U+D83D) in E.'
    );
  });

  it('gives the refused code point of a mark on a printable letter, and none to other scripts', () => {
    const found = findUnprintable([{ field: 'bodyText', where: 'in the text', text: 'a\u034F and नमस\u094Dत\u0947' }]);
    const refusal = unprintableRefusal('letter', found);
    expect(refusal).toContain('in this letter: a\u034F (U+034F), न, म');
    expect(refusal).not.toMatch(/U\+09[0-7]/);
  });

  it('lists at most eight characters of a field', () => {
    const found = findUnprintable([{ field: 'message', where: 'in the message', text: '一二三四五六七八九十' }]);
    expect(unprintableRefusal('postcard', found)).toContain(
      'in this postcard: 一, 二, 三, 四, 五, 六, 七, 八 and 2 more in the message.'
    );
  });

  it('finds nothing in printable text or a missing field', () => {
    expect(
      findUnprintable([
        { field: 'bodyText', where: 'in the text', text: 'Dear Zoë, see you in Kraków \u2212 or Braşov.' },
        { field: 'signOff', where: 'in the sign-off', text: undefined },
        { field: 'sender', where: "in the sender's address", text: null }
      ])
    ).toEqual([]);
  });
});
