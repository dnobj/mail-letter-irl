/**
 * A signature on a letter preview (#608): the previews' `signature`, or the
 * account's remembered choice, read once (chooseSignature); the letter laid
 * out with it, so the fit counts its three lines; the draft keeping its own
 * copy and recording pdf-4; and the choice remembered once the draft exists.
 * The band's geometry is tested in layoutSignature.test.ts, the saved
 * signature's tools in signatures.test.ts.
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

vi.mock('../../../src/services/signatureService.js', () => ({
  getSignature: vi.fn(),
  rememberSignatureChoice: vi.fn()
}));

import { getLetterProvider } from '../../../src/services/providers/index.js';
import { createDraft } from '../../../src/services/draftService.js';
import { getRecentUploadedImage } from '../../../src/services/recentUploadStore.js';
import { getReturnAddress } from '../../../src/services/returnAddressService.js';
import { downloadAndProcessLetterImageWithPreview } from '../../../src/services/imageService.js';
import { getGiftBalance } from '../../../src/services/giftLetterService.js';
import { getSendEligibility } from '../../../src/services/commerceService.js';
import { rememberedStationery } from '../../../src/services/stationeryDefaultService.js';
import { getSignature, rememberSignatureChoice } from '../../../src/services/signatureService.js';
import { quoteAndPreviewLetterTextOnlyTool } from '../../../src/tools/quoteAndPreviewLetterTextOnly.js';
import { quoteAndPreviewLetterWithHeaderImageTool } from '../../../src/tools/quoteAndPreviewLetterWithHeaderImage.js';
import { quoteAndPreviewLetterWithImageTool } from '../../../src/tools/quoteAndPreviewLetterWithImage.js';
import { chooseSignature, rememberPreviewSignature } from '../../../src/tools/signatureInput.js';
import { letterRunsPast, SIGNATURE_GIFT_WORDS, withDisplayImage } from '../../../src/tools/letterHelpers.js';
import { GIFT_PAYS_ONE_PAGE } from '../../../src/tools/giftSendChoice.js';
import { SignatureRefusedError } from '../../../src/tools/signatureShared.js';
import { layoutLetter, readImageDataUri, type Layout } from '../../../src/render/index.js';
import type { Address, ToolContext } from '../../../src/contracts/types.js';

/** A PNG's signature and header: enough for the layout to size it. */
function pngBytes(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  bytes.writeUInt32BE(0x89504e47, 0);
  bytes.writeUInt32BE(0x0d0a1a0a, 4);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}
