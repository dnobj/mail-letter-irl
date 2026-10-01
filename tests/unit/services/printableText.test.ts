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

  it('prints a canonical equivalent as the character it stands for, as the coverage probe did', () => {
    // The kelvin and angstrom signs, drawn as K and A with a ring; the ohm sign
    // has its own glyph.
    const signs = String.fromCodePoint(0x212a, 0x212b, 0x2126);
    expect(unprintableCharacters(`300 ${signs}`)).toEqual([]);
  });

  it('prints letters the renderer builds from a letter and a mark, and refuses the rest', () => {
    // Pinyin tones and Sanskrit dots: a letter and a mark the font has.
    expect(unprintableCharacters(String.fromCodePoint(0x4e, 0x1d0, 0x20, 0x68, 0x1ce, 0x6f))).toEqual([]);
    expect(unprintableCharacters(String.fromCodePoint(0x4b, 0x1e5b, 0x1e63, 0x1e47, 0x61))).toEqual([]);
    // Polytonic Greek needs a perispomeni, which the font lacks.
    const perispomeni = String.fromCodePoint(0x1ff6);
    const word = String.fromCodePoint(0x3b3, 0x3bd, 0x1ff6, 0x3b8, 0x3b9);
    expect(unprintableCharacters(word)).toEqual([perispomeni]);
  });

  it('refuses controls, direction overrides and line separators', () => {
    expect(unprintableCharacters('bell\u0007')).toEqual(['\u0007']);
    expect(unprintableCharacters('Pay to \u202Ecba')).toEqual(['\u202E']);
    expect(unprintableCharacters('one\u2028two')).toEqual(['\u2028']);
  });

  it('refuses symbols no print has shown', () => {
    expect(unprintableCharacters('→ ✓ ★ ♥ ‼ 1\u20122')).toEqual(['→', '✓', '★', '♥', '‼', '\u2012']);
  });

  it('refuses the hyphens, and keeps the narrow no-break space, which prints as a space', () => {
    const [hyphen, nonBreaking, narrowSpace] = [0x2010, 0x2011, 0x202f].map(cp => String.fromCodePoint(cp));
    expect(unprintableCharacters(`A follow${nonBreaking}up at 7:00${narrowSpace}PM, well${hyphen}known.`)).toEqual([
      nonBreaking,
      hyphen
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
    expect(isPrintableCodePoint(0x202f)).toBe(true); // narrow no-break space: printed as a space
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
    expect(isPrintableCodePoint(0x0513)).toBe(true); // the last Cyrillic Supplement letter the font has
    expect(isPrintableCodePoint(0x0514)).toBe(false); // the next
    expect(isPrintableCodePoint(0x215e)).toBe(true); // seven eighths, on the font's list
    expect(isPrintableCodePoint(0x215f)).toBe(false); // the fraction numerator one, not on it
    // The glyph-less neighbours of the one-off ranges stay refused.
    expect(isPrintableCodePoint(0x02c8)).toBe(false); // IPA stress mark
    expect(isPrintableCodePoint(0x02ca)).toBe(false); // modifier acute
    expect(isPrintableCodePoint(0x02de)).toBe(false); // rhotic hook
    expect(isPrintableCodePoint(0x2071)).toBe(false); // superscript i
    expect(isPrintableCodePoint(0x20ad)).toBe(false); // kip sign
    expect(isPrintableCodePoint(0x2261)).toBe(false); // identical to
    expect(isPrintableCodePoint(0x25c9)).toBe(false); // fisheye
    expect(isPrintableCodePoint(0x215a)).toBe(false); // five sixths
    expect(isPrintableCodePoint(0xfb04)).toBe(true); // the last ligature printed
    expect(isPrintableCodePoint(0xfb05)).toBe(false); // the next
  });

  // The coverage probe of 2026-09-30 (#526, letter_wAEPpwHccd9gKtrUkPjNRu):
  // what it printed, and what came out as boxes (glyph 0).
  const PROBE_PRINTED = [
    0x2015, 0x2017, 0x201b, 0x2002, 0x2003, 0x2009, 0x200a, 0x202f, 0x205f,
    0x01ce, 0x01d0, 0x01d2, 0x01d4, 0x01d6, 0x01d8, 0x01da, 0x01dc, 0x01cd, 0x01cf, 0x01d1, 0x01d3,
    0x01fa, 0x01fb, 0x01fc, 0x01fd, 0x01fe, 0x01ff, 0x0259,
    0x02bc, 0x02c6, 0x02c7, 0x02c9, 0x02d8, 0x02d9, 0x02da, 0x02db, 0x02dc, 0x02dd,
    0x1e03, 0x1e0b, 0x1e1f, 0x1e41, 0x1e57, 0x1e61, 0x1e6b, 0x1e81, 0x1e83, 0x1e85, 0x1e9e,
    0x1e25, 0x1e47, 0x1e5b, 0x1e63, 0x1e6d, 0x1e0d, 0x1e37, 0x1e43, 0x1e45,
    0x1f70, 0x03d1, 0x03d6,
    0x0500, 0x0501, 0x0481, 0x0482, 0x0460, 0x0461, 0x0462, 0x0463,
    0x05bd, 0x05be, 0xfb1d,
    0x20aa, 0x20ab,
    0x2116, 0x2113, 0x212e, 0x2126, 0x2105, 0x2120, 0x215b, 0x215c, 0x215d,
    0x221e, 0x2248, 0x2260, 0x2264, 0x2265, 0x2202, 0x2206, 0x220f, 0x2211, 0x221a, 0x222b,
    0x25ca, 0xfb00, 0xfb01, 0xfb02, 0xfb03, 0xfb04, 0x212a, 0x212b, 0x207f, 0x2074, 0x2082, 0x00aa, 0x00ba
  ];
  const PROBE_BOXES = [
    0x2010, 0x2011, 0x2012, 0x2016, 0x201f, 0x2023, 0x2024, 0x2025, 0x2027,
    0x2031, 0x2034, 0x2035, 0x2036, 0x2037, 0x2038, 0x203b, 0x203d, 0x203e, 0x204a, 0x204e,
    0x018f, 0x0250, 0x025b, 0x0254, 0x0283, 0x02bb, 0x1e49, 0x1e0f,
    0x1f00, 0x1f01, 0x1f04, 0x1fb6, 0x1ff6, 0x1f66, 0x1fb3, 0x1fe5, 0x03d0, 0x03d5,
    0x051a, 0x051b, 0x051c, 0x051d,
    0x05f3, 0x05f4, 0x05c3, 0x05c6, 0xfb20, 0xfb21,
    0x20b4, 0x20bd, 0x20b9, 0x20ba, 0x20bf, 0x20a9, 0x20a6, 0x20b1, 0x20b2, 0x20a1,
    0x2117, 0x2153, 0x2154, 0x2213, 0x2219,
    0x2190, 0x2191, 0x2192, 0x2193, 0x2194, 0x2195, 0x21d2, 0x21d0, 0x21d4, 0x21a9,
    0x2605, 0x2606, 0x2665, 0x2661, 0x2713, 0x2714, 0x2717, 0x263a, 0x266a, 0x266b, 0x25cb, 0x25cf,
    0x25a0, 0x25a1, 0x25aa, 0x25ab, 0x25b2, 0x25ba, 0x25bc, 0x25c4, 0x25c6, 0x25c7, 0x2610, 0x2611
  ];
  const hex = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;

  it('prints everything the coverage probe printed', () => {
    expect(PROBE_PRINTED.filter(cp => !isPrintableCodePoint(cp)).map(hex)).toEqual([]);
  });

  it('refuses everything the coverage probe printed as a box', () => {
    expect(PROBE_BOXES.filter(cp => isPrintableCodePoint(cp)).map(hex)).toEqual([]);
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
        '→ (U+2192), ʻ (U+02BB), Ａ (U+FF21) in the text.'
    );
  });

  it('shows every kind of character in the way that lets a model find it', () => {
    const found = findUnprintable([
      // Emoji as they are: by default presentation, a flag, a sequence.
      { field: 'emoji', where: 'in A', text: '\u{1F389} \u{1F1FA}\u{1F1F8} ❤\uFE0F' },
      // A lone text symbol, and letters of the look-alike scripts, with code points.
      { field: 'lookAlike', where: 'in B', text: '★ ‼ ῶ Ԛ ׳ \u0000' },
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
      '; ★ (U+2605), ‼ (U+203C), ῶ (U+1FF6), Ԛ (U+051A), ׳ (U+05F3), ' +
        'a control character (U+0000) in B;'
    );
    expect(refusal).toContain('; ✔\uFE0E (U+2714), ★\u0301 (U+2605) in B2;');
    expect(refusal).toContain('; \u034F (U+034F) in C;');
    expect(refusal).toContain(
      '; a paragraph separator (U+2029), a direction override (U+202E), a direction isolate (U+2066), ' +
        'an invisible character (U+2062), an ideographic space (U+3000) in D;'
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

describe('text printed in another font (#534)', () => {
  // A letter drawn by our renderer prints its text in the renderer's font:
  // each text can name the font it prints in, and addresses keep Open Sans.
  const onlyLowercase = (grapheme: string) => /^[a-z ]$/.test(grapheme);

  it('judges each grapheme by the font the text names', () => {
    expect(unprintableCharacters('abc Def', onlyLowercase)).toEqual(['D']);
  });

  it("names what the text's own font refuses, even a character Open Sans prints", () => {
    // U+205F prints as a space in Open Sans; a font that refuses it must
    // still have it named, not listed as nothing.
    const mediumSpace = String.fromCodePoint(0x205f);
    const found = findUnprintable([
      { field: 'bodyText', where: 'in the text', text: `a${mediumSpace}b`, prints: grapheme => grapheme !== mediumSpace }
    ]);
    expect(unprintableRefusal('letter', found)).toContain(': a special space (U+205F) in the text.');
  });

  it("names a character by the text's font even where Open Sans would print it", () => {
    // U+FB00 is on the Open Sans list; a font without it must name its code
    // point, not call it a cluster with too many marks.
    const ff = String.fromCodePoint(0xfb00);
    const found = findUnprintable([
      { field: 'bodyText', where: 'in the text', text: `sta${ff}`, prints: grapheme => grapheme !== ff }
    ]);
    expect(unprintableRefusal('letter', found)).toContain(`: ${ff} (U+FB00) in the text.`);
  });

  it('says a letter carries too many marks when only the whole cluster is refused', () => {
    const acute = String.fromCodePoint(0x301);
    const found = findUnprintable([
      { field: 'bodyText', where: 'in the text', text: `Caf${'e' + acute.repeat(5)}`, prints: grapheme => [...grapheme].length < 6 }
    ]);
    expect(unprintableRefusal('letter', found)).toContain(`: ${'e' + acute.repeat(5)} (too many marks on one letter) in the text.`);
  });

  it('keeps Open Sans for a text that names no font', () => {
    const nonBreakingHyphen = String.fromCodePoint(0x2011);
    expect(
      findUnprintable([
        { field: 'bodyText', where: 'in the text', text: `well${nonBreakingHyphen}known`, prints: () => true },
        { field: 'recipient', where: "in the recipient's address", text: `Sam${nonBreakingHyphen}Rivera` }
      ])
    ).toEqual([{ field: 'recipient', where: "in the recipient's address", characters: [nonBreakingHyphen] }]);
  });
});
