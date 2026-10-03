/**
 * Certified mail at the provider (#625). A letter with an extra service goes to
 * PostGrid with `extraService` set to `certified` or `certified_return_receipt`,
 * exactly as PostGrid names them, by either route (our PDF as a multipart form,
 * the legacy HTML as JSON); a standard letter's request is byte for byte what it
 * was. The carrier's tracking number is not on the first answer: a later status
 * read carries it, and only then.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DIYProvider } from '../../../src/services/providers/DIYProvider.js';
import { DummyProvider } from '../../../src/services/providers/DummyProvider.js';
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

  const STANDARD_FIELDS = [
    'to[firstName]', 'to[lastName]', 'to[addressLine1]', 'to[addressLine2]', 'to[city]', 'to[provinceOrState]',
    'to[postalOrZip]', 'to[country]', 'from[firstName]', 'from[lastName]', 'from[addressLine1]', 'from[city]',
    'from[provinceOrState]', 'from[postalOrZip]', 'from[country]', 'description', 'color', 'doubleSided',
    'addressPlacement'
  ];

  it('adds the one field to the form, before the PDF, and changes no other', async () => {
    const standard = answering(accepted);
    await provider().sendLetter({ ...base, rendererVersion: RENDERER_VERSION });
    expect([...((standard.mock.calls[0] as [string, RequestInit])[1].body as FormData).keys()]).toEqual([...STANDARD_FIELDS, 'pdf']);

    const certified = answering(accepted);
    await provider().sendLetter({ ...base, rendererVersion: RENDERER_VERSION, extraService: 'certified' });
    expect([...((certified.mock.calls[0] as [string, RequestInit])[1].body as FormData).keys()]).toEqual([
      ...STANDARD_FIELDS,
      'extraService',
      'pdf'
    ]);
  });

  it.each(['registered', 'express', 'Certified', ' certified', 'constructor', 'toString', '__proto__', 5, ['certified'], {}])(
    'refuses an extra service it does not sell (%j) before any request, so what paid for it comes back',
    async extraService => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      const fetchMock = answering(accepted);
      const result = await provider().sendLetter({ ...base, rendererVersion: RENDERER_VERSION, extraService: extraService as never });
      expect(result).toMatchObject({
        success: false,
        trackingId: '',
        error: 'PostGrid does not sell that extra service.',
        metadata: { retryable: false, submissionOutcome: 'definite_rejection' }
      });
      expect(fetchMock).not.toHaveBeenCalled();
      // The operator is told, in a fixed word and not the value.
      const logged = errorLog.mock.calls.map(call => String(call[0])).filter(line => line.includes('extra_service_refused'));
      expect(logged).toHaveLength(1);
      expect(JSON.parse(logged[0])).toMatchObject({ event: 'provider.postgrid.extra_service_refused', operation: 'create_letter' });
      expect(logged[0]).not.toContain('constructor');
    }
  );

  // A letter built from stored JSON may write "no service" as null, an empty
  // string or 'standard' (the vocabulary mailServiceOf reads a row by). It is
  // standard mail, not a refusal: refusing it would refund every standard letter.
  it.each([null, '', 'standard'])('sends %j as standard mail, by either route', async extraService => {
    const pdf = answering(accepted);
    await expect(
      provider().sendLetter({ ...base, rendererVersion: RENDERER_VERSION, extraService: extraService as never })
    ).resolves.toMatchObject({ success: true, trackingId: 'letter_cert' });
    expect(((pdf.mock.calls[0] as [string, RequestInit])[1].body as FormData).has('extraService')).toBe(false);

    const html = answering(accepted);
    await expect(provider().sendLetter({ ...base, extraService: extraService as never })).resolves.toMatchObject({
      success: true
    });
    const body = JSON.parse((html.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect('extraService' in body).toBe(false);
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

  it.each(['9407100000000000000000', '9407-1000-0000-0000-0000-00', 'EJ123456789US', '12345678', 'A'.repeat(40)])(
    'carries a number shaped like one: %s',
    async trackingNumber => {
      answering({ ...status, trackingNumber });
      await expect(provider().getStatus('letter_cert')).resolves.toMatchObject({ carrierTrackingNumber: trackingNumber });
    }
  );

  it.each([
    ['one too short', '1234567'],
    ['one too long', 'A'.repeat(41)],
    ['a character that cannot be in one', '9407100000000000/000000'],
    ['a NUL', '94071000\u0000000000000000'],
    ['markup', '<script>alert(1)</script>'],
    ['a leading hyphen', '-9407100000000000000000'],
    ['a line break inside', '9407100000\n000000000000']
  ])('does not carry %s', async (_name, trackingNumber) => {
    answering({ ...status, trackingNumber });
    const result = await provider().getStatus('letter_cert');
    expect('carrierTrackingNumber' in result).toBe(false);
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

  it('says so, with the length and never the value, when PostGrid sets a number this code refuses', async () => {
    const warnLog = vi.spyOn(console, 'warn').mockImplementation(() => {});
    answering({ ...status, trackingNumber: '<b>9407</b>1000000000' });
    await provider().getStatus('letter_cert');
    const logged = warnLog.mock.calls.map(call => String(call[0])).filter(line => line.includes('carrier_number'));
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0])).toMatchObject({
      event: 'provider.postgrid.carrier_number_unrecognised',
      operation: 'get_letter_status',
      length: 21
    });
    expect(logged[0]).not.toContain('9407');
  });

  it.each([[{}], [{ trackingNumber: null }], [{ trackingNumber: '' }], [{ trackingNumber: '   ' }], [{ trackingNumber: '9407100000000000000000' }]])(
    'says nothing when there is no number to refuse (%j)',
    async extra => {
      const warnLog = vi.spyOn(console, 'warn').mockImplementation(() => {});
      answering({ ...status, ...extra });
      await provider().getStatus('letter_cert');
      expect(warnLog.mock.calls.filter(call => String(call[0]).includes('carrier_number'))).toEqual([]);
    }
  );

  it('is never the provider id, which stays the tracking id', async () => {
    answering({ ...status, trackingNumber: '9407100000000000000000' });
    const result = await provider().getStatus('letter_cert');
    expect(result.trackingId).toBe('letter_cert');
    expect(result.carrierTrackingNumber).not.toBe(result.trackingId);
  });
});

describe("the provider's cost estimate with an extra service", () => {
  it('adds the public price of the service to the letter, at most about a dollar high', async () => {
    const standard = await provider().estimateCost(base);
    const certified = await provider().estimateCost({ ...base, extraService: 'certified' });
    const receipt = await provider().estimateCost({ ...base, extraService: 'certified_return_receipt' });

    expect(certified.totalCents - standard.totalCents).toBe(694);
    expect(receipt.totalCents - standard.totalCents).toBe(985);
    expect(certified.servicesCents - standard.servicesCents).toBe(694);
    expect(certified.breakdown).toContainEqual({ item: 'Certified Mail', costCents: 694 });
    expect(receipt.breakdown).toContainEqual({ item: 'Certified Mail with Return Receipt', costCents: 985 });
    expect(standard.breakdown?.some(line => line.item.startsWith('Certified'))).toBe(false);
  });

  it('is the cost a send reports, and unchanged for standard mail and for a service it does not know', async () => {
    answering(accepted);
    const sent = await provider().sendLetter({ ...base, extraService: 'certified' });
    expect(sent.costCents).toBe(85 + 694);
    answering(accepted);
    const plain = await provider().sendLetter(base);
    expect(plain.costCents).toBe(85);

    const unknown = await provider().estimateCost({ ...base, extraService: 'constructor' as never });
    expect(unknown.totalCents).toBe(85);
  });
});

describe('providers that cannot sell an extra service', () => {
  const diy = () => new DIYProvider({ name: 'diy', displayName: 'DIY', enabled: true, config: { verbose: false } });
  const dummy = () =>
    new DummyProvider({ name: 'dummy', displayName: 'Dummy', enabled: true }, { verbose: false, delayMs: 0, failureRate: 0 });

  it.each(['certified', 'certified_return_receipt'] as const)(
    'manual fulfilment refuses %s outright, as an authoritative rejection, queueing nothing',
    async extraService => {
      await expect(diy().sendLetter({ ...base, extraService })).resolves.toEqual({
        success: false,
        trackingId: '',
        error: 'Manual fulfilment cannot send an extra service such as certified mail.',
        metadata: { retryable: false, submissionOutcome: 'definite_rejection' }
      });
    }
  );

  it.each(['express', 'Certified', 5])('manual fulfilment refuses any other service (%j) too', async extraService => {
    await expect(diy().sendLetter({ ...base, extraService: extraService as never })).resolves.toMatchObject({
      success: false,
      metadata: { retryable: false, submissionOutcome: 'definite_rejection' }
    });
  });

  it('manual fulfilment still queues standard mail', async () => {
    await expect(diy().sendLetter({ ...base, metadata: { letterId: 'L1' } })).resolves.toMatchObject({
      success: true,
      trackingId: 'DIY-L1'
    });
  });

  it.each([null, '', 'standard'])('manual fulfilment queues %j as standard mail, not a refusal', async extraService => {
    await expect(
      diy().sendLetter({ ...base, extraService: extraService as never, metadata: { letterId: 'L2' } })
    ).resolves.toMatchObject({ success: true, trackingId: 'DIY-L2' });
  });

  it('the dummy records the service it was asked for, so a test can see it arrive, and nothing for standard mail', async () => {
    const certified = await dummy().sendLetter({ ...base, extraService: 'certified_return_receipt' });
    expect(certified.metadata).toMatchObject({ provider: 'dummy', extraService: 'certified_return_receipt' });
    const standard = await dummy().sendLetter(base);
    expect(standard.metadata).not.toHaveProperty('extraService');
    for (const none of [null, '', 'standard']) {
      const written = await dummy().sendLetter({ ...base, extraService: none as never });
      expect(written.metadata).not.toHaveProperty('extraService');
    }
  });
});
