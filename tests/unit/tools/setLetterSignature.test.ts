/**
 * set_letter_signature (#608 part 4): a letter preview signed or unsigned
 * without previewing again. The letter is laid out again with or without the
 * saved signature's band, in its own stationery, so a band with no room is
 * refused; its page is drawn again from the draft's own content (with the
 * small copy of its picture and a gift letter's card page as they were); and
 * the draft is changed only while it waits to be sent (setDraftSignature).
 * Signed and unsigned again, a preview is byte for byte the one first made.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/draftService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/draftService.js')>()),
  getDraftForStationery: vi.fn(),
  setDraftSignature: vi.fn()
}));

vi.mock('../../../src/services/signatureService.js', () => ({
  getSignature: vi.fn()
}));

import { getDraftForStationery, setDraftSignature, type DraftForStationery } from '../../../src/services/draftService.js';
import { getSignature } from '../../../src/services/signatureService.js';
import { setLetterSignatureTool } from '../../../src/tools/setLetterSignature.js';
import { layoutLetterForPreview, withDisplayImage } from '../../../src/tools/letterHelpers.js';
import { renderPreviewSvg } from '../../../src/render/index.js';
import { renderLetterPreviewDocument, stampedAddressLines } from '../../../src/services/previewService.js';
import type { Address, LetterLayoutType, ToolContext } from '../../../src/contracts/types.js';

const DRAFT_ID = '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0';
const NOW = new Date('2026-10-03T12:00:00Z');

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

/** A PNG's signature and header: enough for the renderer to read its size. */
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
const FULL = uri(pngBytes(1950, 600));
const SMALL = uri(pngBytes(390, 120));
const SAVED_PNG = pngBytes(1200, 300);
const SIGNATURE = uri(SAVED_PNG);
const SAVED = { png: SAVED_PNG, width: 1200, height: 300, useByDefault: true, createdAt: '2026-10-02T14:00:00.000Z', updatedAt: '2026-10-02T14:00:00.000Z' };

/** `count` short lines, each one printed line. */
const lines = (count: number) => Array.from({ length: count }, (_, index) => `Line ${index + 1}`).join('\n');

/** A pending letter draft and the preview the preview tools drew for it, signed or not. */
function draft(options: { layoutType?: LetterLayoutType; bodyText?: string; signed?: boolean; gift?: boolean } = {}): DraftForStationery {
  const layoutType = options.layoutType ?? 'text_only';
  const bodyText = options.bodyText ?? 'Dear Sam,\n\nThank you for the jam.';
  const signOff = 'Love,\nPat';
  const image = layoutType === 'text_only' ? undefined : FULL;
  const signatureImage = options.signed ? SIGNATURE : undefined;
  const layout = layoutLetterForPreview({ bodyText, signOff, layoutType, imageData: image, signatureImage }, context(), 'pdf')!;
  const previewHtml = renderLetterPreviewDocument(
    renderPreviewSvg(withDisplayImage(layout, image ? SMALL : undefined), {
      addresses: { from: stampedAddressLines(SENDER), to: stampedAddressLines(RECIPIENT) }
    }),
    { bodyText, signOff },
    options.signed ? 'pdf-4' : 'pdf-1'
  );
  return {
    mail_type: 'letter',
    status: 'pending',
    expires_at: new Date('2026-10-04T12:00:00Z'),
    redacted_at: null,
    renderer_version: options.signed ? 'pdf-4' : 'pdf-1',
    body_text: bodyText,
    sign_off: signOff,
    layout_type: layoutType,
    header_image_data: layoutType === 'header_image' ? FULL : null,
    inline_image_data: layoutType === 'inline_image' ? FULL : null,
    sender: SENDER as unknown as Record<string, unknown>,
    recipient: RECIPIENT as unknown as Record<string, unknown>,
    preview_html: previewHtml,
    pages: layout.pages.length,
    is_gift_send: options.gift === true,
    required_credits: 2,
    stationery: null,
    signature_image: signatureImage ?? null
  };
}

type Handler = (input: unknown, ctx: ToolContext) => Promise<Record<string, unknown>>;
const handler = setLetterSignatureTool.handler as unknown as Handler;
const run = (input: Record<string, unknown>, ctx = context()) => handler({ draftId: DRAFT_ID, ...input }, ctx);

