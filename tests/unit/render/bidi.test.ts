/**
 * Right-to-left text in the renderer (#534).
 *
 * pdfkit draws text in the order it is given, so without this step Hebrew
 * printed with each word's letters reversed (Phase 0 probe P2). Lines are
 * reordered here, by grapheme cluster, and drawn left to right.
 */

import { describe, expect, it } from 'vitest';
import { paragraphBidi, visualOrder, withoutInvisible } from '../../../src/render/bidi.js';

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

  it('never prints a letter twice when a joiner sits at another level (review round 1)', () => {
    // ZWNJ and ZWJ join the letter before them in one grapheme cluster, but
    // bidi gives them the paragraph's level: the cluster's units come out
    // apart in visual order, and each must be emitted once.
    const [bet, zwnj, zwj, alef, acute] = [cp(0x05d1), cp(0x200c), cp(0x200d), cp(0x05d0), cp(0x0301)];
    expect(visualOrder(bet + bet + zwnj)).toBe(bet + bet);
    expect(visualOrder(`${bet}1${zwnj}`)).toBe(`1${bet}`);
    expect(visualOrder(`${alef}${acute}${zwj}1`)).toBe(`1${alef}${acute}`);
  });

  it('resolves a wrapped line within its paragraph, not alone', () => {
    // UAX #9 resolves the paragraph, then reorders each line: a hyphen that
    // starts a line between two Hebrew words belongs to the Hebrew run.
    const paragraph = `${SHALOM} - ${OLAM}`;
    const lineStart = paragraph.indexOf('-');
    expect(paragraphBidi(paragraph).lineVisual(lineStart, paragraph.length)).toBe(`${reversed(OLAM)} -`);
    expect(visualOrder(paragraph.slice(lineStart))).toBe(`- ${reversed(OLAM)}`);
  });

  it('removes characters that print nothing, before and after reordering', () => {
    const zwsp = cp(0x200b), vs16 = cp(0xfe0f), rlm = cp(0x200f), softHyphen = cp(0x00ad);
    expect(withoutInvisible(`a${zwsp}b${vs16}c${softHyphen}d`)).toBe('abcd');
    expect(visualOrder(`x${rlm}y`)).not.toContain(rlm);
    // The left-to-right fast path strips them too.
    expect(visualOrder(`one${zwsp}two${vs16}`)).toBe('onetwo');
  });
});
