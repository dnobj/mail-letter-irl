/**
 * Saved stationery designs (#649): what the service decides with what the
 * database answers, and ids that name no design. The name rule is the
 * renderer's (tests/unit/render/stationeryDesigns.test.ts); what the
 * statements hold against real PostgreSQL is
 * tests/integration/stationeryDesigns.postgres.test.ts's.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/db/index.js', () => ({
  query: vi.fn(),
  transaction: vi.fn()
}));

import { query, transaction } from '../../../src/db/index.js';
import {
  deleteDesign,
  getDesign,
  isDesignId,
  listDesigns,
  MAX_STATIONERY_DESIGNS,
  rememberDesign,
  rememberedDesign,
  saveDesign
} from '../../../src/services/stationeryDesignService.js';

const ID = '3f2b8c1e-9a4d-4c7e-8b1f-2d6a5e9c0b7a';
const DESIGN = { face: 'handwritten', ornament: 'sprig', ruled: true, tone: 'medium' } as const;
const AT = new Date('2026-10-06T12:00:00Z');
const row = (name = 'Garden', design: Record<string, unknown> = DESIGN) => ({
  design_id: ID,
  name,
  ...design,
  created_at: AT,
  updated_at: AT
});
const SAVED = { designId: ID, name: 'Garden', design: DESIGN, createdAt: AT.toISOString(), updatedAt: AT.toISOString() };

/** A transaction whose client answers each statement in turn, recording them. */
function inTransaction(...answers: Array<{ rows: unknown[] }>) {
  const statements: Array<[string, unknown[]]> = [];
  const client = {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      statements.push([sql, params]);
      const answer = answers.shift();
      if (!answer) throw new Error(`no answer for ${sql.slice(0, 40)}`);
      return answer;
    })
  };
  vi.mocked(transaction).mockImplementation(async (work: (c: never) => Promise<unknown>) => work(client as never));
  return statements;
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(transaction).mockReset();
});

describe('saving a design (#649)', () => {
  it('locks the account first, and saves nothing onto one that is erased or gone', async () => {
    for (const account of [[{ erased_at: AT }], []]) {
      const statements = inTransaction({ rows: account });
      expect(await saveDesign('user-1', 'Garden', DESIGN)).toEqual({ ok: false, refusal: 'account_closed' });
      expect(statements).toHaveLength(1);
      expect(statements[0][0]).toBe('SELECT erased_at FROM users WHERE user_id = $1 FOR UPDATE');
      expect(statements[0][1]).toEqual(['user-1']);
    }
  });

  it('replaces the design of the same name, whatever its case, and counts nothing', async () => {
    const statements = inTransaction({ rows: [{ erased_at: null }] }, { rows: [row('GARDEN')] });
    expect(await saveDesign('user-1', 'GARDEN', DESIGN)).toEqual({ ok: true, replaced: true, saved: { ...SAVED, name: 'GARDEN' } });
    expect(statements).toHaveLength(2);
    expect(statements[1][0]).toContain('WHERE user_id = $1 AND lower(name) = lower($2)');
    expect(statements[1][1]).toEqual(['user-1', 'GARDEN', 'handwritten', 'sprig', true, 'medium']);
  });

  it(`adds a new one while the account holds fewer than ${MAX_STATIONERY_DESIGNS}`, async () => {
    const statements = inTransaction(
      { rows: [{ erased_at: null }] },
      { rows: [] },
      { rows: [{ count: String(MAX_STATIONERY_DESIGNS - 1) }] },
      { rows: [row()] }
    );
    expect(await saveDesign('user-1', 'Garden', DESIGN)).toEqual({ ok: true, replaced: false, saved: SAVED });
    expect(statements[2][0]).toBe('SELECT count(*) AS count FROM stationery_designs WHERE user_id = $1');
    expect(statements[3][0]).toContain('INSERT INTO stationery_designs (user_id, name, face, ornament, ruled, tone)');
    expect(statements[3][1]).toEqual(['user-1', 'Garden', 'handwritten', 'sprig', true, 'medium']);
  });

  it(`refuses a new one once the account holds ${MAX_STATIONERY_DESIGNS}`, async () => {
    for (const held of [MAX_STATIONERY_DESIGNS, MAX_STATIONERY_DESIGNS + 3]) {
      const statements = inTransaction({ rows: [{ erased_at: null }] }, { rows: [] }, { rows: [{ count: String(held) }] });
      expect(await saveDesign('user-1', 'Garden', DESIGN)).toEqual({ ok: false, refusal: 'limit' });
      expect(statements).toHaveLength(3);
    }
  });
});

describe('reading designs (#649)', () => {
  it("lists the account's designs oldest first, past any whose choices this build does not draw", async () => {
    vi.mocked(query).mockResolvedValue({ rows: [row(), row('Later', { ...DESIGN, ornament: 'border' })] } as never);
    expect(await listDesigns('user-1')).toEqual([SAVED]);
    expect(vi.mocked(query).mock.calls[0][0]).toContain('WHERE user_id = $1 ORDER BY created_at, design_id');
  });

  it("reads one of the account's designs by its id, or none", async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [row()] } as never).mockResolvedValueOnce({ rows: [] } as never);
    expect(await getDesign('user-1', ID)).toEqual(SAVED);
    expect(await getDesign('user-1', ID)).toBeNull();
    expect(vi.mocked(query).mock.calls[0][1]).toEqual(['user-1', ID]);
    expect(vi.mocked(query).mock.calls[0][0]).toContain('WHERE user_id = $1 AND design_id = $2');
  });

  it("reads the remembered design only as one of the account's own", async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [row()] } as never).mockResolvedValueOnce({ rows: [] } as never);
    expect(await rememberedDesign('user-1')).toEqual(SAVED);
    expect(await rememberedDesign('user-1')).toBeNull();
    expect(vi.mocked(query).mock.calls[0][0]).toContain('d.design_id = u.stationery_design_id AND d.user_id = u.user_id');
  });
});

describe('deleting and remembering (#649)', () => {
  it("deletes only the account's own design, and says whether there was one", async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [], rowCount: 1 } as never).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    expect(await deleteDesign('user-1', ID)).toBe(true);
    expect(await deleteDesign('user-1', ID)).toBe(false);
    expect(vi.mocked(query).mock.calls[0]).toEqual(['DELETE FROM stationery_designs WHERE user_id = $1 AND design_id = $2', ['user-1', ID]]);
  });

  it("remembers one of the account's own designs on an account not erased, and says whether it did", async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [], rowCount: 1 } as never).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    expect(await rememberDesign('user-1', ID)).toBe(true);
    expect(await rememberDesign('user-1', ID)).toBe(false);
    const [sql, params] = vi.mocked(query).mock.calls[0];
    expect(sql).toContain('u.erased_at IS NULL AND d.user_id = u.user_id AND d.design_id = $2');
    expect(params).toEqual(['user-1', ID]);
  });

  it('forgets the remembered design on asking for none, on an account not erased', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 1 } as never);
    expect(await rememberDesign('user-1', null)).toBe(true);
    expect(vi.mocked(query).mock.calls[0]).toEqual([
      'UPDATE users SET stationery_design_id = NULL WHERE user_id = $1 AND erased_at IS NULL',
      ['user-1']
    ]);
  });
});

describe('an id that names no design (#649)', () => {
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
});
