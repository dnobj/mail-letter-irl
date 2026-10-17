/**
 * Held mail prints as previewed (#697, decision D3). PostGrid uploads the PDF
 * the send stored, as it is; without one it lays the mail out again, and
 * holds mail whose layout is not the one the send recorded, before any
 * request, as every refusal of our renderer is held.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostGridProvider } from '../../../src/services/providers/PostGridProvider.js';
import { layoutFingerprint, RENDERER_VERSION } from '../../../src/render/index.js';
import { letterPrintLayout, postcardPrintLayout } from '../../../src/services/printDocument.js';

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

const letter = {
  idempotencyKey: 'letter-stable-id',
  recipientName: 'Sam Rivera',
  recipientAddress: { line1: '350 5th Ave', city: 'New York', state: 'NY', postalCode: '10118' },
  senderName: 'Test Sender',
  senderAddress: { line1: '1600 Pennsylvania Ave NW', city: 'Washington', state: 'DC', postalCode: '20500' },
  message: 'Dear Sam,\n\nHappy birthday.\n\nWarmly,\nTest',
  layoutType: 'text_only' as const,
  rendererVersion: RENDERER_VERSION,
  metadata: { letterId: 'letter-1' }
};

/** A 1x1 grey PNG. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==';

const postcard = {
  idempotencyKey: 'postcard-stable-id',
  recipientName: 'Sam Rivera',
  recipientAddress: { line1: '350 5th Ave', city: 'New York', state: 'NY', postalCode: '10118' },
  senderName: 'Test Sender',
  senderAddress: { line1: '1600 Pennsylvania Ave NW', city: 'Washington', state: 'DC', postalCode: '20500' },
  frontImageBase64: PNG,
  backMessage: 'Wish you were here.',
  size: '6x9' as const,
  rendererVersion: RENDERER_VERSION,
  metadata: { letterId: 'postcard-1' }
};

function accepted() {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify({
    id: 'mail_abc',
    status: 'ready',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    url: 'https://example.test/mail_abc'
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
}

async function uploaded(fetchMock: ReturnType<typeof vi.fn>): Promise<Buffer> {
  const form = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as FormData;
  return Buffer.from(await (form.get('pdf') as File).arrayBuffer());
}

const letterFingerprint = (params: typeof letter) => {
  const print = letterPrintLayout(params as never, 1);
  return layoutFingerprint(print.layout, print.rendererVersion);
};

describe("a held letter's print (#697)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    diagnostics.written.length = 0;
  });

  it('uploads the PDF the send stored, byte for byte, without laying the letter out', async () => {
    const fetchMock = accepted();
    vi.stubGlobal('fetch', fetchMock);
    const stored = Buffer.from('%PDF-1.3 the stored print');
    // Text that would lay out otherwise: the stored PDF is what prints.
    const result = await provider().sendLetter({
      ...letter,
      message: 'Something else entirely',
      heldPrint: { pdf: stored, layoutFingerprint: letterFingerprint(letter) }
    });
    expect(result.success).toBe(true);
    expect((await uploaded(fetchMock)).equals(stored)).toBe(true);
  });

  it('prints a letter that lays out as recorded, from a new layout, when no PDF was stored', async () => {
    const fetchMock = accepted();
    vi.stubGlobal('fetch', fetchMock);
    const result = await provider().sendLetter({ ...letter, heldPrint: { layoutFingerprint: letterFingerprint(letter) } });
    expect(result.success).toBe(true);
    expect((await uploaded(fetchMock)).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('holds a letter that lays out otherwise than recorded, before any request', async () => {
    const fetchMock = accepted();
    vi.stubGlobal('fetch', fetchMock);
    const result = await provider().sendLetter({
      ...letter,
      message: 'Dear Sam,\n\nHappy birthday, and many more.\n\nWarmly,\nTest',
      heldPrint: { layoutFingerprint: letterFingerprint(letter) }
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.metadata).toMatchObject({ submissionOutcome: 'ambiguous', retryable: false, errorClass: 'render_refused' });
    expect(diagnostics.written).toContainEqual(expect.objectContaining({
      event: 'provider.postgrid.render_refused',
      fields: expect.objectContaining({ reason: 'layout_changed', letterId: 'letter-1' })
    }));
  });

  it("holds a letter whose recorded layout is of a scheme this build cannot compare", async () => {
    const fetchMock = accepted();
    vi.stubGlobal('fetch', fetchMock);
    const result = await provider().sendLetter({ ...letter, heldPrint: { layoutFingerprint: `fp2:${'a'.repeat(64)}` } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.metadata).toMatchObject({ errorClass: 'render_refused' });
    expect(diagnostics.written).toContainEqual(expect.objectContaining({
      event: 'provider.postgrid.render_refused',
      fields: expect.objectContaining({ reason: 'unknown_version' })
    }));
  });

  it('still refuses a renderer version this build cannot print, stored PDF or not', async () => {
    const fetchMock = accepted();
    vi.stubGlobal('fetch', fetchMock);
    const result = await provider().sendLetter({ ...letter, rendererVersion: 'pdf-99', heldPrint: { pdf: Buffer.from('%PDF-') } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.metadata).toMatchObject({ errorClass: 'render_refused' });
  });
});

describe("a held postcard's print (#697)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    diagnostics.written.length = 0;
  });

  const postcardFingerprint = () => {
    const print = postcardPrintLayout(postcard as never, '6x9');
    return layoutFingerprint(print.layout, print.rendererVersion);
  };

  it('uploads the PDF the send stored, byte for byte', async () => {
    const fetchMock = accepted();
    vi.stubGlobal('fetch', fetchMock);
    const stored = Buffer.from('%PDF-1.3 the stored postcard');
    const result = await provider().sendPostcard({ ...postcard, heldPrint: { pdf: stored, layoutFingerprint: postcardFingerprint() } });
    expect(result.success).toBe(true);
    expect((await uploaded(fetchMock)).equals(stored)).toBe(true);
  });

  it('prints one that lays out as recorded, and holds one that does not', async () => {
    const fetchMock = accepted();
    vi.stubGlobal('fetch', fetchMock);
    const fingerprint = postcardFingerprint();
    expect((await provider().sendPostcard({ ...postcard, heldPrint: { layoutFingerprint: fingerprint } })).success).toBe(true);

    const refused = await provider().sendPostcard({ ...postcard, backMessage: 'Wish you were here, all of you.', heldPrint: { layoutFingerprint: fingerprint } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refused.metadata).toMatchObject({ errorClass: 'render_refused' });
    expect(diagnostics.written).toContainEqual(expect.objectContaining({
      event: 'provider.postgrid.render_refused',
      fields: expect.objectContaining({ reason: 'layout_changed', letterId: 'postcard-1' })
    }));
  });
});
