/**
 * Certified mail at the provider (#625). A letter with an extra service goes to
 * PostGrid with `extraService` set to `certified` or `certified_return_receipt`,
 * exactly as PostGrid names them, by either route (our PDF as a multipart form,
 * the legacy HTML as JSON); a standard letter's request is byte for byte what it
 * was. The carrier's tracking number is not on the first answer: a later status
 * read carries it, and only then.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostGridProvider } from '../../../src/services/providers/PostGridProvider.js';
import { RENDERER_VERSION } from '../../../src/render/index.js';

function provider() {
  return new PostGridProvider(
    { name: 'postgrid', displayName: 'PostGrid', enabled: true },
    { apiKey: 'test-key', baseUrl: 'https://postgrid.invalid/print-mail/v1', verbose: false, timeoutMs: 100 }
  );
}

const base = {
  idempotencyKey: 'letter-stable-id',
  recipientName: 'Sam Rivera',
  recipientAddress: { line1: '350 5th Ave', line2: 'Ste 3300', city: 'New York', state: 'NY', postalCode: '10118' },
  senderName: 'Test Sender',
  senderAddress: { line1: '1600 Pennsylvania Ave NW', city: 'Washington', state: 'DC', postalCode: '20500' },
  message: 'Dear Sam,\n\nThis is formal notice.\n\nSincerely,\nTest',
  layoutType: 'text_only' as const
};

function answering(body: Record<string, unknown>) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const accepted = {
  id: 'letter_cert',
  status: 'ready',
  createdAt: '2026-10-03T00:00:00.000Z',
  updatedAt: '2026-10-03T00:00:00.000Z',
  url: 'https://example.test/letter_cert'
};

afterEach(() => vi.unstubAllGlobals());

describe('the extra service in the request', () => {
  it.each(['certified', 'certified_return_receipt'] as const)('sends %s with our PDF, as a form field', async extraService => {
    const fetchMock = answering(accepted);
    await expect(provider().sendLetter({ ...base, rendererVersion: RENDERER_VERSION, extraService })).resolves.toMatchObject({
      success: true,
      trackingId: 'letter_cert'
    });
    const form = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('extraService')).toBe(extraService);
    // The rest of the request is the letter's, as before.
    expect(form.get('addressPlacement')).toBe('top_first_page');
    expect(form.get('to[firstName]')).toBe('Sam');
  });

  it.each(['certified', 'certified_return_receipt'] as const)('sends %s with the legacy HTML, in the JSON body', async extraService => {
    const fetchMock = answering(accepted);
    await provider().sendLetter({ ...base, extraService });
    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    const body = JSON.parse(init.body as string);
    expect(body.extraService).toBe(extraService);
    expect(Object.keys(body)).toEqual(['to', 'from', 'html', 'description', 'color', 'doubleSided', 'addressPlacement', 'extraService']);
  });

  it('sends nothing for a standard letter, by either route', async () => {
    const pdf = answering(accepted);
    await provider().sendLetter({ ...base, rendererVersion: RENDERER_VERSION });
    expect(((pdf.mock.calls[0] as [string, RequestInit])[1].body as FormData).has('extraService')).toBe(false);

    const html = answering(accepted);
    await provider().sendLetter(base);
    const body = JSON.parse((html.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect('extraService' in body).toBe(false);
    expect(Object.keys(body)).toEqual(['to', 'from', 'html', 'description', 'color', 'doubleSided', 'addressPlacement']);
  });
});

describe("the carrier's tracking number on a status read", () => {
  const status = {
    id: 'letter_cert',
    object: 'letter',
    live: false,
    status: 'processed_for_delivery',
    createdAt: '2026-10-03T00:00:00.000Z',
    updatedAt: '2026-10-04T00:00:00.000Z'
  };

  it('is carried when PostGrid has set one, trimmed', async () => {
    answering({ ...status, trackingNumber: '  9407 1000 0000 0000 0000 00  ' });
    await expect(provider().getStatus('letter_cert')).resolves.toMatchObject({
      trackingId: 'letter_cert',
      status: 'in_transit',
      carrierTrackingNumber: '9407 1000 0000 0000 0000 00'
    });
  });

  it.each([
    ['no field', {}],
    ['null', { trackingNumber: null }],
    ['an empty string', { trackingNumber: '' }],
    ['only spaces', { trackingNumber: '   ' }],
    ['a number', { trackingNumber: 9407100000000000 }],
    ['an object', { trackingNumber: { value: 'x' } }]
  ])('is absent for %s', async (_name, extra) => {
    answering({ ...status, ...extra });
    const result = await provider().getStatus('letter_cert');
    expect('carrierTrackingNumber' in result).toBe(false);
  });

  it('is never the provider id, which stays the tracking id', async () => {
    answering({ ...status, trackingNumber: '9407100000000000000000' });
    const result = await provider().getStatus('letter_cert');
    expect(result.trackingId).toBe('letter_cert');
    expect(result.carrierTrackingNumber).not.toBe(result.trackingId);
  });
});
