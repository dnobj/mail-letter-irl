/**
 * The tool logger's redaction (src/logging/index.ts).
 *
 * Every string over 32 characters is redacted, so a letter's text or an address
 * never reaches the log. Event names and tool names are code constants that
 * every log search keys on: one that looks like an identifier is kept however
 * long. Before, quote.letter.unprintable_characters (#526) and the tool
 * quote_and_preview_letter_with_header_image logged as [REDACTED].
 */

import { describe, expect, it } from 'vitest';
import { createLogger } from '../../../src/logging/index.js';
import type { LogEvent } from '../../../src/contracts/types.js';

function capture() {
  const events: LogEvent[] = [];
  const logger = createLogger({
    context: { service: 'letter-irl' },
    sink: (_level, _message, event) => {
      events.push(event);
    }
  });
  return { logger, events };
}

describe('tool log redaction', () => {
  it('keeps an event name longer than 32 characters', () => {
    const { logger, events } = capture();
    logger.info({ correlationId: 'c1', event: 'quote.letter.header_image.from_recent_upload' });
    expect(events[0].event).toBe('quote.letter.header_image.from_recent_upload');
  });

  it('keeps a long tool name from the request context', () => {
    const { logger, events } = capture();
    logger
      .child({ correlationId: 'c1', toolName: 'quote_and_preview_letter_with_header_image' })
      .warn({ correlationId: 'c1', event: 'quote.letter.unprintable_characters' });
    expect(events[0]).toMatchObject({
      toolName: 'quote_and_preview_letter_with_header_image',
      event: 'quote.letter.unprintable_characters'
    });
  });

  it('still redacts an event or tool name that is not identifier-shaped', () => {
    const { logger, events } = capture();
    logger.info({
      correlationId: 'c1',
      event: 'Dear Sam, happy birthday to you and yours!',
      toolName: 'quote and preview letter with a header image'
    });
    expect(events[0].event).toBe('[REDACTED]');
    expect(events[0].toolName).toBe('[REDACTED]');
  });

  it('still redacts an identifier over 80 characters', () => {
    const { logger, events } = capture();
    logger.info({ correlationId: 'c1', event: `quote.${'a'.repeat(80)}` });
    expect(events[0].event).toBe('[REDACTED]');
  });

  it('still redacts every other string over 32 characters, identifier or not', () => {
    const { logger, events } = capture();
    logger.info({
      correlationId: 'c1',
      event: 'quote.letter.computed',
      stage: 'quote.letter.header_image.from_recent_upload',
      details: { event: 'quote.letter.header_image.from_recent_upload' }
    });
    expect(events[0]).toMatchObject({
      event: 'quote.letter.computed',
      stage: '[REDACTED]',
      details: { event: '[REDACTED]' }
    });
  });

  it('still redacts content keys inside a logged object, whatever their length', () => {
    // Key-based redaction applies inside objects; at the top level only the
    // 32-character rule does, and no caller logs content there.
    const { logger, events } = capture();
    logger.info({
      correlationId: 'c1',
      event: 'quote.letter.computed',
      draft: { bodyText: 'Hi', recipient: { name: 'Sam' }, layoutType: 'text_only' }
    });
    expect(events[0].draft).toEqual({ bodyText: '[REDACTED]', recipient: '[REDACTED]', layoutType: 'text_only' });
  });
});
