/**
 * Room to write (#586): while LETTER_IRL_ROOM_TO_WRITE_ENABLED is on, with our
 * renderer and Pay & Send, a letter preview lays the letter out on up to three
 * pages. The draft records the pages, the preview prices them as Pay & Send,
 * no gift letter pays for them, and only a letter longer than three pages is
 * refused. Off, every preview is as before.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/providers/index.js', () => ({
  getLetterProvider: vi.fn()
}));

vi.mock('../../../src/services/draftService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/draftService.js')>()),
  createDraft: vi.fn(),
  getDraftForStationery: vi.fn(),
  setDraftStationery: vi.fn()
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
  downloadAndProcessLetterImageWithPreview: vi.fn()
}));

vi.mock('../../../src/services/giftLetterService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/giftLetterService.js')>()),
  getGiftBalance: vi.fn()
}));

vi.mock('../../../src/services/stationeryDefaultService.js', () => ({
  rememberedStationery: vi.fn(),
  rememberStationery: vi.fn()
}));

vi.mock('../../../src/services/commerceService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/commerceService.js')>()),
  getSendEligibility: vi.fn()
}));

import { getLetterProvider } from '../../../src/services/providers/index.js';
import { createDraft, getDraftForStationery, setDraftStationery } from '../../../src/services/draftService.js';
import { getRecentUploadedImage } from '../../../src/services/recentUploadStore.js';
import { getReturnAddress } from '../../../src/services/returnAddressService.js';
import { downloadAndProcessLetterImageWithPreview } from '../../../src/services/imageService.js';
import { getGiftBalance } from '../../../src/services/giftLetterService.js';
import { getSendEligibility } from '../../../src/services/commerceService.js';
import { quoteAndPreviewLetterTextOnlyTool } from '../../../src/tools/quoteAndPreviewLetterTextOnly.js';
import { quoteAndPreviewLetterWithHeaderImageTool } from '../../../src/tools/quoteAndPreviewLetterWithHeaderImage.js';
import { quoteAndPreviewLetterWithImageTool } from '../../../src/tools/quoteAndPreviewLetterWithImage.js';
import { setStationeryTool } from '../../../src/tools/setStationery.js';
import { isRoomToWriteOffered, letterPageLimit } from '../../../src/config/roomToWrite.js';
import { draftMailOption, jitProductMatching } from '../../../src/config/products.js';
import { PAID_PER_SEND_REASON, RENDERED_LETTER_CHARACTER_CAP } from '../../../src/tools/letterHelpers.js';
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

function context(credits = 10): ToolContext {
  return {
    user: { userId: 'user-1', creditsRemaining: credits } as ToolContext['user'],
    correlationId: 'corr-1',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never,
    now: () => new Date('2026-10-02T12:00:00Z'),
    persist: vi.fn(),
    isMobile: false
  } as unknown as ToolContext;
}

function address(overrides: Partial<Address> = {}): Address {
  return { name: 'Sam Rivera', addressLine1: '350 Fifth Ave', city: 'New York', state: 'NY', postalCode: '10118', country: 'US', ...overrides };
}

/** `count` short lines, each one printed line; the sign-off prints on one more. */
const lines = (count: number) => Array.from({ length: count }, (_, index) => `Line ${index + 1}`).join('\n');

type Handler = (input: unknown, ctx: ToolContext) => Promise<Record<string, unknown>>;
const TOOLS = {
  text_only: [quoteAndPreviewLetterTextOnlyTool, {}],
  header_image: [quoteAndPreviewLetterWithHeaderImageTool, { imageUrl: 'https://files.example/a.png' }],
  inline_image: [quoteAndPreviewLetterWithImageTool, { imageUrl: 'https://files.example/a.png' }]
} as const;

