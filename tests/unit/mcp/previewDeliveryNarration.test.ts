/**
 * A preview's text says when the mail usually arrives (#630): the four preview
 * tools' descriptions promise that their answer says it, and an app whose model
 * reads only the text (not structuredContent) must see it there too. Held mail
 * keeps its own dates instead.
 */

import { describe, expect, it } from 'vitest';
import { summarizeToolResult } from '../../../src/mcp/registerTools.js';
import { DELIVERY_ESTIMATE } from '../../../src/content/delivery.js';

const letter = {
  draftId: 'd-1',
  lettersRequired: 1,
  canSendNow: true,
  deliveryEstimate: DELIVERY_ESTIMATE
};

describe('a preview narrates its delivery estimate (#630)', () => {
  for (const tool of ['quote_and_preview_letter', 'quote_and_preview_letter_with_header_image', 'quote_and_preview_letter_with_image']) {
    it(`${tool} says when mail sent at once usually arrives`, () => {
      expect(summarizeToolResult(tool, letter)).toContain(`${DELIVERY_ESTIMATE}.`);
    });
  }

  it('a postcard preview says it too', () => {
    expect(summarizeToolResult('quote_and_preview_postcard', letter)).toContain(`${DELIVERY_ESTIMATE}.`);
  });

  it('a held preview gives its dates, not the at-once estimate', () => {
    const held = {
      ...letter,
      deliveryEstimate: 'Goes to the printer on 2026-11-02 to arrive by 2026-11-12.',
      schedule: { arriveBy: '2026-11-12', mailOn: '2026-11-02' }
    };
    for (const tool of ['quote_and_preview_letter', 'quote_and_preview_postcard']) {
      const summary = summarizeToolResult(tool, held);
      expect(summary).toContain('Scheduled: Goes to the printer on 2026-11-02');
      expect(summary).not.toContain(DELIVERY_ESTIMATE);
      expect(summary.split('Goes to the printer').length - 1).toBe(1);
    }
  });

  it('adds nothing when the preview gave no estimate', () => {
    const { deliveryEstimate: _omitted, ...bare } = letter;
    expect(summarizeToolResult('quote_and_preview_letter', bare)).toBe(
      'Preview ready: requires 1 letter. The card shows whether it can be sent now and the options to proceed.'
    );
  });
});
