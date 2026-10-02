/**
 * Postcard previews drawn by our own renderer (#534 Phase 4), behind
 * LETTER_IRL_PRINT_RENDERER=pdf: the back is measured as it prints, the
 * message is checked against the renderer's font, and the draft keeps the
 * postcard's front and back as SVG, the addresses where PostGrid stamps them,
 * under the renderer's version, a gift send's card in a strip at the foot of
 * the message. Without the flag, previews are the legacy HTML.
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

  it("stamps the addresses as they are sent, after the provider's correction", async () => {
    vi.mocked(getLetterProvider).mockReturnValue({
      validateAddress: vi.fn(async (input: { line1: string }) =>
        input.line1 === '350 Fifth Ave'
          ? { status: 'corrected', verifiedAddress: { line1: '350 5th Ave', city: 'New York', state: 'NY', postalCode: '10118-0110', country: 'US' } }
          : { status: 'verified', verifiedAddress: input })
    } as never);

    await run();

    const draft = drafted();
    expect(draft.recipient).toMatchObject({ addressLine1: '350 5th Ave', postalCode: '10118-0110' });
    const back = draft.previewHtml!.match(/<svg [\s\S]*?<\/svg>/g)![1];
    const stamped = [...back.matchAll(/<text x="[\d.]+" y="[\d.]+">([^<]*)<\/text>/g)].map(match => match[1]);
    expect(stamped.slice(-3)).toEqual(['SAM RIVERA', '350 5TH AVE', 'NEW YORK, NY 10118-0110']);
  });

  it('gives the card the postcard as it prints, beside its own front and back, the front landscape', async () => {
    const output = await run();
    // The draft's document: the card shows these pages (#534 Phase 4b).
    expect(output.previewHtml).toBe(drafted().previewHtml);
    expect(output.previewHtml).toContain('<body data-renderer="pdf-1">');
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

  it('refuses a 4x6 or an 11x6 while those sizes are not offered, before anything is fetched (#594)', async () => {
    for (const [size, named] of [['6x4', 'A 4x6'], ['6x11', 'An 11x6']] as const) {
      const refused = await run({ size }).catch(error => error);
      expect(refused.message, size).toBe(`${named} postcard is not offered here. Leave size out for a 6x9 postcard.`);
      expect(refused, size).toMatchObject({ diagnosticClass: 'validation_error' });
    }
    expect(downloadAndProcessPostcardImageWithPreview).not.toHaveBeenCalled();
    expect(createPostcardDraft).not.toHaveBeenCalled();
    // The flag and Pay & Send are not enough without our renderer: the legacy
    // back is a 9 x 6in page whatever the card.
    vi.stubEnv('LETTER_IRL_POSTCARD_SIZES_ENABLED', 'true');
    vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
    vi.stubEnv('LETTER_IRL_PRINT_RENDERER', 'html');
    await expect(run({ size: '6x4' })).rejects.toThrow('A 4x6 postcard is not offered here.');
    // A 6x9, named or not, as before.
    await expect(run({ size: '6x9' })).resolves.toMatchObject({ draftId: 'draft-1' });
    expect(drafted().postcardSize).toBe('6x9');
  });

  describe('while the 4x6 and 11x6 are offered (#594)', () => {
    beforeEach(() => {
      vi.stubEnv('LETTER_IRL_POSTCARD_SIZES_ENABLED', 'true');
      vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
    });

    // imageService's crop for each size, at 300 dpi; the page with its bleed;
    // where PostGrid stamps the addresses (probe P14).
    const SIZES = [
      { size: '6x4' as const, crop: [1800, 1200], viewBox: '0 0 450 306', stampX: 282.6, recipientY: 211.46, held: 11 },
      { size: '6x11' as const, crop: [3300, 1800], viewBox: '0 0 810 450', stampX: 556.2, recipientY: 355.46, held: 16 }
    ];
    const crop = ([width, height]: readonly number[]) => ({
      base64DataUri: png(width, height),
      previewDataUri: SMALL,
      originalWidth: width,
      originalHeight: height,
      processedWidth: width,
      processedHeight: height
    });

    it.each(SIZES)('previews a $size on our renderer: its pages, its stamps, its size and version on the draft', async ({ size, crop: cropped, viewBox, stampX, recipientY }) => {
      vi.mocked(downloadAndProcessPostcardImageWithPreview).mockResolvedValue(crop(cropped) as never);
      await run({ size, message: 'Dear Sam,\nWish you were here.\nPat' });
      // The front cropped to its size.
      expect(downloadAndProcessPostcardImageWithPreview).toHaveBeenCalledWith(expect.anything(), size, expect.anything());
      const draft = drafted();
      expect(draft).toMatchObject({ postcardSize: size, rendererVersion: 'pdf-1' });
      const pages = draft.previewHtml!.match(/<svg [\s\S]*?<\/svg>/g)!;
      expect(pages).toHaveLength(2);
      for (const page of pages) expect(page).toContain(`viewBox="${viewBox}"`);
      const stamped = [...pages[1].matchAll(/<text x="([\d.]+)" y="([\d.]+)">([^<]*)<\/text>/g)];
      expect(stamped.map(match => Number(match[1]))).toEqual(Array(stamped.length).fill(stampX));
      expect(stamped.find(match => match[3] === 'SAM RIVERA')?.[2]).toBe(String(recipientY));
      expect(pages[1]).toContain('<title>Dear Sam,\nWish you were here.\nPat</title>');
    });

    it.each(SIZES)('measures a $size back at its own size: $held lines are accepted, one more refused', async ({ size, held }) => {
      await expect(run({ size, message: lines(held) })).resolves.toMatchObject({ draftId: 'draft-1' });
      vi.mocked(createPostcardDraft).mockClear();
      const ctx = context();
      await expect(run({ size, message: lines(held + 1) }, ctx)).rejects.toThrow(
        `Postcard message is 1 line too long for the back: it takes ${held + 1} lines and the back holds ${held}.`
      );
      expect(ctx.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'quote.postcard.exceeds_back', linesUsed: held + 1, linesAvailable: held }),
        'Postcard message runs past its room on the back'
      );
      expect(createPostcardDraft).not.toHaveBeenCalled();
    });

    it("bounds an 11x6's message at 2,000 characters, the 6x9's and 4x6's at 1,000, so its lines govern", async () => {
      // About 1,050 characters of prose: past the 6x9's and 4x6's caps, and
      // about what an 11x6's 16 lines hold, so it is refused there by its lines.
      const prose = 'the quick brown fox jumps over the lazy dog '.repeat(24).trim();
      expect(prose.length).toBeGreaterThan(1_000);
      await expect(run({ message: prose })).rejects.toThrow(`Postcard message is too long (${prose.length}/1000 characters).`);
      await expect(run({ size: '6x4', message: prose })).rejects.toThrow(`(${prose.length}/1000 characters)`);
      const elevenBySix = await run({ size: '6x11', message: prose }).then(() => null, (error: Error) => error.message);
      expect(elevenBySix).toMatch(/^Postcard message is \d+ lines? too long for the back: it takes \d+ lines and the back holds 16\./);
      await expect(run({ size: '6x11', message: 'a'.repeat(2_001) })).rejects.toThrow('(2001/2000 characters)');
    });
  });

  it('shows a 4x6 as paid per send, though the balance could pay a 6x9 (#579)', async () => {
    vi.stubEnv('LETTER_IRL_POSTCARD_SIZES_ENABLED', 'true');
    vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
    // Ten credits: five letters, enough for any 6x9.
    const output = (await run({ size: '6x4' })) as { canSendNow: boolean; reasonCannotSend?: string };
    expect(output.canSendNow).toBe(false);
    expect(output.reasonCannotSend).toBe(
      'Letter packs and gift letters pay for one-page letters and 6x9 postcards; this one is paid with Pay & Send.'
    );
    // Priced as the 4x6 it is.
    expect(getSendEligibility).toHaveBeenCalledWith(10, expect.any(Number), { mailType: 'postcard', postcardSize: '6x4' });
    // And the 6x9, as before.
    vi.mocked(createPostcardDraft).mockClear();
    const sixByNine = (await run()) as { canSendNow: boolean; reasonCannotSend?: string };
    expect(sixByNine.canSendNow).toBe(true);
    expect(sixByNine.reasonCannotSend).toBeUndefined();
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
  const backOf = (html: string) => html.match(/<svg [\s\S]*?<\/svg>/g)![1];
  const giftBalance = (next: Record<string, unknown>) =>
    vi.mocked(getGiftBalance).mockResolvedValue({ available: 1, next: { giftId: 'gift-1', ...next } } as never);
  const sender = (name: string) =>
    address({ name, addressLine1: '1600 Pennsylvania Ave NW', city: 'Washington', state: 'DC', postalCode: '20500' });

  beforeEach(() => {
    vi.stubEnv('LETTER_IRL_GIFT_LETTERS_ENABLED', 'true');
    giftBalance({ cardState: 'funded' });
  });

  it('draws its card on the renderer, at the foot of the back, under pdf-1 (#534)', async () => {
    const output = await run({ sendAsGift: true, message: 'Dear Sam,\nWish you were here.' });
    const draft = drafted();
    expect(draft.isGiftSend).toBe(true);
    expect(draft.rendererVersion).toBe('pdf-1');
    // The card shows the postcard as it prints, card and all.
    expect(output.previewHtml).toBe(draft.previewHtml);
    expect(output.giftCard).toMatchObject({ state: 'funded' });
    const back = backOf(draft.previewHtml!);
    // The page reads the message, then the card: the sender's name, and a
    // placeholder where the code the send mints will print.
    const title = /<title>([^<]*)<\/title>/.exec(back)![1];
    expect(title.startsWith('Dear Sam,\nWish you were here.\nA gift from Pat Example:\n')).toBe(true);
    expect(title).toContain('••••-••••');
    expect(back).toContain('#b9ad99');
  });

  it('holds 11 lines above the card, and says so when a message takes more', async () => {
    await expect(run({ sendAsGift: true, message: lines(11) })).resolves.toMatchObject({ draftId: 'draft-1' });
    vi.mocked(createPostcardDraft).mockClear();
    const error = await run({ sendAsGift: true, message: lines(12) }).catch(e => e);
    expect(error.message).toBe(
      'Postcard message is 1 line too long for the back: it takes 12 lines and the back holds 11 above the gift card. ' +
      'Please shorten your message to fit on the postcard back.'
    );
    expect(createPostcardDraft).not.toHaveBeenCalled();
    // The legacy 350-character limit gives way, as it does without a card.
    const message = Array.from({ length: 11 }, () => 'the quick brown fox jumps over the lazy').join('\n');
    expect(message.length).toBeGreaterThan(350);
    await expect(run({ sendAsGift: true, message })).resolves.toMatchObject({ draftId: 'draft-1' });
  });

  it("checks the sender's name against the renderer's font, whichever card the send prints", async () => {
    // U+FB00 prints in Open Sans, so a paid postcard's return address may carry it.
    await expect(run({ sender: sender(`Pat Sta${FF}ord`) })).resolves.toMatchObject({ draftId: 'draft-1' });
    vi.mocked(downloadAndProcessPostcardImageWithPreview).mockClear();
    await expect(run({ sendAsGift: true, sender: sender(`Pat Sta${FF}ord`) }))
      .rejects.toThrow("in the sender's name, which the gift card prints");
    // The plain card prints no name, but the send may print a funded one.
    giftBalance({ cardState: 'unfunded' });
    await expect(run({ sendAsGift: true, sender: sender(`Pat Sta${FF}ord`) }))
      .rejects.toThrow("in the sender's name, which the gift card prints");
    expect(downloadAndProcessPostcardImageWithPreview).not.toHaveBeenCalled();
  });

  it("refuses a sender's name too long for the card a send could print, before the picture is fetched", async () => {
    const name = (count: number) => 'Pat Example '.repeat(count).trim();
    await expect(run({ sendAsGift: true, sender: sender(name(7)) })).resolves.toMatchObject({ draftId: 'draft-1' });
    vi.mocked(downloadAndProcessPostcardImageWithPreview).mockClear();
    // This name fits the preview's card, but not a seed campaign's, which a
    // send may print instead (longestSendCard).
    const ctx = context();
    const error = await run({ sendAsGift: true, sender: sender(name(10)) }, ctx).catch(e => e);
    expect(error.message).toBe("The sender's name is too long to print on the gift card. Shorten it, then preview again.");
    expect(error).toMatchObject({ diagnosticClass: 'validation_error' });
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'quote.postcard.gift_card_overflow', cause: 'name' }),
      expect.any(String)
    );
    // The plain card prints no name, but the send may print a funded one.
    giftBalance({ cardState: 'unfunded' });
    await expect(run({ sendAsGift: true, sender: sender(name(10)) })).rejects.toThrow("The sender's name is too long");
    expect(downloadAndProcessPostcardImageWithPreview).not.toHaveBeenCalled();
  });

  it("says when a seed campaign's code is too long for any postcard, whatever the name", async () => {
    giftBalance({ cardState: 'funded', seed: { code: 'W'.repeat(50), endsAt: null, newAccountsOnly: false } });
    const ctx = context();
    const error = await run({ sendAsGift: true }, ctx).catch(e => e);
    expect(error.message).toBe(
      "This gift letter's card does not fit on a postcard. Send it as a letter, or set sendAsGift to false to pay from the balance."
    );
    expect(error).toMatchObject({ diagnosticClass: 'validation_error' });
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'quote.postcard.gift_card_overflow', cause: 'card' }),
      expect.any(String)
    );
    // A seed code of ordinary length prints.
    giftBalance({ cardState: 'funded', seed: { code: 'PRESS2026', endsAt: new Date('2026-12-31T00:00:00Z'), newAccountsOnly: true } });
    await expect(run({ sendAsGift: true })).resolves.toMatchObject({ draftId: 'draft-1' });
    expect(/<title>([^<]*)<\/title>/.exec(backOf(drafted().previewHtml!))![1]).toContain('PRESS2026');
  });

  it('refuses a gift on any size but 6x9, and keeps every gift postcard without the flag on the legacy HTML and its limits', async () => {
    // A gift letter pays only where a pack does (#579): a 6x9 postcard. Not
    // offered, a 4x6 is refused for its size first (#594).
    await expect(run({ sendAsGift: true, size: '6x4' })).rejects.toThrow('A 4x6 postcard is not offered here.');
    vi.stubEnv('LETTER_IRL_POSTCARD_SIZES_ENABLED', 'true');
    vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
    for (const size of ['6x4', '6x11'] as const) {
      await expect(run({ sendAsGift: true, size }), size).rejects.toThrow(
        'A gift letter pays for a one-page letter or a 6x9 postcard, not for this one.'
      );
    }
    expect(createPostcardDraft).not.toHaveBeenCalled();
    vi.stubEnv('LETTER_IRL_POSTCARD_SIZES_ENABLED', '');

    vi.stubEnv('LETTER_IRL_PRINT_RENDERER', 'html');
    const output = await run({ sendAsGift: true });
    expect(drafted().rendererVersion).toBeUndefined();
    expect(drafted().previewHtml).not.toContain('data-renderer');
    // So the card keeps its own front and mockup.
    expect(output).not.toHaveProperty('previewHtml');
    vi.mocked(createPostcardDraft).mockClear();
    await expect(run({ sendAsGift: true, message: 'a'.repeat(351) })).rejects.toThrow('(351/350 characters)');
    await expect(run({ sendAsGift: true, message: `We will sta${FF} it` })).resolves.toMatchObject({ draftId: 'draft-1' });
  });
});

describe("a postcard's front (#594)", () => {
  beforeEach(() => {
    vi.stubEnv('LETTER_IRL_POSTCARD_LAYOUTS_ENABLED', 'true');
  });

  const frontPage = () => drafted().previewHtml!.match(/<svg xmlns[\s\S]*?(?=<svg xmlns|<\/body>)/g)![0];

  it('draws a border with its caption, and keeps it on the draft, drawn as pdf-3', async () => {
    await run({ layout: 'border', caption: 'Cape Cod,\n August 2026' });
    const draft = drafted();
    expect(draft).toMatchObject({ postcardFront: { layout: 'border', caption: 'Cape Cod, August 2026' }, rendererVersion: 'pdf-3' });
    const front = frontPage();
    // The photo in a viewport of its own, and the caption in its colour, spoken as written.
    expect(front).toMatch(/<svg x="[\d.]+" y="[\d.]+" width="[\d.]+" height="[\d.]+"><image href="data:image\/png;base64,/);
    expect(front).toMatch(/<g fill="#1E1A16">(<use [^>]+\/>)+<\/g>/);
    expect(front).toContain('<title>Cape Cod, August 2026</title>');
  });

  it('draws a greeting with its place, and keeps it on the draft, drawn as pdf-3', async () => {
    await run({ layout: 'greetings', place: 'Asheville' });
    expect(drafted()).toMatchObject({ postcardFront: { layout: 'greetings', place: 'Asheville' }, rendererVersion: 'pdf-3' });
    const front = frontPage();
    expect(front).toMatch(/<g fill="#FFFFFF">(<use [^>]+\/>)+<\/g><g fill="#A8461F">(<use [^>]+\/>)+<\/g><g fill="#F6E3A1">(<use [^>]+\/>)+<\/g>/);
    expect(front).toContain('<title>Greetings from\nAsheville</title>');
  });

  it('keeps full bleed as before: no front on the draft, drawn as pdf-1', async () => {
    await run({ layout: 'full_bleed' });
    expect(drafted()).toMatchObject({ postcardFront: null, rendererVersion: 'pdf-1' });
    expect(frontPage()).not.toContain('<g fill=');
  });

  it('refuses a caption Caveat cannot draw, naming it, before the picture is fetched', async () => {
    await expect(run({ layout: 'border', caption: 'Ωμέγα beach' })).rejects.toThrow('in the caption');
    expect(downloadAndProcessPostcardImageWithPreview).not.toHaveBeenCalled();
    expect(createPostcardDraft).not.toHaveBeenCalled();
  });

  it('refuses a front that does not fit, before the picture is fetched', async () => {
    await expect(run({ size: '6x9', layout: 'border', caption: 'W'.repeat(60) })).rejects.toThrow(
      /^The caption is too long for its line on the front of a 6x9 postcard: about \d+ of its 60 characters fit\. Shorten it\.$/
    );
    await expect(run({ layout: 'greetings' })).rejects.toThrow('The greetings layout needs a place');
    expect(downloadAndProcessPostcardImageWithPreview).not.toHaveBeenCalled();
  });

  it('refuses any front but full bleed while the layouts are not offered, as a stray from a cached schema', async () => {
    vi.stubEnv('LETTER_IRL_POSTCARD_LAYOUTS_ENABLED', '');
    await expect(run({ layout: 'border', caption: 'Cape Cod' })).rejects.toThrow('Postcard layouts are not offered here');
    await expect(run({ layout: 'full_bleed' })).resolves.toMatchObject({ draftId: 'draft-1' });
    expect(drafted()).toMatchObject({ postcardFront: null, rendererVersion: 'pdf-1' });
  });
});

describe('without the flag', () => {
  it('leaves postcard previews on the legacy HTML, with no version', async () => {
    vi.stubEnv('LETTER_IRL_PRINT_RENDERER', '');
    const output = await run();
    expect(output).not.toHaveProperty('previewHtml');
    const draft = drafted();
    expect(draft.rendererVersion).toBeUndefined();
    expect(draft.previewHtml).toContain('class="postcard-front"');
    expect(draft.previewHtml).not.toContain('<svg');
  });
});
