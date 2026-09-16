/**
 * A small in-process concurrency gate.
 *
 * At most `limit` callers run at once. Up to `maxQueue` further callers wait,
 * each for at most `queueTimeoutMs`; anything beyond that fails fast. With
 * `perKeyLimit`, a caller that names a key (an account, say) is refused at
 * once when that key already has that many callers running or waiting, so one
 * key cannot fill the gate for everyone else. The gate exists so that work
 * whose memory cost is set by the caller (decoding a customer-supplied image,
 * holding a download buffer) cannot be multiplied by concurrency into an
 * out-of-memory kill of the whole process. One instance per resource, no
 * dependency, no timers left running once the queue drains.
 */

export type ConcurrencyGateRejection = 'queue_full' | 'queue_timeout' | 'key_limit';

export class ConcurrencyGateError extends Error {
  constructor(
    public readonly gate: string,
    public readonly reason: ConcurrencyGateRejection
  ) {
    super(`${gate} gate: ${reason}`);
    this.name = 'ConcurrencyGateError';
  }
}

export interface ConcurrencyGateOptions {
  /** Appears in the error and in diagnostics. */
  name: string;
  /** Callers allowed to run at once. At least 1. */
  limit: number;
  /** Callers allowed to wait for a slot. 0 means fail fast when full. */
  maxQueue: number;
  /** How long a waiting caller may wait before it fails with queue_timeout. */
  queueTimeoutMs: number;
  /**
   * Callers one key may have running or waiting at once. A keyed caller over
   * this share fails fast with key_limit. Unset means no per-key share.
   */
  perKeyLimit?: number;
}

export interface ConcurrencyGateSnapshot {
  active: number;
  queued: number;
  limit: number;
  maxQueue: number;
  perKeyLimit?: number;
  /** Distinct keys with a caller running or waiting. */
  keys: number;
}

export interface ConcurrencyGate {
  readonly name: string;
  /**
   * Runs `fn` once a slot is free; the slot is released when `fn` settles.
   * `key` names the caller's share (see perKeyLimit); it is optional.
   */
  run<T>(fn: () => Promise<T>, key?: string): Promise<T>;
  snapshot(): ConcurrencyGateSnapshot;
}

interface Waiter {
  key: string | undefined;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export function createConcurrencyGate(options: ConcurrencyGateOptions): ConcurrencyGate {
  const { name, limit, maxQueue, queueTimeoutMs, perKeyLimit } = options;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`${name} gate: limit must be a positive integer`);
  }
  if (!Number.isInteger(maxQueue) || maxQueue < 0) {
    throw new RangeError(`${name} gate: maxQueue must be a non-negative integer`);
  }
  if (!Number.isFinite(queueTimeoutMs) || queueTimeoutMs <= 0) {
    throw new RangeError(`${name} gate: queueTimeoutMs must be positive`);
  }
  if (perKeyLimit !== undefined && (!Number.isInteger(perKeyLimit) || perKeyLimit < 1)) {
    throw new RangeError(`${name} gate: perKeyLimit must be a positive integer`);
  }

  let active = 0;
  const waiters: Waiter[] = [];
  /** Running plus waiting callers per key. */
  const inFlightByKey = new Map<string, number>();

  function countKey(key: string | undefined, delta: 1 | -1): void {
    if (key === undefined) return;
    const next = (inFlightByKey.get(key) ?? 0) + delta;
    if (next > 0) inFlightByKey.set(key, next);
    else inFlightByKey.delete(key);
  }

  function acquire(key: string | undefined): Promise<void> {
    if (key !== undefined && perKeyLimit !== undefined && (inFlightByKey.get(key) ?? 0) >= perKeyLimit) {
      return Promise.reject(new ConcurrencyGateError(name, 'key_limit'));
    }
    if (active < limit) {
      active += 1;
      countKey(key, 1);
      return Promise.resolve();
    }
    if (waiters.length >= maxQueue) {
      return Promise.reject(new ConcurrencyGateError(name, 'queue_full'));
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        key,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          countKey(key, -1);
          reject(new ConcurrencyGateError(name, 'queue_timeout'));
        }, queueTimeoutMs),
      };
      waiter.timer.unref?.();
      waiters.push(waiter);
      countKey(key, 1);
    });
  }

  function release(key: string | undefined): void {
    countKey(key, -1);
    // Hand the slot straight to the next waiter: `active` is unchanged, the
    // finished caller's slot now belongs to the waiter.
    const next = waiters.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve();
      return;
    }
    active -= 1;
  }

  return {
    name,
    async run<T>(fn: () => Promise<T>, key?: string): Promise<T> {
      await acquire(key);
      try {
        return await fn();
      } finally {
        release(key);
      }
    },
    snapshot(): ConcurrencyGateSnapshot {
      return { active, queued: waiters.length, limit, maxQueue, perKeyLimit, keys: inFlightByKey.size };
    },
  };
}
