import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

/**
 * The letters list leaves out each letter's preview, which the single-letter
 * route keeps (#540 review round 4). A page our renderer drew is about 95 KB,
 * so a list of 100 would be megabytes the website never shows.
 *
 * Both routes give a letter sent with an arrival date its dates, whether it
 * still waits for them and whether it can be cancelled, and the list can be
 * filtered by any status, or by scheduled (#535).
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
import { handleLetterApiRequest, LETTER_STATUS_FILTERS } from '../../../src/api/letterApiHandler.js';

const ROW = {
  letter_id: 'ltr_1',
  user_id: 'auth0|user-1',
  content: { bodyText: 'Dear Sam,', signOff: 'Pat' },
  recipient: { name: 'Sam Rivera' },
  credits_cost: 2,
  status: 'sent',
  tracking_id: null,
  created_at: new Date('2026-09-30T12:00:00Z'),
  sent_at: null,
  provider: 'postgrid',
  arrive_by: null,
  mail_on: null,
  funding_type: 'prepaid_balance'
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authenticateRestRequest).mockResolvedValue({
    ok: true,
    user: { userId: 'auth0|user-1', scopes: ['mail:read'] }
  } as never);
  vi.mocked(rateLimitAccount).mockResolvedValue(false);
});

describe('the letters list and a single letter', () => {
  it('lists letters without selecting or returning their previews', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [ROW] } as never)
      .mockResolvedValueOnce({ rows: [{ count: '1' }] } as never);

    const { status, body } = await call('/api/letters?limit=100');

    expect(status).toBe(200);
    const [sql] = vi.mocked(query).mock.calls[0] as [string];
    expect(sql).toMatch(/SELECT[\s\S]*FROM letters/);
    expect(sql).not.toContain('preview_html');
    expect(body.letters).toHaveLength(1);
    expect(body.letters[0]).not.toHaveProperty('previewHtml');
    expect(body.letters[0].contentPreview).toBe('Dear Sam,');
  });

  it('reads each letter\'s dates and funding, on the list and a single letter (#535)', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [ROW] } as never)
      .mockResolvedValueOnce({ rows: [{ count: '1' }] } as never);
    await call('/api/letters');
    expect((vi.mocked(query).mock.calls[0] as [string])[0]).toMatch(/arrive_by, mail_on, funding_type/);

    vi.mocked(query).mockReset();
    vi.mocked(query).mockResolvedValueOnce({ rows: [ROW] } as never).mockResolvedValue({ rows: [] } as never);
    await call('/api/letters/ltr_1');
    expect((vi.mocked(query).mock.calls[0] as [string])[0]).toMatch(/arrive_by, mail_on, funding_type/);
  });

  it('keeps the preview on the single-letter route', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [{ ...ROW, preview_html: '<svg></svg>' }] } as never)
      .mockResolvedValue({ rows: [] } as never);

    const { status, body } = await call('/api/letters/ltr_1');

    expect(status).toBe(200);
    const [sql] = vi.mocked(query).mock.calls[0] as [string];
    expect(sql).toContain('preview_html');
    expect(body.previewHtml).toBe('<svg></svg>');
  });
});

describe('a letter sent with an arrival date (#535)', () => {
  const DATES = { arrive_by: '2026-10-16', mail_on: '2026-10-06' };
  async function listed(row: Record<string, unknown>) {
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [{ ...ROW, ...row }] } as never)
      .mockResolvedValueOnce({ rows: [{ count: '1' }] } as never);
    const { body } = await call('/api/letters');
    const { arriveBy, mailOn, scheduled, cancellable } = body.letters[0];
    return { arriveBy, mailOn, scheduled, cancellable };
  }

  it('waits for its mail date, scheduled and cancellable', async () => {
    expect(await listed({ ...DATES, status: 'queued' })).toEqual({
      arriveBy: '2026-10-16',
      mailOn: '2026-10-06',
      scheduled: true,
      cancellable: true
    });
    expect(await listed({ ...DATES, status: 'queued', funding_type: 'gift_letter' })).toMatchObject({ cancellable: true });
  });

  it('waits too when Pay & Send paid for it, but cannot be cancelled here', async () => {
    expect(await listed({ ...DATES, status: 'queued', funding_type: 'jit_order' })).toEqual({
      arriveBy: '2026-10-16',
      mailOn: '2026-10-06',
      scheduled: true,
      cancellable: false
    });
  });

  it.each(['processing', 'held', 'accepted', 'in_transit', 'delivered', 'failed', 'cancelled'])(
    'keeps its dates once it no longer waits (%s), with nothing to cancel',
    async status => {
      expect(await listed({ ...DATES, status })).toEqual({
        arriveBy: '2026-10-16',
        mailOn: '2026-10-06',
        scheduled: false,
        cancellable: false
      });
    }
  );

  it('says nothing of dates for a letter without them, or with dates it cannot read', async () => {
    const none = { arriveBy: null, mailOn: null, scheduled: false, cancellable: false };
    expect(await listed({ status: 'queued' })).toEqual(none);
    expect(await listed({ status: 'queued', arrive_by: '16/10/2026', mail_on: '2026-10-06' })).toEqual(none);
    expect(await listed({ status: 'queued', arrive_by: '2026-10-16', mail_on: null })).toEqual(none);
  });

  it('says the same on the single-letter route', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [{ ...ROW, ...DATES, status: 'queued' }] } as never)
      .mockResolvedValue({ rows: [] } as never);
    const { body } = await call('/api/letters/ltr_1');
    expect(body).toMatchObject({ arriveBy: '2026-10-16', mailOn: '2026-10-06', scheduled: true, cancellable: true });
  });
});

describe('the status filter (#535)', () => {
  const sqlOf = (n: number) => (vi.mocked(query).mock.calls[n] as [string, unknown[]]);

  it('takes every status a letter can have', async () => {
    expect(LETTER_STATUS_FILTERS).toEqual([
      'draft',
      'queued',
      'processing',
      'held',
      'sent',
      'accepted',
      'in_transit',
      'delivered',
      'returned',
      'failed',
      'cancelled',
      'scheduled'
    ]);
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [{ count: '0' }] } as never);

    const { status } = await call('/api/letters?status=delivered');

    expect(status).toBe(200);
    expect(sqlOf(0)[0]).toMatch(/AND status = \$2 ORDER BY/);
    expect(sqlOf(0)[1]).toEqual(['auth0|user-1', 'delivered', 20, 0]);
    expect(sqlOf(1)[0]).toMatch(/AND status = \$2$/);
    expect(sqlOf(1)[1]).toEqual(['auth0|user-1', 'delivered']);
  });

  it('lists held mail waiting for its date as scheduled', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [{ count: '0' }] } as never);

    const { status } = await call('/api/letters?status=scheduled');

    expect(status).toBe(200);
    expect(sqlOf(0)[0]).toContain("AND status = 'queued' AND mail_on IS NOT NULL ORDER BY");
    expect(sqlOf(0)[1]).toEqual(['auth0|user-1', 20, 0]);
    expect(sqlOf(1)[0]).toContain("AND status = 'queued' AND mail_on IS NOT NULL");
    expect(sqlOf(1)[1]).toEqual(['auth0|user-1']);
  });

  it('refuses anything else, naming what it takes', async () => {
    const { status, body } = await call('/api/letters?status=lost');
    expect(status).toBe(400);
    expect(body.message).toBe(`Status must be one of: ${LETTER_STATUS_FILTERS.join(', ')}`);
    expect(query).not.toHaveBeenCalled();
  });
});
