/**
 * Letter previews drawn by our own renderer (#534), behind
 * LETTER_IRL_PRINT_RENDERER=pdf: the preview is the page as it prints, the
 * draft records the renderer's version, the page is measured rather than
 * estimated, and the text is checked against the renderer's font while the
 * addresses keep PostGrid's Open Sans. A gift send's card is the second
 * page. Without the flag, previews are the legacy HTML, unchanged.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/providers/index.js', () => ({
  getLetterProvider: vi.fn()
}));

vi.mock('../../../src/services/draftService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/draftService.js')>()),
  createDraft: vi.fn()
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
import { createDraft } from '../../../src/services/draftService.js';
import { getRecentUploadedImage } from '../../../src/services/recentUploadStore.js';
import { getReturnAddress } from '../../../src/services/returnAddressService.js';
import { downloadAndProcessLetterImageWithPreview } from '../../../src/services/imageService.js';
import { getGiftBalance, sampleFundedCard } from '../../../src/services/giftLetterService.js';
import { getSendEligibility } from '../../../src/services/commerceService.js';
import { rememberedStationery, rememberStationery } from '../../../src/services/stationeryDefaultService.js';
import { quoteAndPreviewLetterTextOnlyTool } from '../../../src/tools/quoteAndPreviewLetterTextOnly.js';
import { quoteAndPreviewLetterWithHeaderImageTool } from '../../../src/tools/quoteAndPreviewLetterWithHeaderImage.js';
import { quoteAndPreviewLetterWithImageTool } from '../../../src/tools/quoteAndPreviewLetterWithImage.js';
import {
  createLetterDraftAndBuildOutput,
  layoutLetterForPreview,
  RENDERED_LETTER_CHARACTER_CAP
} from '../../../src/tools/letterHelpers.js';
import { printRenderer } from '../../../src/config/printRenderer.js';
import type { Address, ToolContext } from '../../../src/contracts/types.js';

const PROVIDER_REACHED = new Error('the provider was reached');

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

// The processed images at 300 dpi: 6.5 x 2 in for a header, 6.5 x 3 in enclosed.
const FULL = { header_image: png(1950, 600), inline_image: png(1950, 900) };
const SMALL = { header_image: png(390, 120), inline_image: png(390, 180) };

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

/** `count` short lines, each one printed line. */
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

/** The draft's fields, from the one createDraft call. */
function drafted() {
  expect(createDraft).toHaveBeenCalledTimes(1);
  return vi.mocked(createDraft).mock.calls[0][0];
}

let processedLayout: keyof typeof FULL = 'header_image';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('LETTER_IRL_PRINT_RENDERER', 'pdf');
  // No provider address check: a preview goes straight on to its draft.
  vi.mocked(getLetterProvider).mockReturnValue({} as never);
  vi.mocked(createDraft).mockResolvedValue({ draftId: 'draft-1', expiresAt: new Date('2026-10-01T12:00:00Z') });
  vi.mocked(getRecentUploadedImage).mockResolvedValue(null);
  vi.mocked(getReturnAddress).mockResolvedValue(null);
  vi.mocked(getGiftBalance).mockResolvedValue({ available: 0, next: undefined } as never);
  vi.mocked(getSendEligibility).mockReturnValue({
    payAndSend: { available: true, amountCents: 499 },
    letterPack: { available: true, purchaseUrl: 'https://letterirl.com/pricing' }
  } as never);
  vi.mocked(downloadAndProcessLetterImageWithPreview).mockImplementation(async () => ({
    base64DataUri: FULL[processedLayout],
    previewDataUri: SMALL[processedLayout],
    originalWidth: 1950,
    originalHeight: 600,
    processedWidth: 1950,
    processedHeight: 600
  }) as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the flag', () => {
  it('is pdf only when it says pdf; anything else is the legacy HTML', () => {
    expect(printRenderer({ LETTER_IRL_PRINT_RENDERER: 'pdf' })).toBe('pdf');
    expect(printRenderer({ LETTER_IRL_PRINT_RENDERER: ' PDF ' })).toBe('pdf');
    expect(printRenderer({ LETTER_IRL_PRINT_RENDERER: 'html' })).toBe('html');
    expect(printRenderer({ LETTER_IRL_PRINT_RENDERER: 'true' })).toBe('html');
    expect(printRenderer({})).toBe('html');
  });

  it('leaves previews on the legacy HTML, with no version, when it is off', async () => {
    vi.stubEnv('LETTER_IRL_PRINT_RENDERER', '');
    const output = await run('text_only');
    const draft = drafted();
    expect(draft.rendererVersion).toBeUndefined();
    expect(draft.previewHtml).toContain("font-family: 'Times New Roman'");
    expect(draft.previewHtml).not.toContain('<svg');
    expect(output.previewHtml).toBe(draft.previewHtml);
  });
});

