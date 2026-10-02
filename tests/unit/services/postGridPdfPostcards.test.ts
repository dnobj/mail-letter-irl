/**
 * Postcards printed from our own PDF (#534 Phase 4). A postcard whose preview
 * was drawn by src/render (rendererVersion 'pdf-1') goes to PostGrid as a
 * multipart upload of a two-page PDF with its bleed, front then back, a gift
 * send's card in a strip at the foot of the message; every other postcard
 * keeps the legacy HTML. Probe P9 fixed the page size and why the back's right
 * half stays empty, and probe P14 the same for the 4x6 and 11x6 (#594)
 * (docs/learnings/postgrid-pdf-rendering.md).
 */

import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostGridProvider } from '../../../src/services/providers/PostGridProvider.js';
import { layoutPostcard, readImageDataUri, RENDERER_VERSION, renderPdf } from '../../../src/render/index.js';
import { giftPostcardStripCopy } from '../../../src/services/giftCardRenderer.js';

const diagnostics = vi.hoisted(() => ({ written: [] as Array<{ level: string; event: string; fields: Record<string, unknown> }> }));
vi.mock('../../../src/utils/diagnosticLog.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/utils/diagnosticLog.js')>()),
  writeDiagnostic: (level: string, event: string, fields: Record<string, unknown> = {}) => {
    diagnostics.written.push({ level, event, fields });
  }
}));

// The renderer as it is, but for a switch that makes its layout or its
// drawing throw, as a missing font or a pdfkit fault would.
const failing = vi.hoisted(() => ({ layout: false, draw: false }));
vi.mock('../../../src/render/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/render/index.js')>();
  return {
    ...actual,
    layoutPostcard: (...args: Parameters<typeof actual.layoutPostcard>) => {
      if (failing.layout) throw new Error('no font');
      return actual.layoutPostcard(...args);
    },
    renderPdf: (...args: Parameters<typeof actual.renderPdf>) => {
      if (failing.draw) return Promise.reject(new Error('pdfkit fault'));
      return actual.renderPdf(...args);
    }
  };
});

