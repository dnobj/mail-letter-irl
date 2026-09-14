/**
 * Every new personal access token expires (audit A-02).
 *
 * patService.test.ts exercises a stand-in object rather than the service, so
 * these tests import the real createToken with only the database and bcrypt
 * mocked. Each names the change that turns it red.
 */

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

import { query } from '../../../src/db/index.js';
import {
  createToken,
  resolveTokenExpiry,
  TokenExpiryError,
  DEFAULT_TOKEN_LIFETIME_DAYS,
  MAX_TOKEN_LIFETIME_DAYS,
} from '../../../src/services/patService.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-14T12:00:00.000Z');

describe('resolveTokenExpiry', () => {
  it('gives a token with no requested expiry the 90-day default', () => {
    // Red if undefined passes through as "never expires".
    expect(DEFAULT_TOKEN_LIFETIME_DAYS).toBe(90);
    expect(resolveTokenExpiry(undefined, NOW)).toEqual(new Date(NOW.getTime() + 90 * DAY_MS));
  });

  it('keeps a requested expiry inside the maximum', () => {
    const requested = new Date(NOW.getTime() + 30 * DAY_MS);
    expect(resolveTokenExpiry(requested, NOW)).toBe(requested);
  });

  it('accepts exactly the 365-day maximum', () => {
    // Red if the bound becomes exclusive.
    expect(MAX_TOKEN_LIFETIME_DAYS).toBe(365);
    const edge = new Date(NOW.getTime() + 365 * DAY_MS);
    expect(resolveTokenExpiry(edge, NOW)).toBe(edge);
  });

  it.each([
    ['in the past', new Date(NOW.getTime() - 1000)],
    ['equal to now', new Date(NOW.getTime())],
    ['one millisecond beyond the maximum', new Date(NOW.getTime() + 365 * DAY_MS + 1)],
    ['not a valid date', new Date('not a date')],
  ])('refuses an expiry %s', (_label, requested) => {
    // Red if the matching check is removed.
    expect(() => resolveTokenExpiry(requested, NOW)).toThrow(TokenExpiryError);
  });
});

describe('createToken expiry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.mocked(query).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores the default expiry when none is requested', async () => {
    const stored = new Date(NOW.getTime() + 90 * DAY_MS);
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [{ user_id: 'user-1' }] } as never)
      .mockResolvedValueOnce({ rows: [{ token_id: 7, name: 'Laptop', expires_at: stored }] } as never);

    const result = await createToken('user-1', 'Laptop');

    // Red if the INSERT goes back to binding `options?.expiresAt || null`.
    expect(query).toHaveBeenCalledTimes(2);
    const insertParams = vi.mocked(query).mock.calls[1][1] as unknown[];
    expect(insertParams[4]).toEqual(stored);
    expect(result.expiresAt).toEqual(stored);
  });

  it('stores a valid requested expiry unchanged', async () => {
    const requested = new Date(NOW.getTime() + 10 * DAY_MS);
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [{ user_id: 'user-1' }] } as never)
      .mockResolvedValueOnce({ rows: [{ token_id: 8, name: 'CI', expires_at: requested }] } as never);

    await createToken('user-1', 'CI', { expiresAt: requested });

    const insertParams = vi.mocked(query).mock.calls[1][1] as unknown[];
    expect(insertParams[4]).toBe(requested);
  });

  it('refuses a past expiry before touching the database', async () => {
    await expect(
      createToken('user-1', 'Laptop', { expiresAt: new Date(NOW.getTime() - DAY_MS) })
    ).rejects.toBeInstanceOf(TokenExpiryError);
    // Red if the expiry is checked after the user lookup or the insert.
    expect(query).not.toHaveBeenCalled();
  });
});
