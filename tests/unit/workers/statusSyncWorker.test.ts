import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/statusSyncService.js', () => ({
  syncLetterStatuses: vi.fn(),
}));

import { syncLetterStatuses } from '../../../src/services/statusSyncService.js';
import {
  runStatusSync,
  startStatusSyncWorker,
  stopStatusSyncWorker,
  triggerImmediateSync,
} from '../../../src/workers/statusSyncWorker.js';

describe('statusSyncWorker one-shot behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(syncLetterStatuses).mockResolvedValue({
      checked: 0,
      updated: 0,
      errors: 0,
      details: [],
    });
  });

  it('runs one status synchronization without scheduling a timer', async () => {
    await runStatusSync();
    expect(syncLetterStatuses).toHaveBeenCalledTimes(1);
    expect(syncLetterStatuses).toHaveBeenCalledWith(false, 30);
  });

  it('supports a manual dry run', async () => {
    await triggerImmediateSync(true);
    expect(syncLetterStatuses).toHaveBeenCalledWith(true, 30);
  });

  it('disables the former in-process scheduler', async () => {
    await expect(startStatusSyncWorker()).rejects.toThrow('In-process status workers are disabled');
    expect(() => stopStatusSyncWorker()).not.toThrow();
  });
});
