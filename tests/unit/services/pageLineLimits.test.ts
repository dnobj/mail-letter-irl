/**
 * The line limits a letter must fit to print on one page (#77).
 *
 * From the print check in PostGrid's test mode on 2026-09-29, with short lines
 * that do not wrap (docs/manual-tests.md, Validation Errors):
 * - a header-image letter at 19 lines printed lines 18 and 19 on a second
 *   page, with 17 on the first;
 * - an inline-image letter at 15 printed a blank second page;
 * - text-only letters at 26 printed on one page.
 * A limit above what fits prints, and bills, an extra page, and nothing else
 * tested these limits.
 */

import { describe, expect, it } from 'vitest';
import {
  LAYOUT_LINE_LIMITS,
  LAYOUT_LINE_LIMITS_SOFT,
  estimateLines,
  letterPrintText,
  validateCharacterLimit
} from '../../../src/services/previewService.js';

type Layout = keyof typeof LAYOUT_LINE_LIMITS;

// The most lines each layout may take. header_image and text_only are seen on
// one page; inline_image is one under the 15 that printed a blank page, which
// by the print CSS leaves about a quarter inch (a print at 14 is still to do).
const FITS_ONE_PAGE: Record<Layout, number> = { text_only: 26, header_image: 17, inline_image: 14 };

// n short lines that never wrap: the tallest letter a line count allows.
const shortLines = (n: number) =>
  Array.from({ length: n }, (_, i) => `Line ${String(i + 1).padStart(2, '0')}: one short line of a poem.`).join('\n');

describe('line limits that fit one printed page (#77)', () => {
  it('never accept more lines than printed on one page', () => {
    for (const layout of Object.keys(FITS_ONE_PAGE) as Layout[]) {
      expect(LAYOUT_LINE_LIMITS[layout], layout).toBeLessThanOrEqual(FITS_ONE_PAGE[layout]);
    }
  });

  it('keep the guidance at or under the limit', () => {
    for (const layout of Object.keys(LAYOUT_LINE_LIMITS) as Layout[]) {
      expect(LAYOUT_LINE_LIMITS_SOFT[layout], layout).toBeLessThanOrEqual(LAYOUT_LINE_LIMITS[layout]);
    }
  });

  it.each([
    ['header_image', 17],
    ['inline_image', 14],
    ['text_only', 26]
  ] as const)('%s accepts %i lines with the sign-off and refuses one more', (layout, limit) => {
    // The sign-off is the last line, as the preview tools join it.
    const fits = validateCharacterLimit(shortLines(limit - 1), 'Test', layout);
    expect(fits.isValid).toBe(true);
    expect(fits.totalLines).toBe(limit);

    const over = validateCharacterLimit(shortLines(limit), 'Test', layout);
    expect(over.isValid).toBe(false);
    expect(over.totalLines).toBe(limit + 1);
    expect(over.error).toContain(`${limit + 1}/${limit} lines`);
  });

  it('counts the lines of the text as it prints, whatever blank lines the body ends with', () => {
    // A body ending in blank lines used to be counted without them and
    // printed with them, so a letter at the limit could still print taller.
    const shapes: Array<[string, string]> = [
      [`${shortLines(13)}\n\n\n`, 'Test'],
      [`${shortLines(13)}\r\n\r\n`, 'Test'],
      [`${shortLines(13)}  \n \n`, 'Test'],
      [`\n\n${shortLines(13)}`, 'Test'],
      [shortLines(14), ''],
      [`${shortLines(12)}\n`, 'With love,\nDave\n\n']
    ];
    for (const [body, signOff] of shapes) {
      const printed = letterPrintText(body, signOff);
      const counted = validateCharacterLimit(body, signOff, 'inline_image');
      expect(counted.totalLines, JSON.stringify(body)).toBe(estimateLines(printed));
      expect(counted.isValid, JSON.stringify(body)).toBe(true);
      expect(printed, JSON.stringify(body)).not.toMatch(/\n\s*\nTest$/);
    }
  });
});
