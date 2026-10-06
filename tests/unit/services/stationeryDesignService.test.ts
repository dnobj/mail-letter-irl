/**
 * Saved stationery designs (#649): the name a design is kept under, and ids
 * that name no design. What the statements hold is the PostgreSQL suite's
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
  designNameOf,
  getDesign,
  isDesignId,
  rememberDesign
} from '../../../src/services/stationeryDesignService.js';

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe("a design's name (#649)", () => {
  it('is kept trimmed, with each run of white space one space', () => {
    expect(designNameOf('  Grandma   Ruth \t')).toBe('Grandma Ruth');
    expect(designNameOf('Line\nbreak')).toBe('Line break');
  });

  it('loses what prints nothing: controls, bidi marks and zero-width characters', () => {
    const hidden = String.fromCodePoint(0x202e, 0x200b, 0x2066, 0x0007, 0xfeff);
    expect(designNameOf(`Gar${hidden}den`)).toBe('Garden');
    expect(designNameOf(`${hidden}`)).toBeNull();
  });

  it('holds one to forty characters, counted as PostgreSQL counts them', () => {
    expect(designNameOf('x')).toBe('x');
    expect(designNameOf('x'.repeat(40))).toBe('x'.repeat(40));
    expect(designNameOf('x'.repeat(41))).toBeNull();
    // Forty code points, eighty UTF-16 units: kept.
    const smile = String.fromCodePoint(0x1f600);
    expect(designNameOf(smile.repeat(40))).toBe(smile.repeat(40));
    expect(designNameOf(smile.repeat(41))).toBeNull();
    expect(designNameOf('')).toBeNull();
    expect(designNameOf('   ')).toBeNull();
  });

  it('is text', () => {
    for (const value of [undefined, null, 7, ['Garden'], { name: 'Garden' }]) expect(designNameOf(value)).toBeNull();
  });
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
