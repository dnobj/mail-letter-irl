/** Compatibility wrapper for the former pg-boss worker. */

export { processLetterJob } from '../services/letterJobService.js';

export async function startLetterWorker(): Promise<void> {
  throw new Error('In-process letter workers are disabled; use the transactional outbox');
}

export async function stopLetterWorker(): Promise<void> {
  // No worker process exists.
}
