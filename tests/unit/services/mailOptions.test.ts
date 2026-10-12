/**
 * Who pays (#691): one module reads a draft's mail option, and holds the rule for what a
 * pack or a gift letter pays for. A reader that loads part of the option prices a long
 * letter as one page, or a certified letter as a standard one; the row draftMailOption takes
 * names every column, so a reader that declares part of them does not compile. The SQL is
 * never checked against the declared type: draftOptionColumns.test.ts still searches the
 * source for a column list that leaves the service out, and pins the two locking reads.
 *
 * What the option is for each row: mailOptionPrices.test.ts and commerceService.test.ts;
 * letterOption: certifiedReaders.test.ts; the readers' own queries: draftService.test.ts
 * (getDraftForMailService) and commerceService.test.ts (the checkout's peek).
 */

import { describe, expect, it } from 'vitest';
import {
  DRAFT_OPTION_COLUMNS,
  draftMailOption,
  isPackPayable,
  storedMailService,
  storedPages,
  type DraftOptionRow
} from '../../../src/services/mailOptions.js';
import type { LetterDraft } from '../../../src/services/types.js';
import { optionRow } from '../../fixtures/mailOptions.js';

describe('the columns a draft is priced from (#691)', () => {
  it('are selected together, exactly the columns the row names', () => {
    expect(DRAFT_OPTION_COLUMNS.split(',').map(column => column.trim()).sort()).toEqual(Object.keys(optionRow({})).sort());
  });

  it('are all required of a row, so a reader of part of them does not compile', () => {
    // A whole draft, as SELECT * reads it, is a row the option is read from.
    const whole = { mail_type: 'letter', postcard_size: null, pages: 2, mail_service: 'certified' } as LetterDraft;
    const fromWhole: DraftOptionRow = whole;
    expect(draftMailOption(fromWhole)).toEqual({ mailType: 'letter', pages: 2, mailService: 'certified' });

    // The pages without the service: the partial-row defect (#625). The test types fail if this compiles.
    // @ts-expect-error mail_service and postcard_size are missing
    const partial: DraftOptionRow = { mail_type: 'letter', pages: 2 };
    // Read without them, a certified two-page letter would be priced as a standard one.
    expect(draftMailOption(partial)).toEqual({ mailType: 'letter', pages: 2 });
  });
});

describe('what a pack or a gift letter pays for (#579, #625)', () => {
  it('pays for a one-page standard letter and a 6x9 postcard, and nothing else', () => {
    expect(isPackPayable({ mailType: 'letter' })).toBe(true);
    expect(isPackPayable({ mailType: 'letter', pages: 1 })).toBe(true);
    expect(isPackPayable({ mailType: 'postcard', postcardSize: '6x9' })).toBe(true);
    expect(isPackPayable({ mailType: 'postcard' })).toBe(true);
    expect(isPackPayable({ mailType: 'letter', pages: 2 })).toBe(false);
    expect(isPackPayable({ mailType: 'postcard', postcardSize: '6x4' })).toBe(false);
    expect(isPackPayable({ mailType: 'letter', mailService: 'certified' })).toBe(false);
    expect(isPackPayable({ mailType: 'letter', mailService: 'certified_return_receipt' })).toBe(false);
    // A service this code does not know is not a pack's either.
    expect(isPackPayable({ mailType: 'letter', mailService: 'express' as never })).toBe(false);
  });
});

describe('what a letter draft may record (#586, #625)', () => {
  it('records one page by default, and up to three for a letter our renderer drew that is not a gift', () => {
    expect(storedPages({})).toBe(1);
    expect(storedPages({ pages: 3, rendererVersion: 'pdf-2' })).toBe(3);
    for (const params of [
      { pages: 0, rendererVersion: 'pdf-2' },
      { pages: 4, rendererVersion: 'pdf-2' },
      { pages: 1.5, rendererVersion: 'pdf-2' },
      { pages: 2 },
      { pages: 2, rendererVersion: null },
      { pages: 2, rendererVersion: 'pdf-2', isGiftSend: true }
    ]) {
      expect(() => storedPages(params), JSON.stringify(params)).toThrow(
        expect.objectContaining({ code: 'DRAFT_PAGES_INVALID', diagnosticClass: 'validation_error' })
      );
    }
  });

  it('records standard by default, a certified service only off a gift, and nothing it does not know', () => {
    expect(storedMailService({})).toBe('standard');
    expect(storedMailService({ mailService: 'certified' })).toBe('certified');
    expect(storedMailService({ mailService: 'standard', isGiftSend: true })).toBe('standard');
    for (const params of [
      { mailService: 'certified' as const, isGiftSend: true },
      { mailService: 'certified_return_receipt' as const, isGiftSend: true },
      { mailService: 'express' as never }
    ]) {
      expect(() => storedMailService(params), JSON.stringify(params)).toThrow(
        expect.objectContaining({ code: 'DRAFT_MAIL_SERVICE_INVALID', diagnosticClass: 'validation_error' })
      );
    }
  });
});
