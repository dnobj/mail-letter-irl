const WAKE_RETRY_CODES = new Set([
  '57P03',
  '08001',
  'ECONNREFUSED',
  'ETIMEDOUT',
]);

const CONNECTION_ACQUISITION_MESSAGES = [
  /connection terminated due to connection timeout/i,
  /timeout exceeded when trying to connect/i,
];

export function isWakeConnectionError(error: unknown): boolean {
  let current = error;

  for (let depth = 0; depth < 4 && current; depth += 1) {
    const candidate = current as { cause?: unknown; code?: string; message?: string };
    if (candidate.code && WAKE_RETRY_CODES.has(candidate.code)) {
      return true;
    }
    if (
      candidate.message &&
      CONNECTION_ACQUISITION_MESSAGES.some((pattern) => pattern.test(candidate.message!))
    ) {
      return true;
    }
    current = candidate.cause;
  }

  return false;
}
