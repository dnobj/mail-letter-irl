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
import { layoutGiftPage, layoutLetter, readImageDataUri, renderPreviewSvg, type Stationery } from '../../../src/render/index.js';
import { letterPrintText, renderLetterPreviewDocument, stampedAddressLines } from '../../../src/services/previewService.js';
import { sampleFundedCard } from '../../../src/services/giftLetterService.js';
import { giftLetterPageCopy } from '../../../src/services/giftCardRenderer.js';
import { withDisplayImage } from '../../../src/tools/letterHelpers.js';
import { partitionToolResult } from '../../../src/mcp/registerTools.js';
import { CERTIFIED_PAID_PER_SEND_REASON, PAID_PER_SEND_REASON, RENDERED_LETTER_CHARACTER_CAP, wordsVersionOf } from '../../../src/tools/letterHelpers.js';
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
  vi.stubEnv('LETTER_IRL_ROOM_TO_WRITE_ENABLED', '');
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

describe('the words editor without room to write (#647)', () => {
  it('gives the card the fit and the words version on one page, and says the letter may run to one page', async () => {
    vi.stubEnv('LETTER_IRL_ROOM_TO_WRITE_ENABLED', '');
    vi.stubEnv('LETTER_IRL_WORDS_EDITOR_ENABLED', 'true');
    const output = await run('text_only', { bodyText: lines(10) });
    expect(output.pageFit).toMatchObject({ pages: 1, maxPages: 1 });
    expect(output.wordsVersion).toBe(wordsVersionOf(lines(10), 'Pat'));
  });
});

