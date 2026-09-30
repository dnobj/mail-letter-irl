/**
 * A refused non-US address is logged with a constant message.
 *
 * The logger redacts long strings in the fields of a log line, never its
 * message. The refusal names each country as the caller sent it, which can be
 * part of an address when a model maps the fields wrongly; so the person gets
 * that sentence, and the log line gets a constant one.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/providers/index.js', () => ({
  getLetterProvider: vi.fn()
}));

vi.mock('../../../src/services/recentUploadStore.js', () => ({
  getRecentUploadedImage: vi.fn()
}));

vi.mock('../../../src/services/imageService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/imageService.js')>()),
  downloadAndProcessPostcardImageWithPreview: vi.fn()
}));

vi.mock('../../../src/tools/giftSendChoice.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/tools/giftSendChoice.js')>()),
  resolveGiftSendChoice: vi.fn()
}));

import { getRecentUploadedImage } from '../../../src/services/recentUploadStore.js';
import { resolveGiftSendChoice } from '../../../src/tools/giftSendChoice.js';
import { validateUSOnly } from '../../../src/tools/letterHelpers.js';
import { quoteAndPreviewPostcardTool } from '../../../src/tools/quoteAndPreviewPostcard.js';
import type { Address, ToolContext } from '../../../src/contracts/types.js';

const MISMAPPED = 'Flat 2, 12 Main Street';

function context(): ToolContext {
  return {
    user: { userId: 'user-1', creditsRemaining: 10 } as ToolContext['user'],
    correlationId: 'corr-1',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never,
    now: () => new Date('2026-09-30T12:00:00Z'),
    persist: vi.fn(),
    isMobile: false
  } as unknown as ToolContext;
}

function address(overrides: Partial<Address> = {}): Address {
  return {
    name: 'Sam Rivera',
    addressLine1: '350 Fifth Ave',
    city: 'New York',
    state: 'NY',
    postalCode: '10118',
    country: 'US',
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRecentUploadedImage).mockResolvedValue(null);
  vi.mocked(resolveGiftSendChoice).mockResolvedValue({ isGift: false, giftLettersAvailable: 0 });
});

function expectConstantLogLine(ctx: ToolContext, event: string) {
  const warn = vi.mocked(ctx.logger.warn);
  expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event }), 'Address outside the United States refused');
  expect(JSON.stringify(warn.mock.calls.map(call => call[1]))).not.toMatch(/main street/i);
}

describe('a refused non-US address', () => {
  it('tells the person which country, and logs a constant message (letters)', () => {
    const ctx = context();
    expect(() => validateUSOnly(address({ country: MISMAPPED }), address(), ctx)).toThrow(
      `Letter IRL currently only supports mailing within the United States. sender address is in ${MISMAPPED}.`
    );
    expectConstantLogLine(ctx, 'quote.letter.non_us_address');
  });

  it('tells the person which country, and logs a constant message (postcards)', async () => {
    const ctx = context();
    await expect(
      (quoteAndPreviewPostcardTool.handler as (input: unknown, c: ToolContext) => Promise<unknown>)(
        {
          sender: address({ name: 'Pat Example' }),
          recipient: address({ country: MISMAPPED }),
          message: 'Greetings!',
          imageUrl: 'https://files.example/a.jpg'
        },
        ctx
      )
    ).rejects.toThrow(`recipient address is in ${MISMAPPED.toUpperCase()}.`);
    expectConstantLogLine(ctx, 'quote.postcard.non_us_address');
  });
});
