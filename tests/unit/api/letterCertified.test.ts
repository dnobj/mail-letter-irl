import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

/**
 * The letters routes for certified mail (#625): the service a letter went as,
 * and the USPS number and its link once the status sync has stored it.
 * `trackingNumber` stays the printer's id for the letter, which is not a
 * carrier number.
 */

vi.mock('../../../src/api/middleware/restAuth.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/api/middleware/restAuth.js')>()),
  authenticateRestRequest: vi.fn()
}));

vi.mock('../../../src/api/middleware/rateLimit.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/api/middleware/rateLimit.js')>()),
  rateLimitAccount: vi.fn()
}));

vi.mock('../../../src/db/index.js', () => ({ query: vi.fn() }));

import { authenticateRestRequest } from '../../../src/api/middleware/restAuth.js';
import { rateLimitAccount } from '../../../src/api/middleware/rateLimit.js';
import { query } from '../../../src/db/index.js';
import { handleLetterApiRequest } from '../../../src/api/letterApiHandler.js';

const ROW = {
  letter_id: 'ltr_1',
  user_id: 'auth0|user-1',
  content: { bodyText: 'Dear Sam,', signOff: 'Pat' },
  recipient: { name: 'Sam Rivera' },
  credits_cost: 0,
  status: 'in_transit',
  tracking_id: 'letter_postgrid_123',
  created_at: new Date('2026-09-30T12:00:00Z'),
  sent_at: new Date('2026-09-30T12:05:00Z'),
  provider: 'postgrid',
  arrive_by: null,
  mail_on: null,
  funding_type: 'jit_order',
  mail_service: 'standard',
  carrier_tracking_number: null
};

function call(url: string) {
  const captured = { status: 0, body: '' };
  const res = {
    statusCode: 0,
    setHeader: () => undefined,
    end(chunk?: string) {
      captured.status = (this as unknown as { statusCode: number }).statusCode;
      captured.body = chunk ?? '';
    }
  } as unknown as ServerResponse;
  const req = { method: 'GET', url, headers: { host: 'api.test' } } as unknown as IncomingMessage;
  return handleLetterApiRequest(req, res, url.split('?')[0]).then(() => ({
    status: captured.status,
    body: JSON.parse(captured.body)
  }));
}

async function listed(row: Record<string, unknown>) {
  vi.mocked(query)
    .mockResolvedValueOnce({ rows: [{ ...ROW, ...row }] } as never)
    .mockResolvedValueOnce({ rows: [{ count: '1' }] } as never);
  const { body } = await call('/api/letters');
  const { mailService, carrierTrackingNumber, carrierTrackingUrl, trackingNumber } = body.letters[0];
  return { mailService, carrierTrackingNumber, carrierTrackingUrl, trackingNumber };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authenticateRestRequest).mockResolvedValue({
    ok: true,
    user: { userId: 'auth0|user-1', scopes: ['mail:read'] }
  } as never);
  vi.mocked(rateLimitAccount).mockResolvedValue(false);
});

describe('certified mail on the letters routes (#625)', () => {
  it('reads the service and the carrier number on the list and on a single letter', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [ROW] } as never)
      .mockResolvedValueOnce({ rows: [{ count: '1' }] } as never);
    await call('/api/letters');
    expect((vi.mocked(query).mock.calls[0] as [string])[0]).toMatch(/mail_service,\s+carrier_tracking_number\s+FROM letters/);

    vi.mocked(query).mockReset();
    vi.mocked(query).mockResolvedValueOnce({ rows: [ROW] } as never).mockResolvedValue({ rows: [] } as never);
    await call('/api/letters/ltr_1');
    expect((vi.mocked(query).mock.calls[0] as [string])[0]).toMatch(/mail_service,\s+carrier_tracking_number\s+FROM letters/);
  });

  it('calls an ordinary letter standard, with no carrier number, and keeps the printer\'s id as trackingNumber', async () => {
    expect(await listed({})).toEqual({
      mailService: 'standard',
      carrierTrackingNumber: null,
      carrierTrackingUrl: null,
      trackingNumber: 'letter_postgrid_123'
    });
  });

  it('gives certified mail its service, and no number before the status sync has stored one', async () => {
    expect(await listed({ mail_service: 'certified' })).toEqual({
      mailService: 'certified',
      carrierTrackingNumber: null,
      carrierTrackingUrl: null,
      trackingNumber: 'letter_postgrid_123'
    });
    expect((await listed({ mail_service: 'certified_return_receipt' })).mailService).toBe('certified_return_receipt');
  });

  it('gives the carrier number and the USPS page that shows it, apart from the printer\'s id', async () => {
    expect(await listed({ mail_service: 'certified', carrier_tracking_number: '9407 1000 0000 0000 0000 00' })).toEqual({
      mailService: 'certified',
      carrierTrackingNumber: '9407 1000 0000 0000 0000 00',
      carrierTrackingUrl: 'https://tools.usps.com/go/TrackConfirmAction?tLabels=9407100000000000000000',
      trackingNumber: 'letter_postgrid_123'
    });
  });

  it('calls text it does not know unknown (null), never standard, and shows no number for it', async () => {
    expect(await listed({ mail_service: 'express', carrier_tracking_number: '9407100000000000000000' })).toEqual({
      mailService: null,
      carrierTrackingNumber: null,
      carrierTrackingUrl: null,
      trackingNumber: 'letter_postgrid_123'
    });
  });

  it.each([null, undefined, '', 'standard'])('calls a letter whose service column holds %j standard', async mail_service => {
    expect((await listed({ mail_service })).mailService).toBe('standard');
  });

  it('shows no number that is not shaped like a carrier number', async () => {
    const letter = await listed({ mail_service: 'certified', carrier_tracking_number: 'https://example.com/<script>' });
    expect(letter).toMatchObject({ mailService: 'certified', carrierTrackingNumber: null, carrierTrackingUrl: null });
  });

  it('shows no number beside an ordinary letter, whatever the column holds', async () => {
    const letter = await listed({ mail_service: 'standard', carrier_tracking_number: '9407100000000000000000' });
    expect(letter).toMatchObject({ mailService: 'standard', carrierTrackingNumber: null, carrierTrackingUrl: null });
  });

  it('says the same on the single-letter route', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [{ ...ROW, mail_service: 'certified_return_receipt', carrier_tracking_number: '9407100000000000000000' }] } as never)
      .mockResolvedValue({ rows: [] } as never);
    const { status, body } = await call('/api/letters/ltr_1');
    expect(status).toBe(200);
    expect(body).toMatchObject({
      mailService: 'certified_return_receipt',
      carrierTrackingNumber: '9407100000000000000000',
      carrierTrackingUrl: 'https://tools.usps.com/go/TrackConfirmAction?tLabels=9407100000000000000000',
      trackingNumber: 'letter_postgrid_123'
    });
  });
});