describe('when room to write is offered', () => {
  it('gives no fit while room to write is not offered', async () => {
    const output = await run('text_only', { bodyText: lines(10) });
    expect(output).not.toHaveProperty('pageFit');
    // Nor the version of the words, which only set_letter_words names (#593 review round 1).
    expect(output).not.toHaveProperty('wordsVersion');
  });

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

  it('gives the card how full the pages are, in _meta, never the model (#586)', async () => {
    const output = await run('text_only', { bodyText: lines(40) });
    expect(output.pageFit).toMatchObject({ pages: 2, sheets: 1, doubleSided: true });
    const { structuredContent, _meta } = partitionToolResult(output);
    expect(_meta.pageFit).toEqual(output.pageFit);
    expect(structuredContent).not.toHaveProperty('pageFit');
    // The version of its words, for a change of them: the model's to name (#593 review round 1).
    expect(structuredContent.wordsVersion).toBe(wordsVersionOf(lines(40), 'Pat'));

    // One page says the room it has left.
    vi.mocked(createDraft).mockClear();
    const short = await run('text_only', { bodyText: lines(10) });
    expect(short.pageFit).toMatchObject({ pages: 1, sheets: 1, doubleSided: false });
    expect((short.pageFit as { roomCharacters: number }).roomCharacters).toBeGreaterThan(0);
  });

  it('keeps a letter that fits one page as it was: one page, no pages field, a pack pays', async () => {
    const output = await run('text_only', { bodyText: lines(10) }, context(10));
    expect(drafted().pages).toBe(1);
    expect(output).not.toHaveProperty('pages');
    expect(output.canSendNow).toBe(true);
    expect(getSendEligibility).toHaveBeenCalledWith(10, expect.any(Number), { mailType: 'letter' });
  });

  it('prices a second page that only the enclosed image takes', async () => {
    // 20 lines fit page 1 alone, but not with the 3-inch image after them.
    vi.mocked(downloadAndProcessLetterImageWithPreview).mockResolvedValue({
      base64DataUri: png(1950, 900),
      previewDataUri: png(390, 180),
      originalWidth: 1950,
      originalHeight: 900,
      processedWidth: 1950,
      processedHeight: 900
    } as never);
    const output = await run('inline_image', { bodyText: lines(20) });
    const draft = drafted();
    expect(draft.pages).toBe(2);
    expect(output.pages).toBe(2);
    expect(getSendEligibility).toHaveBeenCalledWith(10, expect.any(Number), { mailType: 'letter', pages: 2 });
    // The same text with no image is one page, as before.
    vi.mocked(createDraft).mockClear();
    await run('text_only', { bodyText: lines(20) });
    expect(drafted().pages).toBe(1);
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

  it('scales the character cap with the pages, and names three pages in it', async () => {
    // Past one page's cap, but laid out and measured: it is far from fitting.
    const over = await run('text_only', { bodyText: 'x'.repeat(RENDERED_LETTER_CHARACTER_CAP + 1) }).catch(e => e);
    expect(over.message).toMatch(/^Letter is \d+ lines too long for three pages: three pages is the longest letter we print\./);
    const error = await run('text_only', { bodyText: 'x'.repeat(3 * RENDERED_LETTER_CHARACTER_CAP + 1) }).catch(e => e);
    expect(error.message).toMatch(/^Letter is far too long for three pages: \d+\/30000 characters\. Please shorten your message to fit on three pages\.$/);
  });

  it('judges the theme ways out at three pages too', async () => {
    vi.stubEnv('LETTER_IRL_STATIONERY_ENABLED', 'true');
    // Each line fits Classic's measure and wraps in Typewriter's wider face: 50
    // lines fit three Classic pages, and run past three in Typewriter.
    const wide = Array.from({ length: 50 }, () => 'the quick brown fox jumps over the lazy dog while the letters wait patiently to be written').join('\n');
    const error = await run('text_only', { bodyText: wide, stationery: 'typewriter' }).catch(e => e);
    expect(error.message).toContain('too long for three pages on the typewriter stationery: three pages is the longest letter we print.');
    expect(error.message).toContain('The typewriter stationery sets the text in its own typeface: shorten the message, or choose the classic stationery.');

    // Too long on three Classic pages too: then the only way out is a shorter letter.
    const longer = await run('text_only', { bodyText: lines(26 + 33 + 33), stationery: 'typewriter' }).catch(e => e);
    expect(longer.message).toContain('and the letter runs past three pages on the classic stationery too: shorten the message.');
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

    // A name too long for the card is refused after the layout too.
    const tooLong = await run('text_only', { sender: address({ name: 'Pat Example '.repeat(125).trim() }), bodyText: lines(10), sendAsGift: true }).catch(e => e);
    expect(tooLong.message).toBe("The sender's name is too long to print on the gift card. Shorten it, then preview again.");
    expect(createDraft).not.toHaveBeenCalled();

    // A longer letter has no card, so the name is only stamped, in Open Sans.
    await expect(run('text_only', { sender, bodyText: lines(40) }, context(0))).resolves.toMatchObject({ pages: 2 });
    expect(drafted().isGiftSend).toBe(false);
  });
});

describe('set_stationery lays a letter out again on its pages, and prices it again (#586)', () => {
  const sender = { name: 'Pat Example', addressLine1: '1 Main St', city: 'Springfield', state: 'IL', postalCode: '62701', country: 'US' };
  /** Lines that fit Classic's measure and wrap in Typewriter's wider face. */
  const wide = (count: number) =>
    Array.from({ length: count }, () => 'the quick brown fox jumps over the lazy dog while the letters wait patiently to be written').join('\n');
  const FULL_INLINE = png(1950, 900);
  const SMALL_INLINE = png(390, 180);

  /** A pending letter draft, and the preview a preview tool drew for it on its own pages. */
  function draft(options: { bodyText: string; stationery?: Stationery; gift?: boolean; inline?: boolean }) {
    const layoutType = options.inline ? 'inline_image' : 'text_only';
    const layout = layoutLetter(
      {
        text: letterPrintText(options.bodyText, 'Pat'),
        layoutType,
        ...(options.inline ? { image: readImageDataUri(FULL_INLINE) } : {}),
        ...(options.stationery ? { stationery: options.stationery } : {})
      },
      { maxPages: 3 }
    );
    expect(layout.overflowLines).toBe(0);
    const pages = options.gift ? [...layout.pages, layoutGiftPage(giftLetterPageCopy(sampleFundedCard(), sender.name))] : layout.pages;
    const previewHtml = renderLetterPreviewDocument(
      renderPreviewSvg(withDisplayImage({ ...layout, pages }, options.inline ? SMALL_INLINE : undefined), {
        addresses: { from: stampedAddressLines(sender as Address), to: stampedAddressLines(address()) }
      }),
      { bodyText: options.bodyText, signOff: 'Pat' }
    );
    return {
      mail_type: 'letter',
      status: 'pending',
      expires_at: new Date('2026-10-03T12:00:00Z'),
      redacted_at: null,
      renderer_version: options.stationery ? 'pdf-2' : 'pdf-1',
      body_text: options.bodyText,
      sign_off: 'Pat',
      layout_type: layoutType,
      header_image_data: null,
      inline_image_data: options.inline ? FULL_INLINE : null,
      sender,
      recipient: address(),
      preview_html: previewHtml,
      pages: layout.pages.length,
      is_gift_send: options.gift === true,
      required_credits: 2
    };
  }
  const restyle = (stationery: string, ctx = context(10)) =>
    (setStationeryTool.handler as unknown as Handler)({ draftId: '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0', stationery }, ctx);
  const svgs = (html: string) => html.match(/<svg [\s\S]*?<\/svg>/g) ?? [];
  function written() {
    expect(setDraftStationery).toHaveBeenCalledTimes(1);
    return vi.mocked(setDraftStationery).mock.calls[0][2];
  }

  beforeEach(() => {
    offer();
    vi.stubEnv('LETTER_IRL_STATIONERY_ENABLED', 'true');
    vi.mocked(setDraftStationery).mockResolvedValue(null);
  });

  it('restyles a two-page letter on its pages, and keeps it paid with Pay & Send', async () => {
    vi.mocked(getDraftForStationery).mockResolvedValue(draft({ bodyText: lines(40) }) as never);
    const output = await restyle('botanical');
    const change = written();
    expect(change.pages).toBe(2);
    expect(svgs(change.previewHtml)).toHaveLength(2);
    expect(output).toMatchObject({ pages: 2, canSendNow: false, reasonCannotSend: PAID_PER_SEND_REASON });
    expect(output.message).toBe('The letter is now on the botanical stationery, and the account remembers it for its next letter preview. Nothing has been sent.');
    expect(getSendEligibility).toHaveBeenCalledWith(10, 2, { mailType: 'letter', pages: 2 });
  });

  it.each(['certified', 'certified_return_receipt'])(
    'keeps a %s letter priced as certified mail: no pack pays for it, whatever the balance (#625)',
    async service => {
      vi.mocked(getDraftForStationery).mockResolvedValue({ ...draft({ bodyText: lines(10) }), mail_service: service } as never);
      const output = await restyle('botanical', context(10));
      expect(written().pages).toBe(1);
      expect(output).toMatchObject({ canSendNow: false, reasonCannotSend: CERTIFIED_PAID_PER_SEND_REASON });
      expect(getSendEligibility).toHaveBeenCalledWith(10, 2, { mailType: 'letter', mailService: service });
    }
  );

  it('prices a certified letter by its pages and its service together, as the checkout reads the draft (#625)', async () => {
    const stored = { ...draft({ bodyText: lines(40) }), mail_service: 'certified' };
    vi.mocked(getDraftForStationery).mockResolvedValue(stored as never);
    await restyle('botanical', context(10));
    const quoted = vi.mocked(getSendEligibility).mock.calls.at(-1)![2];
    expect(quoted).toEqual({ mailType: 'letter', pages: 2, mailService: 'certified' });
    expect(quoted).toEqual(draftMailOption({ mail_type: 'letter', pages: stored.pages, mail_service: 'certified' }));
    // One product whatever the pages: the service sets the price.
    expect(jitProductMatching(quoted)?.productCode).toBe('jit-letter-certified');
  });

  it('says a certified letter that runs on to a second page costs the same, and not that Pay & Send pays for the page (#625)', async () => {
    vi.mocked(getDraftForStationery).mockResolvedValue({ ...draft({ bodyText: wide(13) }), mail_service: 'certified' } as never);
    const output = await restyle('typewriter', context(10));
    expect(written().pages).toBe(2);
    expect(output.message).toBe(
      'The letter is now on the typewriter stationery, and the account remembers it for its next letter preview. ' +
        'It now runs to two pages, printed on both sides. The price is the same. Nothing has been sent.'
    );
    expect(getSendEligibility).toHaveBeenCalledWith(10, 2, { mailType: 'letter', pages: 2, mailService: 'certified' });
  });

  it('runs a one-page letter on to a second page in a wider face, and prices it as Pay & Send', async () => {
    vi.mocked(getDraftForStationery).mockResolvedValue(draft({ bodyText: wide(13) }) as never);
    const output = await restyle('typewriter');
    const change = written();
    expect(change.pages).toBe(2);
    expect(svgs(change.previewHtml)).toHaveLength(2);
    expect(output).toMatchObject({ pages: 2, canSendNow: false, reasonCannotSend: PAID_PER_SEND_REASON });
    expect(output.message).toBe(
      'The letter is now on the typewriter stationery, and the account remembers it for its next letter preview. ' +
        'It now runs to two pages, printed on both sides, and is paid with Pay & Send. Nothing has been sent.'
    );
    // And how full its pages are now, for the card (#586).
    expect(output.pageFit).toMatchObject({ pages: 2, sheets: 1, doubleSided: true });
    expect(getSendEligibility).toHaveBeenCalledWith(10, 2, { mailType: 'letter', pages: 2 });
  });

  it('runs a two-page letter on to a third page, and says so', async () => {
    // 30 wide lines are two Classic pages, and three in Typewriter's face.
    const stored = draft({ bodyText: wide(30) });
    expect(stored.pages).toBe(2);
    vi.mocked(getDraftForStationery).mockResolvedValue(stored as never);
    const output = await restyle('typewriter');
    expect(written().pages).toBe(3);
    expect(output).toMatchObject({ pages: 3, canSendNow: false });
    expect(output.message).toContain('It now runs to three pages, printed on both sides, and is paid with Pay & Send.');
    expect(getSendEligibility).toHaveBeenCalledWith(10, 2, { mailType: 'letter', pages: 3 });
  });

  it('refuses a draft whose stored preview has fewer pages than it counts, drawing nothing', async () => {
    vi.mocked(getDraftForStationery).mockResolvedValue({ ...draft({ bodyText: lines(10) }), pages: 2 } as never);
    await expect(restyle('botanical')).rejects.toMatchObject({ code: 'DRAFT_NOT_DRAWN' });
    expect(setDraftStationery).not.toHaveBeenCalled();
  });

  it('fits a letter back on one page, which a pack pays for', async () => {
    const typewriter = { theme: 'typewriter' as const, dateLine: 'October 2, 2026' };
    vi.mocked(getDraftForStationery).mockResolvedValue(draft({ bodyText: wide(13), stationery: typewriter }) as never);
    const output = await restyle('classic');
    expect(written().pages).toBe(1);
    expect(output).not.toHaveProperty('pages');
    expect(output).toMatchObject({ canSendNow: true });
    expect(output).not.toHaveProperty('reasonCannotSend');
    expect(output.message).toContain('It now fits on one page, which a letter pack pays for.');
    expect(getSendEligibility).toHaveBeenCalledWith(10, 2, { mailType: 'letter' });
  });

  it('keeps a gift letter on one page, its card after it, and refuses a face that would run it on', async () => {
    const gift = draft({ bodyText: lines(10), gift: true });
    vi.mocked(getDraftForStationery).mockResolvedValue(gift as never);
    // An empty balance: the gift letter is what pays for it.
    const output = await restyle('botanical', context(0));
    const change = written();
    expect(change.pages).toBe(1);
    const [, card] = svgs(change.previewHtml);
    expect(card).toBe(svgs(gift.preview_html)[1]);
    expect(output).toMatchObject({ canSendNow: true });

    vi.mocked(setDraftStationery).mockClear();
    vi.mocked(getDraftForStationery).mockResolvedValue(draft({ bodyText: wide(13), gift: true }) as never);
    const error = await restyle('typewriter').catch(e => e);
    expect(error.message).toMatch(/too long for one page on the typewriter stationery/);
    expect(setDraftStationery).not.toHaveBeenCalled();
  });

  it('draws the picture from whichever page showed it', async () => {
    // 20 lines and the sign-off fill page 1; the enclosed image takes page 2.
    const stored = draft({ bodyText: lines(20), inline: true });
    expect(stored.pages).toBe(2);
    vi.mocked(getDraftForStationery).mockResolvedValue(stored as never);
    await restyle('botanical');
    const change = written();
    expect(change.pages).toBe(2);
    expect(change.previewHtml).toContain(SMALL_INLINE);
    expect(change.previewHtml).not.toContain(FULL_INLINE);
  });

  it('with room to write off, lays a restyle out on one page: a longer draft is refused as too long', async () => {
    vi.stubEnv('LETTER_IRL_ROOM_TO_WRITE_ENABLED', '');
    vi.mocked(getDraftForStationery).mockResolvedValue(draft({ bodyText: lines(40) }) as never);
    const error = await restyle('botanical').catch(e => e);
    expect(error.message).toMatch(/too long for one page/);
    expect(setDraftStationery).not.toHaveBeenCalled();

    // A one-page letter restyles as before, with no fit for the card (#586).
    vi.mocked(getDraftForStationery).mockResolvedValue(draft({ bodyText: lines(10) }) as never);
    const output = await restyle('botanical');
    expect(setDraftStationery).toHaveBeenCalledTimes(1);
    expect(output).not.toHaveProperty('pageFit');
  });
});
