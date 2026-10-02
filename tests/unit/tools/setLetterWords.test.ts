/**
 * set_letter_words (#586): a letter preview's words, changed without
 * previewing again, while room to write is offered. The words are checked as
 * the previews check theirs, laid out again in the draft's own stationery on
 * up to three pages, and the draft is changed in place, with its page drawn
 * again and its pages and price with it, only while it waits to be sent. A
 * gift letter stays on one page.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/draftService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/draftService.js')>()),
  getDraftForStationery: vi.fn(),
  setDraftWords: vi.fn()
}));

vi.mock('../../../src/services/giftLetterService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/giftLetterService.js')>()),
  getGiftBalance: vi.fn()
}));

vi.mock('../../../src/services/commerceService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/commerceService.js')>()),
  getSendEligibility: vi.fn()
}));

import { getDraftForStationery, setDraftWords } from '../../../src/services/draftService.js';
import { getSendEligibility } from '../../../src/services/commerceService.js';
import { setLetterWordsTool } from '../../../src/tools/setLetterWords.js';
import { partitionToolResult } from '../../../src/mcp/registerTools.js';
import { layoutGiftPage, layoutLetter, readImageDataUri, renderPreviewSvg, type Stationery } from '../../../src/render/index.js';
import { letterPrintText, renderLetterPreviewDocument, stampedAddressLines } from '../../../src/services/previewService.js';
import { sampleFundedCard } from '../../../src/services/giftLetterService.js';
import { giftLetterPageCopy } from '../../../src/services/giftCardRenderer.js';
import { PAID_PER_SEND_REASON, withDisplayImage, wordsVersionOf } from '../../../src/tools/letterHelpers.js';
import { getGiftBalance } from '../../../src/services/giftLetterService.js';
import type { Address, ToolContext } from '../../../src/contracts/types.js';

const DRAFT_ID = '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0';
const NOW = new Date('2026-10-02T12:00:00Z');

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
const FULL_INLINE = png(1950, 900);
const SMALL_INLINE = png(390, 180);

function context(credits = 10): ToolContext {
  return {
    user: { userId: 'user-1', creditsRemaining: credits } as ToolContext['user'],
    correlationId: 'corr-1',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never,
    now: () => NOW,
    persist: vi.fn(),
    isMobile: false
  } as unknown as ToolContext;
}

const SENDER: Address = { name: 'Pat Example', addressLine1: '1 Main St', city: 'Springfield', state: 'IL', postalCode: '62701', country: 'US' };
const RECIPIENT: Address = { name: 'Sam Rivera', addressLine1: '350 Fifth Ave', city: 'New York', state: 'NY', postalCode: '10118', country: 'US' };

/** `count` short lines, each one printed line; the sign-off prints on one more. */
const lines = (count: number) => Array.from({ length: count }, (_, index) => `Line ${index + 1}`).join('\n');
/** Lines that fit Classic's measure and wrap in Typewriter's wider face. */
const wide = (count: number) =>
  Array.from({ length: count }, () => 'the quick brown fox jumps over the lazy dog while the letters wait patiently to be written').join('\n');

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
  const pages = options.gift ? [...layout.pages, layoutGiftPage(giftLetterPageCopy(sampleFundedCard(), SENDER.name))] : layout.pages;
  const previewHtml = renderLetterPreviewDocument(
    renderPreviewSvg(withDisplayImage({ ...layout, pages }, options.inline ? SMALL_INLINE : undefined), {
      addresses: { from: stampedAddressLines(SENDER), to: stampedAddressLines(RECIPIENT) }
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
    sender: SENDER,
    recipient: RECIPIENT,
    preview_html: previewHtml,
    pages: layout.pages.length,
    is_gift_send: options.gift === true,
    required_credits: 2,
    // As the draft stores it: none for Classic.
    stationery: options.stationery ?? null
  };
}

type Handler = (input: unknown, ctx: ToolContext) => Promise<Record<string, unknown>>;
const handler = setLetterWordsTool.handler as unknown as Handler;
/** The version of the words the mocked draft has now: what a caller that saw them names (#593 review round 1). */
async function versionNow(): Promise<string | undefined> {
  const read = vi.mocked(getDraftForStationery).getMockImplementation();
  const found = read ? ((await read(DRAFT_ID, 'user-1')) as { body_text: string; sign_off: string | null } | null) : null;
  return found ? wordsVersionOf(found.body_text, found.sign_off) : undefined;
}
const change = async (bodyText: string, ctx = context(), signOff = 'Love, Pat') =>
  handler({ draftId: DRAFT_ID, bodyText, signOff, wordsVersion: await versionNow() }, ctx);
const svgs = (html: string) => html.match(/<svg [\s\S]*?<\/svg>/g) ?? [];

/** The one change written: what setDraftWords was given. */
function written() {
  expect(setDraftWords).toHaveBeenCalledTimes(1);
  const [draftId, userId, words, now] = vi.mocked(setDraftWords).mock.calls[0];
  expect([draftId, userId, now]).toEqual([DRAFT_ID, 'user-1', NOW]);
  return words;
}

/** Room to write as it is offered: the flag, our renderer, and Pay & Send. */
function offer() {
  vi.stubEnv('LETTER_IRL_ROOM_TO_WRITE_ENABLED', 'true');
  vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('LETTER_IRL_PRINT_RENDERER', 'pdf');
  offer();
  vi.mocked(setDraftWords).mockResolvedValue(null);
  // A pack pays for one page; a longer letter is Pay & Send.
  vi.mocked(getSendEligibility).mockImplementation(((_available: number, _credits: number, option: { pages?: number }) =>
    (option?.pages ?? 1) > 1
      ? { packPays: false, payAndSend: { available: true, amountCents: 599 }, letterPack: { available: false } }
      : { packPays: true, payAndSend: { available: true, amountCents: 499 }, letterPack: { available: true } }) as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('set_letter_words', () => {
  it("changes a one-page letter's words on one page: drawn with them, written with what it was drawn in, priced as before", async () => {
    vi.mocked(getDraftForStationery).mockResolvedValue(draft({ bodyText: lines(10) }) as never);

    const output = await change('Dear Sam,\n\nThe garden is in.');

    const words = written();
    expect(words).toMatchObject({ bodyText: 'Dear Sam,\n\nThe garden is in.', signOff: 'Love, Pat', pages: 1, drawnIn: null });
    // The words it replaces, as read, so a change under it is refused (#593 review round 1).
    expect(words.replacing).toEqual({ bodyText: lines(10), signOff: 'Pat' });
    expect(svgs(words.previewHtml)).toHaveLength(1);
    expect(words.previewHtml).toContain('<body data-renderer="pdf-1">');
    // The page's title is its printed lines.
    expect(words.previewHtml).toContain('<title>Dear Sam,\nThe garden is in.\nLove, Pat</title>');
    // The addresses where PostGrid stamps them, as before.
    expect(words.previewHtml).toContain('>SAM RIVERA</text>');
    expect(output).toMatchObject({ draftId: DRAFT_ID, canSendNow: true, previewHtml: words.previewHtml });
    expect(output).not.toHaveProperty('pages');
    expect(output).not.toHaveProperty('reasonCannotSend');
    expect(output.pageFit).toMatchObject({ pages: 1, sheets: 1, doubleSided: false });
    expect(output.message).toBe("The letter's words are changed and its page is drawn again. Nothing has been sent.");
    // The new words' version, for the next change.
    expect(output.wordsVersion).toBe(wordsVersionOf('Dear Sam,\n\nThe garden is in.', 'Love, Pat'));
    expect(output.wordsVersion).not.toBe(await versionNow());
    expect(getSendEligibility).toHaveBeenCalledWith(10, 2, { mailType: 'letter' });
  });

  it('runs a letter on to a second page, prices it as Pay & Send, and says so', async () => {
    vi.mocked(getDraftForStationery).mockResolvedValue(draft({ bodyText: lines(10) }) as never);

    const output = await change(lines(40));

    const words = written();
    expect(words.pages).toBe(2);
    expect(svgs(words.previewHtml)).toHaveLength(2);
    expect(output).toMatchObject({ pages: 2, canSendNow: false, reasonCannotSend: PAID_PER_SEND_REASON });
    expect(output.sendEligibility).toMatchObject({ packPays: false });
    expect(output.pageFit).toMatchObject({ pages: 2, sheets: 1, doubleSided: true });
    expect(output.message).toContain('It now runs to two pages, printed on both sides, and is paid with Pay & Send.');
    expect(getSendEligibility).toHaveBeenCalledWith(10, 2, { mailType: 'letter', pages: 2 });
  });

  it('fits a longer letter back on one page, which a pack pays for', async () => {
    vi.mocked(getDraftForStationery).mockResolvedValue(draft({ bodyText: lines(40) }) as never);

    const output = await change(lines(10));

    expect(written().pages).toBe(1);
    expect(output).toMatchObject({ canSendNow: true });
    expect(output).not.toHaveProperty('pages');
    expect(output.message).toContain('It now fits on one page, which a letter pack pays for.');
  });

  it("lays the words out in the draft's own stationery, and writes the stationery it was drawn in", async () => {
    const typewriter = { theme: 'typewriter' as const, dateLine: 'October 2, 2026' };
    vi.mocked(getDraftForStationery).mockResolvedValue(draft({ bodyText: lines(10), stationery: typewriter }) as never);

    // Lines that fit Classic's measure run past one page in Typewriter's face.
    const output = await change(wide(13));

    const words = written();
    expect(words.drawnIn).toEqual(typewriter);
    expect(words.pages).toBe(2);
    expect(words.previewHtml).toContain('<body data-renderer="pdf-2">');
    expect(words.previewHtml).toContain('<title>October 2, 2026\n');
    expect(output).toMatchObject({ pages: 2, canSendNow: false });
  });

  it("keeps a gift letter's card page, and refuses words that would run it past one page", async () => {
    vi.mocked(getDraftForStationery).mockResolvedValue(draft({ bodyText: lines(10), gift: true }) as never);

    const output = await change(lines(12), context(0));
    const words = written();
    expect(words.pages).toBe(1);
    // The letter's page, then its card, as it was.
    expect(svgs(words.previewHtml)).toHaveLength(2);
    expect(output).toMatchObject({ canSendNow: true });
    expect(output.sendEligibility).toMatchObject({ payAndSend: { available: false } });

    vi.mocked(setDraftWords).mockClear();
    // Past three pages, and past the character cap, it is still a gift letter's refusal (#593 review round 1).
    for (const long of [lines(200), 'x'.repeat(10_001), 'x'.repeat(30_001)]) {
      await expect(change(long, context(0)), long.slice(0, 12)).rejects.toMatchObject({ code: 'GIFT_LETTER_ONE_PAGE' });
    }
    const error = await change(lines(40), context(0)).catch(e => e);
    expect(error).toMatchObject({ code: 'GIFT_LETTER_ONE_PAGE' });
    expect(error.message).toBe(
      'This letter is sent as a gift letter, which is one page, and these words run past it. ' +
        'Shorten them to fit one page, or make a new preview to send it another way.'
    );
    expect(setDraftWords).not.toHaveBeenCalled();
  });

  it("refuses a change of words its caller has not seen, and gives the words as they are now (#593 review round 1)", async () => {
    vi.mocked(getDraftForStationery).mockResolvedValue({ ...draft({ bodyText: lines(10) }), body_text: 'Dear Sam,\n\nChanged on the card.', sign_off: 'Love, Pat' } as never);
    const now = wordsVersionOf('Dear Sam,\n\nChanged on the card.', 'Love, Pat');

    // Named, but not the words it has now.
    const stale = await handler({ draftId: DRAFT_ID, bodyText: 'Dear Sam, with a P.S.', signOff: 'Pat', wordsVersion: wordsVersionOf(lines(10), 'Pat') }, context()).catch(e => e);
    expect(stale).toMatchObject({ code: 'WORDS_CHANGED' });
    expect(stale.message).toBe(
      "Nothing was changed: the letter's words now are not the ones that wordsVersion names. The letter card can change them too. " +
        `The letter's words now are below, at wordsVersion "${now}". Make the change to these words, then call set_letter_words again with that wordsVersion.` +
        '\n\nDear Sam,\n\nChanged on the card.\n\nLove, Pat'
    );

    // Not named at all.
    const unnamed = await handler({ draftId: DRAFT_ID, bodyText: 'Dear Sam, with a P.S.', signOff: 'Pat' }, context()).catch(e => e);
    expect(unnamed).toMatchObject({ code: 'WORDS_CHANGED' });
    expect(unnamed.message).toMatch(/^Nothing was changed: give wordsVersion, the version of the words this change replaces/);
    expect(unnamed.message).toContain(`wordsVersion "${now}"`);
    expect(setDraftWords).not.toHaveBeenCalled();

    // Named as it is now, it goes through: copied with spaces or quotes round it too (#593 review round 2).
    await handler({ draftId: DRAFT_ID, bodyText: 'Dear Sam, with a P.S.', signOff: 'Pat', wordsVersion: ` "${now}" ` }, context());
    expect(written().replacing).toEqual({ bodyText: 'Dear Sam,\n\nChanged on the card.', signOff: 'Love, Pat' });
  });

  it("goes through when the words are the draft's already, as when a call is retried after its answer was lost (#593 review round 2)", async () => {
    // The first call changed them; the retry names the version from before it.
    vi.mocked(getDraftForStationery).mockResolvedValue({ ...draft({ bodyText: lines(10) }), body_text: 'Dear Sam, with a P.S.', sign_off: 'Pat' } as never);
    const output = await handler(
      { draftId: DRAFT_ID, bodyText: 'Dear Sam, with a P.S.', signOff: 'Pat', wordsVersion: wordsVersionOf(lines(10), 'Pat') },
      context()
    );
    expect(output.wordsVersion).toBe(wordsVersionOf('Dear Sam, with a P.S.', 'Pat'));
    expect(written()).toMatchObject({ bodyText: 'Dear Sam, with a P.S.', replacing: { bodyText: 'Dear Sam, with a P.S.', signOff: 'Pat' } });
  });

  it('says a new preview can use a gift letter when the words bring it back to a page the balance cannot pay (#593 review round 1)', async () => {
    vi.stubEnv('LETTER_IRL_GIFT_LETTERS_ENABLED', 'true');
    vi.mocked(getGiftBalance).mockResolvedValue({ available: 1 } as never);
    vi.mocked(getDraftForStationery).mockResolvedValue(draft({ bodyText: lines(40) }) as never);
    const output = await change(lines(10), context(0));
    expect(output.message).toBe(
      "The letter's words are changed and its page is drawn again. It now fits on one page, which a letter pack pays for. " +
        'A new preview of it can use your gift letter. Nothing has been sent.'
    );

    // None on hand, or a balance that pays: nothing said of it.
    vi.mocked(getGiftBalance).mockResolvedValue({ available: 0 } as never);
    expect((await change(lines(10), context(0))).message).not.toContain('gift letter');
    vi.mocked(getGiftBalance).mockResolvedValue({ available: 1 } as never);
    expect((await change(lines(10), context(10))).message).not.toContain('gift letter');
  });

  it('draws the enclosed picture again from the small copy its preview showed', async () => {
    vi.mocked(getDraftForStationery).mockResolvedValue(draft({ bodyText: lines(4), inline: true }) as never);

    await change(lines(6));

    const words = written();
    expect(words.previewHtml).toContain(SMALL_INLINE);
    expect(words.previewHtml).not.toContain(FULL_INLINE);
  });

  it("refuses words that are not there, too long for three pages, or that would print as boxes, before writing", async () => {
    vi.mocked(getDraftForStationery).mockResolvedValue(draft({ bodyText: lines(10) }) as never);

    await expect(change('   ')).rejects.toMatchObject({ code: 'WORDS_MISSING' });
    await expect(change('x'.repeat(30_001))).rejects.toThrow(/far too long for three pages/);
    await expect(change(lines(200))).rejects.toThrow(/three pages/);
    await expect(change('Dear Sam, \u{1F600}')).rejects.toThrow();
    expect(setDraftWords).not.toHaveBeenCalled();
  });

  it("checks what prints in the draft's own face: Greek prints in Classic, not in Handwritten", async () => {
    const greek = 'Αγαπητέ Sam, ο κήπος άνθισε.';
    vi.mocked(getDraftForStationery).mockResolvedValue(draft({ bodyText: lines(4) }) as never);
    await change(greek);
    expect(written().bodyText).toBe(greek);

    vi.mocked(setDraftWords).mockClear();
    const handwritten = { theme: 'handwritten' as const, dateLine: 'October 2, 2026' };
    vi.mocked(getDraftForStationery).mockResolvedValue(draft({ bodyText: lines(4), stationery: handwritten }) as never);
    await expect(change(greek)).rejects.toThrow();
    expect(setDraftWords).not.toHaveBeenCalled();
  });

  it('is refused while room to write is not offered, before reading the draft', async () => {
    vi.stubEnv('LETTER_IRL_ROOM_TO_WRITE_ENABLED', '');
    await expect(change(lines(4))).rejects.toMatchObject({
      code: 'WORDS_DISABLED',
      message: "A letter's words can't be changed in place yet. Make a new preview with the words you want."
    });
    expect(getDraftForStationery).not.toHaveBeenCalled();
  });

  it.each([
    ['a draft id of the wrong shape', null, { draftId: 'not-a-draft' }, 'DRAFT_NOT_FOUND'],
    ['a draft that is not there, or not the caller\'s', null, {}, 'DRAFT_NOT_FOUND'],
    ['a postcard', { mail_type: 'postcard' }, {}, 'DRAFT_NOT_A_LETTER'],
    ['a sent draft', { status: 'consumed' }, {}, 'DRAFT_ALREADY_SENT'],
    ['an expired draft', { expires_at: NOW }, {}, 'DRAFT_EXPIRED'],
    ['a draft an erasure emptied', { redacted_at: NOW }, {}, 'DRAFT_EXPIRED'],
    ['a preview the legacy HTML drew', { renderer_version: null }, {}, 'DRAFT_NOT_DRAWN'],
    ['a stored preview with fewer pages than it counts', { pages: 2 }, {}, 'DRAFT_NOT_DRAWN']
  ])('refuses %s, writing nothing', async (_label, overrides, input, code) => {
    vi.mocked(getDraftForStationery).mockResolvedValue(overrides ? ({ ...draft({ bodyText: lines(10) }), ...overrides } as never) : null);
    const ctx = context();
    await expect(handler({ draftId: DRAFT_ID, bodyText: lines(4), signOff: 'Pat', wordsVersion: await versionNow(), ...input }, ctx)).rejects.toMatchObject({ code });
    expect(setDraftWords).not.toHaveBeenCalled();
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'draft.words_refused', reason: code }), expect.any(String));
  });

  it.each([
    ['not_found', 'DRAFT_NOT_FOUND'],
    ['sent', 'DRAFT_ALREADY_SENT'],
    ['expired', 'DRAFT_EXPIRED'],
    ['checkout_pending', 'DRAFT_CHECKOUT_PENDING'],
    ['changed', 'DRAFT_CHANGED']
  ] as const)('says why when the draft changed under the lock: %s', async (refusal, code) => {
    vi.mocked(getDraftForStationery).mockResolvedValue(draft({ bodyText: lines(10) }) as never);
    vi.mocked(setDraftWords).mockResolvedValue(refusal);
    await expect(change(lines(4))).rejects.toMatchObject({ code });
  });

  it('logs how long the words are, never the words', async () => {
    vi.mocked(getDraftForStationery).mockResolvedValue(draft({ bodyText: lines(10) }) as never);
    const ctx = context();
    await change('Dear Sam, a secret about the garden.', ctx);
    expect(ctx.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'draft.words_changed', pages: 1, pagesBefore: 1, characters: 36 + 9 }),
      expect.any(String)
    );
    const logged = JSON.stringify([vi.mocked(ctx.logger.info).mock.calls, vi.mocked(ctx.logger.warn).mock.calls]);
    expect(logged).not.toContain('secret');
  });

  it('gives the card its page and how full it is in _meta, never the model', async () => {
    vi.mocked(getDraftForStationery).mockResolvedValue(draft({ bodyText: lines(10) }) as never);
    const output = await change(lines(40));
    const { structuredContent, _meta } = partitionToolResult(output);
    expect(structuredContent).not.toHaveProperty('previewHtml');
    expect(structuredContent).not.toHaveProperty('pageFit');
    expect(_meta).toMatchObject({ previewHtml: output.previewHtml, pageFit: output.pageFit });
    expect(structuredContent).toMatchObject({ draftId: DRAFT_ID, pages: 2, canSendNow: false });
  });

  it('versions the words by both their parts, and the same words alike', () => {
    expect(wordsVersionOf('Dear Sam,', 'Pat')).toBe(wordsVersionOf('Dear Sam,', 'Pat'));
    expect(wordsVersionOf('Dear Sam,', 'Pat')).not.toBe(wordsVersionOf('Dear Sam!', 'Pat'));
    expect(wordsVersionOf('Dear Sam,', 'Pat')).not.toBe(wordsVersionOf('Dear Sam,', 'Love, Pat'));
    // A sign-off stored as none is the empty one the card and the model give.
    expect(wordsVersionOf('Dear Sam,', null)).toBe(wordsVersionOf('Dear Sam,', ''));
    // The parts are kept apart: moving text between them is a change.
    expect(wordsVersionOf('Dear Sam, Pat', '')).not.toBe(wordsVersionOf('Dear Sam,', ' Pat'));
  });

  it('is card-callable, idempotent and not read-only', () => {
    expect(setLetterWordsTool.meta).toMatchObject({ 'openai/widgetAccessible': true, readOnlyHint: false, idempotentHint: true });
  });
});
