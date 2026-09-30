/**
 * Letters printed from our own PDF (#534 PR 2). A letter whose preview was
 * drawn by src/render (rendererVersion 'pdf-1') goes to PostGrid as a
 * multipart upload of the PDF; every other letter keeps the legacy HTML.
 */

import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostGridProvider } from '../../../src/services/providers/PostGridProvider.js';
import { RENDERER_VERSION } from '../../../src/render/index.js';

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
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    const body = JSON.parse(init.body as string);
    expect(body.html).toContain('Happy birthday.');
    expect(body.addressPlacement).toBe('top_first_page');
  });

  it('prints a gift send on the legacy HTML for now, so its card is never dropped', async () => {
    const fetchMock = accepted();
    vi.stubGlobal('fetch', fetchMock);
    const giftCard = {
      state: 'funded' as const,
      code: 'K7M2QX9A',
      url: 'https://letterirl.com/g/K7M2QX9A',
      displayUrl: 'letterirl.com/g',
      redeemBy: '2026-12-16',
    };

    diagnostics.written = [];
    await expect(provider().sendLetter({ ...base, giftCard })).resolves.toMatchObject({ success: true });

    // The fallback is logged whether or not the provider is verbose.
    expect(diagnostics.written).toContainEqual(expect.objectContaining({
      level: 'warn',
      event: 'provider.postgrid.renderer_fallback',
      fields: expect.objectContaining({ reason: 'gift_card', operation: 'create_letter' })
    }));
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    // The gift page, with its code printed in groups (postGridGiftCard.test.ts).
    expect(body.html).toContain('page-break-before: always');
    expect(body.html).toContain('K7M2-QX9A');
  });

  it('holds a letter whose renderer this build does not know, and sends nothing', async () => {
    const fetchMock = accepted();
    vi.stubGlobal('fetch', fetchMock);

    const result = await provider().sendLetter({ ...base, rendererVersion: 'pdf-9' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toContain('pdf-9');
    // Not an authoritative rejection, so nothing is refunded: held for an operator.
    expect(result.metadata).toMatchObject({ submissionOutcome: 'ambiguous', retryable: false });
  });

  it('holds a letter that no longer fits the page rather than printing it clipped', async () => {
    const fetchMock = accepted();
    vi.stubGlobal('fetch', fetchMock);
    const tooLong = Array.from({ length: 40 }, (_, index) => `Line ${index + 1}`).join('\n');

    const result = await provider().sendLetter({ ...base, message: tooLong });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toContain('past the page');
    expect(result.metadata).toMatchObject({ submissionOutcome: 'ambiguous' });
  });
});
