/**
 * How long the renderer takes to lay a letter out (#694): the cases the 2026-10-11 audit
 * measured, each laid out a few times and the median reported. Not a test and not gating:
 * timings vary by machine. The bound that gates is a count of shapings, in
 * tests/unit/render/layout.test.ts.
 *
 *   npm run benchmark:layout
 */

import { layoutLetter, type LetterContent } from '../src/render/layout.js';
import type { Stationery } from '../src/render/stationery.js';

const PROSE =
  'Thank you for the lovely afternoon last week. The garden looked wonderful, and the lemon cake was the best I have had in years. ';

function prose(characters: number): string {
  return PROSE.repeat(Math.ceil(characters / PROSE.length)).slice(0, characters);
}

function oneLetterWords(characters: number): string {
  return 'a '.repeat(Math.ceil(characters / 2)).slice(0, characters);
}

const CASES: Array<{ name: string; text: string; maxPages: number }> = [
  { name: '2,700 characters of prose', text: prose(2_700), maxPages: 1 },
  { name: '10,000 characters of prose', text: prose(10_000), maxPages: 1 },
  { name: '30,000 characters of prose, 3 pages', text: prose(30_000), maxPages: 3 },
  { name: '10,000 characters of one-letter words', text: oneLetterWords(10_000), maxPages: 1 },
  { name: '30,000 characters of one-letter words, 3 pages', text: oneLetterWords(30_000), maxPages: 3 }
];

const FACES: Array<{ name: string; stationery: Stationery }> = [
  { name: 'Classic', stationery: { theme: 'classic' } },
  { name: 'Handwritten', stationery: { theme: 'handwritten' } }
];

const RUNS = 3;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

console.log(`| Letter text | ${FACES.map(face => face.name).join(' | ')} |`);
console.log(`|---|${FACES.map(() => '---').join('|')}|`);
for (const testCase of CASES) {
  const cells = FACES.map(face => {
    const timings: number[] = [];
    let truncated = false;
    for (let run = 0; run < RUNS; run += 1) {
      // A different text each run, so the layout's recent wrappings are not what is measured.
      const content: LetterContent = { text: `${run} ${testCase.text}`, layoutType: 'text_only', stationery: face.stationery };
      const started = performance.now();
      truncated = layoutLetter(content, { maxPages: testCase.maxPages }).truncated === true;
      timings.push(performance.now() - started);
    }
    return `${Math.round(median(timings))} ms${truncated ? ' (budget)' : ''}`;
  });
  console.log(`| ${testCase.name} | ${cells.join(' | ')} |`);
}