function run(layout: keyof typeof TOOLS, input: Record<string, unknown> = {}, ctx: ToolContext = context()) {
  const [tool, extras] = TOOLS[layout];
  return (tool.handler as unknown as Handler)(
    { sender: address({ name: 'Pat Example' }), recipient: address(), bodyText: 'Dear Sam,', signOff: 'Pat', ...extras, ...input },
    ctx
  );
}

function drafted() {
  expect(createDraft).toHaveBeenCalledTimes(1);
  return vi.mocked(createDraft).mock.calls[0][0];
}

/** Room to write as it is offered: the flag, our renderer, and Pay & Send. */
function offer() {
  vi.stubEnv('LETTER_IRL_ROOM_TO_WRITE_ENABLED', 'true');
  vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('LETTER_IRL_PRINT_RENDERER', 'pdf');
  vi.mocked(getLetterProvider).mockReturnValue({} as never);
  vi.mocked(createDraft).mockResolvedValue({ draftId: 'draft-1', expiresAt: new Date('2026-10-03T12:00:00Z') });
  vi.mocked(getRecentUploadedImage).mockResolvedValue(null);
  vi.mocked(getReturnAddress).mockResolvedValue(null);
  vi.mocked(getGiftBalance).mockResolvedValue({ available: 0, next: undefined } as never);
  vi.mocked(getSendEligibility).mockReturnValue({
    payAndSend: { available: true, amountCents: 599 },
    letterPack: { available: false, purchaseUrl: 'https://letterirl.com/pricing' },
    packPays: false
  } as never);
  vi.mocked(downloadAndProcessLetterImageWithPreview).mockResolvedValue({
    base64DataUri: png(1950, 600),
    previewDataUri: png(390, 120),
    originalWidth: 1950,
    originalHeight: 600,
    processedWidth: 1950,
    processedHeight: 600
  } as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('when room to write is offered', () => {
  it('needs the flag, our renderer and Pay & Send, and then allows three pages', () => {
    expect(isRoomToWriteOffered()).toBe(false);
    expect(letterPageLimit()).toBe(1);
    offer();
    expect(isRoomToWriteOffered()).toBe(true);
    expect(letterPageLimit()).toBe(3);
    for (const [name, value] of [
      ['LETTER_IRL_ROOM_TO_WRITE_ENABLED', 'false'],
      ['LETTER_IRL_PRINT_RENDERER', 'html'],
      ['JIT_PURCHASE_ENABLED', 'false']
    ]) {
      offer();
      vi.stubEnv('LETTER_IRL_PRINT_RENDERER', 'pdf');
      vi.stubEnv(name, value);
      expect(isRoomToWriteOffered(), name).toBe(false);
      expect(letterPageLimit(), name).toBe(1);
    }
  });

  it('says so in the three letter previews\' descriptions, and only then', () => {
    const descriptions = () => Object.values(TOOLS).map(([tool]) => (tool.description as (client: unknown) => string)({}));
    for (const description of descriptions()) expect(description).not.toContain('second or third page');
    offer();
    for (const description of descriptions()) {
      expect(description).toContain(
        'A letter too long for one page runs on to a second or third page, printed on both sides and paid with Pay & Send; three pages is the longest.'
      );
    }
  });
});

describe('a longer letter, while room to write is offered', () => {
  beforeEach(offer);

  it.each([
    [2, 40],
    [3, 75]
  ])('is laid out on %i pages, recorded on its draft, and priced as Pay & Send', async (pages, count) => {
    const output = await run('text_only', { bodyText: lines(count) }, context(10));
    const draft = drafted();
    expect(draft.pages).toBe(pages);
    expect(draft.rendererVersion).toBe('pdf-1');
    expect(draft.isGiftSend).toBe(false);
    expect(draft.previewHtml!.match(/<svg /g)).toHaveLength(pages);
    expect(output.pages).toBe(pages);
    // The balance never pays for it (#579): Pay & Send at its own price.
    expect(output.canSendNow).toBe(false);
    expect(output.reasonCannotSend).toBe(PAID_PER_SEND_REASON);
    expect(getSendEligibility).toHaveBeenCalledWith(10, expect.any(Number), { mailType: 'letter', pages });
  });

  it('quotes exactly the option the checkout prices its stored draft by, for one, two and three pages', async () => {
    for (const [count, pages, product] of [[10, 1, 'jit-letter'], [40, 2, 'jit-letter-2-pages'], [75, 3, 'jit-letter-3-pages']] as const) {
      vi.mocked(createDraft).mockClear();
      vi.mocked(getSendEligibility).mockClear();
      await run('text_only', { bodyText: lines(count) });
      const stored = drafted();
      const quoted = vi.mocked(getSendEligibility).mock.calls.at(-1)![2];
      // The checkout reads the draft row through draftMailOption: the same option, so the same price.
      expect(quoted, String(pages)).toEqual(draftMailOption({ mail_type: 'letter', pages: stored.pages }));
      expect(jitProductMatching(quoted)?.productCode, String(pages)).toBe(product);
    }
  });

  it('keeps a letter that fits one page as it was: one page, no pages field, a pack pays', async () => {
    const output = await run('text_only', { bodyText: lines(10) }, context(10));
    expect(drafted().pages).toBe(1);
    expect(output).not.toHaveProperty('pages');
    expect(output.canSendNow).toBe(true);
    expect(getSendEligibility).toHaveBeenCalledWith(10, expect.any(Number), { mailType: 'letter' });
  });

  it.each(['header_image', 'inline_image'] as const)('lays out a letter with an image (%s) on more pages too', async layout => {
    const output = await run(layout, { bodyText: lines(40) });
    expect(drafted().pages).toBe(2);
    expect(output.pages).toBe(2);
  });

  it('refuses only a letter longer than three pages, saying three pages is the longest', async () => {
    const ctx = context();
    const error = await run('text_only', { bodyText: lines(26 + 33 + 33 + 5) }, ctx).catch(e => e);
    expect(error.message).toBe(
      'Letter is 6 lines too long for three pages: three pages is the longest letter we print. Please shorten your message to fit on three pages.'
    );
    expect(error).toMatchObject({ diagnosticClass: 'validation_error' });
    expect(createDraft).not.toHaveBeenCalled();
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'quote.letter.exceeds_page', maxPages: 3 }),
      expect.any(String)
    );
  });

  it('names three pages in the character cap', async () => {
    const error = await run('text_only', { bodyText: 'x'.repeat(RENDERED_LETTER_CHARACTER_CAP + 1) }).catch(e => e);
    expect(error.message).toMatch(/^Letter is far too long for three pages: \d+\/10000 characters\. Please shorten your message to fit on three pages\.$/);
  });

  it('offers the theme ways out at three pages too', async () => {
    vi.stubEnv('LETTER_IRL_STATIONERY_ENABLED', 'true');
    const error = await run('text_only', { bodyText: lines(26 + 33 + 33), stationery: 'typewriter' }).catch(e => e);
    expect(error.message).toContain('too long for three pages on the typewriter stationery: three pages is the longest letter we print.');
    expect(error.message).toContain('The typewriter stationery sets the text in its own typeface');
  });
});

