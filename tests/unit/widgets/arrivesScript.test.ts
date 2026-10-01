/**
 * widgets/shared/arrives.js (#535): the helpers both preview cards share for
 * the arrival date. Its picker and Cancel run inside the cards in
 * previewCardsOnBridge.test.ts (MCP Apps) and previewRecovery.test.ts
 * (ChatGPT); here are the words and dates it works out.
 */

import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';
import { SCHEDULED_MAIL_REFUSALS } from '../../../src/tools/cancelScheduledMail.js';

const SOURCE = fs.readFileSync(path.resolve(__dirname, '../../../widgets/shared/arrives.js'), 'utf-8');

function load() {
  const dom = new JSDOM(`<body><script>${SOURCE}</script></body>`, { runScripts: 'dangerously' });
  return (dom.window as any).letterIrlArrives;
}

describe('the arrival date script (#535)', () => {
  const arrives = load();

  it('writes a date as the server does, with the year only when it is not this year in New York', () => {
    const october2026 = new Date('2026-10-01T14:00:00Z');
    expect(arrives.describeDate('2026-10-06', october2026)).toBe('Tue, Oct 6');
    expect(arrives.describeDate('2027-01-08', october2026)).toBe('Fri, Jan 8, 2027');
    // New Year's Eve evening in New York is still the old year there.
    expect(arrives.describeDate('2026-12-31', new Date('2027-01-01T03:00:00Z'))).toBe('Thu, Dec 31');
    expect(arrives.describeDate('2027-01-01', new Date('2027-01-01T03:00:00Z'))).toBe('Fri, Jan 1, 2027');
    expect(arrives.describeDate('not a date', october2026)).toBe('');
  });

  it('says when held mail goes to the printer, and that it can be cancelled until then', () => {
    expect(arrives.mailsLine({ arriveBy: '2026-10-16', mailOn: '2026-10-06' }, new Date('2026-10-01T14:00:00Z'))).toBe(
      'Mails Tue, Oct 6 · cancel free until then'
    );
  });

  it('reads the dates a refusal names', () => {
    expect(
      arrives.boundsFromRefusal(
        'The earliest this can arrive is Wed, Oct 14 (2026-10-14). Choose that date or later, or leave arriveBy out to mail as soon as possible.'
      )
    ).toEqual({ earliest: '2026-10-14' });
    expect(
      arrives.boundsFromRefusal(
        'The latest arrival date on offer is Mon, Nov 30 (2026-11-30). Choose an earlier date, or preview it again nearer the time.'
      )
    ).toEqual({ latest: '2026-11-30' });
    expect(arrives.boundsFromRefusal('Arrival dates cannot be scheduled right now.')).toEqual({});
    expect(arrives.boundsFromRefusal(undefined)).toEqual({});
  });

  it("closes Cancel only on a refusal that leaves nothing to cancel, by cancel_scheduled_mail's own words", () => {
    const said = (refusal: keyof typeof SCHEDULED_MAIL_REFUSALS) => SCHEDULED_MAIL_REFUSALS[refusal][1];
    expect(arrives.closingMessage(said('too_late'))).toBe('It has gone to the printer, so it can no longer be cancelled.');
    expect(arrives.closingMessage(said('busy'))).toBe('It is going to the printer right now, so it can no longer be cancelled.');
    expect(arrives.closingMessage(said('not_scheduled'))).toBe("It goes to the printer as soon as it can, so it can't be cancelled here.");
    expect(arrives.closingMessage(said('pay_and_send'))).toBe(said('pay_and_send'));
    // Anything else is shown as it is, and may be tried again.
    expect(arrives.closingMessage(said('not_found'))).toBeNull();
    expect(arrives.closingMessage('The host timed out.')).toBeNull();
  });

  it('takes held mail only with both dates', () => {
    expect(arrives.scheduleOf({ arriveBy: '2026-10-16', mailOn: '2026-10-06', releasesAt: 'x' })).toEqual({
      arriveBy: '2026-10-16',
      mailOn: '2026-10-06'
    });
    expect(arrives.scheduleOf({ arriveBy: '2026-10-16' })).toBeNull();
    expect(arrives.scheduleOf({ arriveBy: '16/10/2026', mailOn: '2026-10-06' })).toBeNull();
    expect(arrives.scheduleOf(null)).toBeNull();
  });
});
