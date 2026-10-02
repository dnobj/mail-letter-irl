/**
 * An account's remembered stationery (#563, migration 045): the theme it last
 * chose. A theme this build does not draw reads as none.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/db/index.js', () => ({ query: vi.fn() }));

import * as db from '../../../src/db/index.js';
import { rememberedStationery, rememberStationery } from '../../../src/services/stationeryDefaultService.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('rememberedStationery', () => {
  it("reads the account's theme", async () => {
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [{ stationery_theme: 'botanical' }] } as never);
    await expect(rememberedStationery('auth0|pat')).resolves.toBe('botanical');
    expect(db.query).toHaveBeenCalledWith('SELECT stationery_theme FROM users WHERE user_id = $1', ['auth0|pat']);
  });

  it('is none for no theme, no account, or a theme this build does not draw', async () => {
    for (const rows of [[{ stationery_theme: null }], [], [{ stationery_theme: 'floral' }]]) {
      vi.mocked(db.query).mockResolvedValueOnce({ rows } as never);
      await expect(rememberedStationery('auth0|pat'), JSON.stringify(rows)).resolves.toBeNull();
    }
  });
});

describe('rememberStationery', () => {
  it('writes the theme, Classic included', async () => {
    vi.mocked(db.query).mockResolvedValue({ rows: [], rowCount: 1 } as never);
    await rememberStationery('auth0|pat', 'classic');
    // Never on an erased account (#571 review round 3).
    expect(db.query).toHaveBeenCalledWith('UPDATE users SET stationery_theme = $2 WHERE user_id = $1 AND erased_at IS NULL', [
      'auth0|pat',
      'classic'
    ]);
  });
});
