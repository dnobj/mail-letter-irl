/**
 * A letter far too long to print is refused from a bounded layout (#694): the renderer wraps
 * at most a line budget a page, so the refusal says the letter is more than so many lines too
 * long, and a signed letter is not laid out again without its signature when its text alone is
 * past every page. The bound on the shaping itself is in tests/unit/render/layout.test.ts.
 */

import { describe, expect, it, vi } from 'vitest';
import { layoutLetterForPreview } from '../../../src/tools/letterHelpers.js';
import { LINE_BUDGET_PER_PAGE } from '../../../src/render/layout.js';
import type { ToolContext } from '../../../src/contracts/types.js';

/** A PNG's signature and header: enough for the layout to size it. */
function pngDataUri(width: number, height: number): string {
  const bytes = Buffer.alloc(33);
  bytes.writeUInt32BE(0x89504e47, 0);
  bytes.writeUInt32BE(0x0d0a1a0a, 4);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

function context(): ToolContext {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { correlationId: 'c1', user: { userId: 'u1' }, logger } as unknown as ToolContext;
}

const refusal = (letter: Parameters<typeof layoutLetterForPreview>[0], maxPages: number) => {
  try {
    layoutLetterForPreview(letter, context(), 'pdf', maxPages);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('laid out without a refusal');
};

describe('a letter far too long to print (#694)', () => {
  it('is refused as more than so many lines too long', () => {
    const message = refusal({ bodyText: 'word '.repeat(6000), signOff: 'Pat', layoutType: 'text_only' }, 3);
    expect(message).toMatch(/^Letter is more than \d+ lines too long for three pages/);
    const over = Number(/more than (\d+) lines/.exec(message)![1]);
    // At least the budget past what the pages hold: the layout stopped at twice that.
    expect(over).toBeGreaterThanOrEqual(3 * LINE_BUDGET_PER_PAGE - 3 * (LINE_BUDGET_PER_PAGE / 2));
  });

  it('previews a letter whose blank stretch is longer than the budget, with its end (#694 review round 1)', () => {
    const layout = layoutLetterForPreview(
      { bodyText: 'Dear Sam,' + '\n'.repeat(200) + 'The part that matters.', signOff: 'Love, Pat', layoutType: 'text_only' },
      context(),
      'pdf',
      3
    )!;
    expect(layout.truncated).toBeUndefined();
    expect(JSON.stringify(layout)).toContain('The part that matters.');
    expect(JSON.stringify(layout)).toContain('Love, Pat');
  });

  it('says it takes more than the lines it laid out, on one page', () => {
    const message = refusal({ bodyText: 'word '.repeat(6000), signOff: 'Pat', layoutType: 'text_only' }, 1);
    expect(message).toMatch(/: it takes more than \d+ lines and the page holds \d+\./);
  });

  it('says exactly how many lines too long a letter is that the budget did not stop', () => {
    const message = refusal({ bodyText: 'word '.repeat(700), signOff: 'Pat', layoutType: 'text_only' }, 1);
    expect(message).toMatch(/^Letter is \d+ lines? too long for one page/);
    expect(message).not.toContain('more than');
  });

  it('does not offer a signed letter the way out without its signature when its text alone is past every page', () => {
    const message = refusal(
      { bodyText: 'word '.repeat(6000), signOff: 'Pat', layoutType: 'text_only', signatureImage: pngDataUri(600, 200) },
      3
    );
    expect(message).toContain('The signature takes 3 lines.');
    expect(message).not.toContain('signature: false');
  });

  it('still offers it when the letter fits without its signature', () => {
    // Long enough that the signature's band pushes it past one page, short enough to fit without.
    let words = 300;
    let message = '';
    for (; words < 600; words += 5) {
      const letter = { bodyText: 'word '.repeat(words), signOff: 'Pat', layoutType: 'text_only' as const };
      const signed = { ...letter, signatureImage: pngDataUri(600, 200) };
      let unsignedFits = true;
      try {
        layoutLetterForPreview(letter, context(), 'pdf', 1);
      } catch {
        unsignedFits = false;
      }
      if (!unsignedFits) break;
      try {
        layoutLetterForPreview(signed, context(), 'pdf', 1);
      } catch (error) {
        message = (error as Error).message;
        break;
      }
    }
    expect(message).toContain('preview it with signature: false to leave it off');
    expect(message).not.toContain('more than');
  });
});
