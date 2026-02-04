/**
 * Unit tests for workerEvents
 *
 * Tests the worker event emitter and configuration functions:
 * - Event emission for on-demand polling
 * - Environment variable parsing for polling interval
 * - Trigger-on-send feature flag
 *
 * User Stories Covered:
 * - US-INFRA-01: Configurable Worker Polling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('workerEvents', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('getPollingIntervalSeconds', () => {
    it('should return default value (2) when env var is not set', async () => {
      delete process.env.WORKER_POLLING_SECONDS;

      const { getPollingIntervalSeconds } = await import(
        '../../../src/workers/workerEvents.js'
      );

      expect(getPollingIntervalSeconds()).toBe(2);
    });

    it('should return configured value when env var is set', async () => {
      process.env.WORKER_POLLING_SECONDS = '600';

      const { getPollingIntervalSeconds } = await import(
        '../../../src/workers/workerEvents.js'
      );

      expect(getPollingIntervalSeconds()).toBe(600);
    });

    it('should return default value for invalid (non-numeric) input', async () => {
      process.env.WORKER_POLLING_SECONDS = 'invalid';

      const { getPollingIntervalSeconds } = await import(
        '../../../src/workers/workerEvents.js'
      );

      expect(getPollingIntervalSeconds()).toBe(2);
    });

    it('should return default value for zero', async () => {
      process.env.WORKER_POLLING_SECONDS = '0';

      const { getPollingIntervalSeconds } = await import(
        '../../../src/workers/workerEvents.js'
      );

      expect(getPollingIntervalSeconds()).toBe(2);
    });

    it('should return default value for negative numbers', async () => {
      process.env.WORKER_POLLING_SECONDS = '-5';

      const { getPollingIntervalSeconds } = await import(
        '../../../src/workers/workerEvents.js'
      );

      expect(getPollingIntervalSeconds()).toBe(2);
    });
  });

  describe('isTriggerOnSendEnabled', () => {
    it('should return false when env var is not set', async () => {
      delete process.env.WORKER_TRIGGER_ON_SEND;

      const { isTriggerOnSendEnabled } = await import(
        '../../../src/workers/workerEvents.js'
      );

      expect(isTriggerOnSendEnabled()).toBe(false);
    });

    it('should return true when env var is "true"', async () => {
      process.env.WORKER_TRIGGER_ON_SEND = 'true';

      const { isTriggerOnSendEnabled } = await import(
        '../../../src/workers/workerEvents.js'
      );

      expect(isTriggerOnSendEnabled()).toBe(true);
    });

    it('should return false when env var is "false"', async () => {
      process.env.WORKER_TRIGGER_ON_SEND = 'false';

      const { isTriggerOnSendEnabled } = await import(
        '../../../src/workers/workerEvents.js'
      );

      expect(isTriggerOnSendEnabled()).toBe(false);
    });

    it('should return false for other truthy-looking values', async () => {
      process.env.WORKER_TRIGGER_ON_SEND = '1';

      const { isTriggerOnSendEnabled } = await import(
        '../../../src/workers/workerEvents.js'
      );

      // Strict comparison to 'true' string
      expect(isTriggerOnSendEnabled()).toBe(false);
    });
  });

  describe('triggerPoll', () => {
    it('should emit trigger-poll event with queue name', async () => {
      const { workerEvents, triggerPoll } = await import(
        '../../../src/workers/workerEvents.js'
      );

      const listener = vi.fn();
      workerEvents.on('trigger-poll', listener);

      triggerPoll('send-letter');

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({ queue: 'send-letter' });

      workerEvents.removeListener('trigger-poll', listener);
    });

    it('should emit trigger-poll event with wildcard when no queue specified', async () => {
      const { workerEvents, triggerPoll } = await import(
        '../../../src/workers/workerEvents.js'
      );

      const listener = vi.fn();
      workerEvents.on('trigger-poll', listener);

      triggerPoll();

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({ queue: '*' });

      workerEvents.removeListener('trigger-poll', listener);
    });

    it('should allow multiple listeners', async () => {
      const { workerEvents, triggerPoll } = await import(
        '../../../src/workers/workerEvents.js'
      );

      const listener1 = vi.fn();
      const listener2 = vi.fn();
      workerEvents.on('trigger-poll', listener1);
      workerEvents.on('trigger-poll', listener2);

      triggerPoll('test-queue');

      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);

      workerEvents.removeListener('trigger-poll', listener1);
      workerEvents.removeListener('trigger-poll', listener2);
    });
  });
});
