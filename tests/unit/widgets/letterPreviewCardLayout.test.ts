/**
 * The letter card's address window grows to fit its addresses.
 *
 * With a fixed `height:30%`, a return address and a four-line recipient (a
 * Suite line) overflowed the window: in ChatGPT on Android (2026-09-29) the
 * city line ran into the letter's first line, and on the desktop it sat on the
 * window's edge. jsdom lays nothing out, so this holds the rule itself: a
 * minimum height the window may grow past, and no shrinking to make room.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const card = fs.readFileSync(path.resolve(__dirname, '../../../widgets/LetterPreviewCard.html'), 'utf-8');
const rule = card.match(/\.address-window\{([^}]*)\}/)?.[1] ?? '';

describe('LetterPreviewCard address window', () => {
  it('grows to fit its addresses rather than holding a fixed height', () => {
    expect(rule).not.toBe('');
    expect(rule).toMatch(/(^|;)min-height:30%(;|$)/);
    expect(rule).toMatch(/(^|;)flex-shrink:0(;|$)/);
    expect(rule).not.toMatch(/(^|;)height:/);
    expect(rule).not.toMatch(/(^|;)max-height:/);
    expect(rule).not.toMatch(/overflow:hidden/);
  });
});