/** The one change written: what setDraftSignature was given. */
function written() {
  expect(setDraftSignature).toHaveBeenCalledTimes(1);
  const [draftId, userId, change, now] = vi.mocked(setDraftSignature).mock.calls[0];
  expect([draftId, userId, now]).toEqual([DRAFT_ID, 'user-1', NOW]);
  return change;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('LETTER_IRL_SIGNATURES_ENABLED', 'true');
  vi.stubEnv('LETTER_IRL_PRINT_RENDERER', 'pdf');
  vi.mocked(setDraftSignature).mockResolvedValue(null);
  vi.mocked(getSignature).mockResolvedValue(SAVED);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('set_letter_signature', () => {
  it('signs a letter with the signature as saved now, records pdf-4 in its page, and says what it did', async () => {
    const original = draft();
    vi.mocked(getDraftForStationery).mockResolvedValue(original);

    const output = await run({ signature: true });

    const change = written();
    expect(change.signatureImage).toBe(SIGNATURE);
    expect(change.previewHtml).toContain('<body data-renderer="pdf-4">');
    expect(change.previewHtml).toContain(`<image data-role="signature" href="${SIGNATURE}"`);
    expect(change.pages).toBe(1);
    // What the page was drawn from, as read, so a change under it is refused.
    expect(change.drawnFrom).toEqual({
      words: { bodyText: original.body_text, signOff: 'Love,\nPat' },
      stationery: null,
      signature: null
    });
    expect(output).toMatchObject({
      draftId: DRAFT_ID,
      signature: { printed: true, source: 'asked' },
      previewHtml: change.previewHtml,
      canSendNow: true,
      message:
        "The letter now prints the person's saved signature under the closing, and the account's next letter previews print it too. Nothing has been sent."
    });
    expect(output).not.toHaveProperty('pages');
    expect(getDraftForStationery).toHaveBeenCalledWith(DRAFT_ID, 'user-1');
  });

  it.each([
    ['a text-only letter', {}],
    ['a header image', { layoutType: 'header_image' as const }],
    ['an enclosed image', { layoutType: 'inline_image' as const }]
  ])('unsigned again, is byte for byte the preview first made: %s', async (_label, options) => {
    const original = draft(options);
    vi.mocked(getDraftForStationery).mockResolvedValue(original);
    await run({ signature: true });
    const signed = written();
    // The letter's own picture from its small copy, never the signature in its place.
    if (options.layoutType) {
      expect(signed.previewHtml.match(/<image href="([^"]+)"/)?.[1]).toBe(SMALL);
      expect(signed.previewHtml).not.toContain(FULL);
    }

    vi.mocked(setDraftSignature).mockClear();
    vi.mocked(getDraftForStationery).mockResolvedValue({
      ...original,
      renderer_version: 'pdf-4',
      signature_image: SIGNATURE,
      preview_html: signed.previewHtml
    });
    const output = await run({ signature: false });
    const unsigned = written();
    expect(unsigned.signatureImage).toBeNull();
    expect(unsigned.previewHtml).toBe(original.preview_html);
    expect(unsigned.drawnFrom.signature).toBe(SIGNATURE);
    // Turning it off reads no saved signature.
    expect(getSignature).toHaveBeenCalledTimes(1);
    expect(output).toMatchObject({
      signature: { printed: false, source: 'asked' },
      message: "The letter now prints no signature, and the account's next letter previews leave it off unless they ask for it. Nothing has been sent."
    });
  });

  it('draws a themed letter in its own stationery, signed', async () => {
    vi.stubEnv('LETTER_IRL_STATIONERY_ENABLED', 'true');
    vi.mocked(getDraftForStationery).mockResolvedValue({ ...draft(), renderer_version: 'pdf-2', stationery: { theme: 'botanical', dateLine: 'October 3, 2026' } });
    await run({ signature: true });
    const change = written();
    expect(change.previewHtml).toContain('<body data-renderer="pdf-4">');
    expect(change.previewHtml).toContain('October 3, 2026');
    expect(change.drawnFrom.stationery).toEqual({ theme: 'botanical', dateLine: 'October 3, 2026' });
  });

  it('refuses a signature with no room for it, naming the band, writing nothing', async () => {
    // 24 lines and the two-line sign-off fill the page; the band's three do not fit.
    vi.mocked(getDraftForStationery).mockResolvedValue(draft({ bodyText: lines(24) }));
    const error = await run({ signature: true }).catch(e => e);
    expect(error).toMatchObject({ code: 'SIGNATURE_NO_ROOM' });
    expect(error.message).toBe(
      'The signature takes 3 lines, and this letter has no room for them on one page. Shorten the message, then add the signature.'
    );
    expect(setDraftSignature).not.toHaveBeenCalled();
  });

  it("names a gift letter's one page when the band has no room there", async () => {
    vi.stubEnv('LETTER_IRL_ROOM_TO_WRITE_ENABLED', 'true');
    vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
    vi.mocked(getDraftForStationery).mockResolvedValue(draft({ bodyText: lines(24), gift: true }));
    const error = await run({ signature: true }).catch(e => e);
    expect(error.message).toContain("no room for them on a gift letter's one page");
    expect(setDraftSignature).not.toHaveBeenCalled();
  });

  it('runs a letter onto a second page while room to write is offered, and says how it is paid', async () => {
    vi.stubEnv('LETTER_IRL_ROOM_TO_WRITE_ENABLED', 'true');
    vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
    vi.mocked(getDraftForStationery).mockResolvedValue(draft({ bodyText: lines(24) }));
    const output = await run({ signature: true });
    expect(written().pages).toBe(2);
    expect(output).toMatchObject({ pages: 2, canSendNow: false });
    expect(output.message).toContain('It now runs to two pages, printed on both sides, and is paid with Pay & Send.');
  });

  it('prices a certified letter by its service and says its price is the same on a second page (#625)', async () => {
    vi.stubEnv('LETTER_IRL_ROOM_TO_WRITE_ENABLED', 'true');
    vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
    vi.mocked(getDraftForStationery).mockResolvedValue({ ...draft({ bodyText: lines(24) }), mail_service: 'certified' });
    const output = await run({ signature: true });
    expect(written().pages).toBe(2);
    expect(output).toMatchObject({ pages: 2, canSendNow: false, reasonCannotSend: 'Certified mail is paid with Pay & Send.' });
    // The terms say how it travels (#625), so a card that takes them draws a certified letter as one.
    expect(output).toMatchObject({ mailService: 'certified', deliveryClass: 'USPS Certified Mail' });
    expect(output.deliveryDisclaimer).toContain('signed for at delivery');
    expect(output.sendEligibility).toMatchObject({ packPays: false });
    expect(output.message).toContain('It now runs to two pages, printed on both sides. The price is the same.');
    expect(output.message).not.toContain('letter pack');
  });

  it('refuses a draft whose page lost its picture, rather than embed the full image', async () => {
    const withImage = draft({ layoutType: 'header_image' });
    vi.mocked(getDraftForStationery).mockResolvedValue({ ...withImage, preview_html: withImage.preview_html!.replace(SMALL, 'x') });
    await expect(run({ signature: true })).rejects.toMatchObject({ code: 'DRAFT_NOT_DRAWN' });
    expect(setDraftSignature).not.toHaveBeenCalled();
  });

  it('refuses true with none saved, saying how to save one, writing nothing', async () => {
    vi.mocked(getSignature).mockResolvedValue(null);
    vi.mocked(getDraftForStationery).mockResolvedValue(draft());
    const error = await run({ signature: true }).catch(e => e);
    expect(error).toMatchObject({ code: 'SIGNATURE_NOT_SAVED' });
    expect(error.message).toContain('set_signature');
    expect(setDraftSignature).not.toHaveBeenCalled();
  });

  it.each([
    ['not found', null, 'DRAFT_NOT_FOUND'],
    ['a postcard', { ...draft(), mail_type: 'postcard' }, 'DRAFT_NOT_A_LETTER'],
    ['sent', { ...draft(), status: 'consumed' }, 'DRAFT_ALREADY_SENT'],
    ['expired', { ...draft(), expires_at: new Date('2026-10-01T00:00:00Z') }, 'DRAFT_EXPIRED'],
    ['emptied by retention', { ...draft(), redacted_at: new Date('2026-10-02T00:00:00Z') }, 'DRAFT_EXPIRED'],
    ['drawn by the legacy HTML', { ...draft(), renderer_version: null }, 'DRAFT_NOT_DRAWN']
  ] as const)('refuses a draft %s, writing nothing', async (_label, found, code) => {
    vi.mocked(getDraftForStationery).mockResolvedValue(found as never);
    await expect(run({ signature: true })).rejects.toMatchObject({ code });
    expect(setDraftSignature).not.toHaveBeenCalled();
  });

  it.each([
    ['changed', 'DRAFT_CHANGED'],
    ['checkout_pending', 'DRAFT_CHECKOUT_PENDING'],
    ['sent', 'DRAFT_ALREADY_SENT']
  ] as const)("passes on the service's refusal under the lock: %s", async (refusal, code) => {
    vi.mocked(getDraftForStationery).mockResolvedValue(draft());
    vi.mocked(setDraftSignature).mockResolvedValue(refusal);
    await expect(run({ signature: false })).rejects.toMatchObject({ code });
  });

  it('refuses a call that names no choice, or a malformed id, reading no draft', async () => {
    await expect(run({})).rejects.toMatchObject({ code: 'SIGNATURE_CHOICE_MISSING' });
    await expect(run({ signature: 'yes' })).rejects.toMatchObject({ code: 'SIGNATURE_CHOICE_MISSING' });
    await expect(handler({ draftId: 'not-a-uuid', signature: true }, context())).rejects.toMatchObject({ code: 'DRAFT_NOT_FOUND' });
    expect(getDraftForStationery).not.toHaveBeenCalled();
  });

  it.each([
    ['the flag off', { LETTER_IRL_SIGNATURES_ENABLED: '', LETTER_IRL_PRINT_RENDERER: 'pdf' }],
    ['the legacy renderer', { LETTER_IRL_SIGNATURES_ENABLED: 'true', LETTER_IRL_PRINT_RENDERER: 'html' }]
  ])('is refused while signatures are not offered (%s), reading no draft', async (_label, env) => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    await expect(run({ signature: true })).rejects.toMatchObject({ code: 'SIGNATURES_OFF' });
    expect(getDraftForStationery).not.toHaveBeenCalled();
  });

  it('is card-callable, idempotent and not destructive', () => {
    expect(setLetterSignatureTool.meta).toMatchObject({ 'openai/widgetAccessible': true, readOnlyHint: false, idempotentHint: true });
    expect(setLetterSignatureTool.readOnly).toBe(false);
  });
});