describe('a preview drawn by our renderer', () => {
  it('records pdf-1 and stores the page as SVG, the same one the card gets', async () => {
    const output = await run('text_only', { bodyText: 'Dear Sam,\n\nThank you for the jam.', signOff: 'Love, Pat' });
    const draft = drafted();
    expect(draft.rendererVersion).toBe('pdf-1');
    const html = draft.previewHtml!;
    expect(html.match(/<svg /g)).toHaveLength(1);
    expect(html).toContain('viewBox="0 0 612 792"');
    // Each printed line is spoken in the SVG's title (a blank line draws
    // nothing), and drawn as outlines.
    expect(html).toContain('<title>Dear Sam,\nThank you for the jam.\nLove, Pat</title>');
    expect(html).toMatch(/<use href="#tr12-\d+"/);
    expect(output.previewHtml).toBe(html);
    // The addresses as sent, where PostGrid stamps them, in upper case.
    expect([...html.matchAll(/<text x="[\d.]+" y="[\d.]+">([^<]*)<\/text>/g)].map(match => match[1])).toEqual([
      'PAT EXAMPLE', '350 FIFTH AVE', 'NEW YORK, NY 10118',
      'SAM RIVERA', '350 FIFTH AVE', 'NEW YORK, NY 10118'
    ]);
    expect(html).toContain('<body data-renderer="pdf-1">');
  });

  it('keeps the text, hidden, where the letter card reads it', async () => {
    await run('text_only', { bodyText: 'Dear Sam,\n<b>& thanks</b>\n\n', signOff: 'Pat' });
    const html = drafted().previewHtml!;
    const hidden = html.slice(html.indexOf('<div hidden>'));
    expect(hidden).toContain('<div class="letter-body">Dear Sam,\n&lt;b&gt;&amp; thanks&lt;/b&gt;</div>');
    expect(hidden).toContain('<div class="sign-off">Pat</div>');
    // The card takes the first match of each: the hidden copy is the only one.
    expect(html.indexOf('class="letter-body"')).toBe(html.lastIndexOf('class="letter-body"'));
  });

  it.each([
    ['header_image', 'the image above the text', 216],
    ['inline_image', 'the image after the text', undefined]
  ] as const)('draws %s at the printed size, from the small copy', async (layout, _what, top) => {
    processedLayout = layout;
    await run(layout, { bodyText: lines(3) });
    const html = drafted().previewHtml!;
    const image = html.match(/<image href="([^"]+)" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/)!;
    expect(image[1]).toBe(SMALL[layout]);
    expect(html).not.toContain(FULL[layout]);
    // The printed image's box: the full width, at its capped height.
    expect([Number(image[4]), Number(image[5])]).toEqual([468, layout === 'header_image' ? 144 : 216]);
    if (top !== undefined) expect(Number(image[3])).toBe(top);
  });
});

describe('the page is measured', () => {
  it.each([
    ['text_only', 26],
    ['header_image', 16],
    ['inline_image', 13]
  ] as const)('accepts %s at its %i lines, and refuses one more with the count', async (layout, holds) => {
    processedLayout = layout === 'text_only' ? 'header_image' : layout;
    // The sign-off prints on the last line.
    await expect(run(layout, { bodyText: lines(holds - 1) })).resolves.toMatchObject({ draftId: 'draft-1' });

    vi.mocked(createDraft).mockClear();
    vi.mocked(getLetterProvider).mockClear();
    vi.mocked(getLetterProvider).mockImplementation(() => {
      throw PROVIDER_REACHED;
    });
    const ctx = context();
    const error = await run(layout, { bodyText: lines(holds) }, ctx).catch(e => e);
    expect(error.message).toMatch(
      new RegExp(`^Letter is 1 line too long for one page(.*): it takes ${holds + 1} lines and the page holds ${holds}\\. Please shorten`)
    );
    expect(error).toMatchObject({ diagnosticClass: 'validation_error' });
    // Before the addresses are checked or a draft is made.
    expect(getLetterProvider).not.toHaveBeenCalled();
    expect(createDraft).not.toHaveBeenCalled();
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'quote.letter.exceeds_page', linesUsed: holds + 1, linesAvailable: holds }),
      expect.any(String)
    );
  });

  it('says how many lines over, in the plural', async () => {
    await expect(run('text_only', { bodyText: lines(30) })).rejects.toThrow(
      'Letter is 5 lines too long for one page: it takes 31 lines and the page holds 26.'
    );
  });

  it('names the layout in the refusal', async () => {
    processedLayout = 'header_image';
    await expect(run('header_image', { bodyText: lines(20) })).rejects.toThrow('too long for one page with a header image:');
    processedLayout = 'inline_image';
    await expect(run('inline_image', { bodyText: lines(20) })).rejects.toThrow('too long for one page with an enclosed image:');
  });

  it("no longer applies the legacy estimate: a letter the estimate refuses, but that fits, is accepted", async () => {
    // 24 lines of 68 characters: over the legacy 1,600-character limit and
    // its 65-characters-a-line estimate, but each fits one printed line.
    const body = Array.from({ length: 24 }, () => 'the quick brown fox jumps over the lazy dog and keeps on running far').join('\n');
    expect(body.length).toBeGreaterThan(1600);
    await expect(run('text_only', { bodyText: body })).resolves.toMatchObject({ draftId: 'draft-1' });
    expect(drafted().rendererVersion).toBe('pdf-1');

    vi.stubEnv('LETTER_IRL_PRINT_RENDERER', 'html');
    await expect(run('text_only', { bodyText: body })).rejects.toThrow('Letter exceeds');
  });

  it('refuses a letter over the character cap before anything else', async () => {
    const body = 'a'.repeat(RENDERED_LETTER_CHARACTER_CAP);
    await expect(run('text_only', { bodyText: body, signOff: 'P' })).rejects.toThrow(
      `Letter is far too long for one page: ${RENDERED_LETTER_CHARACTER_CAP + 1}/${RENDERED_LETTER_CHARACTER_CAP} characters.`
    );
    expect(createDraft).not.toHaveBeenCalled();
  });
});

