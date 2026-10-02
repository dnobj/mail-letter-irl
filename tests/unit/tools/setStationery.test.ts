/**
 * set_stationery (#563): a letter preview's stationery, changed without
 * previewing again. The theme is checked as the previews check theirs, the
 * letter's page is drawn again from the draft's own content (with the small
 * copy of its picture the preview showed, and a gift letter's card page kept
 * as it was), and the draft is restyled only while it waits to be sent. Drawn
 * back to Classic, a preview is byte for byte the one first made.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/draftService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/draftService.js')>()),
  getDraftForStationery: vi.fn(),
  setDraftStationery: vi.fn()
}));

import { getDraftForStationery, setDraftStationery, type DraftForStationery } from '../../../src/services/draftService.js';
import { setStationeryTool } from '../../../src/tools/setStationery.js';
import { layoutLetterForPreview, withDisplayImage } from '../../../src/tools/letterHelpers.js';
import { layoutGiftPage, renderPreviewSvg } from '../../../src/render/index.js';
import { renderLetterPreviewDocument, stampedAddressLines } from '../../../src/services/previewService.js';
import { sampleFundedCard } from '../../../src/services/giftLetterService.js';
import { giftLetterPageCopy } from '../../../src/services/giftCardRenderer.js';
import type { Address, LetterLayoutType, ToolContext } from '../../../src/contracts/types.js';

const DRAFT_ID = '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0';
const NOW = new Date('2026-09-30T12:00:00Z');

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
const FULL = png(1950, 600);
const SMALL = png(390, 120);

/** A pending letter draft and the Classic preview the preview tools drew for it. */
function draft(options: { layoutType?: LetterLayoutType; gift?: boolean; bodyText?: string } = {}): DraftForStationery {
  const layoutType = options.layoutType ?? 'text_only';
  const bodyText = options.bodyText ?? 'Dear Sam,\n\nThank you for the jam.';
  const signOff = 'Love, Pat';
  const image = layoutType === 'text_only' ? undefined : FULL;
  const layout = layoutLetterForPreview({ bodyText, signOff, layoutType, imageData: image }, context(), 'pdf')!;
  const pages = options.gift ? [...layout.pages, layoutGiftPage(giftLetterPageCopy(sampleFundedCard(), SENDER.name))] : layout.pages;
  const previewHtml = renderLetterPreviewDocument(
    renderPreviewSvg(withDisplayImage({ ...layout, pages }, image ? SMALL : undefined), {
      addresses: { from: stampedAddressLines(SENDER), to: stampedAddressLines(RECIPIENT) }
    }),
    { bodyText, signOff }
  );
  return {
    mail_type: 'letter',
    status: 'pending',
    expires_at: new Date('2026-10-01T12:00:00Z'),
    redacted_at: null,
    renderer_version: 'pdf-1',
    body_text: bodyText,
    sign_off: signOff,
    layout_type: layoutType,
    header_image_data: layoutType === 'header_image' ? FULL : null,
    inline_image_data: layoutType === 'inline_image' ? FULL : null,
    sender: SENDER as unknown as Record<string, unknown>,
    recipient: RECIPIENT as unknown as Record<string, unknown>,
    preview_html: previewHtml,
    pages: 1,
    is_gift_send: options.gift === true,
    required_credits: 2
  };
}

type Handler = (input: unknown, ctx: ToolContext) => Promise<Record<string, unknown>>;
const handler = setStationeryTool.handler as unknown as Handler;
const run = (input: Record<string, unknown>, ctx = context()) => handler({ draftId: DRAFT_ID, ...input }, ctx);
const pages = (html: string) => html.match(/<svg [\s\S]*?<\/svg>/g) ?? [];
const inked = (html: string) => html.match(/<path d="M[^"]*" fill="none" stroke="#222222"/g) ?? [];

