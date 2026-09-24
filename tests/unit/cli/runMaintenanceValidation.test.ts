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
  processAccountErasures: vi.fn().mockResolvedValue({ erased: 0, refused: 0, retrying: 0, failed: 0 }),
  processRetentionRestores: vi.fn().mockResolvedValue({ done: 0, refused: 0, retrying: 0, failed: 0 }),
  runCommerceMaintenance: vi.fn().mockResolvedValue({}),
  reconcileGenerationReservations: vi.fn().mockResolvedValue({}),
  cleanupExpiredImages: vi.fn().mockResolvedValue(0),
  closeTempImageStore: vi.fn(),
  runMaintenanceTaskIfDue: vi.fn().mockResolvedValue({ ran: false }),
  runDailyMaintenance: vi.fn().mockResolvedValue(undefined),
  runStatusSync: vi.fn().mockResolvedValue(undefined),
  purgeExpiredRecentUploads: vi.fn().mockResolvedValue(0),
  purgeExpiredFeatureRequests: vi.fn().mockResolvedValue(0),
  sendMaintenanceHeartbeat: vi.fn().mockResolvedValue('sent'),
  closePool: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../../../src/services/letterJobService.js', () => ({
  processDueLetterJobs: services.processDueLetterJobs
}));
vi.mock('../../../src/services/accountErasureService.js', () => ({
  processAccountErasures: services.processAccountErasures
}));
vi.mock('../../../src/services/retentionService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/retentionService.js')>()),
  processRetentionRestores: services.processRetentionRestores
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
vi.mock('../../../src/services/featureRequestService.js', () => ({
  purgeExpiredFeatureRequests: services.purgeExpiredFeatureRequests
}));
vi.mock('../../../src/db/index.js', () => ({
  closePool: services.closePool
}));
vi.mock('../../../src/services/maintenanceHeartbeat.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/maintenanceHeartbeat.js')>()),
  sendMaintenanceHeartbeat: services.sendMaintenanceHeartbeat
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

