/**
 * A personal access token is found by the SHA-256 of the whole token (#730,
 * migration 059), not by its last four characters and a bcrypt compare per
 * match. A token made before 059 is found the old way, once, and given its
 * hash. The real service, with only the database and bcrypt mocked.
 */

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/db/index.js', () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('bcrypt', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('hashed-token'),
    compare: vi.fn(),
  },
}));

import bcrypt from 'bcrypt';
import { query } from '../../../src/db/index.js';
import { createToken, tokenLookupHash, validateToken } from '../../../src/services/patService.js';

const RAW = `lirl_pat_${'a'.repeat(28)}wxyz`;
const LOOKUP = createHash('sha256').update(RAW).digest('hex');
const FUTURE = new Date(Date.now() + 24 * 60 * 60 * 1000);

function rows(list: unknown[]) {
  return { rows: list, rowCount: list.length, command: 'SELECT', oid: 0, fields: [] } as never;
}

function tokenRow(overrides: Record<string, unknown> = {}) {
  return { token_id: 7, user_id: 'auth0|u1', status: 'active', expires_at: FUTURE, scopes: ['mail:read'], ...overrides };
}

function sql(call: number): string {
  return String(vi.mocked(query).mock.calls[call][0]).replace(/\s+/g, ' ');
}

describe('finding a personal access token (#730)', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
    vi.mocked(bcrypt.compare).mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hashes the whole token with SHA-256, as hex', () => {
    expect(tokenLookupHash(RAW)).toBe(LOOKUP);
    expect(tokenLookupHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('stores the hash with a new token', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce(rows([{ user_id: 'auth0|u1' }]))
      .mockResolvedValueOnce(rows([{ token_id: 1, name: 'Laptop', expires_at: FUTURE }]));
    const created = await createToken('auth0|u1', 'Laptop');
    expect(sql(1)).toContain('(user_id, name, token_hash, token_prefix, expires_at, token_lookup) VALUES ($1, $2, $3, $4, $5, $6)');
    const params = vi.mocked(query).mock.calls[1][1] as unknown[];
    expect(params[5]).toBe(tokenLookupHash(created.token));
  });

  it('finds a token by one indexed read of its hash, with no bcrypt compare', async () => {
    vi.mocked(query).mockResolvedValueOnce(rows([tokenRow()]));
    await expect(validateToken(RAW)).resolves.toEqual({ valid: true, userId: 'auth0|u1', tokenId: 7, scopes: ['mail:read'] });
    expect(query).toHaveBeenCalledTimes(1);
    expect(sql(0)).toContain('WHERE token_lookup = $1');
    expect(vi.mocked(query).mock.calls[0][1]).toEqual([LOOKUP]);
    expect(bcrypt.compare).not.toHaveBeenCalled();
  });

  it('refuses a revoked token it finds', async () => {
    vi.mocked(query).mockResolvedValueOnce(rows([tokenRow({ status: 'revoked' })]));
    await expect(validateToken(RAW)).resolves.toEqual({ valid: false, error: 'Token has been revoked' });
  });

  it('refuses a token at or past its expiry, and one with none at all', async () => {
    vi.mocked(query).mockResolvedValueOnce(rows([tokenRow({ expires_at: new Date(Date.now() - 1000) })]));
    await expect(validateToken(RAW)).resolves.toEqual({ valid: false, error: 'Token has expired' });
    // 057 holds the column NOT NULL; a NULL fails closed rather than meaning "never".
    vi.mocked(query).mockResolvedValueOnce(rows([tokenRow({ expires_at: null })]));
    await expect(validateToken(RAW)).resolves.toEqual({ valid: false, error: 'Token has expired' });
  });

  it('finds a token made before 059 by its suffix among live tokens without a hash, and gives it one', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce(rows([]))
      .mockResolvedValueOnce(rows([{ ...tokenRow({ token_id: 3 }), token_hash: 'other' }, { ...tokenRow(), token_hash: 'mine' }]))
      .mockResolvedValueOnce(rows([]));
    vi.mocked(bcrypt.compare).mockImplementation(async (_raw, hash) => hash === 'mine');

    await expect(validateToken(RAW)).resolves.toMatchObject({ valid: true, tokenId: 7 });
    expect(sql(1)).toContain("WHERE token_prefix = $1 AND token_lookup IS NULL AND status = 'active' AND expires_at > NOW()");
    expect(vi.mocked(query).mock.calls[1][1]).toEqual(['wxyz']);
    expect(sql(2)).toContain('SET token_lookup = $2 WHERE token_id = $1 AND token_lookup IS NULL');
    expect(vi.mocked(query).mock.calls[2][1]).toEqual([7, LOOKUP]);
  });

  it('still admits an old token whose hash could not be filled in', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(query)
      .mockResolvedValueOnce(rows([]))
      .mockResolvedValueOnce(rows([{ ...tokenRow(), token_hash: 'mine' }]))
      .mockRejectedValueOnce(new Error('connection reset'));
    vi.mocked(bcrypt.compare).mockResolvedValue(true as never);

    await expect(validateToken(RAW)).resolves.toMatchObject({ valid: true, tokenId: 7 });
    expect(warn.mock.calls.flat().join('\n')).toContain('auth.pat_lookup_fill_failed');
  });

  it('answers not found when neither way finds it', async () => {
    vi.mocked(query).mockResolvedValueOnce(rows([])).mockResolvedValueOnce(rows([{ ...tokenRow(), token_hash: 'other' }]));
    vi.mocked(bcrypt.compare).mockResolvedValue(false as never);
    await expect(validateToken(RAW)).resolves.toEqual({ valid: false, error: 'Token not found' });
    expect(query).toHaveBeenCalledTimes(2);
  });
});
