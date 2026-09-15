import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Issue #155. The maintenance cron previously ran with no environment
 * validation at all, and it is the surface most exposed to the silent-dummy
 * failure: the status sync uses the environment-default provider, and
 * commerce maintenance moves real money through Stripe. maintenanceEntry now
 * validates before touching anything; these pin that the gate is in front of
 * the work, not beside it.
 */

const services = vi.hoisted(() => ({
  processDueLetterJobs: vi.fn().mockResolvedValue({ processed: 0 }),
  runCommerceMaintenance: vi.fn().mockResolvedValue({}),
  reconcileGenerationReservations: vi.fn().mockResolvedValue({}),
  cleanupExpiredImages: vi.fn().mockResolvedValue(0),
  closeTempImageStore: vi.fn(),
  runMaintenanceTaskIfDue: vi.fn().mockResolvedValue({ ran: false }),
  runDailyMaintenance: vi.fn().mockResolvedValue(undefined),
  runStatusSync: vi.fn().mockResolvedValue(undefined),
  purgeExpiredRecentUploads: vi.fn().mockResolvedValue(0),
  closePool: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../../../src/services/letterJobService.js', () => ({
  processDueLetterJobs: services.processDueLetterJobs
}));
vi.mock('../../../src/services/packRefundService.js', () => ({
  reconcilePackRefunds: async () => ({ retried: 0, adopted: 0, settled: 0, compensated: 0 })
}));
vi.mock('../../../src/services/commerceService.js', () => ({
  runCommerceMaintenance: services.runCommerceMaintenance
}));
vi.mock('../../../src/services/imageGenerationLimitService.js', () => ({
  reconcileGenerationReservations: services.reconcileGenerationReservations
}));
vi.mock('../../../src/services/tempImageStore.js', () => ({
  cleanupExpiredImages: services.cleanupExpiredImages,
  closeTempImageStore: services.closeTempImageStore
}));
vi.mock('../../../src/services/maintenanceTaskService.js', () => ({
  runMaintenanceTaskIfDue: services.runMaintenanceTaskIfDue
}));
vi.mock('../../../src/workers/creditExpirationWorker.js', () => ({
  runDailyMaintenance: services.runDailyMaintenance
}));
vi.mock('../../../src/workers/statusSyncWorker.js', () => ({
  runStatusSync: services.runStatusSync
}));
vi.mock('../../../src/services/recentUploadStore.js', () => ({
  purgeExpiredRecentUploads: services.purgeExpiredRecentUploads
}));
vi.mock('../../../src/db/index.js', () => ({
  closePool: services.closePool
}));

import { maintenanceEntry, writeMaintenanceFailure } from '../../../src/cli/runMaintenance.js';

type TaskRunner = (
  name: string,
  interval: number,
  task: () => Promise<unknown>
) => Promise<{ ran: boolean; result?: unknown }>;

function stubValidDevelopment(): void {
  vi.stubEnv('LETTER_IRL_DEPLOYMENT_ENVIRONMENT', 'development');
  vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@fixture.example/db');
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_maintenance_fixture');
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_maintenance_fixture');
}

