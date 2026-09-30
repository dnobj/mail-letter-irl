import bidiFactory from 'bidi-js';

// The package's default export is a factory; its named exports are not
// functions under Node's CommonJS interop.
const { getEmbeddingLevels, getMirroredCharactersMap, getReorderSegments } = bidiFactory();

/**
 * A regular expression character class built from code-point ranges, so the
 * source holds numbers, never invisible or right-to-left characters.
 */
function characterClass(ranges: ReadonlyArray<readonly [number, number]>, flags: string): RegExp {
  const escape = (codePoint: number) => `\\u{${codePoint.toString(16)}}`;
  const body = ranges.map(([low, high]) => (low === high ? escape(low) : `${escape(low)}-${escape(high)}`)).join('');
  return new RegExp(`[${body}]`, `u${flags}`);
}

/**
 * Characters that print nothing, removed before measuring and drawing:
 * the soft hyphen, the Arabic letter mark, zero-width spaces and joiners,
 * direction marks, embeddings and isolates (bidi has used them by then), the
 * word joiner and invisible operators, variation selectors and the byte-order
 * mark. Tinos maps some of them to empty glyphs and has no glyph for others,
 * which would draw as a box.
 */
const INVISIBLE_RANGES = [
  [0x00ad, 0x00ad], [0x061c, 0x061c], [0x200b, 0x200f], [0x202a, 0x202e],
  [0x2060, 0x2064], [0x2066, 0x2069], [0xfe00, 0xfe0f], [0xfeff, 0xfeff]
] as const;
const INVISIBLE = characterClass(INVISIBLE_RANGES, 'g');
const ONE_INVISIBLE = characterClass(INVISIBLE_RANGES, '');

/**
 * The invisible characters that are not direction controls: the soft hyphen,
 * zero-width space and joiners, the word joiner and invisible operators,
 * variation selectors and the byte-order mark. bidi-js gives these (UAX #9
 * class BN) the paragraph's level, which splits a right-to-left run around
 * them, so they are left out when levels are resolved.
 */
const NOT_FOR_BIDI = characterClass([
  [0x00ad, 0x00ad], [0x200b, 0x200d], [0x2060, 0x2064], [0xfe00, 0xfe0f], [0xfeff, 0xfeff]
], '');

/** Right-to-left scripts, and the controls that can make a run right to left. */
const RIGHT_TO_LEFT = characterClass([
  [0x0590, 0x08ff], [0xfb1d, 0xfdff], [0xfe70, 0xfefc],
  [0x200f, 0x200f], [0x202b, 0x202b], [0x202e, 0x202e], [0x2067, 0x2067]
], '');

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** The text without the characters that print nothing. */
export function withoutInvisible(text: string): string {
  return text.replace(INVISIBLE, '');
}

/** Whether a character prints nothing (see INVISIBLE). */
export function isInvisible(character: string): boolean {
  return ONE_INVISIBLE.test(character);
}

/** A paragraph whose bidi levels are resolved once, and any line of it drawn from them. */
export interface ParagraphBidi {
  /**
   * The paragraph's code units [start, end) in the order they are drawn,
   * left to right, without the characters that print nothing.
   */
  lineVisual(start: number, end: number): string;
}

/**
 * Resolves a paragraph's bidi levels once (UAX #9 resolves a paragraph, then
 * reorders each line), so a neutral at the start of a wrapped line takes its
 * direction from the paragraph, not from that line alone.
 *
 * The paragraph direction is left to right, as in the legacy HTML, so a Hebrew
 * phrase inside an English sentence keeps its place and reads right to left.
 * Lines are reordered by whole grapheme clusters, each emitted once where it
 * first appears: a Hebrew point stays after its letter, and a joiner at another
 * level cannot make a letter print twice. A mirrored character (a bracket in a
 * right-to-left run) is drawn as its mirror image.
 */
export function paragraphBidi(paragraph: string): ParagraphBidi {
  if (!RIGHT_TO_LEFT.test(paragraph)) {
    return { lineVisual: (start, end) => withoutInvisible(paragraph.slice(start, end)) };
  }
  // Levels are resolved on the paragraph without NOT_FOR_BIDI characters;
  // `kept` maps that text's code units back to the paragraph's, and
  // `keptBefore[i]` counts the kept units before paragraph index i.
  const kept: number[] = [];
  const keptBefore = new Int32Array(paragraph.length + 1);
  let bidiText = '';
  for (let index = 0; index < paragraph.length; index++) {
    keptBefore[index] = kept.length;
    if (NOT_FOR_BIDI.test(paragraph[index])) continue;
    kept.push(index);
    bidiText += paragraph[index];
  }
  keptBefore[paragraph.length] = kept.length;
  const levels = getEmbeddingLevels(bidiText, 'ltr');
  // bidi-js reads this one's levels by index, so it takes the levels array,
  // not the result object; given the object, it silently mirrors nothing.
  const mirrored = new Map<number, string>();
  for (const [index, mirror] of getMirroredCharactersMap(bidiText, levels.levels, 0, bidiText.length - 1)) {
    mirrored.set(kept[index], mirror);
  }
  const clusterOf = new Int32Array(paragraph.length);
  const clusterStart: number[] = [];
  for (const { segment, index } of graphemes.segment(paragraph)) {
    for (let unit = 0; unit < segment.length; unit++) clusterOf[index + unit] = clusterStart.length;
    clusterStart.push(index);
  }
  clusterStart.push(paragraph.length);

  return {
    lineVisual(start, end) {
      const [bidiStart, bidiEnd] = [keptBefore[start], keptBefore[end]];
      if (bidiEnd <= bidiStart) return '';
      // Apply the line's reversals to an array the length of the line, as
      // bidi-js's getReorderedIndices does for the whole text, then map back
      // to the paragraph's code units. Measuring calls this once per candidate
      // line, so its cost must follow the line, not the paragraph.
      const local = Array.from({ length: bidiEnd - bidiStart }, (_, offset) => bidiStart + offset);
      for (const [segmentStart, segmentEnd] of getReorderSegments(bidiText, levels, bidiStart, bidiEnd - 1)) {
        const [low, high] = [segmentStart - bidiStart, segmentEnd - bidiStart];
        local.splice(low, high - low + 1, ...local.slice(low, high + 1).reverse());
      }
      const order = local.map(index => kept[index]);
      const emitted = new Set<number>();
      const drawn: string[] = [];
      for (const unit of order) {
        const cluster = clusterOf[unit];
        if (emitted.has(cluster)) continue;
        emitted.add(cluster);
        // A line never splits a cluster, but clip to the line to be sure.
        const from = Math.max(clusterStart[cluster], start);
        const to = Math.min(clusterStart[cluster + 1], end);
        const text = paragraph.slice(from, to);
        const mirror = mirrored.get(from);
        drawn.push(mirror ? mirror + text.slice(1) : text);
      }
      return withoutInvisible(drawn.join(''));
    }
  };
}

/** One line on its own, in the order it is drawn (a one-line paragraph). */
export function visualOrder(line: string): string {
  return paragraphBidi(line).lineVisual(0, line.length);
}