describe('a gift letter, while room to write is offered', () => {
  beforeEach(() => {
    offer();
    vi.stubEnv('LETTER_IRL_GIFT_LETTERS_ENABLED', 'true');
    vi.mocked(getGiftBalance).mockResolvedValue({ available: 1, next: { giftId: 'gift-1', cardState: 'funded' } } as never);
  });

  it('is never a longer letter: asked for, it is refused; not asked for, none is chosen', async () => {
    await expect(run('text_only', { bodyText: lines(40), sendAsGift: true }, context(0))).rejects.toThrow(
      'A gift letter pays for a one-page letter or a 6x9 postcard, not for this one.'
    );
    expect(createDraft).not.toHaveBeenCalled();

    // The balance cannot pay either, and still no gift is spent on it.
    const output = await run('text_only', { bodyText: lines(40) }, context(0));
    const draft = drafted();
    expect(draft.isGiftSend).toBe(false);
    expect(draft.pages).toBe(2);
    expect(output.giftCard).toBeUndefined();
    expect(output.canSendNow).toBe(false);
  });

  it('is chosen for a one-page letter as before, its card on a page of its own', async () => {
    const output = await run('text_only', { bodyText: lines(10) }, context(0));
    const draft = drafted();
    expect(draft.isGiftSend).toBe(true);
    expect(draft.pages).toBe(1);
    expect(draft.previewHtml!.match(/<svg /g)).toHaveLength(2);
    expect(output).not.toHaveProperty('pages');
    expect(output.giftCard).toMatchObject({ state: 'funded' });
  });

  it("checks the card's name once the gift is decided, after the layout", async () => {
    const FF = 'ﬀ';
    const sender = address({ name: `Pat Sta${FF}ord` });
    const error = await run('text_only', { sender, bodyText: lines(10), sendAsGift: true }).catch(e => e);
    expect(error.message).toContain(`${FF} (U+FB00) in the sender's name, which the gift card prints.`);
    expect(createDraft).not.toHaveBeenCalled();

    // A longer letter has no card, so the name is only stamped, in Open Sans.
    await expect(run('text_only', { sender, bodyText: lines(40) }, context(0))).resolves.toMatchObject({ pages: 2 });
    expect(drafted().isGiftSend).toBe(false);
  });
});

