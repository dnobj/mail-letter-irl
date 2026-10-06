/**
 * A saved design's name as a draft stores it (#649): kept as the print reads
 * it back, and dropped, never refused, when it would not be; a drop is a
 * defect upstream, so it is written down where it happens.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testAddresses } from '../../fixtures/letters.js';

vi.mock('../../../src/db/index.js', () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock('../../../src/utils/diagnosticLog.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/utils/diagnosticLog.js')>()),
  writeDiagnostic: vi.fn()
}));

import * as db from '../../../src/db/index.js';
import { writeDiagnostic } from '../../../src/utils/diagnosticLog.js';
import { createDraft } from '../../../src/services/draftService.js';

const inserted = { rows: [{ draft_id: 'draft-1', expires_at: new Date('2026-10-02T12:00:00Z') }], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
const DESIGN = { face: 'handwritten', ornament: 'sprig', ruled: true, tone: 'medium' };
const base = {
  userId: 'user-1',
  sender: testAddresses.validSender as unknown as Record<string, unknown>,
  recipient: testAddresses.validRecipient as unknown as Record<string, unknown>,
  bodyText: 'Hello',
  signOff: 'Love',
  requiredCredits: 2,
  rendererVersion: 'pdf-2'
};
type Stationery = Parameters<typeof createDraft>[0]['stationery'];

/** The stationery the draft was inserted with. */
function storedStationery(): unknown {
  const [sql, params] = vi.mocked(db.query).mock.calls[0] as [string, unknown[]];
  const columns = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map(column => column.trim());
  const valuesAt = sql.indexOf('VALUES');
  const values = sql.slice(sql.indexOf('(', valuesAt) + 1, sql.indexOf(')', valuesAt)).split(',').map(value => value.trim());
  const placeholder = /^\$(\d+)/.exec(values[columns.indexOf('stationery')])!;
  return JSON.parse(params[Number(placeholder[1]) - 1] as string);
}

beforeEach(() => {
  vi.mocked(db.query).mockReset().mockResolvedValue(inserted as never);
  vi.mocked(writeDiagnostic).mockClear();
});

describe("a saved design's name in a draft (#649)", () => {
  it('is stored as given when the print reads it back, and nothing is written down', async () => {
    await createDraft({ ...base, stationery: { theme: 'custom', design: DESIGN, name: 'Garden', dateLine: 'October 1, 2026' } as Stationery });
    expect(storedStationery()).toEqual({ theme: 'custom', design: DESIGN, name: 'Garden', dateLine: 'October 1, 2026' });
    expect(writeDiagnostic).not.toHaveBeenCalledWith('warn', 'draft.stationery_name_dropped', expect.anything());
  });

  it('is dropped, and the letter stored all the same, when the print would not read it back; the drop is written down', async () => {
    await createDraft({ ...base, stationery: { theme: 'custom', design: DESIGN, name: ' Garden', dateLine: 'October 1, 2026' } as Stationery });
    expect(storedStationery()).toEqual({ theme: 'custom', design: DESIGN, dateLine: 'October 1, 2026' });
    expect(writeDiagnostic).toHaveBeenCalledWith('warn', 'draft.stationery_name_dropped', { theme: 'custom' });
  });

  it('is not missed where a design has none', async () => {
    await createDraft({ ...base, stationery: { theme: 'custom', design: DESIGN, dateLine: 'October 1, 2026' } as Stationery });
    expect(storedStationery()).toEqual({ theme: 'custom', design: DESIGN, dateLine: 'October 1, 2026' });
    expect(writeDiagnostic).not.toHaveBeenCalledWith('warn', 'draft.stationery_name_dropped', expect.anything());
  });
});