/** The one restyle written: what setDraftStationery was given. */
function written() {
  expect(setDraftStationery).toHaveBeenCalledTimes(1);
  const [draftId, userId, change, now] = vi.mocked(setDraftStationery).mock.calls[0];
  expect([draftId, userId, now]).toEqual([DRAFT_ID, 'user-1', NOW]);
  return change;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('LETTER_IRL_STATIONERY_ENABLED', 'true');
  vi.stubEnv('LETTER_IRL_PRINT_RENDERER', 'pdf');
  vi.mocked(setDraftStationery).mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('set_stationery', () => {
  it('draws the letter again in the theme, records pdf-2 with it, and says what it did', async () => {
    vi.mocked(getDraftForStationery).mockResolvedValue(draft());

    const output = await run({ stationery: 'Botanical' });

    const change = written();
    const botanical = { theme: 'botanical', dateLine: 'September 30, 2026', source: 'asked' };
    expect(change.stationery).toEqual(botanical);
    // The service records the version that goes with it (rendererVersionFor).
    // And the pages it is laid out on now (#586): one, as before.
    expect(Object.keys(change).sort()).toEqual(['pages', 'previewHtml', 'stationery']);
    expect(change.pages).toBe(1);
    expect(inked(change.previewHtml).length).toBeGreaterThan(0);
    expect(change.previewHtml).toContain('<body data-renderer="pdf-2">');
    expect(change.previewHtml).toContain('<title>September 30, 2026\nDear Sam,\nThank you for the jam.\nLove, Pat</title>');
    // The addresses where PostGrid stamps them, as before.
    expect(change.previewHtml).toContain('>SAM RIVERA</text>');
    expect(output).toMatchObject({
      draftId: DRAFT_ID,
      stationery: botanical,
      previewHtml: change.previewHtml,
      // What it costs as it stands (#586): one page, which the balance pays.
      canSendNow: true,
      sendEligibility: expect.any(Object),
      message: 'The letter is now on the botanical stationery, and the account remembers it for its next letter preview. Nothing has been sent.'
    });
    expect(output).not.toHaveProperty('pages');
    expect(output).not.toHaveProperty('reasonCannotSend');
    expect(getDraftForStationery).toHaveBeenCalledWith(DRAFT_ID, 'user-1');
  });

  it.each([
    ['a text-only letter', {}],
    ['a header image', { layoutType: 'header_image' as const }],
    ['an enclosed image', { layoutType: 'inline_image' as const }],
    ['a gift letter, its card page kept', { gift: true }]
  ])('drawn back to Classic, is byte for byte the preview first made: %s', async (_label, options) => {
    const original = draft(options);
    vi.mocked(getDraftForStationery).mockResolvedValue(original);
    await run({ stationery: 'celebration', headline: 'Happy Birthday!' });
    const themed = written();
    expect(pages(themed.previewHtml)).toHaveLength(pages(original.preview_html!).length);
    // The pages after the letter's, a gift letter's card, as they were drawn.
    expect(pages(themed.previewHtml).slice(1)).toEqual(pages(original.preview_html!).slice(1));
    // The small copy of the picture, never the full image.
    if (options.layoutType) {
      expect(themed.previewHtml).toContain(SMALL);
      expect(themed.previewHtml).not.toContain(FULL);
    }

    vi.mocked(setDraftStationery).mockClear();
    vi.mocked(getDraftForStationery).mockResolvedValue({ ...original, renderer_version: 'pdf-2', preview_html: themed.previewHtml });
    const output = await run({ stationery: 'classic' });
    const classic = written();
    expect(classic.previewHtml).toContain('<body data-renderer="pdf-1">');
    expect(classic.stationery).toEqual({ theme: 'classic', source: 'asked' });
    expect(classic.previewHtml).toBe(original.preview_html);
    expect(output.message).toBe(
      'The letter is now on a plain page, the classic stationery, and the account remembers it for its next letter preview. Nothing has been sent.'
    );
  });

  it.each([['typewriter', 'cr11-'], ['handwritten', 'cv15-']] as const)(
    'restyles to %s, setting the letter in its own typeface, recording pdf-2 (#563 PR 8b)',
    async (theme, glyphs) => {
      vi.mocked(getDraftForStationery).mockResolvedValue(draft());
      const output = await run({ stationery: theme });
      const change = written();
      expect(change.stationery).toEqual({ theme, dateLine: 'September 30, 2026', source: 'asked' });
      expect(change.previewHtml).toContain('<body data-renderer="pdf-2">');
      expect(change.previewHtml).toContain(`id="${glyphs}`);
      expect(change.previewHtml).not.toContain('id="tr12-');
      expect(output.message).toBe(`The letter is now on the ${theme} stationery, and the account remembers it for its next letter preview. Nothing has been sent.`);
    }
  );

  it('refuses Handwritten for text its typeface cannot draw, naming it, writing nothing; Classic and Typewriter take it (#563 PR 8b)', async () => {
    const greek = 'Dear Sam,\n\n' + String.fromCodePoint(0x03ba, 0x03b1, 0x03bb, 0x03b7, 0x03bc, 0x03ad, 0x03c1, 0x03b1);
    vi.mocked(getDraftForStationery).mockResolvedValue(draft({ bodyText: greek }));
    const error = await run({ stationery: 'handwritten' }).catch(e => e);
    expect(error.message).toContain('in the text, which the handwritten stationery prints in its own typeface');
    expect(error.message).toMatch(/The handwritten stationery sets the text in its own typeface, which has fewer: choose another stationery/);
    expect(error).toMatchObject({ diagnosticClass: 'validation_error' });
    expect(setDraftStationery).not.toHaveBeenCalled();
    await run({ stationery: 'typewriter' });
    expect(written().stationery).toMatchObject({ theme: 'typewriter' });
    vi.mocked(setDraftStationery).mockClear();
    await run({ stationery: 'classic' });
    expect(written().stationery).toEqual({ theme: 'classic', source: 'asked' });
  });

  it("refuses Typewriter for a letter its wider typeface pushes past the page, saying so and the way out (#563 PR 8b)", async () => {
    const long = Array.from({ length: 20 }, () => 'All work and no play makes a letter long, and longer still, line after line.').join('\n');
    vi.mocked(getDraftForStationery).mockResolvedValue(draft({ bodyText: long }));
    await expect(run({ stationery: 'typewriter' })).rejects.toThrow(
      /^Letter is \d+ lines too long for one page on the typewriter stationery: it takes \d+ lines and the page holds 26\. The typewriter stationery sets the text in its own typeface: shorten the message, or choose the classic stationery\.$/
    );
    expect(setDraftStationery).not.toHaveBeenCalled();
    await run({ stationery: 'botanical' });
    expect(written().stationery).toMatchObject({ theme: 'botanical' });
  });

  it("prints the return address's initials on Monogram, or the ones asked for", async () => {
    vi.mocked(getDraftForStationery).mockResolvedValue(draft());
    await run({ stationery: 'monogram' });
    expect(written().stationery).toMatchObject({ theme: 'monogram', monogram: 'PE' });
    vi.mocked(setDraftStationery).mockClear();
    await run({ stationery: 'monogram', monogram: 'J. M. S.' });
    expect(written().stationery).toMatchObject({ theme: 'monogram', monogram: 'JMS' });
  });

  it('refuses a headline that pushes the letter past its page, as a preview does, writing nothing', async () => {
    const lines = Array.from({ length: 23 }, (_, index) => `Line ${index + 1}`).join('\n');
    vi.mocked(getDraftForStationery).mockResolvedValue(draft({ bodyText: lines }));
    await expect(run({ stationery: 'celebration', headline: 'Happy Birthday!' })).rejects.toThrow(
      'Letter is 1 line too long for one page on the celebration stationery with a headline: it takes 24 lines and the page holds 23.'
    );
    expect(setDraftStationery).not.toHaveBeenCalled();
  });

  it("refuses initials and a headline the font cannot draw, and the previews' other refusals, writing nothing", async () => {
    vi.mocked(getDraftForStationery).mockResolvedValue(draft());
    const CAKE = String.fromCodePoint(0x1f382);
    await expect(run({ stationery: 'celebration', headline: `Hooray ${CAKE}` })).rejects.toThrow(/in the headline/);
    await expect(run({ stationery: 'botanical', headline: 'Hooray' })).rejects.toThrow('A headline prints only on the celebration stationery.');
    await expect(run({ stationery: 'floral' })).rejects.toThrow('stationery must be one of classic, monogram, botanical, celebration, typewriter or handwritten.');
    expect(setDraftStationery).not.toHaveBeenCalled();
  });

  it('refuses a call that names no theme, reading no draft (#571 review round 3)', async () => {
    for (const input of [{}, { stationery: '' }, { stationery: '  ' }, { stationery: 7 }]) {
      await expect(run(input)).rejects.toMatchObject({
        code: 'STATIONERY_MISSING',
        message: 'Name the stationery: classic, monogram, botanical, celebration, typewriter or handwritten.'
      });
    }
    expect(getDraftForStationery).not.toHaveBeenCalled();
  });

  it('is refused while stationery is not offered, reading no draft', async () => {
    for (const [enabled, renderer] of [['', 'pdf'], ['true', 'html']]) {
      vi.stubEnv('LETTER_IRL_STATIONERY_ENABLED', enabled);
      vi.stubEnv('LETTER_IRL_PRINT_RENDERER', renderer);
      await expect(run({ stationery: 'botanical' })).rejects.toMatchObject({
        code: 'STATIONERY_DISABLED',
        message: 'Stationery is not available yet. The preview stays as it is.'
      });
    }
    expect(getDraftForStationery).not.toHaveBeenCalled();
  });

  it.each([
    ['a draftId that is not one', { draftId: 'nope' }, undefined, 'DRAFT_NOT_FOUND', "That preview wasn't found. Make a new preview, then try again."],
    ['a draft not found', {}, null, 'DRAFT_NOT_FOUND', "That preview wasn't found. Make a new preview, then try again."],
    ['a postcard', {}, { mail_type: 'postcard' }, 'DRAFT_NOT_A_LETTER', 'Stationery is for letters. A postcard keeps its own design.'],
    ['a sent draft', {}, { status: 'consumed' }, 'DRAFT_ALREADY_SENT', "This letter has already been sent, so its stationery can't change. list_orders shows it."],
    ['an expired draft', {}, { status: 'expired' }, 'DRAFT_EXPIRED', 'This preview has expired. Make a new preview: the letter previews take stationery themselves.'],
    ['a draft past its expiry', {}, { expires_at: NOW }, 'DRAFT_EXPIRED', 'This preview has expired. Make a new preview: the letter previews take stationery themselves.'],
    // Before its empty content is laid out (#573 review round 3).
    ['a draft an erasure emptied', {}, { redacted_at: NOW, body_text: '', sender: {}, preview_html: null }, 'DRAFT_EXPIRED', 'This preview has expired. Make a new preview: the letter previews take stationery themselves.'],
    ['a draft the legacy HTML drew', {}, { renderer_version: null }, 'DRAFT_NOT_DRAWN', 'This preview was not drawn in a way that can take stationery. Make a new preview, with stationery if you like.']
  ])('refuses %s before drawing anything', async (_label, input, change, code, message) => {
    if (change !== undefined) vi.mocked(getDraftForStationery).mockResolvedValue(change === null ? null : { ...draft(), ...change });
    await expect(run({ stationery: 'botanical', ...input })).rejects.toMatchObject({ code, message, diagnosticClass: code });
    expect(setDraftStationery).not.toHaveBeenCalled();
    if (change === undefined) expect(getDraftForStationery).not.toHaveBeenCalled();
  });

  it('refuses a draft whose page is not one our renderer drew, or lost its picture, rather than embed the full image', async () => {
    vi.mocked(getDraftForStationery).mockResolvedValue({ ...draft(), preview_html: '<html><body>legacy</body></html>' });
    await expect(run({ stationery: 'botanical' })).rejects.toMatchObject({ code: 'DRAFT_NOT_DRAWN' });
    // Pages are read only from our renderer's document, whatever else holds an svg.
    vi.mocked(getDraftForStationery).mockResolvedValue({ ...draft(), preview_html: '<html><body><svg width="1"></svg></body></html>' });
    await expect(run({ stationery: 'botanical' })).rejects.toMatchObject({ code: 'DRAFT_NOT_DRAWN' });
    const withImage = draft({ layoutType: 'header_image' });
    vi.mocked(getDraftForStationery).mockResolvedValue({ ...withImage, preview_html: withImage.preview_html!.replace(SMALL, 'x') });
    await expect(run({ stationery: 'botanical' })).rejects.toMatchObject({ code: 'DRAFT_NOT_DRAWN' });
    expect(setDraftStationery).not.toHaveBeenCalled();
  });

  it.each([
    ['not_found', 'DRAFT_NOT_FOUND'],
    ['sent', 'DRAFT_ALREADY_SENT'],
    ['expired', 'DRAFT_EXPIRED'],
    ['checkout_pending', 'DRAFT_CHECKOUT_PENDING']
  ] as const)('says why when the draft changed under the lock: %s', async (refusal, code) => {
    vi.mocked(getDraftForStationery).mockResolvedValue(draft());
    vi.mocked(setDraftStationery).mockResolvedValue(refusal);
    const ctx = context();
    await expect(run({ stationery: 'botanical' }, ctx)).rejects.toMatchObject({ code });
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'draft.stationery_refused', reason: code }),
      expect.any(String)
    );
  });

  it('is card-callable, idempotent and not destructive', () => {
    expect(setStationeryTool.meta).toMatchObject({ 'openai/widgetAccessible': true, readOnlyHint: false, idempotentHint: true });
    expect(setStationeryTool.readOnly).toBe(false);
  });
});
