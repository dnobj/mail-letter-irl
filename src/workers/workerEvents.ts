/**
 * Worker Events
 *
 * Event emitter for coordinating between job producers (tools that queue jobs)
 * and job consumers (workers that process jobs).
 *
 * Used for on-demand worker triggering when WORKER_TRIGGER_ON_SEND=true.
 */

import { EventEmitter } from 'events';

/**
 * Shared event emitter for worker coordination
 *
 * Events:
 * - 'trigger-poll': Signals workers to check for jobs immediately
 *   Payload: { queue: string } - The queue name to poll ('*' for all)
 */
export const workerEvents = new EventEmitter();

/**
 * Trigger immediate job polling for a specific queue
 *
 * @param queue - Queue name to poll, or '*' for all queues
 */
export function triggerPoll(queue: string = '*'): void {
  workerEvents.emit('trigger-poll', { queue });
}

/**
 * Check if on-demand triggering is enabled
 */
export function isTriggerOnSendEnabled(): boolean {
  return process.env.WORKER_TRIGGER_ON_SEND === 'true';
}

/**
 * Get the configured polling interval in seconds
 *
 * @returns Polling interval in seconds (default: 2)
 */
export function getPollingIntervalSeconds(): number {
  const value = parseInt(process.env.WORKER_POLLING_SECONDS || '2', 10);
  // Validate: must be positive integer, fallback to default if invalid
  if (isNaN(value) || value < 1) {
    console.warn(`⚠️  Invalid WORKER_POLLING_SECONDS value, using default (2)`);
    return 2;
  }
  return value;
}
