/** Compatibility surface retained while pg-boss is removed from deployments. */

export async function initializeJobQueue(): Promise<never> {
  throw new Error('pg-boss has been replaced by the letter_jobs transactional outbox');
}

export function getJobQueue(): never {
  throw new Error('pg-boss has been replaced by the letter_jobs transactional outbox');
}

export async function runMaintenance(): Promise<void> {
  // pg-boss maintenance is no longer required.
}

export async function stopJobQueue(): Promise<void> {
  // No separate job queue pool exists.
}
