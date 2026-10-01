/**
 * Postcard previews drawn by our own renderer (#534 Phase 4), behind
 * LETTER_IRL_PRINT_RENDERER=pdf: the back is measured as it prints, the
 * message is checked against the renderer's font, and the draft keeps the
 * postcard's front and back as SVG, the addresses where PostGrid stamps them,
 * under the renderer's version. A gift postcard keeps the legacy HTML until
 * its strip moves over. Without the flag, previews are the legacy HTML.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/providers/index.js', () => ({
  getLetterProvider: vi.fn()
}));

vi.mock('../../../src/services/draftService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/draftService.js')>()),
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
import { createPostcardDraft } from '../../../src/services/draftService.js';
import { getRecentUploadedImage } from '../../../src/services/recentUploadStore.js';
import { getReturnAddress } from '../../../src/services/returnAddressService.js';
import { downloadAndProcessPostcardImageWithPreview } from '../../../src/services/imageService.js';
import { getGiftBalance } from '../../../src/services/giftLetterService.js';
import { getSendEligibility } from '../../../src/services/commerceService.js';
import { quoteAndPreviewPostcardTool, RENDERED_POSTCARD_CHARACTER_CAP } from '../../../src/tools/quoteAndPreviewPostcard.js';
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

// The processed front at 300 dpi, 9 x 6in, and its small copy for previews.
const FULL = png(2700, 1800);
const SMALL = png(540, 360);
// U+2011, which Tinos draws and Open Sans prints as a box; U+FB00, the reverse.
const NB_HYPHEN = String.fromCodePoint(0x2011);
const FF = String.fromCodePoint(0xfb00);

function context(): ToolContext {
  return {
    user: { userId: 'user-1', creditsRemaining: 10 } as ToolContext['user'],
    correlationId: 'corr-1',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never,
    now: () => new Date('2026-10-01T12:00:00Z'),
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

const lines = (count: number) => Array.from({ length: count }, (_, index) => `Line ${index + 1}`).join('\n');

type Handler = (input: unknown, ctx: ToolContext) => Promise<Record<string, unknown>>;
function run(input: Record<string, unknown> = {}, ctx: ToolContext = context()) {
  return (quoteAndPreviewPostcardTool.handler as unknown as Handler)(
    {
      sender: address({ name: 'Pat Example', addressLine1: '1600 Pennsylvania Ave NW', city: 'Washington', state: 'DC', postalCode: '20500' }),
      recipient: address(),
      message: 'Greetings from the coast!',
      imageUrl: 'https://files.example/a.jpg',
      ...input
    },
    ctx
  );
}

/** The draft's fields, from the one createPostcardDraft call. */
function drafted() {
  expect(createPostcardDraft).toHaveBeenCalledTimes(1);
  return vi.mocked(createPostcardDraft).mock.calls[0][0];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('LETTER_IRL_PRINT_RENDERER', 'pdf');
  // No provider address check: a preview goes straight on to its draft.
  vi.mocked(getLetterProvider).mockReturnValue({} as never);
  vi.mocked(createPostcardDraft).mockResolvedValue({ draftId: 'draft-1', expiresAt: new Date('2026-10-02T12:00:00Z') });
  vi.mocked(getRecentUploadedImage).mockResolvedValue(null);
  vi.mocked(getReturnAddress).mockResolvedValue(null);
  vi.mocked(getGiftBalance).mockResolvedValue({ available: 0, next: undefined } as never);
  vi.mocked(getSendEligibility).mockReturnValue({
    payAndSend: { available: true, amountCents: 499 },
    letterPack: { available: true, purchaseUrl: 'https://letterirl.com/pricing' }
  } as never);
  vi.mocked(downloadAndProcessPostcardImageWithPreview).mockResolvedValue({
    base64DataUri: FULL,
    previewDataUri: SMALL,
    originalWidth: 2700,
    originalHeight: 1800,
    processedWidth: 2700,
    processedHeight: 1800
  } as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('a postcard preview drawn by our renderer', () => {
  it('records pdf-1 and keeps the front and back as SVG, the small image drawn in the printed box', async () => {
    await run({ message: 'Dear Sam,\nWish you were here.\nPat\n\n' });
    const draft = drafted();
    expect(draft.rendererVersion).toBe('pdf-1');
    // The draft keeps what the print lays out: the message as written and the full image.
    expect(draft.message).toBe('Dear Sam,\nWish you were here.\nPat\n\n');
    expect(draft.frontImageData).toBe(FULL);
    const html = draft.previewHtml!;
    expect(html).toContain('<body data-renderer="pdf-1">');
    const pages = html.match(/<svg [\s\S]*?<\/svg>/g)!;
    expect(pages).toHaveLength(2);
    for (const page of pages) expect(page).toContain('viewBox="0 0 666 450"');
    const [front, back] = pages;
    // The full image's box, covering the page with its bleed, drawn from the small copy.
    expect(front).toContain(`<image href="${SMALL}" x="-4.5" y="0" width="675" height="450" preserveAspectRatio="none"/>`);
    expect(html).not.toContain(FULL);
    expect(back).toContain('<title>Dear Sam,\nWish you were here.\nPat</title>');
    expect(back).toMatch(/<use href="#tr14-\d+"/);
  });

  it('stamps the addresses on the back where PostGrid does, headed RETURN TO:', async () => {
    await run();
    const back = drafted().previewHtml!.match(/<svg [\s\S]*?<\/svg>/g)![1];
    const stamped = [...back.matchAll(/<text x="([\d.]+)" y="([\d.]+)">([^<]*)<\/text>/g)].map(match => [match[3], Number(match[1]), Number(match[2])]);
    expect(stamped).toEqual([
      ['RETURN TO:', 412.2, 68.98],
      ['PAT EXAMPLE', 412.2, 81.72],
      ['1600 PENNSYLVANIA AVE NW', 412.2, 94.46],
      ['WASHINGTON, DC 20500', 412.2, 107.21],
      ['SAM RIVERA', 412.2, 355.46],
      ['350 FIFTH AVE', 412.2, 368.21],
      ['NEW YORK, NY 10118', 412.2, 380.95]
    ]);
    // Never on the front.
    expect(drafted().previewHtml!.match(/<svg [\s\S]*?<\/svg>/g)![0]).not.toContain('<text');
  });

  it("leaves the card's own front and back as they were, the front now landscape", async () => {
    const output = await run();
    expect(output.previewFrontHtml).toContain('class="postcard-front"');
    expect(output.previewFrontHtml).toContain('width: 810px;');
    expect(output.previewFrontHtml).toContain('height: 540px;');
    expect(output.previewBackHtml).toContain('Greetings from the coast!');
  });

  it('measures the back: 16 lines are accepted, 17 refused with the count, before the picture is fetched', async () => {
    await expect(run({ message: lines(16) })).resolves.toMatchObject({ draftId: 'draft-1' });

    vi.mocked(createPostcardDraft).mockClear();
    vi.mocked(downloadAndProcessPostcardImageWithPreview).mockClear();
    const ctx = context();
    const error = await run({ message: lines(17) }, ctx).catch(e => e);
    expect(error.message).toBe(
      'Postcard message is 1 line too long for the back: it takes 17 lines and the back holds 16. ' +
      'Please shorten your message to fit on the postcard back.'
    );
    expect(error).toMatchObject({ diagnosticClass: 'validation_error' });
    expect(downloadAndProcessPostcardImageWithPreview).not.toHaveBeenCalled();
    expect(createPostcardDraft).not.toHaveBeenCalled();
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'quote.postcard.exceeds_back', linesUsed: 17, linesAvailable: 16 }),
      expect.any(String)
    );
    await expect(run({ message: lines(19) })).rejects.toThrow('Postcard message is 3 lines too long for the back');
  });

  it('no longer applies the legacy character limit, only a cap that bounds the work', async () => {
    // 14 lines of 39 characters: over the legacy 500, but each fits one printed line.
    const message = Array.from({ length: 14 }, () => 'the quick brown fox jumps over the lazy').join('\n');
    expect(message.length).toBeGreaterThan(500);
    await expect(run({ message })).resolves.toMatchObject({ draftId: 'draft-1' });
    expect(drafted().rendererVersion).toBe('pdf-1');

    vi.mocked(createPostcardDraft).mockClear();
    expect(RENDERED_POSTCARD_CHARACTER_CAP).toBe(1_000);
    const ctx = context();
    const capped = await run({ message: 'a'.repeat(1_001) }, ctx).catch(e => e);
    expect(capped.message).toContain('Postcard message is too long (1001/1000 characters).');
    expect(capped).toMatchObject({ diagnosticClass: 'validation_error' });
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'quote.postcard.exceeds_character_cap', messageLength: 1_001, maxLength: 1_000 }),
      expect.any(String)
    );
    expect(createPostcardDraft).not.toHaveBeenCalled();

    vi.stubEnv('LETTER_IRL_PRINT_RENDERER', 'html');
    await expect(run({ message })).rejects.toThrow(`Postcard message is too long (${message.length}/500 characters).`);
  });

  it('refuses what cannot print before measuring the back, as a letter does', async () => {
    await expect(run({ message: `${lines(17)} sta${FF}` })).rejects.toThrow(`${FF} (U+FB00) in the message.`);
    expect(downloadAndProcessPostcardImageWithPreview).not.toHaveBeenCalled();
  });

  it('keeps any size but 6x9 on the legacy HTML, as the print draws 6x9 only', async () => {
    await run({ size: '6x4' });
    expect(drafted().rendererVersion).toBeUndefined();
    expect(drafted().previewHtml).not.toContain('data-renderer');
  });

  it("checks the message against the renderer's font, and the addresses against Open Sans", async () => {
    await expect(run({ message: `A well${NB_HYPHEN}known beach` })).resolves.toMatchObject({ draftId: 'draft-1' });
    await expect(run({ message: `We will sta${FF} it` })).rejects.toThrow(`${FF} (U+FB00) in the message.`);
    await expect(run({ recipient: address({ name: `Sam${NB_HYPHEN}Rivera` }) })).rejects.toThrow("in the recipient's address");

    vi.stubEnv('LETTER_IRL_PRINT_RENDERER', 'html');
    vi.mocked(createPostcardDraft).mockClear();
    await expect(run({ message: `A well${NB_HYPHEN}known beach` })).rejects.toThrow("can't print some characters");
  });
});

