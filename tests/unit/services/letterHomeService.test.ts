import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../src/db/index.js', () => ({ query: vi.fn() }));
import { query } from '../../../src/db/index.js';
import { readLetterHome } from '../../../src/services/letterHomeService.js';
import { openLetterHomeTool } from '../../../src/tools/openLetterHome.js';

const row = (changes: Record<string, unknown> = {}) => ({
  kind: 'order', id: 'order-1', name: 'Ruth', city: 'Chicago', state: 'IL', status: 'accepted',
  created_at: new Date('2026-10-04T00:00:00Z'), expires_at: null,
  arrive_by: null, mail_on: null, mail_type: 'letter', mail_service: 'standard',
  carrier_tracking_number: null, is_gift_send: false, ...changes
});
const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), child: vi.fn() };
const context = { user: { userId: 'owner', orders: [] }, logger, correlationId: 'test' } as any;

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => vi.unstubAllEnvs());

describe('readLetterHome', () => {
  it('reads one bounded snapshot for the account and no street addresses or content', async () => {
    vi.stubEnv('LETTER_IRL_WEBSITE_BASE_URL', 'https://site.example');
    vi.mocked(query).mockResolvedValueOnce({ rows: [] } as any);
    expect(await readLetterHome('owner')).toEqual({ drafts: [], orders: [], recipients: [], limit: 20, websiteOrigin: 'https://site.example' });
    const [sql, values] = vi.mocked(query).mock.calls[0];
    expect(values).toEqual(['owner', 20]);
    expect(sql.match(/WHERE user_id = \$1/g)).toHaveLength(2);
    expect(sql.match(/LIMIT \$2/g)).toHaveLength(2);
    expect(sql.match(/redacted_at IS NULL/g)).toHaveLength(2);
    expect(sql).toContain("status = 'pending' AND expires_at > NOW()");
    expect(sql).not.toMatch(/body_text|sign_off|addressLine1|postalCode|preview_html|signature_image|front_image_data/);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('summarizes drafts, scheduled mail, gifts and deduplicates recent recipients', async () => {
    vi.stubEnv('LETTER_IRL_WEBSITE_BASE_URL', 'https://dev.example.test');
    vi.mocked(query).mockResolvedValueOnce({ rows: [
      row({ kind: 'draft', id: 'draft-1', mail_type: 'postcard', expires_at: new Date('2026-10-05T00:00:00Z'), is_gift_send: true, arrive_by: '2026-10-20', mail_on: '2026-10-09' }),
      row({ status: 'queued', arrive_by: '2026-10-20', mail_on: '2026-10-09', is_gift_send: true }),
      row({ id: 'order-2', status: 'delivered' })
    ] } as any);
    const home = await readLetterHome('owner');
    expect(home.drafts[0]).toMatchObject({ draftId: 'draft-1', mailType: 'postcard', expiresAt: '2026-10-05T00:00:00.000Z', confirmationUrl: 'https://dev.example.test/confirm/draft-1', isGiftSend: true });
    expect(home.orders[0]).toMatchObject({ status: 'scheduled', arriveBy: '2026-10-20', mailOn: '2026-10-09', isGiftSend: true });
    expect(home.drafts[0]).toMatchObject({ arriveBy: '2026-10-20', mailOn: '2026-10-09' });
    expect(home.orders[1].status).toBe('delivered');
    expect(home.recipients).toEqual([{ name: 'Ruth', city: 'Chicago', state: 'IL' }]);
  });

  it.each([
    ['draft', 'pending'], ['queued', 'pending'], ['held', 'pending'], ['processing', 'printing'],
    ['sent', 'accepted'], ['accepted', 'accepted'], ['in_transit', 'in_transit'],
    ['delivered', 'delivered'], ['returned', 'returned'], ['failed', 'failed'], ['cancelled', 'cancelled']
  ])('maps %s without implying confirmed delivery', async (status, expected) => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [row({ status })] } as any);
    expect((await readLetterHome('owner')).orders[0].status).toBe(expected);
  });

  it.each(['failed', 'cancelled', 'returned', 'queued', 'accepted'])('uses existing certified wording for %s', async status => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [row({ status, mail_service: 'certified_return_receipt', carrier_tracking_number: '9400111899223856928499' })] } as any);
    const order = (await readLetterHome('owner')).orders[0];
    expect(order).toMatchObject({ mailService: 'certified_return_receipt', carrierTrackingNumber: '9400111899223856928499' });
    expect(order.carrierTrackingUrl).toMatch(/^https:\/\/tools\.usps\.com\//);
    expect(order.certifiedNote).toContain('USPS Certified Mail');
    if (status === 'failed' || status === 'cancelled' || status === 'returned') {
      expect(order.certifiedNote).not.toMatch(/check again later|ask USPS for it/);
    }
  });

  it('drops invalid carrier numbers and fails instead of claiming empty lists', async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [row({ mail_service: 'certified', carrier_tracking_number: '<script>' })] } as any);
    expect((await readLetterHome('owner')).orders[0]).not.toHaveProperty('carrierTrackingUrl');
    vi.mocked(query).mockRejectedValueOnce(new Error('database unavailable'));
    await expect(readLetterHome('owner')).rejects.toThrow('database unavailable');
  });
});

