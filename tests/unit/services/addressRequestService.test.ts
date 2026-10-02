/**
 * Address request links (#604): the token's shape and the hash it is kept as,
 * and what each statement asks of the database, with the database mocked.
 * That the statements do what they ask, against migration 049's constraints
 * and under concurrency, is proved in addressRequests.postgres.test.ts.
 */

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/db/index.js', () => ({ query: vi.fn(), transaction: vi.fn() }));

import { query, transaction } from '../../../src/db/index.js';
import {
  addressRequestTokenHash,
  answerAddressRequest,
  cancelAddressRequest,
  createAddressRequest,
  declineAddressRequest,
  getAddressRequest,
  mintAddressRequestToken,
  purgeClosedAddressRequests,
  readAddressRequestPage
} from '../../../src/services/addressRequestService.js';

const REQUEST_ID = '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0';
const ADDRESS = { name: 'Ruth', addressLine1: '1 Main St', city: 'Tucson', state: 'AZ', postalCode: '85701', country: 'US' as const };

const row = (overrides: Record<string, unknown> = {}) => ({
  request_id: REQUEST_ID,
  status: 'waiting',
  recipient_name: 'Ruth',
  sender_first_name: 'Pat',
  address: null,
  created_at: new Date('2026-10-02T14:00:00Z'),
  expires_at: new Date('2026-10-09T14:00:00Z'),
  closed_at: null,
  expired: false,
  ...overrides
});

const result = (rows: unknown[]) => ({ rows, rowCount: rows.length }) as never;
const flat = (sql: unknown) => String(sql).replace(/\s+/g, ' ');

