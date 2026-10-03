/**
 * set_postcard_style (#594): a postcard preview's size and front, changed
 * without previewing again. Each is checked as the postcard preview checks
 * it; the front is drawn again, and at the same size the back is kept as it
 * was (a gift card's strip with it); at a new size the picture is cropped
 * again and the back laid out at that size. A gift postcard stays a 6x9, and
 * the draft is restyled only while it waits to be sent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/draftService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/draftService.js')>()),
  getDraftForPostcardStyle: vi.fn(),
  setDraftPostcardStyle: vi.fn()
}));

vi.mock('../../../src/services/imageService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/imageService.js')>()),
  reprocessPostcardImage: vi.fn()
}));

vi.mock('../../../src/services/commerceService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/commerceService.js')>()),
  getSendEligibility: vi.fn()
}));

import { getDraftForPostcardStyle, setDraftPostcardStyle, type DraftForPostcardStyle } from '../../../src/services/draftService.js';
import { ImageProcessingError, reprocessPostcardImage } from '../../../src/services/imageService.js';
import { getSendEligibility } from '../../../src/services/commerceService.js';
import { setPostcardStyleTool } from '../../../src/tools/setPostcardStyle.js';
import { PAID_PER_SEND_REASON, withDisplayImage } from '../../../src/tools/letterHelpers.js';
import {
  layoutPostcard,
  PostcardFrontOverflow,
  POSTCARD_GEOMETRY,
  readImageDataUri,
  renderPreviewSvg,
  type PostcardFront
} from '../../../src/render/index.js';
import {
  rendererDocumentPages,
  renderPostcardPreviewDocument,
  stampedAddressLines,
  stampedPostcardReturnLines
} from '../../../src/services/previewService.js';
import { giftPostcardStripCopy } from '../../../src/services/giftCardRenderer.js';
import { sampleFundedCard } from '../../../src/services/giftLetterService.js';
import type { Address, ToolContext } from '../../../src/contracts/types.js';
import type { PostcardSize } from '../../../src/services/types.js';

const DRAFT_ID = '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0';
const NOW = new Date('2026-10-02T12:00:00Z');
const SOURCE = 'https://files.example/beach.jpg';

function context(): ToolContext {
  return {
    user: { userId: 'user-1', creditsRemaining: 10 } as ToolContext['user'],
    correlationId: 'corr-1',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never,
    now: () => NOW,
    persist: vi.fn(),
    isMobile: false
  } as unknown as ToolContext;
}

const SENDER: Address = { name: 'Pat Example', addressLine1: '350 Fifth Ave', city: 'New York', state: 'NY', postalCode: '10118', country: 'US' };
const RECIPIENT: Address = { ...SENDER, name: 'Sam Rivera' };
const MESSAGE = 'Wish you were here. The beach is wide and the water warm.';

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
/** The picture each size prints from, as the preview crops it. */
const PRINT: Record<PostcardSize, string> = { '6x4': png(1800, 1200), '6x9': png(2700, 1800), '6x11': png(3300, 1800) };
const SMALL = png(400, 267);
const SMALL_AGAIN = png(400, 218);

/** The postcard as a preview draws it, front and back. */
function drawn(options: { size?: PostcardSize; front?: PostcardFront; gift?: boolean; message?: string; print?: string; small?: string } = {}): string[] {
  const size = options.size ?? '6x9';
  const strip = options.gift ? giftPostcardStripCopy(sampleFundedCard(), SENDER.name) : undefined;
  return renderPreviewSvg(
    withDisplayImage(
      layoutPostcard({ message: options.message ?? MESSAGE, image: readImageDataUri(options.print ?? PRINT[size]), strip, size, ...options.front }),
      options.small ?? SMALL
    ),
    {
      addresses: { from: stampedPostcardReturnLines(SENDER), to: stampedAddressLines(RECIPIENT) },
      stamp: { page: 1, geometry: POSTCARD_GEOMETRY[size].stamp }
    }
  );
}