describe('a gift postcard', () => {
  beforeEach(() => {
    vi.stubEnv('LETTER_IRL_GIFT_LETTERS_ENABLED', 'true');
    vi.mocked(getGiftBalance).mockResolvedValue({ available: 1, next: { giftId: 'gift-1', cardState: 'funded' } } as never);
  });

  it('keeps the legacy HTML and its limits until its strip moves onto the renderer', async () => {
    const output = await run({ sendAsGift: true });
    const draft = drafted();
    expect(draft.isGiftSend).toBe(true);
    expect(draft.rendererVersion).toBeUndefined();
    expect(draft.previewHtml).toContain('class="postcard-front"');
    expect(draft.previewHtml).not.toContain('data-renderer');
    expect(output.giftCard).toMatchObject({ state: 'funded' });

    vi.mocked(createPostcardDraft).mockClear();
    await expect(run({ sendAsGift: true, message: 'a'.repeat(351) })).rejects.toThrow('(351/350 characters)');
    await expect(run({ sendAsGift: true, message: `We will sta${FF} it` })).resolves.toMatchObject({ draftId: 'draft-1' });
  });
});

describe('without the flag', () => {
  it('leaves postcard previews on the legacy HTML, with no version', async () => {
    vi.stubEnv('LETTER_IRL_PRINT_RENDERER', '');
    await run();
    const draft = drafted();
    expect(draft.rendererVersion).toBeUndefined();
    expect(draft.previewHtml).toContain('class="postcard-front"');
    expect(draft.previewHtml).not.toContain('<svg');
  });
});
