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
  'Symbols: € £ ¥ © ® ™ — – “double” ‘single’ … •',
  'Test'
];

const BOXES: Array<[string, string]> = [
  ['emoji', '🎉 🎂 ❤️ 👍 😊'],
  ['Chinese', '你好，世界'],
  ['Japanese', 'こんにちは'],
  ['Korean', '안녕하세요'],
  ['Arabic', 'مرحبا بالعالم'],
  ['Hindi', 'नमस्ते दुनिया'],
  ['Thai', 'สวัสดีชาวโลก']
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
    const family = '\u{1F469}‍\u{1F469}‍\u{1F467}';
    const flag = '\u{1F1FA}\u{1F1F8}';
    const thumb = '\u{1F44D}\u{1F3FD}';
    expect(unprintableCharacters(`A ${family}, a ${flag} and a ${thumb}.`)).toEqual([family, flag, thumb]);
  });

  it('keeps line breaks, tabs, and accents written as combining marks', () => {
    expect(unprintableCharacters('Line one\r\nLine two\tend\n')).toEqual([]);
    expect(unprintableCharacters('café naïve Nguyễn ça')).toEqual([]);
  });

  it('keeps the characters that print nothing: joiners, direction marks, variation selectors', () => {
    expect(unprintableCharacters('©️ ™︎ a‍b ﻿ ‏')).toEqual([]);
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
    expect(unprintableCharacters('Pay to ‮cba')).toEqual(['‮']);
    expect(unprintableCharacters('one two')).toEqual([' ']);
  });

  it('refuses symbols no print has shown', () => {
    expect(unprintableCharacters('→ ✓ ★ ♥ ‼ follow‑up')).toEqual(['→', '✓', '★', '♥', '‼', '‑']);
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
    expect(isPrintableCodePoint(0x2010)).toBe(false); // hyphen, not shown to print
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
      "Letter IRL can't print some characters in this letter: 🎉 🎂 in the text; " +
        "王 小 明 in the recipient's address. " +
        'Printed mail shows Latin letters with common accents, modern Greek, Cyrillic, Hebrew ' +
        'and common punctuation, and no emoji. ' +
        'Take those characters out or write them in plain letters, then preview again.'
    );
  });

  it('names invisible characters and look-alikes by code point', () => {
    const found = findUnprintable([
      { field: 'bodyText', where: 'in the text', text: 'At 7:00 PM, a follow‑up → here.' }
    ]);
    expect(unprintableRefusal('letter', found)).toContain(
      'in this letter: U+202F ‑ (U+2011) → (U+2192) in the text.'
    );
  });

  it('lists at most eight characters of a field', () => {
    const found = findUnprintable([{ field: 'message', where: 'in the message', text: '一二三四五六七八九十' }]);
    expect(unprintableRefusal('postcard', found)).toContain(
      'in this postcard: 一 二 三 四 五 六 七 八 and 2 more in the message.'
    );
  });

  it('finds nothing in printable text or a missing field', () => {
    expect(
      findUnprintable([
        { field: 'bodyText', where: 'in the text', text: 'Dear Zoë, see you in Kraków − or Braşov.' },
        { field: 'signOff', where: 'in the sign-off', text: undefined },
        { field: 'sender', where: "in the sender's address", text: null }
      ])
    ).toEqual([]);
  });
});
