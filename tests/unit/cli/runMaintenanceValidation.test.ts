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
  closePool: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../../../src/services/letterJobService.js', () => ({
  processDueLetterJobs: services.processDueLetterJobs
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
vi.mock('../../../src/db/index.js', () => ({
  closePool: services.closePool
}));

import { maintenanceEntry, writeMaintenanceFailure } from '../../../src/cli/runMaintenance.js';

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

    // Review round 1: the class-only failure diagnostic left the operator
    // with one word. The config failure itself must name its variables on
    // stderr (the message is value-free by construction).
    const logged = errorSpy.mock.calls.flat().map(String).join('\n');
    expect(logged).toContain('LETTER_PROVIDER');
    expect(logged).toContain('STRIPE_SECRET_KEY');
  });

  it('runs a valid development maintenance pass end to end', async () => {
    vi.stubEnv('LETTER_IRL_DEPLOYMENT_ENVIRONMENT', 'development');
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@fixture.example/db');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_maintenance_fixture');
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_maintenance_fixture');

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
});
