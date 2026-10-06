/**
 * Saved stationery designs (#649): ids that name no design. The name rule is
 * the renderer's (tests/unit/render/stationeryDesigns.test.ts); what the
 * statements hold is the PostgreSQL suite's
 * (tests/integration/stationeryDesigns.postgres.test.ts).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/db/index.js', () => ({
  query: vi.fn(),
  transaction: vi.fn()
}));

import { query } from '../../../src/db/index.js';
import {
  deleteDesign,
  getDesign,
  isDesignId,
  rememberDesign
} from '../../../src/services/stationeryDesignService.js';

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe('an id that names no design (#649)', () => {
  const ID = '3f2b8c1e-9a4d-4c7e-8b1f-2d6a5e9c0b7a';

  it('is anything but a uuid', () => {
    expect(isDesignId(ID)).toBe(true);
    expect(isDesignId(ID.toUpperCase())).toBe(true);
    for (const value of ['', 'garden', `${ID} `, `${ID}x`, ID.slice(1), 7, null, undefined]) expect(isDesignId(value)).toBe(false);
  });

  it('is never handed to PostgreSQL, whose uuid parser would fail the call', async () => {
    expect(await getDesign('user-1', 'garden')).toBeNull();
    expect(await deleteDesign('user-1', 'garden')).toBe(false);
    expect(await rememberDesign('user-1', 'garden')).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it('is asked of the account only, with the id as given', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 } as never);
    expect(await getDesign('user-1', ID)).toBeNull();
    expect(vi.mocked(query).mock.calls[0][1]).toEqual(['user-1', ID]);
    expect(vi.mocked(query).mock.calls[0][0]).toContain('WHERE user_id = $1 AND design_id = $2');
  });
});
