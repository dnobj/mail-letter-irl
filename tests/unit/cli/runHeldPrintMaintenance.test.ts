/**
 * The maintenance run's held-print step (#697): the backfill, then the sweep,
 * each wrapped so that a bucket or database that is down never stops the run,
 * and logged as counts, never a letter id.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  backfill: vi.fn(),
  sweep: vi.fn(),
  diagnostics: [] as Array<{ level: string; event: string; fields: Record<string, unknown> }>
}));

vi.mock('../../../src/services/heldPrintService.js', () => ({
  backfillHeldPrints: mocks.backfill,
  sweepHeldPdfs: mocks.sweep
}));
vi.mock('../../../src/utils/diagnosticLog.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/utils/diagnosticLog.js')>()),
  writeDiagnostic: (level: string, event: string, fields: Record<string, unknown> = {}) => {
    mocks.diagnostics.push({ level, event, fields });
  }
}));

import { runHeldPrintMaintenance } from '../../../src/cli/runMaintenance.js';

describe('runHeldPrintMaintenance (#697)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.diagnostics.length = 0;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('backfills, then sweeps, and logs the counts', async () => {
    const order: string[] = [];
    mocks.backfill.mockImplementation(async () => { order.push('backfill'); return { stored: 2, layoutChanged: 0, unprintable: 0, failed: 0 }; });
    mocks.sweep.mockImplementation(async () => { order.push('sweep'); return { kept: 3, deleted: 1 }; });
    await runHeldPrintMaintenance();
    expect(order).toEqual(['backfill', 'sweep']);
    expect(mocks.diagnostics).toEqual([
      { level: 'info', event: 'held_print.backfilled', fields: { stored: 2, layoutChanged: 0, unprintable: 0, failed: 0 } },
      { level: 'info', event: 'held_print.swept', fields: { kept: 3, deleted: 1 } }
    ]);
  });

  it('logs a changed layout as an error, for an operator to act on before the mail date', async () => {
    mocks.backfill.mockResolvedValue({ stored: 0, layoutChanged: 1, unprintable: 0, failed: 0 });
    mocks.sweep.mockResolvedValue({ kept: 0, deleted: 0 });
    await runHeldPrintMaintenance();
    expect(mocks.diagnostics[0]).toMatchObject({ level: 'error', event: 'held_print.backfilled' });
  });

  it('logs a letter our renderer refuses as an error too', async () => {
    mocks.backfill.mockResolvedValue({ stored: 0, layoutChanged: 0, unprintable: 1, failed: 0 });
    mocks.sweep.mockResolvedValue({ kept: 0, deleted: 0 });
    await runHeldPrintMaintenance();
    expect(mocks.diagnostics[0]).toMatchObject({ level: 'error', event: 'held_print.backfilled' });
  });

  it('never throws: a failed backfill still sweeps, and a failed sweep ends quietly', async () => {
    mocks.backfill.mockRejectedValue(new Error('connection terminated'));
    mocks.sweep.mockRejectedValue(new Error('bucket unreachable'));
    await expect(runHeldPrintMaintenance()).resolves.toBeUndefined();
    expect(mocks.sweep).toHaveBeenCalled();
    expect(mocks.diagnostics.map(entry => [entry.level, entry.event])).toEqual([
      ['error', 'held_print.backfill_failed'],
      ['error', 'held_print.sweep_failed']
    ]);
    // A class, never the message.
    expect(JSON.stringify(mocks.diagnostics)).not.toContain('bucket unreachable');
  });
});