const uri = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`;

// The signature as the cleaning writes one, and a letter's picture at 300 dpi and as the card shows it.
const SIGNATURE_PNG = pngBytes(1200, 300);
const SIGNATURE = uri(SIGNATURE_PNG);
const FULL = uri(pngBytes(1950, 600));
const SMALL = uri(pngBytes(390, 120));

function saved(useByDefault: boolean) {
  return {
    png: SIGNATURE_PNG,
    width: 1200,
    height: 300,
    useByDefault,
    createdAt: '2026-10-02T14:00:00.000Z',
    updatedAt: '2026-10-02T14:00:00.000Z'
  };
}

function context(): ToolContext {
  return {
    user: { userId: 'user-1', creditsRemaining: 10 } as ToolContext['user'],
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
    { sender: address({ name: 'Pat Example' }), recipient: address(), bodyText: 'Dear Sam,\n\nThank you for the jam.', signOff: 'Love,\nPat', ...extras, ...input },
    ctx
  );
}

/** The draft's fields, from the one createDraft call. */
function drafted() {
  expect(createDraft).toHaveBeenCalledTimes(1);
  return vi.mocked(createDraft).mock.calls[0][0];
}

function offered() {
  vi.stubEnv('LETTER_IRL_SIGNATURES_ENABLED', 'true');
  vi.stubEnv('LETTER_IRL_PRINT_RENDERER', 'pdf');
}

beforeEach(() => {
  vi.clearAllMocks();
  offered();
  vi.mocked(getLetterProvider).mockReturnValue({} as never);
  vi.mocked(createDraft).mockResolvedValue({ draftId: 'draft-1', expiresAt: new Date('2026-10-03T12:00:00Z') });
  vi.mocked(getRecentUploadedImage).mockResolvedValue(null);
  vi.mocked(getReturnAddress).mockResolvedValue(null);
  vi.mocked(getGiftBalance).mockResolvedValue({ available: 0, next: undefined } as never);
  vi.mocked(getSendEligibility).mockReturnValue({
    payAndSend: { available: true, amountCents: 499 },
    letterPack: { available: true, purchaseUrl: 'https://letterirl.com/pricing' }
  } as never);
  vi.mocked(downloadAndProcessLetterImageWithPreview).mockResolvedValue({
    base64DataUri: FULL,
    previewDataUri: SMALL,
    originalWidth: 1950,
    originalHeight: 600,
    processedWidth: 1950,
    processedHeight: 600
  } as never);
  vi.mocked(rememberedStationery).mockResolvedValue(null);
  vi.mocked(getSignature).mockResolvedValue(saved(true));
  vi.mocked(rememberSignatureChoice).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('chooseSignature', () => {
  it.each([
    ['the flag off', { LETTER_IRL_SIGNATURES_ENABLED: '', LETTER_IRL_PRINT_RENDERER: 'pdf' }],
    ['the flag on, with the legacy renderer', { LETTER_IRL_SIGNATURES_ENABLED: 'true', LETTER_IRL_PRINT_RENDERER: 'html' }]
  ])('while not offered (%s), refuses true, and reads nothing for false or left out', async (_label, env) => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const error = await chooseSignature(true, context()).catch(e => e);
    expect(error).toBeInstanceOf(SignatureRefusedError);
    expect(error).toMatchObject({ code: 'SIGNATURES_OFF', diagnosticClass: 'SIGNATURES_OFF' });
    await expect(chooseSignature(false, context())).resolves.toEqual({});
    await expect(chooseSignature(undefined, context())).resolves.toEqual({});
    expect(getSignature).not.toHaveBeenCalled();
  });

  it('prints none for false, reading nothing, and remembers the choice', async () => {
    await expect(chooseSignature(false, context())).resolves.toEqual({ asked: false, offered: true });
    expect(getSignature).not.toHaveBeenCalled();
  });

  it('prints the saved one when left out while the choice is on, or when asked, as a PNG data URI', async () => {
    await expect(chooseSignature(undefined, context())).resolves.toEqual({ image: SIGNATURE, asked: undefined, offered: true, saved: true });
    await expect(chooseSignature(true, context())).resolves.toEqual({ image: SIGNATURE, asked: true, offered: true, saved: true });
    expect(getSignature).toHaveBeenCalledWith('user-1');
  });

  it('prints none when left out while the choice is off, but prints it when asked', async () => {
    vi.mocked(getSignature).mockResolvedValue(saved(false));
    await expect(chooseSignature(undefined, context())).resolves.toEqual({ asked: undefined, offered: true, saved: true });
    await expect(chooseSignature(true, context())).resolves.toEqual({ image: SIGNATURE, asked: true, offered: true, saved: true });
  });

  it('with none saved, prints none when left out, and refuses true with the way to save one', async () => {
    vi.mocked(getSignature).mockResolvedValue(null);
    await expect(chooseSignature(undefined, context())).resolves.toEqual({ offered: true, saved: false });
    const error = await chooseSignature(true, context()).catch(e => e);
    expect(error).toMatchObject({ code: 'SIGNATURE_NOT_SAVED' });
    expect(error.message).toContain('set_signature');
    expect(error.message).toContain('without signature');
  });
});

describe('rememberPreviewSignature', () => {
  it('remembers an explicit choice, on or off, and nothing when the call named none', async () => {
    await rememberPreviewSignature({ asked: undefined, image: SIGNATURE }, context());
    expect(rememberSignatureChoice).not.toHaveBeenCalled();
    await rememberPreviewSignature({ asked: true, image: SIGNATURE }, context());
    await rememberPreviewSignature({ asked: false }, context());
    expect(vi.mocked(rememberSignatureChoice).mock.calls).toEqual([['user-1', true], ['user-1', false]]);
  });

  it('never fails the preview: a failure is logged', async () => {
    vi.mocked(rememberSignatureChoice).mockRejectedValue(new Error('connection reset'));
    const ctx = context();
    await expect(rememberPreviewSignature({ asked: false }, ctx)).resolves.toBeUndefined();
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'quote.signature_not_remembered', error: 'connection reset' }),
      expect.any(String)
    );
  });
});

describe('a letter preview with the saved signature', () => {
  it.each(['text_only', 'header_image', 'inline_image'] as const)(
    '%s: is drawn with it under the closing, records pdf-4, and keeps its own copy',
    async layout => {
      const output = await run(layout);
      const draft = drafted();
      expect(draft.rendererVersion).toBe('pdf-4');
      expect(draft.signatureImage).toBe(SIGNATURE);
      const html = draft.previewHtml!;
      expect(html).toContain('<body data-renderer="pdf-4">');
      // Marked, so the code that finds the letter's picture passes it by.
      expect(html.match(/<image data-role="signature" href="([^"]+)"/)?.[1]).toBe(SIGNATURE);
      // The letter's own picture from its small copy, as before; never the signature's.
      if (layout !== 'text_only') {
        expect(html.match(/<image href="([^"]+)"/)?.[1]).toBe(SMALL);
        expect(html).not.toContain(FULL);
      }
      expect(output.previewHtml).toBe(html);
      // Left out: nothing to remember.
      expect(rememberSignatureChoice).not.toHaveBeenCalled();
    }
  );

  it("draws it under the sign-off's first line, as the print will", async () => {
    await run('text_only');
    const html = drafted().previewHtml!;
    // Paragraphs: "Dear Sam,", "", "Thank you for the jam.", "Love,", "Pat": the closing is the fourth.
    const layout = layoutLetter({
      text: 'Dear Sam,\n\nThank you for the jam.\nLove,\nPat',
      layoutType: 'text_only',
      signature: { image: readImageDataUri(SIGNATURE), closingParagraph: 3 }
    });
    const band = layout.pages[0].items.find(item => item.kind === 'image')!;
    const drawn = html.match(/<image data-role="signature" href="[^"]+" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/)!;
    expect(drawn.slice(1).map(Number)).toEqual([band.x, band.top, band.width, band.height].map(value => Math.round(value * 100) / 100));
  });

  it('records pdf-4 with a theme too, and the theme with it', async () => {
    vi.stubEnv('LETTER_IRL_STATIONERY_ENABLED', 'true');
    await run('text_only', { stationery: 'botanical' });
    const draft = drafted();
    expect(draft.rendererVersion).toBe('pdf-4');
    expect(draft.stationery).toMatchObject({ theme: 'botanical' });
    expect(draft.signatureImage).toBe(SIGNATURE);
  });

  it('leaves it off with signature: false, records pdf-1, and remembers the choice once the draft exists', async () => {
    vi.mocked(createDraft).mockImplementation(async () => {
      expect(rememberSignatureChoice).not.toHaveBeenCalled();
      return { draftId: 'draft-1', expiresAt: new Date('2026-10-03T12:00:00Z') };
    });
    await run('text_only', { signature: false });
    const draft = drafted();
    expect(draft.rendererVersion).toBe('pdf-1');
    expect(draft.signatureImage).toBeUndefined();
    expect(draft.previewHtml).not.toContain('data-role="signature"');
    expect(getSignature).not.toHaveBeenCalled();
    expect(rememberSignatureChoice).toHaveBeenCalledWith('user-1', false);
  });

  it('prints it when asked while the choice is off, and turns the choice back on', async () => {
    vi.mocked(getSignature).mockResolvedValue(saved(false));
    await run('text_only', { signature: true });
    expect(drafted()).toMatchObject({ rendererVersion: 'pdf-4', signatureImage: SIGNATURE });
    expect(rememberSignatureChoice).toHaveBeenCalledWith('user-1', true);
  });

  it('is left off, as before, while the choice is off or none is saved', async () => {
    vi.mocked(getSignature).mockResolvedValue(saved(false));
    await run('text_only');
    expect(drafted()).toMatchObject({ rendererVersion: 'pdf-1', signatureImage: undefined });

    vi.mocked(createDraft).mockClear();
    vi.mocked(getSignature).mockResolvedValue(null);
    await run('text_only');
    expect(drafted()).toMatchObject({ rendererVersion: 'pdf-1', signatureImage: undefined });
    expect(rememberSignatureChoice).not.toHaveBeenCalled();
  });

  it('refuses signature: true with none saved, making no draft and remembering nothing', async () => {
    vi.mocked(getSignature).mockResolvedValue(null);
    const error = await run('text_only', { signature: true }).catch(e => e);
    expect(error).toMatchObject({ code: 'SIGNATURE_NOT_SAVED' });
    expect(createDraft).not.toHaveBeenCalled();
    expect(rememberSignatureChoice).not.toHaveBeenCalled();
  });

  it('refuses signature: true while signatures are not offered, rather than print the letter unsigned', async () => {
    vi.stubEnv('LETTER_IRL_SIGNATURES_ENABLED', '');
    const error = await run('text_only', { signature: true }).catch(e => e);
    expect(error).toMatchObject({ code: 'SIGNATURES_OFF' });
    expect(createDraft).not.toHaveBeenCalled();
    expect(getSignature).not.toHaveBeenCalled();

    // Left out, the preview is as it was before signatures.
    await run('text_only');
    expect(drafted()).toMatchObject({ rendererVersion: 'pdf-1', signatureImage: undefined });
  });

  it('counts its three lines in the fit, and says when the letter fits without it', async () => {
    // 26 lines hold: 24 and the sign-off's two fit unsigned, not with the band.
    const error = await run('text_only', { bodyText: lines(24), signOff: 'Love,\nPat' }).catch(e => e);
    expect(error.message).toMatch(/^Letter is 3 lines too long for one page/);
    expect(error.message).toContain(
      'The signature takes 3 lines, and without it the letter fits: preview it with signature: false to leave it off.'
    );
    expect(createDraft).not.toHaveBeenCalled();
    await expect(run('text_only', { bodyText: lines(24), signOff: 'Love,\nPat', signature: false })).resolves.toMatchObject({ draftId: 'draft-1' });

    // Too long either way: the band is named, without the way out.
    const longer = await run('text_only', { bodyText: lines(26), signOff: 'Love,\nPat' }).catch(e => e);
    expect(longer.message).toMatch(/ The signature takes 3 lines\.$/);
  });
});

describe('what a preview says of the signature (#612 review round 1)', () => {
  it.each([
    ['left out, the choice on', true, {}, { printed: true, source: 'remembered' }],
    ['left out, the choice off', false, {}, { printed: false, source: 'remembered' }],
    ['asked for', false, { signature: true }, { printed: true, source: 'asked' }],
    ['asked against', true, { signature: false }, { printed: false, source: 'asked' }],
    ['left out, none saved', null, {}, { printed: false, source: 'none_saved' }]
  ] as const)('%s', async (_label, useByDefault, input, said) => {
    vi.mocked(getSignature).mockResolvedValue(useByDefault === null ? null : saved(useByDefault));
    const output = await run('text_only', input);
    expect(output.signature).toEqual(said);
    // What the output says is what the draft prints.
    expect(drafted().rendererVersion).toBe(said.printed ? 'pdf-4' : 'pdf-1');
  });

  it('says nothing while signatures are not offered, so the output is as before them', async () => {
    vi.stubEnv('LETTER_IRL_SIGNATURES_ENABLED', '');
    const output = await run('text_only');
    expect(output).not.toHaveProperty('signature');
  });
});

describe('a signed gift letter, while room to write is offered (#612 review round 1)', () => {
  beforeEach(() => {
    vi.stubEnv('LETTER_IRL_ROOM_TO_WRITE_ENABLED', 'true');
    vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
    vi.stubEnv('LETTER_IRL_GIFT_LETTERS_ENABLED', 'true');
    vi.mocked(getGiftBalance).mockResolvedValue({ available: 1, next: { giftId: 'gift-1', cardState: 'funded' } } as never);
  });

  /** The most body lines one page holds unsigned, with the two-line sign-off and the layout's picture. */
  function holds(layoutType: 'text_only' | 'header_image' | 'inline_image'): number {
    const fits = (count: number) =>
      !letterRunsPast({ bodyText: lines(count), signOff: 'Love,\nPat', layoutType, imageData: layoutType === 'text_only' ? undefined : FULL }, 1);
    let count = 1;
    while (fits(count + 1)) count += 1;
    return count;
  }
  const LAYOUTS = ['text_only', 'header_image', 'inline_image'] as const;

  it.each(LAYOUTS)('%s: is refused with the way out when the band pushes it past one page', async layout => {
    const full = holds(layout);
    const error = await run(layout, { bodyText: lines(full), signOff: 'Love,\nPat', sendAsGift: true }).catch(e => e);
    expect(error.message).toBe(`${GIFT_PAYS_ONE_PAGE} ${SIGNATURE_GIFT_WORDS}`);
    expect(error.message).toContain('signature: false');
    expect(createDraft).not.toHaveBeenCalled();

    // Which works: unsigned, it is a gift letter.
    await run(layout, { bodyText: lines(full), signOff: 'Love,\nPat', sendAsGift: true, signature: false });
    expect(drafted()).toMatchObject({ isGiftSend: true, rendererVersion: 'pdf-1' });
  });

  it.each(LAYOUTS)('%s: is refused in the gift\'s own words when it runs past one page even unsigned', async layout => {
    // One line past the page unsigned, with its picture: without the picture it would fit.
    const error = await run(layout, { bodyText: lines(holds(layout) + 1), signOff: 'Love,\nPat', sendAsGift: true }).catch(e => e);
    expect(error.message).toBe(GIFT_PAYS_ONE_PAGE);
  });

  it('is refused in the gift\'s own words for any other reason, such as none to send', async () => {
    vi.mocked(getGiftBalance).mockResolvedValue({ available: 0, next: undefined } as never);
    const error = await run('text_only', { sendAsGift: true }).catch(e => e);
    expect(error.message).toBe('This account has no gift letter to send. Leave sendAsGift out to send from the balance.');
  });
});

describe('withDisplayImage', () => {
  it("swaps the letter's picture for its small copy and leaves the signature alone", () => {
    const layout = {
      pages: [{
        items: [
          { kind: 'image', x: 72, top: 72, width: 468, height: 144, image: { bytes: Buffer.from('full'), mime: 'image/png', width: 1950, height: 600 } },
          { kind: 'image', x: 72, top: 400, width: 180, height: 45, image: { bytes: SIGNATURE_PNG, mime: 'image/png', width: 1200, height: 300 }, role: 'signature' }
        ]
      }]
    } as unknown as Layout;
    const shown = withDisplayImage(layout, SMALL);
    const [picture, signature] = shown.pages[0].items as Array<{ image: { bytes: Buffer; width: number } }>;
    expect(picture.image.width).toBe(390);
    expect(signature.image.bytes).toBe(SIGNATURE_PNG);
  });
});
