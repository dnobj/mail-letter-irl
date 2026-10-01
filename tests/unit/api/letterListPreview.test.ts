import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

/**
 * The letters list leaves out each letter's preview, which the single-letter
 * route keeps (#540 review round 4). A page our renderer drew is about 95 KB,
 * so a list of 100 would be megabytes the website never shows.
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
  credits_cost: 2,
  status: 'sent',
  tracking_id: null,
  created_at: new Date('2026-09-30T12:00:00Z'),
  sent_at: null,
  provider: 'postgrid'
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