describe('open_letter_home handler', () => {
  it.each(['', 'false', 'ture'])('refuses while flag is %s, without reading the database', async flag => {
    vi.stubEnv('LETTER_IRL_HOME_ENABLED', flag);
    await expect(openLetterHomeTool.handler({}, context)).rejects.toThrow('not available');
    expect(query).not.toHaveBeenCalled();
  });

  it('uses only the context account and sanitizes database errors and logs', async () => {
    vi.stubEnv('LETTER_IRL_HOME_ENABLED', 'true');
    vi.mocked(query).mockRejectedValueOnce(new Error('secret street and token'));
    await expect(openLetterHomeTool.handler({}, context)).rejects.toThrow('Unable to load your Letter IRL home');
    expect(vi.mocked(query).mock.calls[0][1]).toEqual(['owner', 20]);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret');
  });
});

describe('home scheduling and share configuration', () => {
  it.each(['prepaid_balance', 'gift_letter'])('offers confirmed cancellation for scheduled %s only while arrive-by is enabled', async funding_type => {
    vi.stubEnv('LETTER_IRL_ARRIVE_BY_ENABLED', 'true');
    vi.mocked(query).mockResolvedValue({ rows: [row({ status: 'queued', funding_type, arrive_by: '2026-10-20', mail_on: '2026-10-09' })] } as any);
    expect((await readLetterHome('owner')).orders[0].cancellable).toBe(true);
    vi.stubEnv('LETTER_IRL_ARRIVE_BY_ENABLED', 'false');
    expect((await readLetterHome('owner')).orders[0].cancellable).toBe(false);
  });
  it.each(['jit_order', 'unknown', null])('never offers cancellation for funding %s', async funding_type => {
    vi.stubEnv('LETTER_IRL_ARRIVE_BY_ENABLED', 'true');
    vi.mocked(query).mockResolvedValue({ rows: [row({ status: 'queued', funding_type, arrive_by: '2026-10-20', mail_on: '2026-10-09' })] } as any);
    expect((await readLetterHome('owner')).orders[0].cancellable).toBe(false);
  });
  it('names the website origin its confirmation links are on, so the card opens them only there (#651)', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [row({ kind: 'draft', id: 'draft-1', status: 'pending', expires_at: new Date('2026-10-06T00:00:00Z') })] } as any);
    vi.stubEnv('LETTER_IRL_WEBSITE_BASE_URL', 'https://dev-site.example/');
    const home = await readLetterHome('owner');
    expect(home.websiteOrigin).toBe('https://dev-site.example');
    expect(new URL(home.drafts[0].confirmationUrl).origin).toBe(home.websiteOrigin);
  });

  it('uses a configured plugin ID only when safe, and never invents one', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [] } as any);
    for (const id of ['', '../evil', 'user@market', 'https://evil.test']) {
      vi.stubEnv('LETTER_IRL_CHATGPT_PLUGIN_ID', id);
      expect(await readLetterHome('owner')).not.toHaveProperty('appUrl');
    }
    vi.stubEnv('LETTER_IRL_CHATGPT_PLUGIN_ID', 'letter-irl-dev');
    expect(await readLetterHome('owner')).toHaveProperty('appUrl', 'https://chatgpt.com/plugins/letter-irl-dev/app/open_letter_home');
  });
});