describe('maintenance deployment validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('rejects an invalid production configuration before any maintenance work runs', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubEnv('LETTER_IRL_DEPLOYMENT_ENVIRONMENT', 'production');
    vi.stubEnv('NODE_ENV', 'production');
    // Deliberately unconfigured beyond identity: everything should fail.

    await expect(maintenanceEntry()).rejects.toThrow('Invalid deployment configuration');

    expect(services.processDueLetterJobs).not.toHaveBeenCalled();
    expect(services.runCommerceMaintenance).not.toHaveBeenCalled();
    expect(services.cleanupExpiredImages).not.toHaveBeenCalled();
    expect(services.runMaintenanceTaskIfDue).not.toHaveBeenCalled();
    expect(services.purgeExpiredRecentUploads).not.toHaveBeenCalled();

    // Review round 1: the class-only failure diagnostic left the operator
    // with one word. The config failure itself must name its variables on
    // stderr (the message is value-free by construction).
    const logged = errorSpy.mock.calls.flat().map(String).join('\n');
    expect(logged).toContain('LETTER_PROVIDER');
    expect(logged).toContain('STRIPE_SECRET_KEY');
  });

  it('runs a valid development maintenance pass end to end', async () => {
    stubValidDevelopment();

    await expect(maintenanceEntry()).resolves.toBeUndefined();

    expect(services.processDueLetterJobs).toHaveBeenCalledTimes(1);
    expect(services.runCommerceMaintenance).toHaveBeenCalledTimes(1);
    expect(services.closePool).toHaveBeenCalledTimes(1);
    expect(services.closeTempImageStore).toHaveBeenCalledTimes(1);
  });

  it('labels a configuration failure configuration_error in the maintenance diagnostic', async () => {
    // The #213 trap, maintenance edition: without the carried class this
    // logged unknown_error and pointed the investigation anywhere but config.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubEnv('LETTER_IRL_DEPLOYMENT_ENVIRONMENT', 'production');
    vi.stubEnv('NODE_ENV', 'production');

    const failure = await maintenanceEntry().catch(e => e);
    writeMaintenanceFailure(failure);

    const logged = errorSpy.mock.calls.flat().map(String).join('\n');
    expect(logged).toContain('"event":"maintenance.run_failed"');
    expect(logged).toContain('"errorClass":"configuration_error"');
  });

  /**
   * Issue #282. The sweep deletes upload references, so it sits beside content
   * retention at the front of the run - which is exactly where an unwrapped
   * failure would skip mail dispatch and everything after it.
   */
  describe('recent uploads sweep', () => {
    afterEach(() => {
      // vi.clearAllMocks keeps implementations and restoreAllMocks only
      // restores spies, so a runner installed below would leak into the next test.
      services.runMaintenanceTaskIfDue.mockReset().mockResolvedValue({ ran: false });
      services.purgeExpiredRecentUploads.mockReset().mockResolvedValue(0);
    });

    function captureOutput(): () => string {
      const spies = (['log', 'info', 'warn', 'error'] as const).map(method =>
        vi.spyOn(console, method).mockImplementation(() => undefined)
      );
      return () => spies.flatMap(spy => spy.mock.calls.flat().map(String)).join('\n');
    }

    it('is scheduled on every hourly run, under its own task name', async () => {
      stubValidDevelopment();

      await expect(maintenanceEntry()).resolves.toBeUndefined();

      const call = services.runMaintenanceTaskIfDue.mock.calls.find(
        ([name]) => name === 'recent-uploads-sweep'
      );
      expect(call).toBeDefined();
      // Below the hourly cron, so start-time jitter against last_completed_at
      // cannot make a run "not due".
      expect(call?.[1]).toBeGreaterThan(0);
      expect(call?.[1]).toBeLessThan(60 * 60 * 1000);
    });

    it('logs the deleted count when it runs', async () => {
      stubValidDevelopment();
      const output = captureOutput();
      services.purgeExpiredRecentUploads.mockResolvedValueOnce(4);
      services.runMaintenanceTaskIfDue.mockImplementation((async (name, _interval, task) =>
        name === 'recent-uploads-sweep' ? { ran: true, result: await task() } : { ran: false }) as TaskRunner);

      await expect(maintenanceEntry()).resolves.toBeUndefined();

      expect(services.purgeExpiredRecentUploads).toHaveBeenCalledTimes(1);
      const logged = output();
      expect(logged).toContain('"event":"recent_uploads.swept"');
      expect(logged).toContain('"deleted":4');
      expect(logged).not.toContain('recent_uploads.sweep_failed');
    });

    it('cannot stop the rest of maintenance, or leak what the driver said, when it fails', async () => {
      stubValidDevelopment();
      const output = captureOutput();
      const driverError = Object.assign(
        new Error('connect ETIMEDOUT while reading https://files.oaiusercontent.com/file-secret'),
        { code: 'ETIMEDOUT' }
      );
      services.purgeExpiredRecentUploads.mockRejectedValueOnce(driverError);
      let rethrown: unknown;
      services.runMaintenanceTaskIfDue.mockImplementation((async (name, _interval, task) => {
        if (name !== 'recent-uploads-sweep') return { ran: false };
        try {
          return { ran: true, result: await task() };
        } catch (error) {
          // The real runner stores error.message in maintenance_tasks.last_error,
          // which the admin reader role can read, and then rethrows.
          rethrown = error;
          throw error;
        }
      }) as TaskRunner);

      await expect(maintenanceEntry()).resolves.toBeUndefined();

      // Everything scheduled after the sweep still ran.
      expect(services.processDueLetterJobs).toHaveBeenCalledTimes(1);
      expect(services.runCommerceMaintenance).toHaveBeenCalledTimes(1);
      expect(services.reconcileGenerationReservations).toHaveBeenCalledTimes(1);
      expect(services.cleanupExpiredImages).toHaveBeenCalledTimes(1);
      const names = services.runMaintenanceTaskIfDue.mock.calls.map(([name]) => name);
      expect(names).toContain('provider-status-sync');
      expect(names).toContain('daily-credit-and-draft-cleanup');

      // What would reach maintenance_tasks.last_error is a class, never the driver's words.
      expect(rethrown).toBeInstanceOf(Error);
      expect((rethrown as Error).message).toContain('ETIMEDOUT');
      expect((rethrown as Error).message).not.toContain('https://');
      expect((rethrown as Error).message).not.toContain('file-secret');
      expect((rethrown as { diagnosticClass?: string }).diagnosticClass).toBe('ETIMEDOUT');

      const logged = output();
      expect(logged).toContain('"event":"recent_uploads.sweep_failed"');
      expect(logged).toContain('"errorClass":"ETIMEDOUT"');
      expect(logged).not.toContain('https://');
      expect(logged).not.toContain('file-secret');
    });
  });
});