describe('what the renderer can print', () => {
  // U+2011, the non-breaking hyphen: Tinos draws it, Open Sans prints a box.
  const NB_HYPHEN = String.fromCodePoint(0x2011);
  const ACUTE = String.fromCodePoint(0x301);

  it('accepts text in the font it prints in, which Open Sans could not print', async () => {
    await expect(run('text_only', { bodyText: `A well${NB_HYPHEN}known road` })).resolves.toMatchObject({ draftId: 'draft-1' });

    vi.stubEnv('LETTER_IRL_PRINT_RENDERER', 'html');
    await expect(run('text_only', { bodyText: `A well${NB_HYPHEN}known road` })).rejects.toThrow("can't print some characters");
  });

  it('still refuses an address PostGrid would stamp as a box', async () => {
    await expect(run('text_only', { recipient: address({ name: `Sam${NB_HYPHEN}Rivera` }) })).rejects.toThrow(
      "in the recipient's address"
    );
    expect(createDraft).not.toHaveBeenCalled();
  });

  it('refuses what the font has no glyph for', async () => {
    await expect(run('text_only', { bodyText: 'Happy birthday! \u{1F389}' })).rejects.toThrow(
      "Letter IRL can't print some characters in this letter: \u{1F389} in the text."
    );
  });

  it('refuses a letter carrying more than four marks, rather than dropping one', async () => {
    await expect(run('text_only', { bodyText: `Caf${'e' + ACUTE.repeat(4)}` })).resolves.toMatchObject({ draftId: 'draft-1' });
    await expect(run('text_only', { bodyText: `Caf${'e' + ACUTE.repeat(5)}` })).rejects.toThrow(
      `${'e' + ACUTE.repeat(5)} (too many marks on one letter) in the text.`
    );
  });

  it('names a character Open Sans prints but Tinos lacks by its code point, not as too many marks', async () => {
    // U+FB00, the ff ligature: on the Open Sans list, missing from Tinos.
    const ff = String.fromCodePoint(0xfb00);
    await expect(run('text_only', { bodyText: `We will sta${ff} it` })).rejects.toThrow(
      `can't print some characters in this letter: ${ff} (U+FB00) in the text.`
    );

    vi.stubEnv('LETTER_IRL_PRINT_RENDERER', 'html');
    await expect(run('text_only', { bodyText: `We will sta${ff} it` })).resolves.toMatchObject({ draftId: 'draft-1' });
  });

  it('refuses a line separator, which the font draws as a box, and names it (review round 1)', async () => {
    // Apple Notes and Pages store a soft line break as U+2028.
    const lineSeparator = String.fromCodePoint(0x2028);
    await expect(run('text_only', { bodyText: `Dear Sam,${lineSeparator}See you soon.` })).rejects.toThrow(
      "can't print some characters in this letter: a line separator (U+2028) in the text."
    );
    // And a nul, which PostgreSQL would refuse to store, before the draft.
    await expect(run('text_only', { bodyText: `Dear Sam,${String.fromCodePoint(0)}` })).rejects.toThrow(
      'a control character (U+0000) in the text.'
    );
    expect(createDraft).not.toHaveBeenCalled();
  });
});

