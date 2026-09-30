import bidiFactory from 'bidi-js';

// The package's default export is a factory; its named exports are not
// functions under Node's CommonJS interop.
const { getEmbeddingLevels, getMirroredCharactersMap, getReorderedIndices } = bidiFactory();

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
const INVISIBLE = characterClass([
  [0x00ad, 0x00ad], [0x061c, 0x061c], [0x200b, 0x200f], [0x202a, 0x202e],
  [0x2060, 0x2064], [0x2066, 0x2069], [0xfe00, 0xfe0f], [0xfeff, 0xfeff]
], 'g');

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

/**
 * One line of text in the order it is drawn, left to right, without the
 * characters that print nothing.
 *
 * The paragraph direction is left to right, as in the legacy HTML, so a Hebrew
 * phrase inside an English sentence keeps its place and reads right to left.
 * Reordering works on whole grapheme clusters, so a Hebrew point stays after
 * its letter, and a mirrored character (a bracket in a right-to-left run) is
 * drawn as its mirror image.
 */
export function visualOrder(line: string): string {
  if (!RIGHT_TO_LEFT.test(line)) return withoutInvisible(line);
  const levels = getEmbeddingLevels(line, 'ltr');
  // bidi-js reads this one's levels by index, so it takes the levels array,
  // not the result object; given the object, it silently mirrors nothing.
  const mirrored = getMirroredCharactersMap(line, levels.levels, 0, line.length - 1);
  const clusterOf = new Int32Array(line.length);
  const clusters: Array<{ start: number; text: string }> = [];
  for (const { segment, index } of graphemes.segment(line)) {
    for (let unit = 0; unit < segment.length; unit++) clusterOf[index + unit] = clusters.length;
    clusters.push({ start: index, text: segment });
  }
  // bidi-js orders UTF-16 code units, and a cluster's units come out reversed
  // inside a right-to-left run, so each cluster is emitted once, whole, where
  // its first unit appears.
  const drawn: string[] = [];
  let previous = -1;
  for (const unit of getReorderedIndices(line, levels, 0, line.length - 1)) {
    const cluster = clusterOf[unit];
    if (cluster === previous) continue;
    previous = cluster;
    const { start, text } = clusters[cluster];
    const mirror = mirrored.get(start);
    drawn.push(mirror ? mirror + text.slice(1) : text);
  }
  return withoutInvisible(drawn.join(''));
}