/** A pending postcard draft, as the preview stored it. */
function draft(options: { size?: PostcardSize; front?: PostcardFront; gift?: boolean; message?: string; collage?: boolean } = {}): DraftForPostcardStyle {
  const size = options.size ?? '6x9';
  return {
    mail_type: 'postcard',
    status: 'pending',
    expires_at: new Date('2026-10-03T12:00:00Z'),
    redacted_at: null,
    renderer_version: options.front ? 'pdf-3' : 'pdf-1',
    body_text: options.message ?? MESSAGE,
    sender: SENDER,
    recipient: RECIPIENT,
    front_image_data: PRINT[size],
    // A collage has no one source: the preview stores its link null (#616).
    front_image_url: options.collage ? null : SOURCE,
    postcard_size: size,
    postcard_front: options.front ?? null,
    preview_html: renderPostcardPreviewDocument(drawn(options)),
    is_gift_send: options.gift === true,
    required_credits: 2
  };
}

function run(input: Record<string, unknown>, ctx: ToolContext = context()) {
  return setPostcardStyleTool.handler({ draftId: DRAFT_ID, ...input } as never, ctx);
}

/** The refusal a call makes. */
async function refusal(input: Record<string, unknown>): Promise<{ code?: string; message: string }> {
  return run(input).then(
    () => { throw new Error('expected a refusal'); },
    (error: { code?: string; message: string }) => error
  );
}

function offer(sizes: boolean, layouts: boolean) {
  vi.stubEnv('LETTER_IRL_POSTCARD_SIZES_ENABLED', sizes ? 'true' : '');
  vi.stubEnv('LETTER_IRL_POSTCARD_LAYOUTS_ENABLED', layouts ? 'true' : '');
}