describe('a gift send', () => {
  // U+2011, which Tinos draws and Open Sans prints as a box; U+FB00, the
  // reverse: the card and the letter print in Tinos, the addresses in Open Sans.
  const NB_HYPHEN = String.fromCodePoint(0x2011);
  const FF = String.fromCodePoint(0xfb00);
  const pages = (html: string) => html.match(/<svg [\s\S]*?<\/svg>/g) ?? [];

  beforeEach(() => {
    vi.stubEnv('LETTER_IRL_GIFT_LETTERS_ENABLED', 'true');
    vi.mocked(getGiftBalance).mockResolvedValue({ available: 1, next: { giftId: 'gift-1', cardState: 'funded' } } as never);
  });

  it('is previewed on our renderer, its card the second page as it prints (#534 PR 5)', async () => {
    const output = await run('text_only', { sendAsGift: true });
    const draft = drafted();
    expect(draft.isGiftSend).toBe(true);
    expect(draft.rendererVersion).toBe('pdf-1');
    const html = draft.previewHtml!;
    expect(output.previewHtml).toBe(html);
    const [letter, card] = pages(html);
    expect(pages(html)).toHaveLength(2);
    expect(letter).toContain('<title>Dear Sam,\nPat</title>');
    // The card: its border, the QR's modules, the sender's name, and the
    // placeholder where the code the send mints will print.
    expect(card).toContain('rx="12" fill="none" stroke="#1f1a15" stroke-width="1.5"/>');
    expect(card).toMatch(/<g fill="#000">(<rect [^>]*\/>)+<\/g>/);
    expect(card).toContain('<title>A GIFT INSIDE THIS LETTER\nA letter for you to send\nPat Example sent this letter');
    expect(card).toContain(`\n${'\u2022'.repeat(4)}-${'\u2022'.repeat(4)}\n`);
    // PostGrid stamps the addresses on the first page only.
    expect(letter).toContain('<text');
    expect(card).not.toContain('<text');
    expect(output.giftCard).toMatchObject({ state: 'funded' });
  });

  it.each(['header_image', 'inline_image'] as const)('is previewed the same way with %s', async layout => {
    processedLayout = layout;
    await run(layout, { bodyText: lines(3), sendAsGift: true });
    const draft = drafted();
    expect(draft.rendererVersion).toBe('pdf-1');
    expect(pages(draft.previewHtml!)).toHaveLength(2);
  });

  it('draws the card a spent budget prints', async () => {
    vi.mocked(getGiftBalance).mockResolvedValue({ available: 1, next: { giftId: 'gift-1', cardState: 'unfunded' } } as never);
    await run('text_only', { sendAsGift: true });
    const card = pages(drafted().previewHtml!)[1];
    expect(card).toContain('<title>SENT WITH LETTER IRL\nThis letter began as a conversation\nPat Example wrote it');
  });

  it("meets the renderer's limits, not the legacy print's", async () => {
    // Under a header image the page holds 16 lines; the legacy print took 17.
    processedLayout = 'header_image';
    await expect(run('header_image', { bodyText: lines(16), sendAsGift: true })).rejects.toThrow(
      'Letter is 1 line too long for one page with a header image: it takes 17 lines and the page holds 16.'
    );
    expect(createDraft).not.toHaveBeenCalled();

    // Over the legacy estimate, but every line fits the page.
    const body = Array.from({ length: 24 }, () => 'the quick brown fox jumps over the lazy dog and keeps on running far').join('\n');
    await expect(run('text_only', { bodyText: body, sendAsGift: true })).resolves.toMatchObject({ draftId: 'draft-1' });
    expect(drafted().rendererVersion).toBe('pdf-1');
  });

  it("and the renderer's font: what Tinos draws prints, what it lacks is refused", async () => {
    await expect(run('text_only', { bodyText: `A well${NB_HYPHEN}known road`, sendAsGift: true })).resolves
      .toMatchObject({ draftId: 'draft-1' });
    await expect(run('text_only', { bodyText: `We will sta${FF} it`, sendAsGift: true })).rejects.toThrow(
      `${FF} (U+FB00) in the text.`
    );
  });

  it.each(['text_only', 'header_image', 'inline_image'] as const)("refuses a sender's name the card cannot draw (%s), and says where it prints", async layout => {
    processedLayout = layout === 'inline_image' ? layout : 'header_image';
    // Open Sans stamps the ligature in the return address; Tinos, which
    // draws the card's "Pat ... sent this letter", has no glyph for it.
    const sender = address({ name: `Pat Sta${FF}ord` });
    const error = await run(layout, { sender, sendAsGift: true }).catch(e => e);
    expect(error.message).toContain(
      `can't print some characters in this letter: ${FF} (U+FB00) in the sender's name, which the gift card prints.`
    );
    expect(error).toMatchObject({ diagnosticClass: 'validation_error' });
    expect(createDraft).not.toHaveBeenCalled();
    expect(downloadAndProcessLetterImageWithPreview).not.toHaveBeenCalled();

    // Without a card, the name is only stamped, in Open Sans, which prints it.
    await expect(run(layout, { sender })).resolves.toMatchObject({ draftId: 'draft-1' });
    expect(drafted().isGiftSend).toBe(false);

    // And on the legacy HTML the card prints in Open Sans too.
    vi.mocked(createDraft).mockClear();
    vi.stubEnv('LETTER_IRL_PRINT_RENDERER', 'html');
    await expect(run(layout, { sender, sendAsGift: true })).resolves.toMatchObject({ draftId: 'draft-1' });
    expect(drafted().rendererVersion).toBeUndefined();
  });

  it.each(['text_only', 'header_image', 'inline_image'] as const)("refuses a sender's name too long for the card (%s), before the picture is fetched", async layout => {
    processedLayout = layout === 'inline_image' ? layout : 'header_image';
    const sender = address({ name: 'Pat Example '.repeat(125).trim() });
    const ctx = context();
    const error = await run(layout, { sender, sendAsGift: true }, ctx).catch(e => e);
    expect(error.message).toBe("The sender's name is too long to print on the gift card. Shorten it, then preview again.");
    expect(error).toMatchObject({ diagnosticClass: 'validation_error' });
    expect(createDraft).not.toHaveBeenCalled();
    expect(downloadAndProcessLetterImageWithPreview).not.toHaveBeenCalled();
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'quote.letter.gift_card_overflow', overflowPoints: expect.any(Number) }),
      expect.any(String)
    );

    // The legacy HTML flows the card onto as many pages as it takes.
    vi.stubEnv('LETTER_IRL_PRINT_RENDERER', 'html');
    await expect(run(layout, { sender, sendAsGift: true })).resolves.toMatchObject({ draftId: 'draft-1' });
  });

  it("adds the card to the page the tool measured, leaving the tool's layout as it was", async () => {
    const ctx = context();
    const letter = { bodyText: 'Dear Sam,', signOff: 'Pat', layoutType: 'text_only' as const };
    const printLayout = layoutLetterForPreview(letter, ctx, 'pdf')!;
    await createLetterDraftAndBuildOutput({
      ...letter,
      sender: address({ name: 'Pat Example' }),
      recipient: address(),
      usedSavedReturnAddress: false,
      gift: { isGift: true, card: sampleFundedCard(), giftLettersAvailable: 1 },
      printLayout,
      context: ctx
    });
    expect(drafted().rendererVersion).toBe('pdf-1');
    expect(pages(drafted().previewHtml!)).toHaveLength(2);
    expect(printLayout.pages).toHaveLength(1);
  });
});

