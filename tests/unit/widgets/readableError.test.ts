/**
 * Three cards read a refused call's sentence out of the host's wrapper with
 * readableError (#434): the letter and postcard preview cards, and the pack
 * card. Each widget is a standalone page, so each carries its own copy.
 * previewRecovery.test.ts exercises the preview cards' copies against every
 * shape of the wrapper; this keeps all three copies the same text, so the
 * pack card cannot drift from what those tests prove.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const WIDGET_DIR = path.resolve(__dirname, '../../../widgets');
const CARDS = ['LetterPreviewCard', 'PostcardPreviewCard', 'PackCheckoutCard'];

function readableErrorSource(card: string): string {
  const html = fs.readFileSync(path.join(WIDGET_DIR, `${card}.html`), 'utf-8').replace(/\r\n/g, '\n');
  // From the declaration to the first closing brace at the same indentation.
  const found = html.match(/\n( *)function readableError\(error\) \{\n[\s\S]*?\n\1\}[ \t]*\n/);
  expect(found, `${card} declares readableError`).not.toBeNull();
  return found![0].replace(/\n */g, '\n');
}

describe('readableError (#434)', () => {
  it('is the same function in the letter, postcard and pack cards', () => {
    const [first, ...rest] = CARDS.map(readableErrorSource);
    expect(first).toContain('String.fromCodePoint');
    for (const copy of rest) expect(copy).toBe(first);
  });
});