/** What the restyle stored. */
function stored() {
  expect(setDraftPostcardStyle).toHaveBeenCalledTimes(1);
  const [draftId, userId, change, now] = vi.mocked(setDraftPostcardStyle).mock.calls[0];
  expect([draftId, userId, now]).toEqual([DRAFT_ID, 'user-1', NOW]);
  return change;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('LETTER_IRL_PRINT_RENDERER', 'pdf');
  vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
  offer(true, true);
  vi.mocked(getDraftForPostcardStyle).mockResolvedValue(draft());
  vi.mocked(setDraftPostcardStyle).mockResolvedValue(null);
  vi.mocked(getSendEligibility).mockReturnValue({ eligible: true } as never);
  vi.mocked(reprocessPostcardImage).mockImplementation(async (_source, size) => ({
    base64DataUri: PRINT[size],
    previewDataUri: SMALL_AGAIN,
    originalWidth: 4000,
    originalHeight: 3000,
    processedWidth: 0,
    processedHeight: 0,
    from: 'source'
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('set_postcard_style at the same size', () => {
  it('draws a border on the front, keeps the back as it was, and crops nothing again', async () => {
    const before = draft();
    vi.mocked(getDraftForPostcardStyle).mockResolvedValue(before);
    const output = await run({ layout: 'border', caption: 'Cape Cod' });

    const change = stored();
    expect(change).toMatchObject({ size: '6x9', front: { layout: 'border', caption: 'Cape Cod' }, drawnFrom: { previewHtml: before.preview_html } });
    expect(change.frontImageData).toBeUndefined();
    expect(reprocessPostcardImage).not.toHaveBeenCalled();
    const [front, back] = rendererDocumentPages(change.previewHtml);
    expect(front).toBe(drawn({ front: { layout: 'border', caption: 'Cape Cod' } })[0]);
    expect(back).toBe(rendererDocumentPages(before.preview_html)[1]);
    expect(change.previewHtml).toBe(output.previewHtml);

    expect(output).toMatchObject({ draftId: DRAFT_ID, size: '6x9', layout: 'border', caption: 'Cape Cod', canSendNow: true });
    expect(output).not.toHaveProperty('reasonCannotSend');
    expect(output.message).toBe('The postcard is now a 6x9, with the photo in a white border over "Cape Cod". Nothing has been sent.');
    expect(getSendEligibility).toHaveBeenCalledWith(10, 2, { mailType: 'postcard', postcardSize: '6x9' });
  });

  it("draws a collage's front again at its own size, naming the size it already has", async () => {
    // A collage's draft records no link (#616); its size is not changing, so nothing is cropped again.
    const before = draft({ collage: true });
    vi.mocked(getDraftForPostcardStyle).mockResolvedValue(before);
    const output = await run({ size: '6x9', layout: 'border', caption: 'Our trip' });

    const change = stored();
    expect(change).toMatchObject({ size: '6x9', front: { layout: 'border', caption: 'Our trip' }, drawnFrom: { previewHtml: before.preview_html } });
    expect(change.frontImageData).toBeUndefined();
    expect(reprocessPostcardImage).not.toHaveBeenCalled();
    expect(output).toMatchObject({ size: '6x9', layout: 'border', caption: 'Our trip' });
  });

  it('gives a greeting its place, and takes a front off back to full bleed', async () => {
    const greeted = await run({ layout: 'greetings', place: 'Asheville' });
    expect(stored().front).toEqual({ layout: 'greetings', place: 'Asheville' });
    expect(greeted).toMatchObject({ layout: 'greetings', place: 'Asheville' });
    expect(greeted).not.toHaveProperty('caption');
    expect(greeted.message).toContain('with "Greetings from Asheville" over the photo');

    vi.mocked(setDraftPostcardStyle).mockClear();
    vi.mocked(getDraftForPostcardStyle).mockResolvedValue(draft({ front: { layout: 'border', caption: 'Cape Cod' } }));
    const plain = await run({ layout: 'full_bleed' });
    expect(stored().front).toBeNull();
    expect(rendererDocumentPages(plain.previewHtml)[0]).toBe(drawn()[0]);
    expect(plain).toMatchObject({ layout: 'full_bleed' });
    expect(plain.message).toContain('with the photo across the front');
  });

  it("draws a gift postcard's front again and keeps its card's strip on the back", async () => {
    const before = draft({ gift: true });
    vi.mocked(getDraftForPostcardStyle).mockResolvedValue(before);
    const output = await run({ layout: 'greetings', place: 'Rye' });
    const [front, back] = rendererDocumentPages(stored().previewHtml);
    expect(front).toBe(drawn({ front: { layout: 'greetings', place: 'Rye' }, gift: true })[0]);
    expect(back).toBe(rendererDocumentPages(before.preview_html)[1]);
    expect(back).not.toBe(drawn()[1]);
    expect(output.canSendNow).toBe(true);
  });

  it('changes nothing for the style it has, and says so', async () => {
    vi.mocked(getDraftForPostcardStyle).mockResolvedValue(draft({ front: { layout: 'border', caption: 'Cape Cod' } }));
    for (const input of [{ layout: 'border', caption: ' Cape Cod ' }, { size: '6x9', layout: 'Border', caption: 'Cape Cod' }]) {
      const output = await run(input);
      expect(output.message, JSON.stringify(input)).toBe(
        'The postcard is already a 6x9, with the photo in a white border over "Cape Cod". Nothing has changed, and nothing has been sent.'
      );
      expect(output.previewHtml).toBe(draft({ front: { layout: 'border', caption: 'Cape Cod' } }).preview_html);
    }
    expect(setDraftPostcardStyle).not.toHaveBeenCalled();
  });

  it("refuses a front's line the face cannot draw, naming it, before anything is written", async () => {
    await expect(run({ layout: 'border', caption: 'Ωμέγα beach' })).rejects.toThrow('in the caption');
    expect(setDraftPostcardStyle).not.toHaveBeenCalled();
  });
});

describe('set_postcard_style at a new size', () => {
  it('crops the picture again from its source, lays the back out at the size, and prices it per send', async () => {
    const output = await run({ size: '6x4' });

    expect(reprocessPostcardImage).toHaveBeenCalledWith({ url: SOURCE, stored: PRINT['6x9'] }, '6x4', { actorId: 'user-1' });
    const change = stored();
    expect(change).toMatchObject({ size: '6x4', front: null, frontImageData: PRINT['6x4'] });
    expect(rendererDocumentPages(change.previewHtml)).toEqual(drawn({ size: '6x4', small: SMALL_AGAIN }));

    expect(output).toMatchObject({ size: '6x4', layout: 'full_bleed', canSendNow: false, reasonCannotSend: PAID_PER_SEND_REASON });
    expect(output.message).toBe(
      'The postcard is now a 4x6, with the photo across the front. This size is paid per send with Pay & Send, at its own price. Nothing has been sent.'
    );
    expect(getSendEligibility).toHaveBeenCalledWith(10, 2, { mailType: 'postcard', postcardSize: '6x4' });
  });

  // The served schema's enum refuses these first; a call that reaches the tool another way may not.
  it('takes a size written in capitals or with spaces', async () => {
    await expect(run({ size: ' 6X4 ' })).resolves.toMatchObject({ size: '6x4' });
    expect(stored().size).toBe('6x4');
  });

  it('measures a front asked for with a new size at that size', async () => {
    const fits = (caption: string, size: PostcardSize) => {
      try {
        layoutPostcard({ message: '', image: readImageDataUri(PRINT[size]), size, layout: 'border', caption });
        return true;
      } catch (error) {
        if (error instanceof PostcardFrontOverflow) return false;
        throw error;
      }
    };
    let caption = 'W';
    while (fits(caption + 'W', '6x11')) caption += 'W';
    vi.mocked(getDraftForPostcardStyle).mockResolvedValue(draft({ size: '6x11' }));
    // It fits the 11x6 it is, but not the 6x9 asked for with it.
    await expect(refusal({ size: '6x9', layout: 'border', caption })).resolves.toMatchObject({
      message: expect.stringMatching(/^The caption is too long for its line on the front of a 6x9 postcard/)
    });
    await expect(run({ layout: 'border', caption })).resolves.toMatchObject({ size: '6x11', caption });
  });

  it('says a pack pays again once it is back to a 6x9', async () => {
    vi.mocked(getDraftForPostcardStyle).mockResolvedValue(draft({ size: '6x11' }));
    const output = await run({ size: '6x9' });
    expect(stored()).toMatchObject({ size: '6x9', frontImageData: PRINT['6x9'] });
    expect(output).toMatchObject({ size: '6x9', canSendNow: true });
    expect(output.message).toContain('A letter pack pays for this size.');
  });

  it('keeps its front, measured again at the size, and refuses one that no longer fits there', async () => {
    const fits = (caption: string, size: PostcardSize) => {
      try {
        layoutPostcard({ message: '', image: readImageDataUri(PRINT[size]), size, layout: 'border', caption });
        return true;
      } catch (error) {
        if (error instanceof PostcardFrontOverflow) return false;
        throw error;
      }
    };
    // The longest run of wide letters an 11x6's caption holds: too long for a
    // 6x9's, whose front is narrower for its height. (A 4x6 is a 6x9 drawn
    // smaller, so it holds what a 6x9 does.)
    let caption = 'W';
    while (fits(caption + 'W', '6x11')) caption += 'W';
    expect(fits(caption, '6x9')).toBe(false);

    vi.mocked(getDraftForPostcardStyle).mockResolvedValue(draft({ size: '6x11', front: { layout: 'border', caption } }));
    const error = await refusal({ size: '6x9' });
    // Named as the postcard's own, with how to give a shorter one with the size (#601 review round 1).
    expect(error.message).toMatch(
      /^The postcard's caption is too long for its line on the front of a 6x9 postcard: about \d+ of its \d+ characters fit\. To change the size, give layout border and a shorter caption with it\.$/
    );
    expect(setDraftPostcardStyle).not.toHaveBeenCalled();
    expect(reprocessPostcardImage).not.toHaveBeenCalled();

    vi.mocked(getDraftForPostcardStyle).mockResolvedValue(draft({ front: { layout: 'border', caption: 'Rye' } }));
    const output = await run({ size: '6x11' });
    expect(stored()).toMatchObject({ size: '6x11', front: { layout: 'border', caption: 'Rye' } });
    expect(rendererDocumentPages(stored().previewHtml)).toEqual(drawn({ size: '6x11', front: { layout: 'border', caption: 'Rye' }, small: SMALL_AGAIN }));
    expect(output).toMatchObject({ size: '6x11', layout: 'border', caption: 'Rye' });
  });

  it("refuses a message the new size's back cannot hold, saying how many lines it takes", async () => {
    const message = Array.from({ length: 13 }, (_, line) => `Line ${line + 1}`).join('\n');
    vi.mocked(getDraftForPostcardStyle).mockResolvedValue(draft({ message }));
    const error = await refusal({ size: '6x4' });
    expect(error).toMatchObject({
      code: 'MESSAGE_TOO_LONG',
      message: 'The message is too long for the back of a 4x6 postcard: it takes 13 lines and the back holds 11. Keep its size, or make a new preview with a shorter message.'
    });
    expect(reprocessPostcardImage).not.toHaveBeenCalled();
    // The 11x6 holds it.
    await expect(run({ size: '6x11' })).resolves.toMatchObject({ size: '6x11' });
  });

  it('keeps a gift postcard a 6x9, refusing any other size before anything is cropped', async () => {
    vi.mocked(getDraftForPostcardStyle).mockResolvedValue(draft({ gift: true }));
    for (const size of ['6x4', '6x11']) {
      await expect(refusal({ size }), size).resolves.toEqual(expect.objectContaining({
        code: 'GIFT_POSTCARD_SIZE',
        message: 'A gift postcard is a 6x9: the gift letter pays for that size only. To send another size, make a new preview with sendAsGift set to false.'
      }));
    }
    expect(reprocessPostcardImage).not.toHaveBeenCalled();
    expect(setDraftPostcardStyle).not.toHaveBeenCalled();
  });

  it('refuses a collage any other size, in every direction, before anything is cropped (#616)', async () => {
    // Its photos were read once and are not kept: cropping the composite again would cut them at its edges.
    const message =
      'A collage keeps the size it was made at: its photos were read once and are not kept, so they cannot be arranged again. ' +
      'To change the size, make a new preview with quote_and_preview_postcard: the same photos in images or imageUrls, the same message and front, and the size you want. The postcard stays as it is.';
    for (const [from, to] of [['6x9', '6x4'], ['6x9', '6x11'], ['6x4', '6x9'], ['6x11', '6x4']] as const) {
      vi.mocked(getDraftForPostcardStyle).mockResolvedValue(draft({ size: from, collage: true }));
      await expect(refusal({ size: to }), `${from} to ${to}`).resolves.toEqual(expect.objectContaining({ code: 'COLLAGE_SIZE', message }));
    }
    // A front asked for in the same call does not slip the size through.
    vi.mocked(getDraftForPostcardStyle).mockResolvedValue(draft({ collage: true }));
    await expect(refusal({ size: '6x4', layout: 'border', caption: 'Our trip' })).resolves.toMatchObject({ code: 'COLLAGE_SIZE' });
    expect(reprocessPostcardImage).not.toHaveBeenCalled();
    expect(setDraftPostcardStyle).not.toHaveBeenCalled();
  });

  it('crops a photo again at a new size: only a collage keeps its size', async () => {
    // The same call on a draft that records its link goes through.
    await run({ size: '6x4' });
    expect(reprocessPostcardImage).toHaveBeenCalledWith({ url: SOURCE, stored: PRINT['6x9'] }, '6x4', { actorId: 'user-1' });
  });

  it('refuses when the picture cannot be cropped again, leaving the postcard as it is', async () => {
    vi.mocked(reprocessPostcardImage).mockRejectedValue(new ImageProcessingError('PROCESSING_FAILED', "The postcard's stored picture cannot be read."));
    await expect(refusal({ size: '6x11' })).resolves.toMatchObject({
      code: 'PICTURE_UNAVAILABLE',
      message: "The postcard's stored picture cannot be read. The postcard stays as it is."
    });
    expect(setDraftPostcardStyle).not.toHaveBeenCalled();
    // Anything else is not a refusal.
    vi.mocked(reprocessPostcardImage).mockRejectedValue(new Error('out of memory'));
    await expect(run({ size: '6x11' })).rejects.toThrow('out of memory');
  });
});

describe('set_postcard_style refuses', () => {
  it('while neither the sizes nor the layouts are offered', async () => {
    for (const [enabled, renderer] of [['', 'pdf'], ['true', 'html']]) {
      vi.stubEnv('LETTER_IRL_POSTCARD_SIZES_ENABLED', enabled);
      vi.stubEnv('LETTER_IRL_POSTCARD_LAYOUTS_ENABLED', enabled);
      vi.stubEnv('LETTER_IRL_PRINT_RENDERER', renderer);
      await expect(refusal({ size: '6x4' })).resolves.toMatchObject({
        code: 'POSTCARD_STYLES_DISABLED',
        message: 'Postcard sizes and layouts are not available yet. The preview stays as it is.'
      });
    }
    expect(getDraftForPostcardStyle).not.toHaveBeenCalled();
  });

  it('a call that names nothing to change', async () => {
    for (const input of [{}, { size: ' ', layout: '', caption: null }]) {
      await expect(refusal(input), JSON.stringify(input)).resolves.toMatchObject({
        code: 'STYLE_MISSING',
        message: 'Name what to change: the size, or the layout with its caption or place.'
      });
    }
    expect(getDraftForPostcardStyle).not.toHaveBeenCalled();
  });

  it('a size not offered: any but the 6x9 while the sizes are not, and an unknown one', async () => {
    await expect(refusal({ size: 'A5' })).resolves.toMatchObject({ code: 'SIZE_NOT_OFFERED', message: 'The size must be 6x9, 6x4 or 6x11.' });
    offer(false, true);
    await expect(refusal({ size: '6x4' })).resolves.toMatchObject({ code: 'SIZE_NOT_OFFERED', message: 'The size must be 6x9.' });
    // The 6x9 it is changes nothing.
    await expect(run({ size: '6x9' })).resolves.toMatchObject({ size: '6x9' });
    expect(setDraftPostcardStyle).not.toHaveBeenCalled();
  });

  it('a front while the layouts are not offered, as the preview does', async () => {
    offer(true, false);
    await expect(refusal({ layout: 'border', caption: 'Cape Cod' })).resolves.toMatchObject({
      message: 'Postcard layouts are not offered here: the front is the photo alone. Leave layout, caption and place out.'
    });
    // A size alone keeps a front the draft already has.
    vi.mocked(getDraftForPostcardStyle).mockResolvedValue(draft({ front: { layout: 'greetings', place: 'Rye' } }));
    await expect(run({ size: '6x11' })).resolves.toMatchObject({ size: '6x11', layout: 'greetings', place: 'Rye' });
  });

  it('a front its layout does not take, as the preview does', async () => {
    await expect(refusal({ caption: 'Cape Cod' })).resolves.toMatchObject({
      message: 'A caption goes with the border layout: set layout to border, or leave caption out.'
    });
    await expect(refusal({ layout: 'greetings' })).resolves.toMatchObject({
      message: 'The greetings layout needs a place: "Greetings from" where?'
    });
    expect(setDraftPostcardStyle).not.toHaveBeenCalled();
  });

  it.each([
    ['a draft id of the wrong shape', () => undefined, { draftId: 'not-a-draft' }, 'DRAFT_NOT_FOUND'],
    ['a draft not found', () => vi.mocked(getDraftForPostcardStyle).mockResolvedValue(null), {}, 'DRAFT_NOT_FOUND'],
    ['a letter', () => vi.mocked(getDraftForPostcardStyle).mockResolvedValue({ ...draft(), mail_type: 'letter' }), {}, 'DRAFT_NOT_A_POSTCARD'],
    ['a sent draft', () => vi.mocked(getDraftForPostcardStyle).mockResolvedValue({ ...draft(), status: 'consumed' }), {}, 'DRAFT_ALREADY_SENT'],
    ['an expired draft', () => vi.mocked(getDraftForPostcardStyle).mockResolvedValue({ ...draft(), expires_at: NOW }), {}, 'DRAFT_EXPIRED'],
    ['an emptied draft', () => vi.mocked(getDraftForPostcardStyle).mockResolvedValue({ ...draft(), redacted_at: NOW }), {}, 'DRAFT_EXPIRED'],
    ['a legacy preview', () => vi.mocked(getDraftForPostcardStyle).mockResolvedValue({ ...draft(), renderer_version: null }), {}, 'DRAFT_NOT_DRAWN'],
    ['a preview of one page', () => vi.mocked(getDraftForPostcardStyle).mockResolvedValue({ ...draft(), preview_html: renderPostcardPreviewDocument(drawn().slice(0, 1)) }), {}, 'DRAFT_NOT_DRAWN'],
    ['a front the print cannot read', () => vi.mocked(getDraftForPostcardStyle).mockResolvedValue({ ...draft(), postcard_front: { layout: 'collage' } }), {}, 'DRAFT_NOT_DRAWN'],
    [
      'a stored picture that cannot be read',
      () => vi.mocked(getDraftForPostcardStyle).mockResolvedValue({ ...draft(), front_image_data: 'data:image/png;base64,AAAA' }),
      {},
      'DRAFT_NOT_DRAWN'
    ],
    [
      'a front page without the picture it showed',
      () => vi.mocked(getDraftForPostcardStyle).mockResolvedValue({
        ...draft(),
        preview_html: renderPostcardPreviewDocument([drawn()[0].replace(/<image [^>]*\/>/, ''), drawn()[1]])
      }),
      {},
      'DRAFT_NOT_DRAWN'
    ]
  ])('%s', async (_name, setUp, input, code) => {
    setUp();
    await expect(refusal({ layout: 'border', ...input })).resolves.toMatchObject({ code });
    expect(setDraftPostcardStyle).not.toHaveBeenCalled();
  });

  it.each([
    ['not_found', 'DRAFT_NOT_FOUND', "That preview wasn't found. Make a new preview, then try again."],
    ['sent', 'DRAFT_ALREADY_SENT', "This postcard has already been sent, so its size and layout can't change. list_orders shows it."],
    ['expired', 'DRAFT_EXPIRED', 'This preview has expired. Make a new preview: the postcard preview takes a size and a layout itself.'],
    ['checkout_pending', 'DRAFT_CHECKOUT_PENDING', "This preview is tied to a Pay & Send payment, so its size and layout can't change now."],
    ['changed', 'DRAFT_CHANGED', 'The postcard changed while it was being drawn again. Try the change again.']
  ] as const)('what the lock refuses (%s), in its words', async (lock, code, message) => {
    vi.mocked(setDraftPostcardStyle).mockResolvedValue(lock);
    const ctx = context();
    await expect(run({ layout: 'border' }, ctx)).rejects.toMatchObject({ code, message, diagnosticClass: code });
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'draft.postcard_style_refused', reason: code }), expect.any(String));
  });
});

describe('the set_postcard_style tool', () => {
  it('describes only what is offered, as the tools are listed (#601 review round 1)', () => {
    const described = () => (setPostcardStyleTool.description as () => string)();
    offer(true, true);
    expect(described()).toMatch(/^Change a previewed postcard's size or front layout without previewing it again\./);
    expect(described()).toContain('A size or layout left out stays as it is.');
    expect(described()).toContain('the 4x6 and 11x6 are paid per send with Pay & Send');
    offer(true, false);
    expect(described()).toMatch(/^Change a previewed postcard's size without previewing it again\. Give the draftId from the preview, and the size\./);
    expect(described()).not.toContain('layout');
    offer(false, true);
    expect(described()).toMatch(/^Change a previewed postcard's front layout without previewing it again\./);
    expect(described()).toContain('give its caption again to keep it');
    expect(described()).not.toMatch(/size|Pay & Send/);
  });

  it('is a card-callable, idempotent drafting tool', () => {
    expect(setPostcardStyleTool).toMatchObject({ name: 'set_postcard_style', readOnly: false });
    expect(setPostcardStyleTool.meta).toMatchObject({ 'openai/widgetAccessible': true, readOnlyHint: false, idempotentHint: true });
  });
});