function provider() {
  return new PostGridProvider(
    { name: 'postgrid', displayName: 'PostGrid', enabled: true },
    { apiKey: 'test-key', verbose: false, timeoutMs: 100 }
  );
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

const base = {
  idempotencyKey: 'postcard-stable-id',
  recipientName: 'Sam Rivera',
  recipientAddress: { line1: '350 5th Ave', line2: 'Ste 3300', city: 'New York', state: 'NY', postalCode: '10118' },
  senderName: 'Test Sender',
  senderAddress: { line1: '1600 Pennsylvania Ave NW', city: 'Washington', state: 'DC', postalCode: '20500' },
  frontImageBase64: pngDataUri(300, 200),
  backMessage: 'Dear Sam,\nWish you were here.\nPat',
  size: '6x9' as const,
  rendererVersion: RENDERER_VERSION,
};

/** A message of `count` short lines. */
const lines = (count: number) => Array.from({ length: count }, (_, n) => `Line ${n + 1}`).join('\n');

/** A gift send's card, with the code the send minted. */
const giftCard = {
  state: 'funded' as const,
  code: 'K7M2QX9A',
  url: 'https://letterirl.com/g/K7M2QX9A',
  displayUrl: 'letterirl.com/g',
  redeemBy: '2026-12-16',
};

function accepted() {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify({
    id: 'postcard_abc',
    status: 'ready',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    url: 'https://example.test/postcard_abc',
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
}

describe('postcards printed from our own PDF (#534 Phase 4)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    failing.layout = false;
    failing.draw = false;
  });

  it('uploads the two pages as a multipart form, the contacts and the size beside them', async () => {
    const fetchMock = accepted();
    vi.stubGlobal('fetch', fetchMock);

    await expect(provider().sendPostcard(base)).resolves.toMatchObject({ success: true, trackingId: 'postcard_abc' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/postcards$/);
    expect(init.method).toBe('POST');
    // fetch writes the multipart boundary: no JSON content type may be set.
    expect(init.headers).toEqual({ 'x-api-key': 'test-key', 'Idempotency-Key': 'postcard-stable-id' });
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('to[firstName]')).toBe('Sam');
    expect(form.get('to[lastName]')).toBe('Rivera');
    expect(form.get('to[addressLine2]')).toBe('Ste 3300');
    expect(form.get('from[addressLine1]')).toBe('1600 Pennsylvania Ave NW');
    // An empty field is left out, never sent as "undefined".
    expect(form.has('from[addressLine2]')).toBe(false);
    expect(form.get('size')).toBe('9x6');
    expect(form.get('description')).toBe('Postcard to Sam Rivera');
    expect(form.has('frontHTML')).toBe(false);
    expect(form.has('backHTML')).toBe(false);
    // A letter's fields mean nothing to a postcard.
    expect(form.has('addressPlacement')).toBe(false);
    expect(form.has('color')).toBe(false);
    expect(form.has('doubleSided')).toBe(false);

    const pdf = form.get('pdf') as File;
    expect(pdf.type).toBe('application/pdf');
    const bytes = Buffer.from(await pdf.arrayBuffer()).toString('latin1');
    expect(bytes.startsWith('%PDF-')).toBe(true);
    expect(bytes).toMatch(/\/Type \/Pages[\s\S]*?\/Count 2/);
    // PostGrid refuses a 9 x 6in page; it wants the bleed (probe P9).
    expect([...bytes.matchAll(/\/MediaBox \[([^\]]+)\]/g)].map(match => match[1].trim())).toEqual(['0 0 666 450', '0 0 666 450']);
  });

  it('prints exactly the layout of this image and this message', async () => {
    const fetchMock = accepted();
    vi.stubGlobal('fetch', fetchMock);
    // pdfkit writes the creation time, and an id made from it, into the file.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));

    await provider().sendPostcard(base);

    const form = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    const printed = Buffer.from(await (form.get('pdf') as File).arrayBuffer());
    const expected = await renderPdf(layoutPostcard({ message: base.backMessage, image: readImageDataUri(base.frontImageBase64) }));
    expect(printed.equals(expected)).toBe(true);
  });

  it.each([
    { size: '6x4' as const, postGrid: '6x4', media: '0 0 450 306' },
    { size: '6x11' as const, postGrid: '11x6', media: '0 0 810 450' }
  ])("prints a $size postcard from our PDF: its own page, PostGrid's $postGrid, exactly its layout (#594)", async ({ size, postGrid, media }) => {
    const fetchMock = accepted();
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));

    await expect(provider().sendPostcard({ ...base, size })).resolves.toMatchObject({ success: true, trackingId: 'postcard_abc' });

    const form = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    expect(form.get('size')).toBe(postGrid);
    expect(form.has('frontHTML')).toBe(false);
    expect(form.has('backHTML')).toBe(false);
    const printed = Buffer.from(await (form.get('pdf') as File).arrayBuffer());
    // The page with its bleed, as probe P14 found PostGrid takes it.
    expect([...printed.toString('latin1').matchAll(/\/MediaBox \[([^\]]+)\]/g)].map(match => match[1].trim())).toEqual([media, media]);
    const image = readImageDataUri(base.frontImageBase64);
    expect(printed.equals(await renderPdf(layoutPostcard({ message: base.backMessage, image, size })))).toBe(true);
    // Not the same postcard laid out at 6x9.
    expect(printed.equals(await renderPdf(layoutPostcard({ message: base.backMessage, image })))).toBe(false);
  });

  it('gives an upload thirty seconds, not the JSON budget, before calling it ambiguous', async () => {
    const aborted = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(aborted));

    const result = await provider().sendPostcard(base);

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out after 30000ms');
    expect(result.metadata).toMatchObject({ submissionOutcome: 'ambiguous', retryable: true });
  });

  it.each([
    ['a renderer this build does not know', { rendererVersion: 'pdf-9' }, 'unknown_version', 'pdf-9'],
    // Stationery is a letter's (#563): never printed on a postcard as if it were not there.
    ['a postcard recording stationery\'s renderer', { rendererVersion: 'pdf-2' }, 'unknown_version', 'A postcard is never drawn in stationery'],
    ['a message past its half of the back', { backMessage: lines(17) }, 'overflow', 'runs 1 line(s) past its room on the back'],
    // Each size holds its own lines (#594): 12 on a 4x6, 16 on an 11x6.
    ['a 4x6 message past its room', { size: '6x4' as const, backMessage: lines(13) }, 'overflow', 'runs 1 line(s) past its room on the back'],
    ['an 11x6 message past its room', { size: '6x11' as const, backMessage: lines(17) }, 'overflow', 'runs 1 line(s) past its room on the back'],
    ['an unreadable image', { frontImageBase64: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' }, 'image', "The postcard's image could not be read"],
    // A size no writer stores, as a damaged row could name.
    ['a size our renderer does not know', { size: '5x7' as unknown as '6x4' }, 'size', 'Our renderer draws no 5x7 postcard.'],
    // A gift postcard is 6x9 (#579): its card is never squeezed onto another size.
    ['a gift postcard at 4x6', { size: '6x4' as const, giftCard }, 'size', 'A gift postcard is 6x9, not 6x4.'],
    ['a gift postcard at 11x6', { size: '6x11' as const, giftCard }, 'size', 'A gift postcard is 6x9, not 6x11.'],
    // A gift postcard too: never printed on the HTML from a different layout.
    ['a gift postcard of a renderer this build does not know', { rendererVersion: 'pdf-9', giftCard }, 'unknown_version', 'pdf-9'],
    // The preview refuses such a name; a seed code it never saw can still do it.
    ['a gift card whose words run past its strip', { giftCard, senderName: 'Pat Example '.repeat(30).trim() }, 'render',
      "The postcard could not be laid out: The gift strip runs"]
  ])('holds %s, sends nothing, and says why', async (_name, change, reason, message) => {
    const fetchMock = accepted();
    vi.stubGlobal('fetch', fetchMock);
    diagnostics.written = [];

    const result = await provider().sendPostcard({ ...base, ...change, metadata: { letterId: 'postcard-1' } });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toContain(message);
    // Not an authoritative rejection, so nothing is refunded: held for an
    // operator, under a class that says no request left.
    expect(result.metadata).toMatchObject({ submissionOutcome: 'ambiguous', retryable: false, errorClass: 'render_refused' });
    expect(diagnostics.written).toContainEqual(expect.objectContaining({
      level: 'error',
      event: 'provider.postgrid.render_refused',
      fields: expect.objectContaining({ reason, letterId: 'postcard-1', operation: 'create_postcard' })
    }));
  });

  it.each([
    ['laid out', 'layout', "The postcard could not be laid out: no font"],
    ['drawn', 'draw', "The postcard could not be drawn: pdfkit fault"]
  ] as const)('holds a postcard that cannot be %s, as a refusal with its reason', async (_name, stage, message) => {
    const fetchMock = accepted();
    vi.stubGlobal('fetch', fetchMock);
    diagnostics.written = [];
    failing[stage] = true;

    const result = await provider().sendPostcard({ ...base, metadata: { letterId: 'postcard-2' } });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.error).toBe(message);
    expect(result.metadata).toMatchObject({ submissionOutcome: 'ambiguous', retryable: false, errorClass: 'render_refused' });
    expect(diagnostics.written).toContainEqual(expect.objectContaining({
      event: 'provider.postgrid.render_refused',
      fields: expect.objectContaining({ reason: 'render', letterId: 'postcard-2' })
    }));
  });

  it('never marks a refusal retryable, even when its message reads like a transport failure', async () => {
    vi.stubGlobal('fetch', accepted());

    const result = await provider().sendPostcard({ ...base, rendererVersion: 'network-timeout' });

    expect(result.metadata).toMatchObject({ retryable: false, errorClass: 'render_refused' });
  });

  it('keeps the legacy HTML, in exactly its old shape, for a postcard with no renderer version', async () => {
    for (const rendererVersion of [undefined, null as unknown as string]) {
      const fetchMock = accepted();
      vi.stubGlobal('fetch', fetchMock);

      await expect(provider().sendPostcard({ ...base, rendererVersion })).resolves.toMatchObject({ success: true });

      const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
      expect(init.headers).toEqual({
        'x-api-key': 'test-key',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'postcard-stable-id'
      });
      const body = JSON.parse(init.body as string);
      expect(Object.keys(body)).toEqual(['to', 'from', 'frontHTML', 'backHTML', 'size', 'description']);
      expect(body.backHTML).toContain('Wish you were here.');
      expect(body.size).toBe('9x6');
    }
  });

  it.each([['6x4', '6x4'], ['6x11', '11x6']] as const)('keeps the legacy HTML for a %s postcard with no renderer version', async (size, postGrid) => {
    const fetchMock = accepted();
    vi.stubGlobal('fetch', fetchMock);

    await expect(provider().sendPostcard({ ...base, size, rendererVersion: undefined })).resolves.toMatchObject({ success: true });

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(Object.keys(body)).toEqual(['to', 'from', 'frontHTML', 'backHTML', 'size', 'description']);
    expect(body.size).toBe(postGrid);
  });

  it("prints a gift postcard's card from our PDF: the sender's name and the code the send minted (#534)", async () => {
    const fetchMock = accepted();
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
    diagnostics.written = [];

    await expect(provider().sendPostcard({ ...base, giftCard })).resolves.toMatchObject({ success: true });

    const form = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    expect(form.has('backHTML')).toBe(false);
    const printed = Buffer.from(await (form.get('pdf') as File).arrayBuffer());
    const image = readImageDataUri(base.frontImageBase64);
    const expected = await renderPdf(layoutPostcard({
      message: base.backMessage,
      image,
      strip: giftPostcardStripCopy(giftCard, 'Test Sender')
    }));
    expect(printed.equals(expected)).toBe(true);
    // Not the postcard without its card, nor with someone else's name on it.
    expect(printed.equals(await renderPdf(layoutPostcard({ message: base.backMessage, image })))).toBe(false);
    const unnamed = await renderPdf(layoutPostcard({ message: base.backMessage, image, strip: giftPostcardStripCopy(giftCard, '') }));
    expect(printed.equals(unnamed)).toBe(false);
    // No fallback any more.
    expect(diagnostics.written.map(entry => entry.event)).not.toContain('provider.postgrid.renderer_fallback');
  });

  it('keeps the legacy strip on a gift postcard previewed before the renderer', async () => {
    const fetchMock = accepted();
    vi.stubGlobal('fetch', fetchMock);

    await expect(provider().sendPostcard({ ...base, rendererVersion: undefined, giftCard })).resolves.toMatchObject({ success: true });

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.backHTML).toContain('class="gift-block"');
    expect(body.backHTML).toContain('K7M2-QX9A');
  });
});