describe('stationery (#563)', () => {
  const pages = (html: string) => html.match(/<svg [\s\S]*?<\/svg>/g) ?? [];
  /** The strokes a theme draws in its ink: the sprig, the monogram's rings. */
  const inked = (html: string) => html.match(/<path d="M[^"]*" fill="none" stroke="#222222"/g) ?? [];
  const LAYOUTS = ['text_only', 'header_image', 'inline_image'] as const;

  beforeEach(() => {
    vi.stubEnv('LETTER_IRL_STATIONERY_ENABLED', 'true');
    vi.mocked(rememberedStationery).mockResolvedValue(null);
    vi.mocked(rememberStationery).mockResolvedValue(undefined);
  });

  it.each(LAYOUTS)('%s: a theme draws the page in it, records pdf-2 with the stationery, and says so', async layout => {
    processedLayout = layout === 'text_only' ? 'header_image' : layout;
    const output = await run(layout, { stationery: 'Botanical' });
    const draft = drafted();
    // The preview's day in New York: 08:00 on September 30.
    const botanical = { theme: 'botanical', dateLine: 'September 30, 2026', source: 'asked' };
    expect(draft.rendererVersion).toBe('pdf-2');
    expect(draft.stationery).toEqual(botanical);
    expect(output.stationery).toEqual(botanical);
    // Asked for, so remembered for the next preview, once the draft exists.
    expect(rememberStationery).toHaveBeenCalledWith('user-1', 'botanical');
    expect(vi.mocked(rememberStationery).mock.invocationCallOrder[0]).toBeGreaterThan(vi.mocked(createDraft).mock.invocationCallOrder[0]);
    const html = draft.previewHtml!;
    expect(output.previewHtml).toBe(html);
    expect(inked(html).length).toBeGreaterThan(0);
    expect(html).toContain('<title>September 30, 2026\nDear Sam,\nPat</title>');
    expect(html).toContain('<body data-renderer="pdf-2">');
  });

  it.each(LAYOUTS)('%s: Classic is the page as before, recording pdf-1, and says Classic', async layout => {
    processedLayout = layout === 'text_only' ? 'header_image' : layout;
    const output = await run(layout, { stationery: 'classic' });
    const classic = drafted();
    expect(classic.rendererVersion).toBe('pdf-1');
    expect(output.stationery).toEqual({ theme: 'classic', source: 'asked' });
    // Classic, asked for, is remembered like any theme.
    expect(rememberStationery).toHaveBeenCalledWith('user-1', 'classic');
    expect(inked(classic.previewHtml!)).toEqual([]);

    // Exactly the page the previews drew before stationery, with the flag off.
    vi.mocked(createDraft).mockClear();
    vi.stubEnv('LETTER_IRL_STATIONERY_ENABLED', '');
    const before = await run(layout);
    expect(drafted().previewHtml).toBe(classic.previewHtml);
    expect(before).not.toHaveProperty('stationery');
  });

  it("a monogram prints the return address's initials, or the ones asked for", async () => {
    const output = await run('text_only', { stationery: 'monogram' });
    expect(output.stationery).toEqual({ theme: 'monogram', dateLine: 'September 30, 2026', monogram: 'PE', source: 'asked' });
    expect(drafted().previewHtml).toContain('<title>September 30, 2026\nPE\nDear Sam,\nPat</title>');
    // Its double ring.
    expect(inked(drafted().previewHtml!)).toHaveLength(2);

    vi.mocked(createDraft).mockClear();
    await run('text_only', { stationery: 'monogram', monogram: 'J. M. S.' });
    expect(drafted().stationery).toMatchObject({ monogram: 'JMS' });
  });

  it("a monogram takes the saved return address's initials when the call names no sender (review round 1)", async () => {
    vi.mocked(getReturnAddress).mockResolvedValue(address({ name: 'Dr. Ada Byron Lovelace' }) as never);
    const handler = quoteAndPreviewLetterTextOnlyTool.handler as unknown as Handler;
    const output = await handler({ recipient: address(), bodyText: 'Dear Sam,', signOff: 'Ada', stationery: 'monogram' }, context());
    expect(output.usedSavedReturnAddress).toBe(true);
    expect(output.stationery).toMatchObject({ theme: 'monogram', monogram: 'ABL' });
  });

  it('refuses a headline in characters the font cannot draw for them, not as too long (review round 1)', async () => {
    const han = String.fromCodePoint(0x4e2d).repeat(60);
    await expect(run('text_only', { stationery: 'celebration', headline: han })).rejects.toThrow(/can't print some characters in this letter: .* in the headline/);
    expect(createDraft).not.toHaveBeenCalled();
  });

  it('a headline prints above the letter, three lines of its page', async () => {
    const output = await run('text_only', { stationery: 'celebration', headline: '  Happy   Birthday, Sam! ' });
    expect(output.stationery).toEqual({ theme: 'celebration', dateLine: 'September 30, 2026', headline: 'Happy Birthday, Sam!', source: 'asked' });
    expect(drafted().previewHtml).toContain('<title>September 30, 2026\nHappy Birthday, Sam!\nDear Sam,\nPat</title>');
  });

  it('refuses a letter the headline pushes past its page, saying so and the ways out, before any draft', async () => {
    // 24 lines: the page holds 26 in Classic, and 23 below a headline.
    await expect(run('text_only', { stationery: 'celebration', bodyText: lines(23) })).resolves.toMatchObject({ draftId: 'draft-1' });
    vi.mocked(createDraft).mockClear();

    const ctx = context();
    const error = await run('text_only', { stationery: 'celebration', headline: 'Happy Birthday!', bodyText: lines(23) }, ctx).catch(e => e);
    expect(error.message).toBe(
      'Letter is 1 line too long for one page on the celebration stationery with a headline: it takes 24 lines and the page holds 23. ' +
        'The headline takes 3 lines: shorten the message, leave the headline out, or choose the classic stationery.'
    );
    expect(error).toMatchObject({ diagnosticClass: 'validation_error' });
    expect(createDraft).not.toHaveBeenCalled();
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'quote.letter.exceeds_page', linesUsed: 24, linesAvailable: 23, stationery: 'celebration' }),
      expect.any(String)
    );

    // Without a headline the theme holds what Classic does, and says nothing of it.
    await expect(run('text_only', { stationery: 'botanical', bodyText: lines(26) })).rejects.toThrow(
      /^Letter is 1 line too long for one page: it takes 27 lines and the page holds 26\. Please shorten your message to fit on one page\.$/
    );
  });

  it('refuses initials and a headline the font cannot draw, naming where, before any draft', async () => {
    const CAKE = String.fromCodePoint(0x1f382);
    await expect(run('text_only', { stationery: 'celebration', headline: `Happy Birthday ${CAKE}` })).rejects.toThrow(/in the headline/);
    const MIDDLE = String.fromCodePoint(0x4e2d);
    await expect(run('text_only', { stationery: 'monogram', monogram: MIDDLE })).rejects.toThrow(/in the monogram's initials/);
    expect(createDraft).not.toHaveBeenCalled();
  });

  it("prints a themed gift send's page in its theme, then today's card page", async () => {
    vi.stubEnv('LETTER_IRL_GIFT_LETTERS_ENABLED', 'true');
    vi.mocked(getGiftBalance).mockResolvedValue({ available: 1, next: { giftId: 'gift-1', cardState: 'funded' } } as never);
    await run('text_only', { stationery: 'botanical', sendAsGift: true });
    const draft = drafted();
    expect(draft.isGiftSend).toBe(true);
    expect(draft.rendererVersion).toBe('pdf-2');
    const [letter, card] = pages(draft.previewHtml!);
    expect(pages(draft.previewHtml!)).toHaveLength(2);
    expect(inked(letter).length).toBeGreaterThan(0);
    expect(inked(card)).toEqual([]);
    expect(card).toContain('<title>A GIFT INSIDE THIS LETTER');
  });

  it('is exactly as before while not offered: no stationery said, and a stray theme refused before any draft', async () => {
    for (const [enabled, renderer] of [['', 'pdf'], ['true', 'html']]) {
      vi.stubEnv('LETTER_IRL_STATIONERY_ENABLED', enabled);
      vi.stubEnv('LETTER_IRL_PRINT_RENDERER', renderer);
      vi.mocked(createDraft).mockClear();
      const output = await run('text_only');
      expect(output, `${enabled} ${renderer}`).not.toHaveProperty('stationery');
      expect(drafted().stationery).toBeUndefined();
      expect(drafted().rendererVersion).toBe(renderer === 'pdf' ? 'pdf-1' : undefined);

      vi.mocked(createDraft).mockClear();
      await expect(run('text_only', { stationery: 'botanical' })).rejects.toThrow('Stationery is not available yet.');
      expect(createDraft).not.toHaveBeenCalled();
    }
    // Nothing read or remembered while not offered.
    expect(rememberedStationery).not.toHaveBeenCalled();
    expect(rememberStationery).not.toHaveBeenCalled();
  });

  it.each(LAYOUTS)("%s: draws a preview that asks for no theme in the remembered one, says so, and remembers nothing new (PR 5)", async layout => {
    processedLayout = layout === 'text_only' ? 'header_image' : layout;
    vi.mocked(rememberedStationery).mockResolvedValue('botanical');
    const output = await run(layout);
    expect(rememberedStationery).toHaveBeenCalledWith('user-1');
    expect(output.stationery).toEqual({ theme: 'botanical', dateLine: 'September 30, 2026', source: 'remembered' });
    expect(drafted().rendererVersion).toBe('pdf-2');
    expect(rememberStationery).not.toHaveBeenCalled();
  });

  it('remembers nothing for a preview it refuses (PR 5)', async () => {
    await expect(run('text_only', { stationery: 'celebration', headline: 'Happy Birthday!', bodyText: lines(23) })).rejects.toThrow('too long');
    expect(rememberStationery).not.toHaveBeenCalled();
  });

  it('still makes the preview when the theme cannot be remembered (PR 5)', async () => {
    vi.mocked(rememberStationery).mockRejectedValue(new Error('connection lost'));
    const ctx = context();
    await expect(run('text_only', { stationery: 'botanical' }, ctx)).resolves.toMatchObject({ draftId: 'draft-1' });
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'quote.stationery_not_remembered' }),
      expect.any(String)
    );
  });
});

