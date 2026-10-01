/**
 * The preview tools' arrival date (#535): `arriveBy` checked against the
 * schedule before anything slow, the draft held to its mail date, and the
 * output saying when it goes to the printer. Behind LETTER_IRL_ARRIVE_BY_ENABLED.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/providers/index.js', () => ({
  getLetterProvider: vi.fn()
}));

vi.mock('../../../src/services/draftService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/draftService.js')>()),
  createDraft: vi.fn(),
  createPostcardDraft: vi.fn()
}));

vi.mock('../../../src/services/recentUploadStore.js', () => ({
  getRecentUploadedImage: vi.fn()
}));

vi.mock('../../../src/services/returnAddressService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/returnAddressService.js')>()),
  getReturnAddress: vi.fn()
}));

vi.mock('../../../src/services/imageService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/imageService.js')>()),
  downloadAndProcessLetterImageWithPreview: vi.fn(),
  downloadAndProcessPostcardImageWithPreview: vi.fn()
}));

vi.mock('../../../src/services/giftLetterService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/giftLetterService.js')>()),
  getGiftBalance: vi.fn()
}));

vi.mock('../../../src/services/commerceService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/commerceService.js')>()),
  getSendEligibility: vi.fn()
}));

import { getLetterProvider } from '../../../src/services/providers/index.js';
import { createDraft, createPostcardDraft } from '../../../src/services/draftService.js';
import { getRecentUploadedImage } from '../../../src/services/recentUploadStore.js';
import { getReturnAddress } from '../../../src/services/returnAddressService.js';
import {
  downloadAndProcessLetterImageWithPreview,
  downloadAndProcessPostcardImageWithPreview
} from '../../../src/services/imageService.js';
import { getGiftBalance } from '../../../src/services/giftLetterService.js';
import { getSendEligibility } from '../../../src/services/commerceService.js';
import { quoteAndPreviewLetterTextOnlyTool } from '../../../src/tools/quoteAndPreviewLetterTextOnly.js';
import { quoteAndPreviewLetterWithHeaderImageTool } from '../../../src/tools/quoteAndPreviewLetterWithHeaderImage.js';
import { quoteAndPreviewLetterWithImageTool } from '../../../src/tools/quoteAndPreviewLetterWithImage.js';
import { quoteAndPreviewPostcardTool } from '../../../src/tools/quoteAndPreviewPostcard.js';
import type { Address, ToolContext } from '../../../src/contracts/types.js';

/** A PNG's signature and header: enough for the renderer to read its size. */
function png(width: number, height: number): string {
  const bytes = Buffer.alloc(33);
  bytes.writeUInt32BE(0x89504e47, 0);
  bytes.writeUInt32BE(0x0d0a1a0a, 4);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

// A Thursday, 10:00 in New York: today is still a mail date.
const THURSDAY_MORNING = new Date('2026-10-01T14:00:00Z');

function context(now = THURSDAY_MORNING): ToolContext {
  return {
    user: { userId: 'user-1', creditsRemaining: 10 } as ToolContext['user'],
    correlationId: 'corr-1',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never,
    now: () => now,
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

type Handler = (input: unknown, ctx: ToolContext) => Promise<Record<string, unknown>>;

const LETTERS = {
  text_only: [quoteAndPreviewLetterTextOnlyTool, {}],
  header_image: [quoteAndPreviewLetterWithHeaderImageTool, { imageUrl: 'https://files.example/a.png' }],
  inline_image: [quoteAndPreviewLetterWithImageTool, { imageUrl: 'https://files.example/a.png' }]
} as const;

function letter(layout: keyof typeof LETTERS, input: Record<string, unknown> = {}, ctx: ToolContext = context()) {
  const [tool, extras] = LETTERS[layout];
  return (tool.handler as unknown as Handler)(
    { sender: address({ name: 'Pat Example' }), recipient: address(), bodyText: 'Dear Sam,', signOff: 'Pat', ...extras, ...input },
    ctx
  );
}

function postcard(input: Record<string, unknown> = {}, ctx: ToolContext = context()) {
  return (quoteAndPreviewPostcardTool.handler as unknown as Handler)(
    {
      sender: address({ name: 'Pat Example' }),
      recipient: address(),
      message: 'Greetings from the coast!',
      imageUrl: 'https://files.example/a.jpg',
      ...input
    },
    ctx
  );
}

const HELD = {
  arriveBy: '2026-10-16',
  mailOn: '2026-10-06',
  releasesAt: '2026-10-06T13:00:00.000Z',
  earliestArrival: '2026-10-13',
  latestArrival: '2026-11-30'
};
const SENTENCE = 'Goes to the printer Tue, Oct 6, and aims to arrive by Fri, Oct 16.';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('LETTER_IRL_ARRIVE_BY_ENABLED', 'true');
  vi.stubEnv('LETTER_IRL_PRINT_RENDERER', 'pdf');
  vi.mocked(getLetterProvider).mockReturnValue({} as never);
  vi.mocked(createDraft).mockResolvedValue({ draftId: 'draft-1', expiresAt: new Date('2026-10-02T14:00:00Z') });
  vi.mocked(createPostcardDraft).mockResolvedValue({ draftId: 'draft-2', expiresAt: new Date('2026-10-02T14:00:00Z') });
  vi.mocked(getRecentUploadedImage).mockResolvedValue(null);
  vi.mocked(getReturnAddress).mockResolvedValue(null);
  vi.mocked(getGiftBalance).mockResolvedValue({ available: 0, next: undefined } as never);
  vi.mocked(getSendEligibility).mockReturnValue({
    payAndSend: { available: true, amountCents: 499 },
    letterPack: { available: true, purchaseUrl: 'https://letterirl.com/pricing' }
  } as never);
  vi.mocked(downloadAndProcessLetterImageWithPreview).mockResolvedValue({
    base64DataUri: png(1950, 600),
    previewDataUri: png(390, 120),
    originalWidth: 1950,
    originalHeight: 600,
    processedWidth: 1950,
    processedHeight: 600
  } as never);
  vi.mocked(downloadAndProcessPostcardImageWithPreview).mockResolvedValue({
    base64DataUri: png(2700, 1800),
    previewDataUri: png(540, 360),
    originalWidth: 2700,
    originalHeight: 1800,
    processedWidth: 2700,
    processedHeight: 1800
  } as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('a held letter or postcard', () => {
  it.each(Object.keys(LETTERS) as Array<keyof typeof LETTERS>)(
    '%s: the draft holds to its mail date, and the output says when it goes to the printer',
    async layout => {
      const output = await letter(layout, { arriveBy: '2026-10-16' });

      expect(vi.mocked(createDraft).mock.calls[0][0].schedule).toEqual({ arriveBy: '2026-10-16', mailOn: '2026-10-06' });
      expect(output.schedule).toEqual(HELD);
      expect(output.deliveryEstimate).toBe(SENTENCE);
    }
  );

  it('postcard: the same', async () => {
    const output = await postcard({ arriveBy: '2026-10-16' });

    expect(vi.mocked(createPostcardDraft).mock.calls[0][0].schedule).toEqual({ arriveBy: '2026-10-16', mailOn: '2026-10-06' });
    expect(output.schedule).toEqual(HELD);
    expect(output.deliveryEstimate).toBe(SENTENCE);
  });

  it('mails as soon as possible without a date, as before', async () => {
    const output = await letter('text_only');
    expect(vi.mocked(createDraft).mock.calls[0][0].schedule).toBeUndefined();
    // Undefined, so the JSON the model and the card get has no schedule at all.
    expect(output.schedule).toBeUndefined();
    expect(JSON.parse(JSON.stringify(output))).not.toHaveProperty('schedule');
    expect(output.deliveryEstimate).toBe('Mailed in 1-2 business days; usually arrives in 1-2 weeks');
    const card = await postcard();
    expect(vi.mocked(createPostcardDraft).mock.calls[0][0].schedule).toBeUndefined();
    expect(card.deliveryEstimate).toBe('Mailed in 1-2 business days; usually arrives in 1-2 weeks');
  });

  it('treats an empty arriveBy as none, as models send for a field they leave unset', async () => {
    for (const arriveBy of ['', '   ']) {
      vi.mocked(createDraft).mockClear();
      const output = await letter('text_only', { arriveBy });
      expect(vi.mocked(createDraft).mock.calls[0][0].schedule, JSON.stringify(arriveBy)).toBeUndefined();
      expect(output.schedule).toBeUndefined();
    }
  });

  it('accepts a date a little either side of the edges of what is on offer, and its spaces', async () => {
    await expect(letter('text_only', { arriveBy: ' 2026-10-13 ' })).resolves.toMatchObject({ schedule: { mailOn: '2026-10-01' } });
    await expect(letter('text_only', { arriveBy: '2026-11-30' })).resolves.toMatchObject({ schedule: { mailOn: '2026-11-18' } });
  });
});

describe('a date that cannot be met', () => {
  it.each([
    ['too soon', '2026-10-12', 'The earliest this can arrive is Tue, Oct 13 (2026-10-13). Choose that date or later, or leave arriveBy out to mail as soon as possible.'],
    ['too late', '2026-12-01', 'The latest arrival date on offer is Mon, Nov 30 (2026-11-30). Choose an earlier date, or preview it again nearer the time.'],
    ['not a date', 'next Friday', 'arriveBy must be a date written YYYY-MM-DD, such as 2026-10-13.'],
    ['no such day', '2026-02-30', 'arriveBy must be a date written YYYY-MM-DD, such as 2026-10-13.']
  ])('is refused when it is %s, naming what is on offer, before any picture or draft', async (_label, arriveBy, message) => {
    const ctx = context();
    const error = await letter('header_image', { arriveBy }, ctx).catch(e => e);

    expect(error.message).toBe(message);
    expect(error).toMatchObject({ diagnosticClass: 'validation_error' });
    expect(downloadAndProcessLetterImageWithPreview).not.toHaveBeenCalled();
    expect(createDraft).not.toHaveBeenCalled();
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'quote.arrive_by_refused' }), expect.any(String));

    await expect(postcard({ arriveBy })).rejects.toThrow(message);
    expect(downloadAndProcessPostcardImageWithPreview).not.toHaveBeenCalled();
    expect(createPostcardDraft).not.toHaveBeenCalled();
  });

  it('is refused as unavailable when nothing can be scheduled', async () => {
    vi.stubEnv('LETTER_IRL_SCHEDULE_HORIZON_DAYS', '5');
    await expect(letter('text_only', { arriveBy: '2026-10-13' })).rejects.toThrow(
      'Arrival dates cannot be scheduled right now. Leave arriveBy out to mail as soon as possible.'
    );
  });

  it('names the year of a date in another year', async () => {
    const december = context(new Date('2026-12-21T15:00:00Z'));
    await expect(letter('text_only', { arriveBy: '2026-12-23' }, december)).rejects.toThrow(
      'The earliest this can arrive is Thu, Dec 31 (2026-12-31).'
    );
    const output = await letter('text_only', { arriveBy: '2027-01-08' }, december);
    // Seven business days back from Fri, Jan 8 skip New Year's Day and the weekend.
    expect(output.deliveryEstimate).toBe('Goes to the printer Tue, Dec 29, and aims to arrive by Fri, Jan 8, 2027.');
  });
});

describe('the settings', () => {
  it('uses the configured lead time: development may hold to today', async () => {
    vi.stubEnv('LETTER_IRL_SCHEDULE_LEAD_DAYS', '0');
    await expect(letter('text_only', { arriveBy: '2026-10-01' })).resolves.toMatchObject({
      schedule: { arriveBy: '2026-10-01', mailOn: '2026-10-01', earliestArrival: '2026-10-01' }
    });
  });

  it('refuses a date while the feature is off, rather than mailing it at once', async () => {
    vi.stubEnv('LETTER_IRL_ARRIVE_BY_ENABLED', '');
    const error = await letter('text_only', { arriveBy: '2026-10-16' }).catch(e => e);
    expect(error.message).toBe('Arrival dates are not available yet. Leave arriveBy out to mail as soon as possible.');
    expect(error).toMatchObject({ diagnosticClass: 'validation_error' });
    expect(createDraft).not.toHaveBeenCalled();
    // Without a date, previews are as they were.
    await expect(letter('text_only')).resolves.toMatchObject({ draftId: 'draft-1' });
  });
});
