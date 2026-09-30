/**
 * Letter previews drawn by our own renderer (#534), behind
 * LETTER_IRL_PRINT_RENDERER=pdf: the preview is the page as it prints, the
 * draft records the renderer's version, the page is measured rather than
 * estimated, and the text is checked against the renderer's font while the
 * addresses keep PostGrid's Open Sans. Without the flag, previews are the
 * legacy HTML, unchanged.
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

vi.mock('../../../src/services/commerceService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/commerceService.js')>()),
  getSendEligibility: vi.fn()
}));

import { getLetterProvider } from '../../../src/services/providers/index.js';
import { createDraft } from '../../../src/services/draftService.js';
import { getRecentUploadedImage } from '../../../src/services/recentUploadStore.js';
import { getReturnAddress } from '../../../src/services/returnAddressService.js';
import { downloadAndProcessLetterImageWithPreview } from '../../../src/services/imageService.js';
import { getGiftBalance } from '../../../src/services/giftLetterService.js';
import { getSendEligibility } from '../../../src/services/commerceService.js';
import { quoteAndPreviewLetterTextOnlyTool } from '../../../src/tools/quoteAndPreviewLetterTextOnly.js';
import { quoteAndPreviewLetterWithHeaderImageTool } from '../../../src/tools/quoteAndPreviewLetterWithHeaderImage.js';
import { quoteAndPreviewLetterWithImageTool } from '../../../src/tools/quoteAndPreviewLetterWithImage.js';
import { RENDERED_LETTER_CHARACTER_CAP } from '../../../src/tools/letterHelpers.js';
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
      "can't print some characters"
    );
  });
});

describe('a gift send', () => {
  beforeEach(() => {
    vi.stubEnv('LETTER_IRL_GIFT_LETTERS_ENABLED', 'true');
    vi.mocked(getGiftBalance).mockResolvedValue({ available: 1, next: { giftId: 'gift-1', cardState: 'funded' } } as never);
  });

  it('is previewed and printed on the legacy HTML, with its card, until the gift page moves over', async () => {
    const output = await run('text_only', { sendAsGift: true });
    const draft = drafted();
    expect(draft.isGiftSend).toBe(true);
    expect(draft.rendererVersion).toBeUndefined();
    expect(draft.previewHtml).toContain("font-family: 'Times New Roman'");
    // None of our renderer's glyphs, and no hidden text for the card.
    expect(draft.previewHtml).not.toMatch(/#tr12-\d+/);
    expect(draft.previewHtml).not.toContain('<div hidden>');
    expect(output.giftCard).toMatchObject({ state: 'funded' });
  });

  it("is held to the legacy print's limits", async () => {
    const body = Array.from({ length: 24 }, () => 'the quick brown fox jumps over the lazy dog and keeps on running far').join('\n');
    await expect(run('text_only', { bodyText: body, sendAsGift: true })).rejects.toThrow('Letter exceeds');
    expect(createDraft).not.toHaveBeenCalled();
  });

  it("and to Open Sans for its text", async () => {
    await expect(run('text_only', { bodyText: `A well${String.fromCodePoint(0x2011)}known road`, sendAsGift: true })).rejects.toThrow(
      "can't print some characters"
    );
    expect(createDraft).not.toHaveBeenCalled();
  });
});