describe('Typewriter and Handwritten (#563 PR 8b)', () => {
  const GREEK = String.fromCodePoint(0x03ba, 0x03b1, 0x03bb, 0x03b7, 0x03bc, 0x03ad, 0x03c1, 0x03b1);

  beforeEach(() => {
    vi.stubEnv('LETTER_IRL_STATIONERY_ENABLED', 'true');
    vi.mocked(rememberedStationery).mockResolvedValue(null);
    vi.mocked(rememberStationery).mockResolvedValue(undefined);
  });

  it.each([['typewriter', 'cr11-'], ['handwritten', 'cv15-']] as const)(
    '%s draws the letter in its own typeface, records pdf-2 with the stationery, and remembers it',
    async (theme, glyphs) => {
      const output = await run('text_only', { stationery: theme });
      const draft = drafted();
      const stationery = { theme, dateLine: 'September 30, 2026', source: 'asked' };
      expect(draft.rendererVersion).toBe('pdf-2');
      expect(draft.stationery).toEqual(stationery);
      expect(output.stationery).toEqual(stationery);
      expect(draft.previewHtml).toContain(`id="${glyphs}`);
      expect(draft.previewHtml).not.toContain('id="tr12-');
      expect(rememberStationery).toHaveBeenCalledWith('user-1', theme);
    }
  );

  it("checks the text and sign-off against the theme's typeface, naming the stationery and the way out, before any draft", async () => {
    // Classic and Typewriter print Greek; Handwritten's Caveat has none.
    for (const theme of ['classic', 'typewriter'] as const) {
      await expect(run('text_only', { stationery: theme, bodyText: `Dear Sam, ${GREEK}` })).resolves.toMatchObject({ draftId: 'draft-1' });
    }
    vi.mocked(createDraft).mockClear();
    vi.mocked(rememberStationery).mockClear();
    const ctx = context();
    const error = await run('text_only', { stationery: 'handwritten', bodyText: `Dear Sam, ${GREEK}` }, ctx).catch(e => e);
    // Each Greek letter Caveat lacks, a look-alike shown with its code point.
    expect(error.message.startsWith("Letter IRL can't print some characters in this letter: ")).toBe(true);
    expect(error.message).toContain('(U+03BA)');
    expect(error.message).toContain(' in the text, which the handwritten stationery prints in its own typeface. ');
    expect(error.message.endsWith(
      'The handwritten stationery sets the text in its own typeface, which has fewer: choose another stationery, ' +
        'or take those characters out or write them in plain letters, then preview again.'
    )).toBe(true);
    expect(error).toMatchObject({ diagnosticClass: 'validation_error' });
    await expect(run('text_only', { stationery: 'handwritten', signOff: GREEK })).rejects.toThrow(
      /in the sign-off, which the handwritten stationery prints in its own typeface/
    );
    expect(createDraft).not.toHaveBeenCalled();
    expect(rememberStationery).not.toHaveBeenCalled();
  });

  it("checks a gift card's name in Tinos, which prints the card, whatever face the letter is in", async () => {
    vi.stubEnv('LETTER_IRL_GIFT_LETTERS_ENABLED', 'true');
    vi.mocked(getGiftBalance).mockResolvedValue({ available: 1, next: { giftId: 'gift-1', cardState: 'funded' } } as never);
    // A Greek name: the card (Tinos) and the address stamp (Open Sans) print it; Caveat could not.
    const name = String.fromCodePoint(0x0393, 0x03b9, 0x03ce, 0x03c1, 0x03b3, 0x03bf, 0x03c2);
    await expect(run('text_only', { stationery: 'handwritten', sendAsGift: true, sender: address({ name }) }))
      .resolves.toMatchObject({ draftId: 'draft-1' });
    expect(drafted()).toMatchObject({ isGiftSend: true, stationery: { theme: 'handwritten' } });
  });

  it("says where a theme the call did not name came from, on both refusals (#575 review round 1)", async () => {
    vi.mocked(rememberedStationery).mockResolvedValue('handwritten');
    const greek = await run('text_only', { bodyText: `Dear Sam, ${GREEK}` }).catch(e => e);
    expect(greek.message.startsWith("The account's remembered stationery is handwritten. Letter IRL can't print some characters")).toBe(true);
    expect(greek.message).toMatch(/choose another stationery/);

    vi.mocked(rememberedStationery).mockResolvedValue('typewriter');
    const long = Array.from({ length: 20 }, () => 'All work and no play makes a letter long, and longer still, line after line.').join('\n');
    await expect(run('text_only', { bodyText: long })).rejects.toThrow(
      /^The account's remembered stationery is typewriter\. Letter is \d+ lines too long for one page on the typewriter stationery: /
    );
    // Asked for, it says nothing of where it came from.
    await expect(run('text_only', { stationery: 'typewriter', bodyText: long })).rejects.toThrow(/^Letter is \d+ lines too long/);
    expect(createDraft).not.toHaveBeenCalled();
  });

  it("suggests another stationery only when Classic would print what the theme's face cannot (#575 review round 1)", async () => {
    const CAKE = String.fromCodePoint(0x1f382);
    const error = await run('text_only', { stationery: 'typewriter', bodyText: `Happy birthday ${CAKE}` }).catch(e => e);
    expect(error.message).toContain('in the text, which the typewriter stationery prints in its own typeface');
    expect(error.message).not.toContain('choose another stationery');
    expect(error.message.endsWith('Take those characters out or write them in plain letters, then preview again.')).toBe(true);
    // Greek and an emoji together: Classic would not print them all either.
    const mixed = await run('text_only', { stationery: 'handwritten', bodyText: `${GREEK} ${CAKE}` }).catch(e => e);
    expect(mixed.message).not.toContain('choose another stationery');
  });

  it('says another stationery mends only the text when an address fails too (#575 review round 2)', async () => {
    const CAKE = String.fromCodePoint(0x1f382);
    const error = await run('text_only', {
      stationery: 'handwritten',
      bodyText: `Dear Sam, ${GREEK}`,
      recipient: address({ name: `Sam ${CAKE}` })
    }).catch(e => e);
    expect(error.message).toContain("in the recipient's address");
    expect(error.message.endsWith(
      'The handwritten stationery sets the text in its own typeface, which has fewer: choose another stationery for the text, ' +
        'and take the other characters out or write them in plain letters, then preview again.'
    )).toBe(true);
  });

  it("takes the narrow no-break space and the non-breaking hyphen ChatGPT writes, as Classic does (#575 review round 3)", async () => {
    const text = `Dear Sam, see you at 10${String.fromCodePoint(0x202f)}am at the well${String.fromCodePoint(0x2011)}known spot.`;
    for (const theme of ['classic', 'typewriter', 'handwritten'] as const) {
      vi.mocked(createDraft).mockClear();
      await expect(run('text_only', { stationery: theme, bodyText: text }), theme).resolves.toMatchObject({ draftId: 'draft-1' });
      expect(drafted().previewHtml).not.toMatch(/id="[a-z]+\d+(?:_\d+)?-0"/);
    }
  });

  it('offers the classic stationery for an overflow only when the letter fits it (#575 review round 3)', async () => {
    // Classic holds 26 lines: 28 short lines overflow every stationery.
    await expect(run('text_only', { stationery: 'typewriter', bodyText: lines(27) })).rejects.toThrow(
      /^Letter is \d+ lines? too long for one page on the typewriter stationery: it takes \d+ lines and the page holds 26\. The typewriter stationery sets the text in its own typeface, and the letter runs past the page on the classic stationery too: shorten the message\.$/
    );
    await expect(run('text_only', { stationery: 'celebration', headline: 'Hooray', bodyText: lines(27) })).rejects.toThrow(
      'The headline takes 3 lines, and the letter runs past the page without it too: shorten the message.'
    );
    expect(createDraft).not.toHaveBeenCalled();
  });

  it("says a remembered Celebration was remembered when its headline pushes the letter past the page (#575 review round 3)", async () => {
    vi.mocked(rememberedStationery).mockResolvedValue('celebration');
    await expect(run('text_only', { headline: 'Happy Birthday!', bodyText: lines(23) })).rejects.toThrow(
      /^The account's remembered stationery is celebration\. Letter is 1 line too long for one page on the celebration stationery with a headline: /
    );
  });

  it("says nothing of a remembered theme when only an address cannot print (#575 review round 3)", async () => {
    vi.mocked(rememberedStationery).mockResolvedValue('handwritten');
    const CAKE = String.fromCodePoint(0x1f382);
    const error = await run('text_only', { recipient: address({ name: `Sam ${CAKE}` }) }).catch(e => e);
    expect(error.message.startsWith("Letter IRL can't print some characters in this letter: ")).toBe(true);
    expect(error.message).not.toContain('stationery');
  });

  it("refuses on Handwritten an accent written apart from its letter, saying so, where Classic prints it (#575 review round 4)", async () => {
    const text = `Querida Mari${String.fromCodePoint(0x301)}a,`;
    await expect(run('text_only', { stationery: 'classic', bodyText: text })).resolves.toMatchObject({ draftId: 'draft-1' });
    vi.mocked(createDraft).mockClear();
    const error = await run('text_only', { stationery: 'handwritten', bodyText: text }).catch(e => e);
    expect(error).toMatchObject({ diagnosticClass: 'validation_error' });
    expect(error.message).toContain(
      '(an accent written apart from its letter, which this typeface cannot place: write it as one character, U+00ED) ' +
        'in the text, which the handwritten stationery prints in its own typeface'
    );
    // No one character to name for a letter with two accents (Yoruba).
    const yoruba = await run('text_only', { stationery: 'handwritten', bodyText: `O${String.fromCodePoint(0x323, 0x301)}la` }).catch(e => e);
    expect(yoruba.message).toContain('(an accent written apart from its letter, which this typeface cannot place) in the text');
    expect(error.message).toContain('choose another stationery');
    expect(createDraft).not.toHaveBeenCalled();
  });

  it("keeps the usual closing when only an address, stamped in Open Sans, cannot print", async () => {
    const CAKE = String.fromCodePoint(0x1f382);
    const error = await run('text_only', { stationery: 'handwritten', recipient: address({ name: `Sam ${CAKE}` }) }).catch(e => e);
    expect(error.message).toMatch(/in the recipient's address\. /);
    expect(error.message).toMatch(/Take those characters out or write them in plain letters, then preview again\.$/);
    expect(error.message).not.toContain('stationery');
  });

  it("says a letter the theme's typeface pushes past the page is too long on that stationery, with the ways out", async () => {
    const long = Array.from({ length: 20 }, () => 'All work and no play makes a letter long, and longer still, line after line.').join('\n');
    await expect(run('text_only', { stationery: 'classic', bodyText: long })).resolves.toMatchObject({ draftId: 'draft-1' });
    vi.mocked(createDraft).mockClear();
    await expect(run('text_only', { stationery: 'typewriter', bodyText: long })).rejects.toThrow(
      /^Letter is \d+ lines too long for one page on the typewriter stationery: it takes \d+ lines and the page holds 26\. The typewriter stationery sets the text in its own typeface: shorten the message, or choose the classic stationery\.$/
    );
    expect(createDraft).not.toHaveBeenCalled();
  });
});

describe('a stationery slot the layout cannot fit (#570 review round 2)', () => {
  it('is refused, classed, wherever the layout meets it, not thrown unclassified', () => {
    const han = String.fromCodePoint(0x4e2d).repeat(60);
    const refusal = (() => {
      try {
        layoutLetterForPreview(
          { bodyText: 'Dear Sam,', signOff: 'Pat', layoutType: 'text_only', stationery: { theme: 'celebration', headline: han } },
          context(),
          'pdf'
        );
      } catch (error) {
        return error as Error & { diagnosticClass?: string };
      }
      throw new Error('not refused');
    })();
    expect(refusal.message).toBe("The stationery's headline does not fit. Shorten it, or choose another stationery.");
    expect(refusal.diagnosticClass).toBe('validation_error');
  });
});
