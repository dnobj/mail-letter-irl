/**
 * Letters printed from our own PDF (#534 PR 2). A letter whose preview was
 * drawn by src/render (rendererVersion 'pdf-1') goes to PostGrid as a
 * multipart upload of the PDF, a gift send's card as its second page (PR 5);
 * every other letter keeps the legacy HTML.
 */

import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostGridProvider } from '../../../src/services/providers/PostGridProvider.js';
import { layoutGiftPage, layoutLetter, RENDERER_VERSION, renderPdf, STATIONERY_RENDERER_VERSION } from '../../../src/render/index.js';
import { giftLetterPageCopy } from '../../../src/services/giftCardRenderer.js';

const diagnostics = vi.hoisted(() => ({ written: [] as Array<{ level: string; event: string; fields: Record<string, unknown> }> }));
vi.mock('../../../src/utils/diagnosticLog.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/utils/diagnosticLog.js')>()),
  writeDiagnostic: (level: string, event: string, fields: Record<string, unknown> = {}) => {
    diagnostics.written.push({ level, event, fields });
  }
}));

function provider() {
  return new PostGridProvider(
    { name: 'postgrid', displayName: 'PostGrid', enabled: true },
    { apiKey: 'test-key', verbose: false, timeoutMs: 100 }
  );
}

const base = {
  idempotencyKey: 'letter-stable-id',
  recipientName: 'Sam Rivera',
  recipientAddress: { line1: '350 5th Ave', line2: 'Ste 3300', city: 'New York', state: 'NY', postalCode: '10118' },
  senderName: 'Test Sender',
  senderAddress: { line1: '1600 Pennsylvania Ave NW', city: 'Washington', state: 'DC', postalCode: '20500' },
  message: 'Dear Sam,\n\nHappy birthday.\n\nWarmly,\nTest',
  layoutType: 'text_only' as const,
  rendererVersion: RENDERER_VERSION,
};

const GIFT_CARD = {
  state: 'funded' as const,
  code: 'K7M2QX9A',
  url: 'https://letterirl.com/g/K7M2QX9A',
  displayUrl: 'letterirl.com/g',
  redeemBy: '2026-12-16',
};