function captureOutput(): () => string {
  const spies = (['log', 'info', 'warn', 'error'] as const).map(method =>
    vi.spyOn(console, method).mockImplementation(() => undefined)
  );
  return () => spies.flatMap(spy => spy.mock.calls.flat().map(String)).join('\n');
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
    expect(services.purgeExpiredFeatureRequests).not.toHaveBeenCalled();
    expect(services.sendMaintenanceHeartbeat).not.toHaveBeenCalled();

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
    // The heartbeat follows a finished run, and only then (#408).
    expect(services.sendMaintenanceHeartbeat).toHaveBeenCalledTimes(1);
    expect(services.sendMaintenanceHeartbeat.mock.invocationCallOrder[0]).toBeGreaterThan(
      services.processDueLetterJobs.mock.invocationCallOrder[0]
    );
  });

  it('prints the validator\'s warnings, so an unusable heartbeat URL shows in the maintenance log (#408)', async () => {
    const output = captureOutput();
    stubValidDevelopment();
    vi.stubEnv('MAINTENANCE_HEARTBEAT_URL', 'http://hc-ping.com/abc');

    await expect(maintenanceEntry()).resolves.toBeUndefined();

    expect(output()).toContain('[config] MAINTENANCE_HEARTBEAT_URL must be an https URL');
  });

  it('sends no heartbeat after a run that failed, so the monitor raises the alarm (#408)', async () => {
    stubValidDevelopment();
    services.runCommerceMaintenance.mockRejectedValueOnce(new Error('stripe down'));

    await expect(maintenanceEntry()).rejects.toThrow('stripe down');

    expect(services.sendMaintenanceHeartbeat).not.toHaveBeenCalled();
    // The pool still closes.
    expect(services.closePool).toHaveBeenCalledTimes(1);
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
          // The real runner stores the error's class in maintenance_tasks.last_error
          // (#394), which the admin reader role can read, and then rethrows.
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

    it('runs before mail dispatch, and dispatch waits for it to finish', async () => {
      // Review round 1: moving the sweep after the unwrapped tasks, or dropping
      // its await, passed every other test. Placed after them, any steady
      // failure there would silently stop deletion with no sweep_failed line.
      stubValidDevelopment();
      captureOutput();
      let sweepStarted = false;
      let releaseSweep: (() => void) | undefined;
      services.runMaintenanceTaskIfDue.mockImplementation((async name => {
        if (name !== 'recent-uploads-sweep') return { ran: false };
        sweepStarted = true;
        await new Promise<void>(resolve => {
          releaseSweep = resolve;
        });
        return { ran: true, result: 0 };
      }) as TaskRunner);

      const entry = maintenanceEntry();
      await vi.waitFor(() => expect(sweepStarted).toBe(true));
      expect(services.processDueLetterJobs).not.toHaveBeenCalled();

      releaseSweep?.();
      await expect(entry).resolves.toBeUndefined();
      expect(services.processDueLetterJobs).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * Issue #393. Same wrapper as the uploads sweep and the same position rule:
   * it sits with the other housekeeping at the front of the run, after the
   * uploads sweep and before mail dispatch, and a failure there must neither
   * stop dispatch nor put what the driver said where the admin reader role can
   * read it.
   */
  describe('feature requests sweep', () => {
    afterEach(() => {
      services.runMaintenanceTaskIfDue.mockReset().mockResolvedValue({ ran: false });
      services.purgeExpiredFeatureRequests.mockReset().mockResolvedValue(0);
    });

    it('is scheduled on every hourly run, under its own task name', async () => {
      stubValidDevelopment();

      await expect(maintenanceEntry()).resolves.toBeUndefined();

      const call = services.runMaintenanceTaskIfDue.mock.calls.find(
        ([name]) => name === 'feature-requests-sweep'
      );
      expect(call).toBeDefined();
      expect(call?.[1]).toBeGreaterThan(0);
      expect(call?.[1]).toBeLessThan(60 * 60 * 1000);
    });

    it('runs after the uploads sweep and before the unwrapped tasks', async () => {
      stubValidDevelopment();

      await expect(maintenanceEntry()).resolves.toBeUndefined();

      const names = services.runMaintenanceTaskIfDue.mock.calls.map(([name]) => name);
      const uploads = names.indexOf('recent-uploads-sweep');
      const requests = names.indexOf('feature-requests-sweep');
      expect(uploads).toBeGreaterThanOrEqual(0);
      expect(requests).toBeGreaterThan(uploads);
      expect(requests).toBeLessThan(names.indexOf('provider-status-sync'));
    });

    it('logs the deleted count when it runs', async () => {
      stubValidDevelopment();
      const output = captureOutput();
      services.purgeExpiredFeatureRequests.mockResolvedValueOnce(2);
      services.runMaintenanceTaskIfDue.mockImplementation((async (name, _interval, task) =>
        name === 'feature-requests-sweep' ? { ran: true, result: await task() } : { ran: false }) as TaskRunner);

      await expect(maintenanceEntry()).resolves.toBeUndefined();

      expect(services.purgeExpiredFeatureRequests).toHaveBeenCalledTimes(1);
      const logged = output();
      expect(logged).toContain('"event":"feature_requests.swept"');
      expect(logged).toContain('"deleted":2');
      expect(logged).not.toContain('feature_requests.sweep_failed');
    });

    it('cannot stop the rest of maintenance, or leak what the driver said, when it fails', async () => {
      stubValidDevelopment();
      const output = captureOutput();
      const driverError = Object.assign(
        new Error('connect ETIMEDOUT while deleting request "Secret plan" for reply@example.invalid'),
        { code: 'ETIMEDOUT' }
      );
      services.purgeExpiredFeatureRequests.mockRejectedValueOnce(driverError);
      let rethrown: unknown;
      services.runMaintenanceTaskIfDue.mockImplementation((async (name, _interval, task) => {
        if (name !== 'feature-requests-sweep') return { ran: false };
        try {
          return { ran: true, result: await task() };
        } catch (error) {
          // The real runner stores the error's class in maintenance_tasks.last_error
          // (#394), which the admin reader role can read, and then rethrows.
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
      expect((rethrown as Error).message).not.toContain('Secret plan');
      expect((rethrown as Error).message).not.toContain('example.invalid');
      expect((rethrown as { diagnosticClass?: string }).diagnosticClass).toBe('ETIMEDOUT');

      const logged = output();
      expect(logged).toContain('"event":"feature_requests.sweep_failed"');
      expect(logged).toContain('"errorClass":"ETIMEDOUT"');
      expect(logged).not.toContain('Secret plan');
      expect(logged).not.toContain('example.invalid');
    });

    it('runs before mail dispatch, and dispatch waits for it to finish', async () => {
      stubValidDevelopment();
      captureOutput();
      let sweepStarted = false;
      let releaseSweep: (() => void) | undefined;
      services.runMaintenanceTaskIfDue.mockImplementation((async name => {
        if (name !== 'feature-requests-sweep') return { ran: false };
        sweepStarted = true;
        await new Promise<void>(resolve => {
          releaseSweep = resolve;
        });
        return { ran: true, result: 0 };
      }) as TaskRunner);

      const entry = maintenanceEntry();
      await vi.waitFor(() => expect(sweepStarted).toBe(true));
      expect(services.processDueLetterJobs).not.toHaveBeenCalled();

      releaseSweep?.();
      await expect(entry).resolves.toBeUndefined();
      expect(services.processDueLetterJobs).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * Issue #153. The admin panel queues restores of quarantined content; this
   * task puts the content back, AHEAD of the retention pass, so a copy queued
   * for restore is never purged by the same run.
   */
  describe('retention restores', () => {
    afterEach(() => {
      services.runMaintenanceTaskIfDue.mockReset().mockResolvedValue({ ran: false });
      services.processRetentionRestores.mockReset().mockResolvedValue({ done: 0, refused: 0, retrying: 0, failed: 0 });
    });

    it('is scheduled on every hourly run, under its own task name, before the retention pass', async () => {
      stubValidDevelopment();

      await expect(maintenanceEntry()).resolves.toBeUndefined();

      const names = services.runMaintenanceTaskIfDue.mock.calls.map(([name]) => name);
      const call = services.runMaintenanceTaskIfDue.mock.calls.find(([name]) => name === 'retention-restores');
      expect(call).toBeDefined();
      expect(call?.[1]).toBeGreaterThan(0);
      expect(call?.[1]).toBeLessThan(60 * 60 * 1000);
      expect(names.indexOf('content-retention-report')).toBeGreaterThan(names.indexOf('retention-restores'));
      expect(names.indexOf('retention-restores')).toBe(0);
    });

    it('logs the counts when it runs', async () => {
      stubValidDevelopment();
      const output = captureOutput();
      services.processRetentionRestores.mockResolvedValueOnce({ done: 2, refused: 1, retrying: 0, failed: 0 });
      services.runMaintenanceTaskIfDue.mockImplementation((async (name, _interval, task) =>
        name === 'retention-restores' ? { ran: true, result: await task() } : { ran: false }) as TaskRunner);

      await expect(maintenanceEntry()).resolves.toBeUndefined();

      const logged = output();
      expect(logged).toContain('"event":"retention_restore.run"');
      expect(logged).toContain('"done":2');
      expect(logged).not.toContain('retention_restore.task_failed');
    });

    it('cannot stop the retention pass or mail, or leak what the driver said, when it fails', async () => {
      stubValidDevelopment();
      const output = captureOutput();
      services.processRetentionRestores.mockRejectedValueOnce(
        Object.assign(new Error('connect ETIMEDOUT restoring letter_secret-id'), { code: 'ETIMEDOUT' })
      );
      services.runMaintenanceTaskIfDue.mockImplementation((async (name, _interval, task) =>
        name === 'retention-restores' ? { ran: true, result: await task() } : { ran: false }) as TaskRunner);

      await expect(maintenanceEntry()).resolves.toBeUndefined();

      const names = services.runMaintenanceTaskIfDue.mock.calls.map(([name]) => name);
      expect(names).toContain('content-retention-report');
      expect(services.processDueLetterJobs).toHaveBeenCalledTimes(1);
      const logged = output();
      expect(logged).toContain('"event":"retention_restore.task_failed"');
      expect(logged).toContain('"errorClass":"ETIMEDOUT"');
      expect(logged).not.toContain('letter_secret-id');
    });
  });

  /**
   * Issue #289. The admin panel queues erasures it cannot perform itself; this
   * task carries them out. Wrapped like the sweeps: a failure must not stop
   * mail, and what reaches maintenance_tasks.last_error is a class.
   */
  describe('account erasures', () => {
    afterEach(() => {
      services.runMaintenanceTaskIfDue.mockReset().mockResolvedValue({ ran: false });
      services.processAccountErasures.mockReset().mockResolvedValue({ erased: 0, refused: 0, retrying: 0, failed: 0 });
    });

    it('is scheduled on every hourly run, under its own task name, after the sweeps', async () => {
      stubValidDevelopment();

      await expect(maintenanceEntry()).resolves.toBeUndefined();

      const names = services.runMaintenanceTaskIfDue.mock.calls.map(([name]) => name);
      const call = services.runMaintenanceTaskIfDue.mock.calls.find(([name]) => name === 'account-erasures');
      expect(call).toBeDefined();
      expect(call?.[1]).toBeGreaterThan(0);
      expect(call?.[1]).toBeLessThan(60 * 60 * 1000);
      expect(names.indexOf('account-erasures')).toBeGreaterThan(names.indexOf('feature-requests-sweep'));
      expect(names.indexOf('account-erasures')).toBeLessThan(names.indexOf('provider-status-sync'));
    });

    it('logs the counts when it runs, and nothing else', async () => {
      stubValidDevelopment();
      const output = captureOutput();
      services.processAccountErasures.mockResolvedValueOnce({ erased: 1, refused: 2, retrying: 0, failed: 0 });
      services.runMaintenanceTaskIfDue.mockImplementation((async (name, _interval, task) =>
        name === 'account-erasures' ? { ran: true, result: await task() } : { ran: false }) as TaskRunner);

      await expect(maintenanceEntry()).resolves.toBeUndefined();

      expect(services.processAccountErasures).toHaveBeenCalledTimes(1);
      const logged = output();
      expect(logged).toContain('Account erasures completed');
      expect(logged).toContain('"event":"account_erasure.run"');
      expect(logged).toContain('"erased":1');
      expect(logged).toContain('"refused":2');
      expect(logged).not.toContain('account_erasure.task_failed');
    });

    it('cannot stop mail or the rest of maintenance, or leak what the driver said, when it fails', async () => {
      stubValidDevelopment();
      const output = captureOutput();
      const driverError = Object.assign(
        new Error('connect ETIMEDOUT while erasing auth0|secret-subject for person@example.invalid'),
        { code: 'ETIMEDOUT' }
      );
      services.processAccountErasures.mockRejectedValueOnce(driverError);
      let rethrown: unknown;
      services.runMaintenanceTaskIfDue.mockImplementation((async (name, _interval, task) => {
        if (name !== 'account-erasures') return { ran: false };
        try {
          return { ran: true, result: await task() };
        } catch (error) {
          rethrown = error;
          throw error;
        }
      }) as TaskRunner);

      await expect(maintenanceEntry()).resolves.toBeUndefined();

      expect(services.processDueLetterJobs).toHaveBeenCalledTimes(1);
      expect(services.runCommerceMaintenance).toHaveBeenCalledTimes(1);
      const names = services.runMaintenanceTaskIfDue.mock.calls.map(([name]) => name);
      expect(names).toContain('provider-status-sync');
      expect(names).toContain('daily-credit-and-draft-cleanup');

      expect((rethrown as Error).message).toContain('ETIMEDOUT');
      expect((rethrown as Error).message).not.toContain('secret-subject');
      expect((rethrown as { diagnosticClass?: string }).diagnosticClass).toBe('ETIMEDOUT');

      const logged = output();
      expect(logged).toContain('"event":"account_erasure.task_failed"');
      expect(logged).toContain('"errorClass":"ETIMEDOUT"');
      expect(logged).not.toContain('secret-subject');
      expect(logged).not.toContain('example.invalid');
    });
  });
});
