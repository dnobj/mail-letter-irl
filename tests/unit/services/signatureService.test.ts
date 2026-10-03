/**
 * A saved signature (#608): what each statement asks of the database, with
 * the database mocked. That the statements do what they ask, against
 * migration 050's constraints, is proved in signatures.postgres.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/db/index.js', () => ({ query: vi.fn(), transaction: vi.fn() }));

import { query, transaction } from '../../../src/db/index.js';
import { clearSignature, getSignature, rememberSignatureChoice, saveSignature } from '../../../src/services/signatureService.js';

const USER = 'auth0|signer';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const CREATED = new Date('2026-10-02T14:00:00Z');
const UPDATED = new Date('2026-10-03T09:30:00Z');

const result = (rows: unknown[], rowCount = rows.length) => ({ rows, rowCount }) as never;
const flat = (sql: unknown) => String(sql).replace(/\s+/g, ' ').trim();

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

describe('getSignature', () => {
  it("reads the account's row only, and gives its picture and dates", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      result([{ image_png: PNG, width: 300, height: 90, use_by_default: true, created_at: CREATED, updated_at: UPDATED }])
    );
    expect(await getSignature(USER)).toEqual({
      png: PNG,
      width: 300,
      height: 90,
      useByDefault: true,
      createdAt: CREATED.toISOString(),
      updatedAt: UPDATED.toISOString()
    });
    const [sql, params] = vi.mocked(query).mock.calls[0];
    expect(flat(sql)).toBe(
      'SELECT image_png, width, height, use_by_default, created_at, updated_at FROM user_signatures WHERE user_id = $1'
    );
    expect(params).toEqual([USER]);
  });

  it('is null when none is saved', async () => {
    vi.mocked(query).mockResolvedValueOnce(result([]));
    expect(await getSignature(USER)).toBeNull();
  });
});

describe('saveSignature', () => {
  const saved = { width: 300, height: 90, use_by_default: true, created_at: CREATED, updated_at: UPDATED, inserted: true };

  it('locks the account, saves the picture, and turns it on for the next previews', async () => {
    const client = inTransaction([{ erased_at: null }], [saved]);
    expect(await saveSignature(USER, { png: PNG, width: 300, height: 90 })).toEqual({
      ok: true,
      replaced: false,
      signature: {
        width: 300,
        height: 90,
        useByDefault: true,
        createdAt: CREATED.toISOString(),
        updatedAt: UPDATED.toISOString()
      }
    });
    expect(client.query).toHaveBeenCalledTimes(2);
    const [lock, upsert] = client.query.mock.calls;
    expect(flat(lock[0])).toBe('SELECT erased_at FROM users WHERE user_id = $1 FOR UPDATE');
    expect(lock[1]).toEqual([USER]);
    expect(flat(upsert[0])).toBe(
      'INSERT INTO user_signatures (user_id, image_png, width, height) VALUES ($1, $2, $3, $4) ' +
        'ON CONFLICT (user_id) DO UPDATE SET image_png = EXCLUDED.image_png, width = EXCLUDED.width, ' +
        'height = EXCLUDED.height, use_by_default = TRUE, updated_at = NOW() ' +
        'RETURNING width, height, use_by_default, created_at, updated_at, (xmax = 0) AS inserted'
    );
    expect(upsert[1]).toEqual([USER, PNG, 300, 90]);
  });

  it('says when it replaced a signature saved before: the upsert updated rather than inserted', async () => {
    inTransaction([{ erased_at: null }], [{ ...saved, inserted: false }]);
    expect(await saveSignature(USER, { png: PNG, width: 300, height: 90 })).toMatchObject({ ok: true, replaced: true });
  });

  it('saves nothing for an account erased while it waited for the lock, or one that is gone', async () => {
    const erased = inTransaction([{ erased_at: new Date() }]);
    expect(await saveSignature(USER, { png: PNG, width: 300, height: 90 })).toEqual({ ok: false, refusal: 'account_closed' });
    expect(erased.query).toHaveBeenCalledTimes(1);

    const gone = inTransaction([]);
    expect(await saveSignature(USER, { png: PNG, width: 300, height: 90 })).toEqual({ ok: false, refusal: 'account_closed' });
    expect(gone.query).toHaveBeenCalledTimes(1);
  });
});

describe('rememberSignatureChoice (#608)', () => {
  it("sets the saved signature's choice, and nothing else", async () => {
    vi.mocked(query).mockResolvedValueOnce(result([]));
    await rememberSignatureChoice('auth0|signer', false);
    expect(vi.mocked(query).mock.calls).toEqual([['UPDATE user_signatures SET use_by_default = $2 WHERE user_id = $1', ['auth0|signer', false]]]);
  });
});

describe('clearSignature', () => {
  it("deletes the account's row, and says whether there was one", async () => {
    vi.mocked(query).mockResolvedValueOnce(result([], 1));
    expect(await clearSignature(USER)).toBe(true);
    const [sql, params] = vi.mocked(query).mock.calls[0];
    expect(flat(sql)).toBe('DELETE FROM user_signatures WHERE user_id = $1');
    expect(params).toEqual([USER]);

    vi.mocked(query).mockResolvedValueOnce(result([], 0));
    expect(await clearSignature(USER)).toBe(false);
  });
});