describe('set_stationery, until a longer letter can be restyled in place', () => {
  const sender = { name: 'Pat Example', addressLine1: '1 Main St', city: 'Springfield', state: 'IL', postalCode: '62701', country: 'US' };
  const draft = (overrides: Record<string, unknown> = {}) => ({
    mail_type: 'letter',
    status: 'pending',
    expires_at: new Date('2026-10-03T12:00:00Z'),
    redacted_at: null,
    renderer_version: 'pdf-1',
    body_text: lines(20),
    sign_off: 'Pat',
    layout_type: 'text_only',
    header_image_data: null,
    inline_image_data: null,
    sender,
    recipient: address(),
    preview_html: '<!DOCTYPE html><html><body data-renderer="pdf-1"><svg></svg></body></html>',
    pages: 1,
    ...overrides
  });
  const restyle = (stationery: string) =>
    (setStationeryTool.handler as unknown as Handler)({ draftId: '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0', stationery }, context());

  beforeEach(() => {
    offer();
    vi.stubEnv('LETTER_IRL_STATIONERY_ENABLED', 'true');
    vi.mocked(setDraftStationery).mockResolvedValue(null);
  });

  it('refuses a letter of more than one page, before drawing anything', async () => {
    vi.mocked(getDraftForStationery).mockResolvedValue(draft({ pages: 2, body_text: lines(40) }) as never);
    await expect(restyle('botanical')).rejects.toMatchObject({
      code: 'DRAFT_LONGER_THAN_A_PAGE',
      message: "This letter runs past one page, so its stationery can't change here yet. Make a new preview in the stationery you'd like."
    });
    expect(setDraftStationery).not.toHaveBeenCalled();
  });

  it('refuses a restyle that would run on to a second page, as too long for its one page', async () => {
    // Each line fits Classic's measure and wraps in Typewriter's wider face:
    // 13 lines are 26 there, and the sign-off is one too many for its page.
    const long = Array.from({ length: 13 }, () => 'the quick brown fox jumps over the lazy dog while the letters wait patiently to be written').join('\n');
    vi.mocked(getDraftForStationery).mockResolvedValue(draft({ body_text: long }) as never);
    const error = await restyle('typewriter').catch(e => e);
    expect(error.message).toMatch(/too long for one page on the typewriter stationery/);
    expect(setDraftStationery).not.toHaveBeenCalled();
  });
});