/** The transaction's client: answers each statement in turn. */
function inTransaction(...answers: unknown[][]) {
  const client = { query: vi.fn() };
  for (const rows of answers) client.query.mockResolvedValueOnce(result(rows));
  vi.mocked(transaction).mockImplementation(async (callback) => callback(client as never));
  return client;
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(transaction).mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('address request tokens (#604)', () => {
  it('are 144 random bits, written as 24 characters of base64url', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => mintAddressRequestToken()));
    expect(tokens.size).toBe(50);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{24}$/);
      expect(Buffer.from(token, 'base64url')).toHaveLength(18);
    }
  });

  it('are kept as their SHA-256, and anything not shaped like one matches nothing', () => {
    const token = mintAddressRequestToken();
    expect(addressRequestTokenHash(token)).toEqual(createHash('sha256').update(token).digest());
    for (const bad of ['', 'a'.repeat(23), 'a'.repeat(25), `${'a'.repeat(23)}+`, `${'a'.repeat(23)}=`, ` ${'a'.repeat(23)}`, 42, null, undefined]) {
      expect(addressRequestTokenHash(bad), String(bad)).toBeNull();
    }
  });

  it('asks the database nothing for a link or an id that cannot match', async () => {
    await expect(readAddressRequestPage('../../etc/passwd')).resolves.toBeNull();
    await expect(answerAddressRequest('short', ADDRESS)).resolves.toEqual({ ok: false, refusal: 'not_found' });
    await expect(getAddressRequest({ userId: 'auth0|x', requestId: "1' OR '1'='1" })).resolves.toBeNull();
    await expect(cancelAddressRequest({ userId: 'auth0|x', requestId: 'nope' })).resolves.toEqual({ ok: false, refusal: 'not_found' });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('making a request (#604)', () => {
  it('locks the account, counts within the caps, and stores the hash of the token it returns', async () => {
    vi.stubEnv('LETTER_IRL_ADDRESS_REQUEST_LINK_DAYS', '5');
    const client = inTransaction([{ erased_at: null }], [{ waiting: 9, today: 19 }], [row()]);
    const created = await createAddressRequest({ userId: 'auth0|sender', recipientName: 'Ruth', senderFirstName: 'Pat' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const [lock, counts, insert] = client.query.mock.calls;
    expect(flat(lock[0])).toBe('SELECT erased_at FROM users WHERE user_id = $1 FOR UPDATE');
    expect(lock[1]).toEqual(['auth0|sender']);
    expect(flat(counts[0])).toContain("COUNT(*) FILTER (WHERE status = 'waiting' AND expires_at > NOW())::int AS waiting");
    expect(flat(counts[0])).toContain("COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS today");
    expect(flat(counts[0])).toContain('WHERE user_id = $1');
    expect(counts[1]).toEqual(['auth0|sender']);
    expect(flat(insert[0])).toContain('NOW() + make_interval(days => $5::int)');
    const [userId, hash, recipientName, senderFirstName, days] = insert[1] as unknown[];
    expect([userId, recipientName, senderFirstName, days]).toEqual(['auth0|sender', 'Ruth', 'Pat', 5]);
    expect(hash).toEqual(createHash('sha256').update(created.token).digest());
    expect(created.request).toEqual({
      requestId: REQUEST_ID,
      state: 'waiting',
      recipientName: 'Ruth',
      senderFirstName: 'Pat',
      createdAt: '2026-10-02T14:00:00.000Z',
      expiresAt: '2026-10-09T14:00:00.000Z',
      closedAt: null,
      address: null
    });
  });

  it('refuses at the waiting cap before the daily one, and inserts nothing', async () => {
    vi.stubEnv('LETTER_IRL_ADDRESS_REQUEST_WAITING_CAP', '3');
    vi.stubEnv('LETTER_IRL_ADDRESS_REQUEST_DAILY_CAP', '4');
    let client = inTransaction([{ erased_at: null }], [{ waiting: 3, today: 4 }]);
    await expect(createAddressRequest({ userId: 'u', recipientName: 'R', senderFirstName: 'P' })).resolves.toEqual({
      ok: false,
      refusal: 'waiting_cap',
      cap: 3
    });
    expect(client.query).toHaveBeenCalledTimes(2);

    client = inTransaction([{ erased_at: null }], [{ waiting: 2, today: 4 }]);
    await expect(createAddressRequest({ userId: 'u', recipientName: 'R', senderFirstName: 'P' })).resolves.toEqual({
      ok: false,
      refusal: 'daily_cap',
      cap: 4
    });
    expect(client.query).toHaveBeenCalledTimes(2);
  });

  it('refuses an account erased, or gone, by the time it holds the lock, and inserts nothing (#605 review round 1)', async () => {
    for (const account of [[{ erased_at: new Date('2026-10-02T13:59:00Z') }], []]) {
      const client = inTransaction(account, [{ waiting: 0, today: 0 }], [row()]);
      await expect(createAddressRequest({ userId: 'u', recipientName: 'R', senderFirstName: 'P' })).resolves.toEqual({
        ok: false,
        refusal: 'account_closed'
      });
      expect(client.query).toHaveBeenCalledTimes(1);
    }
  });
});

describe("reading the account's request (#604)", () => {
  it("reads the owner's own request only, and a waiting one past its expiry as expired", async () => {
    vi.mocked(query).mockResolvedValueOnce(result([row({ expired: true })]));
    await expect(getAddressRequest({ userId: 'auth0|sender', requestId: REQUEST_ID })).resolves.toMatchObject({ state: 'expired', address: null });
    const [sql, params] = vi.mocked(query).mock.calls[0];
    expect(flat(sql)).toContain('WHERE request_id = $1::uuid AND user_id = $2');
    expect(flat(sql)).toContain("(status = 'waiting' AND expires_at <= NOW()) AS expired");
    expect(params).toEqual([REQUEST_ID, 'auth0|sender']);
  });

  it('gives the address only while answered', async () => {
    vi.mocked(query).mockResolvedValueOnce(result([row({ status: 'answered', address: ADDRESS, closed_at: new Date('2026-10-03T00:00:00Z') })]));
    await expect(getAddressRequest({ userId: 'u', requestId: REQUEST_ID })).resolves.toMatchObject({
      state: 'answered',
      address: ADDRESS,
      closedAt: '2026-10-03T00:00:00.000Z'
    });
    vi.mocked(query).mockResolvedValueOnce(result([row({ status: 'declined', address: ADDRESS })]));
    await expect(getAddressRequest({ userId: 'u', requestId: REQUEST_ID })).resolves.toMatchObject({ state: 'declined', address: null });
  });
});

describe('cancelling (#604)', () => {
  it('closes only a waiting, unexpired request of the owner', async () => {
    vi.mocked(query).mockResolvedValueOnce(result([row({ status: 'cancelled', closed_at: new Date() })]));
    await expect(cancelAddressRequest({ userId: 'auth0|sender', requestId: REQUEST_ID })).resolves.toMatchObject({
      ok: true,
      alreadyClosed: false,
      request: { state: 'cancelled' }
    });
    const [sql, params] = vi.mocked(query).mock.calls[0];
    expect(flat(sql)).toContain("SET status = 'cancelled', closed_at = NOW()");
    expect(flat(sql)).toContain("WHERE request_id = $1::uuid AND user_id = $2 AND status = 'waiting' AND expires_at > NOW()");
    expect(params).toEqual([REQUEST_ID, 'auth0|sender']);
  });

  it('says a request it did not change is already closed, or not found', async () => {
    vi.mocked(query).mockResolvedValueOnce(result([])).mockResolvedValueOnce(result([row({ status: 'answered', address: ADDRESS })]));
    await expect(cancelAddressRequest({ userId: 'u', requestId: REQUEST_ID })).resolves.toMatchObject({
      ok: true,
      alreadyClosed: true,
      request: { state: 'answered' }
    });
    vi.mocked(query).mockResolvedValueOnce(result([])).mockResolvedValueOnce(result([]));
    await expect(cancelAddressRequest({ userId: 'u', requestId: REQUEST_ID })).resolves.toEqual({ ok: false, refusal: 'not_found' });
  });
});

describe('answering and declining by the link (#604)', () => {
  const token = 'AbCdEfGhIjKlMnOpQrStUvWx';
  const hash = createHash('sha256').update(token).digest();

  it('answers only a waiting, unexpired request, with the address as JSON and its name beside it', async () => {
    vi.mocked(query).mockResolvedValueOnce(result([{ request_id: REQUEST_ID }]));
    await expect(answerAddressRequest(token, ADDRESS)).resolves.toEqual({ ok: true });
    const [sql, params] = vi.mocked(query).mock.calls[0];
    expect(flat(sql)).toContain("address = $3::jsonb || jsonb_build_object('name', COALESCE($4::text, recipient_name))");
    expect(flat(sql)).toContain("WHERE token_hash = $1 AND status = 'waiting' AND expires_at > NOW()");
    const { name, ...rest } = ADDRESS;
    expect(params).toEqual([hash, 'answered', JSON.stringify(rest), name]);
  });

  it("takes the sender's name for the recipient when the recipient gives none", async () => {
    vi.mocked(query).mockResolvedValueOnce(result([{ request_id: REQUEST_ID }]));
    const { name: _name, ...unnamed } = ADDRESS;
    await answerAddressRequest(token, unnamed);
    expect(vi.mocked(query).mock.calls[0][1]).toEqual([hash, 'answered', JSON.stringify(unnamed), null]);
  });

  it('declines with no address', async () => {
    vi.mocked(query).mockResolvedValueOnce(result([{ request_id: REQUEST_ID }]));
    await expect(declineAddressRequest(token)).resolves.toEqual({ ok: true });
    expect(vi.mocked(query).mock.calls[0][1]).toEqual([hash, 'declined', null, null]);
  });

  it('says why a link it did not change was refused', async () => {
    for (const [status, expired, refusal] of [
      ['answered', false, 'answered'],
      ['declined', false, 'declined'],
      ['cancelled', false, 'cancelled'],
      ['waiting', true, 'expired'],
      // Waiting and unexpired after the UPDATE missed: its clock ran out between the two.
      ['waiting', false, 'expired']
    ] as const) {
      vi.mocked(query).mockReset();
      vi.mocked(query).mockResolvedValueOnce(result([])).mockResolvedValueOnce(result([row({ status, expired })]));
      await expect(answerAddressRequest(token, ADDRESS), `${status} ${expired}`).resolves.toEqual({ ok: false, refusal });
    }
    vi.mocked(query).mockReset();
    vi.mocked(query).mockResolvedValueOnce(result([])).mockResolvedValueOnce(result([]));
    await expect(declineAddressRequest(token)).resolves.toEqual({ ok: false, refusal: 'not_found' });
  });

  it("shows the page the sender's first name, the state and the expiry, and nothing else", async () => {
    vi.mocked(query).mockResolvedValueOnce(result([row({ status: 'answered', address: ADDRESS })]));
    await expect(readAddressRequestPage(token)).resolves.toEqual({
      state: 'answered',
      senderFirstName: 'Pat',
      expiresAt: '2026-10-09T14:00:00.000Z'
    });
    expect(vi.mocked(query).mock.calls[0][1]).toEqual([hash]);
  });
});

describe('the sweep (#604)', () => {
  it('deletes requests the given days after they close, or after their expiry while waiting, and counts them', async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [], rowCount: 4 } as never);
    await expect(purgeClosedAddressRequests(9)).resolves.toBe(4);
    const [sql, params] = vi.mocked(query).mock.calls[0];
    expect(flat(sql)).toBe('DELETE FROM address_requests WHERE COALESCE(closed_at, expires_at) < NOW() - make_interval(days => $1::int)');
    expect(params).toEqual([9]);
  });
});