function accepted() {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify({
    id: 'letter_abc',
    status: 'ready',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    url: 'https://example.test/letter_abc',
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
}

/** A valid 8-bit grayscale PNG, as a data URI. */
function pngDataUri(width: number, height: number): string {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, body: Buffer) => {
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([length, typed, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  const rows = Buffer.alloc((width + 1) * height, 0x80);
  for (let row = 0; row < height; row++) rows[row * (width + 1)] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

describe('letters printed from our own PDF (#534)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uploads the PDF as a multipart form with the addresses as fields', async () => {
    const fetchMock = accepted();
    vi.stubGlobal('fetch', fetchMock);

    await expect(provider().sendLetter(base)).resolves.toMatchObject({ success: true, trackingId: 'letter_abc' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/letters$/);
    expect(init.method).toBe('POST');
    // fetch writes the multipart boundary: no JSON content type may be set.
    expect(init.headers).toEqual({ 'x-api-key': 'test-key', 'Idempotency-Key': 'letter-stable-id' });
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('to[firstName]')).toBe('Sam');
    expect(form.get('to[lastName]')).toBe('Rivera');
    expect(form.get('to[addressLine1]')).toBe('350 5th Ave');
    expect(form.get('to[addressLine2]')).toBe('Ste 3300');
    expect(form.get('to[postalOrZip]')).toBe('10118');
    expect(form.get('from[addressLine1]')).toBe('1600 Pennsylvania Ave NW');
    expect(form.get('addressPlacement')).toBe('top_first_page');
    expect(form.get('color')).toBe('false');
    expect(form.get('doubleSided')).toBe('false');
    expect(form.get('description')).toBe('Letter to Sam Rivera');
    expect(form.has('html')).toBe(false);

    const pdf = form.get('pdf') as File;
    expect(pdf.type).toBe('application/pdf');
    const bytes = Buffer.from(await pdf.arrayBuffer());
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(bytes.toString('latin1')).toContain(`Letter IRL renderer ${RENDERER_VERSION}`);
    // One page: a letter without a gift card has no second.
    expect(bytes.toString('latin1')).toMatch(/\/Count 1\b/);
  });

  it('draws the header image into the PDF and prints in colour', async () => {
    const fetchMock = accepted();
    vi.stubGlobal('fetch', fetchMock);

    await provider().sendLetter({ ...base, layoutType: 'header_image', headerImageData: pngDataUri(40, 20) });

    const form = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    expect(form.get('color')).toBe('true');
    const bytes = Buffer.from(await (form.get('pdf') as File).arrayBuffer()).toString('latin1');
    expect(bytes).toMatch(/\/Subtype\s*\/Image/);
  });

  it('draws the enclosed image of an inline-image letter into the PDF', async () => {
    const fetchMock = accepted();
    vi.stubGlobal('fetch', fetchMock);

    await provider().sendLetter({ ...base, layoutType: 'inline_image', inlineImageData: pngDataUri(20, 40) });

    const form = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    const bytes = Buffer.from(await (form.get('pdf') as File).arrayBuffer()).toString('latin1');
    expect(bytes).toMatch(/\/Subtype\s*\/Image/);
  });

  it('gives an upload thirty seconds, not the JSON budget, before calling it ambiguous', async () => {
    const aborted = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(aborted));

    const result = await provider().sendLetter(base);

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out after 30000ms');
    expect(result.metadata).toMatchObject({ submissionOutcome: 'ambiguous', retryable: true });
  });

  it('lets an upload run past the JSON budget: a slow upload is not cut off', async () => {
    // The provider's configured budget here is 100ms; the upload's is 30s.
    const slow = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response(JSON.stringify({
        id: 'letter_slow', status: 'ready', createdAt: '', updatedAt: '', url: 'https://example.test/slow'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })), 250);
      init.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      });
    }));
    vi.stubGlobal('fetch', slow);

    await expect(provider().sendLetter(base)).resolves.toMatchObject({ success: true, trackingId: 'letter_slow' });
  });

  it('holds an upload whose success response lacks the order id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'ready' }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    })));

    const result = await provider().sendLetter(base);

    expect(result.success).toBe(false);
    expect(result.error).toContain('missing required fields');
    expect(result.metadata).toMatchObject({ submissionOutcome: 'ambiguous' });
  });

  it('keeps the legacy HTML for a letter with no renderer version', async () => {
    const fetchMock = accepted();
    vi.stubGlobal('fetch', fetchMock);

    await provider().sendLetter({ ...base, rendererVersion: undefined });

    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    // Exactly today's headers, in no other shape.
    expect(init.headers).toEqual({
      'x-api-key': 'test-key',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'letter-stable-id'
    });
    const body = JSON.parse(init.body as string);
    expect(Object.keys(body)).toEqual(['to', 'from', 'html', 'description', 'color', 'doubleSided', 'addressPlacement']);
    expect(body.html).toContain('Happy birthday.');
    expect(body.addressPlacement).toBe('top_first_page');
  });

  it('treats a null version as the legacy HTML, never as an unknown renderer', async () => {
    const fetchMock = accepted();
    vi.stubGlobal('fetch', fetchMock);

    await expect(provider().sendLetter({ ...base, rendererVersion: null as unknown as string })).resolves
      .toMatchObject({ success: true });
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string).html).toContain('Happy birthday.');
  });

  it('refuses an unreadable image before sending, and says why', async () => {
    const fetchMock = accepted();
    vi.stubGlobal('fetch', fetchMock);
    diagnostics.written = [];

    const result = await provider().sendLetter({
      ...base,
      layoutType: 'header_image',
      headerImageData: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
      metadata: { letterId: 'letter-1' }
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.metadata).toMatchObject({ submissionOutcome: 'ambiguous', retryable: false, errorClass: 'render_refused' });
    expect(diagnostics.written).toContainEqual(expect.objectContaining({
      level: 'error',
      event: 'provider.postgrid.render_refused',
      fields: expect.objectContaining({ reason: 'image', letterId: 'letter-1' })
    }));
  });

  it('prints a gift send\'s card as the PDF\'s second page, with the code the send minted', async () => {
    const fetchMock = accepted();
    vi.stubGlobal('fetch', fetchMock);
    // pdfkit writes the creation time, and an id made from it, into the file.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
    try {
      await expect(provider().sendLetter({ ...base, giftCard: GIFT_CARD })).resolves.toMatchObject({ success: true });

      const form = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as FormData;
      expect(form.has('html')).toBe(false);
      const printed = Buffer.from(await (form.get('pdf') as File).arrayBuffer());
      // Exactly the letter, then the card for this code and this sender.
      const expected = layoutLetter({ text: base.message, layoutType: 'text_only' });
      expected.pages.push(layoutGiftPage(giftLetterPageCopy(GIFT_CARD, base.senderName)));
      expect(printed.equals(await renderPdf(expected))).toBe(true);
      expect(printed.toString('latin1')).toMatch(/\/Count 2\b/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds a gift send whose card cannot be drawn, and sends nothing', async () => {
    const fetchMock = accepted();
    vi.stubGlobal('fetch', fetchMock);

    diagnostics.written = [];
    // Longer than the largest QR symbol holds.
    const giftCard = { ...GIFT_CARD, url: `https://letterirl.com/g/${'K'.repeat(4000)}` };
    const result = await provider().sendLetter({ ...base, giftCard, metadata: { letterId: 'letter-gift' } });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toContain('The gift card could not be laid out');
    expect(result.metadata).toMatchObject({ submissionOutcome: 'ambiguous', retryable: false, errorClass: 'render_refused' });
    expect(diagnostics.written).toContainEqual(expect.objectContaining({
      event: 'provider.postgrid.render_refused',
      fields: expect.objectContaining({ reason: 'render', letterId: 'letter-gift' })
    }));
  });

  it('holds a gift send whose card would run off the page, and sends nothing', async () => {
    const fetchMock = accepted();
    vi.stubGlobal('fetch', fetchMock);

    const result = await provider().sendLetter({ ...base, giftCard: GIFT_CARD, senderName: 'Test Sender '.repeat(125).trim() });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.error).toMatch(/The gift card could not be laid out: The gift card runs [\d.]+in past the page's bottom margin\./);
    expect(result.metadata).toMatchObject({ submissionOutcome: 'ambiguous', retryable: false, errorClass: 'render_refused' });
  });

  it('holds a letter whose renderer this build does not know, and sends nothing', async () => {
    const fetchMock = accepted();
    vi.stubGlobal('fetch', fetchMock);

    diagnostics.written = [];
    const result = await provider().sendLetter({ ...base, rendererVersion: 'pdf-9', metadata: { letterId: 'letter-9' } });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toContain('pdf-9');
    // Not an authoritative rejection, so nothing is refunded: held for an
    // operator, under a class that says no request left.
    expect(result.metadata).toMatchObject({ submissionOutcome: 'ambiguous', retryable: false, errorClass: 'render_refused' });
    expect(diagnostics.written).toContainEqual(expect.objectContaining({
      event: 'provider.postgrid.render_refused',
      fields: expect.objectContaining({ reason: 'unknown_version', letterId: 'letter-9' })
    }));
  });

  it('never marks a refusal retryable, even when its message reads like a transport failure', async () => {
    const fetchMock = accepted();
    vi.stubGlobal('fetch', fetchMock);

    // The refusal's message names the version, which here says "timeout".
    const result = await provider().sendLetter({ ...base, rendererVersion: 'network-timeout' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.error).toContain('network-timeout');
    expect(result.metadata).toMatchObject({ retryable: false, errorClass: 'render_refused' });
  });

  it('holds a letter that no longer fits the page rather than printing it clipped', async () => {
    const fetchMock = accepted();
    vi.stubGlobal('fetch', fetchMock);
    const tooLong = Array.from({ length: 40 }, (_, index) => `Line ${index + 1}`).join('\n');

    diagnostics.written = [];
    const result = await provider().sendLetter({ ...base, message: tooLong });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toContain('past the page');
    expect(result.metadata).toMatchObject({ submissionOutcome: 'ambiguous', retryable: false, errorClass: 'render_refused' });
    expect(diagnostics.written).toContainEqual(expect.objectContaining({
      event: 'provider.postgrid.render_refused',
      fields: expect.objectContaining({ reason: 'overflow' })
    }));
  });

  describe('letters of more than one page (#586)', () => {
    const lines = (count: number) => Array.from({ length: count }, (_, index) => `Line ${index + 1}`).join('\n');

    async function sent(fetchMock: ReturnType<typeof accepted>) {
      const form = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as FormData;
      return { form, pdf: Buffer.from(await (form.get('pdf') as File).arrayBuffer()) };
    }

    it.each([
      [2, 40],
      [3, 75]
    ])('prints a letter of %i pages double-sided, laid out on exactly those pages', async (pages, count) => {
      const fetchMock = accepted();
      vi.stubGlobal('fetch', fetchMock);
      // pdfkit writes the creation time, and an id made from it, into the file.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-02T12:00:00Z'));
      try {
        const result = await provider().sendLetter({ ...base, message: lines(count), pages });
        expect(result).toMatchObject({ success: true });
        // An extra 10c to print both sides, and 10c for each page past the first.
        expect(result.costCents).toBe(85 + 10 + 10 * (pages - 1));

        const { form, pdf } = await sent(fetchMock);
        expect(form.get('doubleSided')).toBe('true');
        expect(form.get('addressPlacement')).toBe('top_first_page');
        const expected = layoutLetter({ text: lines(count), layoutType: 'text_only' }, { maxPages: pages });
        expect(expected.pages).toHaveLength(pages);
        expect(pdf.equals(await renderPdf(expected))).toBe(true);
        expect(pdf.toString('latin1')).toMatch(new RegExp(`/Count ${pages}\\b`));
      } finally {
        vi.useRealTimers();
      }
    });

    it('prices the extra pages of a letter in colour at 20c each', async () => {
      vi.stubGlobal('fetch', accepted());
      // The outbox passes the colour it decided (letterJobService.letterParams).
      const header = { ...base, layoutType: 'header_image' as const, headerImageData: pngDataUri(600, 200), color: true, message: lines(40), pages: 2 };
      const result = await provider().sendLetter(header);
      expect(result).toMatchObject({ success: true });
      expect(result.costCents).toBe(120 + 10 + 20);
    });

    it('prints one page single-sided, whatever doubleSided says, and a gift card on a sheet of its own', async () => {
      const fetchMock = accepted();
      vi.stubGlobal('fetch', fetchMock);
      await provider().sendLetter({ ...base, doubleSided: true });
      await provider().sendLetter({ ...base, giftCard: GIFT_CARD, doubleSided: true, pages: 1 });
      for (const [, init] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
        expect((init.body as FormData).get('doubleSided')).toBe('false');
      }
    });

    it.each([
      ['no page', 0],
      ['four pages', 4],
      ['part of a page', 1.5],
      ['a count that is text', '2' as unknown as number]
    ])('holds a letter whose page count is %s, and sends nothing', async (_label, pages) => {
      const fetchMock = accepted();
      vi.stubGlobal('fetch', fetchMock);
      diagnostics.written = [];
      const result = await provider().sendLetter({ ...base, message: lines(40), pages, metadata: { letterId: 'letter-pages' } });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.error).toBe("The letter's page count is not a whole number from 1 to 3.");
      expect(result.metadata).toMatchObject({ submissionOutcome: 'ambiguous', retryable: false, errorClass: 'render_refused' });
      expect(diagnostics.written).toContainEqual(expect.objectContaining({
        event: 'provider.postgrid.render_refused',
        fields: expect.objectContaining({ reason: 'pages', letterId: 'letter-pages' })
      }));
    });

    it('holds a longer letter on the legacy HTML, and a gift letter of more than one page', async () => {
      const fetchMock = accepted();
      vi.stubGlobal('fetch', fetchMock);
      const legacy = await provider().sendLetter({ ...base, rendererVersion: undefined, message: lines(40), pages: 2 });
      expect(legacy.error).toBe('A letter of more than one page prints only from our renderer, not the legacy HTML.');
      const gift = await provider().sendLetter({ ...base, giftCard: GIFT_CARD, message: lines(40), pages: 2 });
      expect(gift.error).toBe('A gift letter prints on one page, its card on a sheet of its own.');
      expect(fetchMock).not.toHaveBeenCalled();
      for (const result of [legacy, gift]) {
        expect(result.metadata).toMatchObject({ submissionOutcome: 'ambiguous', retryable: false, errorClass: 'render_refused' });
      }
    });

    it('holds a letter that now lays out on fewer pages than it was previewed on, as a layout that changed', async () => {
      const fetchMock = accepted();
      vi.stubGlobal('fetch', fetchMock);
      diagnostics.written = [];
      const result = await provider().sendLetter({ ...base, message: lines(40), pages: 3 });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.error).toBe('The letter lays out on 2 page(s), not the 3 it was previewed on.');
      expect(result.metadata).toMatchObject({ errorClass: 'render_refused' });
      // Retried once the renderer is fixed, as an overflow is: the reason says so alone.
      expect(diagnostics.written).toContainEqual(expect.objectContaining({
        event: 'provider.postgrid.render_refused',
        fields: expect.objectContaining({ reason: 'overflow' })
      }));
    });

    it.each([undefined, null as unknown as number])('reads a page count of %s as one page', async pages => {
      const fetchMock = accepted();
      vi.stubGlobal('fetch', fetchMock);
      await expect(provider().sendLetter({ ...base, pages })).resolves.toMatchObject({ success: true, costCents: 85 });
      const { form, pdf } = await sent(fetchMock);
      expect(form.get('doubleSided')).toBe('false');
      expect(pdf.toString('latin1')).toMatch(/\/Count 1\b/);
    });

    it('prints a two-page letter in its stationery, the theme on page 1 only', async () => {
      const fetchMock = accepted();
      vi.stubGlobal('fetch', fetchMock);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-02T12:00:00Z'));
      try {
        const stationery = { theme: 'botanical' as const, dateLine: 'October 2, 2026' };
        await expect(provider().sendLetter({
          ...base, rendererVersion: STATIONERY_RENDERER_VERSION, stationery, message: lines(40), pages: 2
        })).resolves.toMatchObject({ success: true });

        const { form, pdf } = await sent(fetchMock);
        expect(form.get('doubleSided')).toBe('true');
        const expected = layoutLetter({ text: lines(40), layoutType: 'text_only', stationery }, { maxPages: 2 });
        expect(expected.pages).toHaveLength(2);
        expect(expected.pages[1].items.some(item => item.kind === 'path')).toBe(false);
        expect(pdf.equals(await renderPdf(expected, STATIONERY_RENDERER_VERSION))).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('holds a letter that runs past its pages rather than printing it clipped', async () => {
      const fetchMock = accepted();
      vi.stubGlobal('fetch', fetchMock);
      // 26 lines fill page 1 and 33 page 2.
      const result = await provider().sendLetter({ ...base, message: lines(26 + 33 + 4), pages: 2 });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.error).toBe('The letter runs 4 line(s) past its 2 pages.');
      expect(result.metadata).toMatchObject({ errorClass: 'render_refused' });
    });
  });

  describe('stationery (#563)', () => {
    const BOTANICAL = { theme: 'botanical' as const, dateLine: 'October 1, 2026' };

    /** The PDF uploaded for `params`, rendered at a fixed time so it can be compared byte for byte. */
    async function printed(params: Record<string, unknown>) {
      const fetchMock = accepted();
      vi.stubGlobal('fetch', fetchMock);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
      try {
        const result = await provider().sendLetter({ ...base, ...params } as Parameters<PostGridProvider['sendLetter']>[0]);
        const call = fetchMock.mock.calls[0] as [string, RequestInit] | undefined;
        const pdf = call ? Buffer.from(await ((call[1].body as FormData).get('pdf') as File).arrayBuffer()) : null;
        return { result, pdf, fetchMock };
      } finally {
        vi.useRealTimers();
      }
    }

    async function drawn(stationery?: typeof BOTANICAL, giftCard?: typeof GIFT_CARD) {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
      try {
        const layout = layoutLetter({ text: base.message, layoutType: 'text_only', stationery });
        if (giftCard) layout.pages.push(layoutGiftPage(giftLetterPageCopy(giftCard, base.senderName)));
        return await renderPdf(layout, stationery ? STATIONERY_RENDERER_VERSION : RENDERER_VERSION);
      } finally {
        vi.useRealTimers();
      }
    }

    it('prints a pdf-2 letter in the stationery it was drawn in', async () => {
      const { result, pdf } = await printed({ rendererVersion: STATIONERY_RENDERER_VERSION, stationery: BOTANICAL });

      expect(result.success).toBe(true);
      expect(pdf!.equals(await drawn(BOTANICAL))).toBe(true);
      expect(pdf!.equals(await drawn())).toBe(false);
      // The file names the version it was drawn as (#563 review round 3).
      expect(pdf!.toString('latin1')).toContain(`Letter IRL renderer ${STATIONERY_RENDERER_VERSION}`);
    });

    it.each([['typewriter'], ['handwritten']] as const)('prints a pdf-2 letter on the %s stationery in its own typeface (#563 PR 8b)', async theme => {
      const stationery = { theme, dateLine: 'October 1, 2026' };
      const { result, pdf } = await printed({ rendererVersion: STATIONERY_RENDERER_VERSION, stationery });

      expect(result.success).toBe(true);
      expect(pdf!.equals(await drawn(stationery))).toBe(true);
      expect(pdf!.equals(await drawn(BOTANICAL))).toBe(false);
      expect(pdf!.equals(await drawn())).toBe(false);
    });

    it("prints a pdf-2 gift send's themed page, then today's card page (#563 review round 3)", async () => {
      const { result, pdf } = await printed({
        rendererVersion: STATIONERY_RENDERER_VERSION,
        stationery: BOTANICAL,
        giftCard: GIFT_CARD
      });

      expect(result.success).toBe(true);
      expect(pdf!.equals(await drawn(BOTANICAL, GIFT_CARD))).toBe(true);
      expect(pdf!.toString('latin1')).toMatch(/\/Count 2\b/);
    });

    it('prints a pdf-1 letter as Classic, whatever stationery its content carries', async () => {
      const { pdf } = await printed({ rendererVersion: RENDERER_VERSION, stationery: BOTANICAL });

      expect(pdf!.equals(await drawn())).toBe(true);
    });

    it.each([
      ['no stationery', undefined],
      ['a theme this build does not draw', { theme: 'floral' }],
      ['Classic, which is never stored', { theme: 'classic' }],
      ['a slot that is not text', { theme: 'monogram', monogram: 42 }]
    ])('holds a pdf-2 letter with %s, and sends nothing', async (_label, stationery) => {
      diagnostics.written = [];
      const { result, fetchMock } = await printed({ rendererVersion: STATIONERY_RENDERER_VERSION, stationery, metadata: { letterId: 'letter-s' } });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.error).toContain('stationery this build cannot read');
      expect(result.metadata).toMatchObject({ submissionOutcome: 'ambiguous', retryable: false, errorClass: 'render_refused' });
      expect(diagnostics.written).toContainEqual(expect.objectContaining({
        event: 'provider.postgrid.render_refused',
        fields: expect.objectContaining({ reason: 'render', letterId: 'letter-s' })
      }));
    });

    it('holds a pdf-2 letter whose headline no longer fits, rather than printing it otherwise', async () => {
      const headline = 'Congratulations on your graduation and your new job in the city, from all of us!';
      const { result, fetchMock } = await printed({
        rendererVersion: STATIONERY_RENDERER_VERSION,
        stationery: { theme: 'celebration', headline }
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.error).toContain('could not be laid out');
      expect(result.metadata).toMatchObject({ errorClass: 'render_refused' });
    });
  });

  it('can print every renderer version the database admits (migration CHECK)', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { PRINTABLE_RENDERER_VERSIONS } = await import('../../../src/render/index.js');
    const migrations = readdirSync('db/migrations').filter(name => name.endsWith('.sql')).sort();
    // The newest CHECK on renderer_version, whatever its constraint is named.
    const latest = migrations.filter(name => /CHECK\s*\(\s*renderer_version\b/i.test(readFileSync(`db/migrations/${name}`, 'utf8'))).at(-1)!;
    const check = readFileSync(`db/migrations/${latest}`, 'utf8');
    // `renderer_version = 'x'` today; a later migration may list them: IN ('x', 'y').
    const admitted = [
      ...[...check.matchAll(/renderer_version\s*=\s*'([^']+)'/g)].map(match => match[1]),
      ...[...check.matchAll(/renderer_version\s+IN\s*\(([^)]*)\)/gi)]
        .flatMap(match => [...match[1].matchAll(/'([^']+)'/g)].map(value => value[1]))
    ];
    expect(admitted.length).toBeGreaterThan(0);
    for (const version of admitted) expect(PRINTABLE_RENDERER_VERSIONS.has(version)).toBe(true);
    // And what previews will write is admitted.
    expect(admitted).toContain(RENDERER_VERSION);
  });
});
