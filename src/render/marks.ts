/**
 * Combining marks, as the body and a theme's slots keep them (#534, #563).
 */

export const MARK = /\p{M}/u;

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * Combining marks kept on one letter. Hebrew can carry four (a dagesh, a shin
 * dot, a vowel and a meteg); more stack upward, 2.6pt each on a capital, and
 * the first line's would reach the address boxes. Previews refuse such text
 * (drawsGrapheme); clampMarks only keeps the layout's promise.
 */
export const MAX_MARKS_PER_LETTER = 4;

/** The text with at most MAX_MARKS_PER_LETTER combining marks on each letter. */
export function clampMarks(text: string): string {
  if (!MARK.test(text)) return text;
  let clamped = '';
  for (const { segment } of graphemes.segment(text)) {
    let marks = 0;
    for (const character of segment) {
      if (MARK.test(character) && ++marks > MAX_MARKS_PER_LETTER) continue;
      clamped += character;
    }
  }
  return clamped;
}
