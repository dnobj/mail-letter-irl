/**
 * Right-to-left text in the renderer (#534).
 *
 * pdfkit draws text in the order it is given, so without this step Hebrew
 * printed with each word's letters reversed (Phase 0 probe P2). Lines are
 * reordered here, by grapheme cluster, and drawn left to right.
 */

import { describe, expect, it } from 'vitest';
import { visualOrder, withoutInvisible } from '../../../src/render/bidi.js';

const cp = (...codePoints: number[]) => String.fromCodePoint(...codePoints);
const SHALOM = cp(0x05e9, 0x05dc, 0x05d5, 0x05dd);
const OLAM = cp(0x05e2, 0x05d5, 0x05dc, 0x05dd);
const reversed = (word: string) => [...word].reverse().join('');

describe('visual order for drawing (#534)', () => {
  it('leaves left-to-right text alone', () => {
    expect(visualOrder('Dear Sam, (a) and [b].')).toBe('Dear Sam, (a) and [b].');
  });

  it('draws a Hebrew phrase in an English line right to left, in place', () => {
    const line = `Hebrew: ${SHALOM} ${OLAM}.`;
    expect(visualOrder(line)).toBe(`Hebrew: ${reversed(OLAM)} ${reversed(SHALOM)}.`);
  });

  it('draws a line that starts in Hebrew right to left too', () => {
    expect(visualOrder(`${SHALOM} ${OLAM}`)).toBe(`${reversed(OLAM)} ${reversed(SHALOM)}`);
  });

  it('keeps a Hebrew point after its letter', () => {
    const yodHiriq = cp(0x05d9, 0x05b4);
    const alef = cp(0x05d0);
    expect(visualOrder(yodHiriq + alef)).toBe(alef + yodHiriq);
  });

  it('mirrors brackets inside a right-to-left run', () => {
    // A regression test: given the levels object instead of its array, bidi-js
    // silently mirrors nothing and the brackets face the wrong way.
    const [alef, bet] = [cp(0x05d0), cp(0x05d1)];
    expect(visualOrder(`${alef}(${bet})`)).toBe(`(${bet})${alef}`);
  });

  it('removes characters that print nothing, before and after reordering', () => {
    const zwsp = cp(0x200b), vs16 = cp(0xfe0f), rlm = cp(0x200f), softHyphen = cp(0x00ad);
    expect(withoutInvisible(`a${zwsp}b${vs16}c${softHyphen}d`)).toBe('abcd');
    expect(visualOrder(`x${rlm}y`)).not.toContain(rlm);
    // The left-to-right fast path strips them too.
    expect(visualOrder(`one${zwsp}two${vs16}`)).toBe('onetwo');
  });
});
