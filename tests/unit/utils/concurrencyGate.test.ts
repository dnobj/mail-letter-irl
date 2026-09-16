import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConcurrencyGateError, createConcurrencyGate } from '../../../src/utils/concurrencyGate.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  // Let queued microtasks (acquire resolutions, finally blocks) run.
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe('createConcurrencyGate', () => {
  // Fake timers throughout: the queue timers must never fire on their own, so
  // no test depends on wall-clock time.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs at most `limit` callers at once and starts the next when one finishes', async () => {
    const gate = createConcurrencyGate({ name: 'test', limit: 2, maxQueue: 5, queueTimeoutMs: 1000 });
    const first = deferred();
    const second = deferred();
    const third = deferred();
    const started: string[] = [];

    const run = (label: string, d: { promise: Promise<void> }) =>
      gate.run(async () => {
        started.push(label);
        await d.promise;
        return label;
      });

    const p1 = run('a', first);
    const p2 = run('b', second);
    const p3 = run('c', third);
    await settle();

    expect(started).toEqual(['a', 'b']);
    expect(gate.snapshot()).toMatchObject({ active: 2, queued: 1 });

    first.resolve();
    await settle();
    expect(started).toEqual(['a', 'b', 'c']);
    expect(gate.snapshot()).toMatchObject({ active: 2, queued: 0 });

    second.resolve();
    third.resolve();
    await expect(Promise.all([p1, p2, p3])).resolves.toEqual(['a', 'b', 'c']);
    expect(gate.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  it('fails fast with queue_full once the queue is at its cap', async () => {
    const gate = createConcurrencyGate({ name: 'decode', limit: 1, maxQueue: 1, queueTimeoutMs: 1000 });
    const hold = deferred();
    const running = gate.run(() => hold.promise);
    const waiting = gate.run(async () => 'waited');
    await settle();

    await expect(gate.run(async () => 'rejected')).rejects.toMatchObject({
      name: 'ConcurrencyGateError',
      gate: 'decode',
      reason: 'queue_full',
    });
    expect(gate.snapshot()).toMatchObject({ active: 1, queued: 1 });

    hold.resolve();
    await expect(waiting).resolves.toBe('waited');
    await running;
  });

  it('rejects a waiter with queue_timeout after queueTimeoutMs and drops it from the queue', async () => {
    const gate = createConcurrencyGate({ name: 'decode', limit: 1, maxQueue: 2, queueTimeoutMs: 100 });
    const hold = deferred();
    const running = gate.run(() => hold.promise);
    // The handler is attached before the timer fires, so the rejection is
    // never unhandled at the moment it happens.
    const outcome = gate.run(async () => 'never').catch((error: unknown) => error);
    await settle();
    expect(gate.snapshot()).toMatchObject({ active: 1, queued: 1 });

    await vi.advanceTimersByTimeAsync(100);
    const error = await outcome;
    expect(error).toBeInstanceOf(ConcurrencyGateError);
    expect(error).toMatchObject({ reason: 'queue_timeout' });
    expect(gate.snapshot()).toMatchObject({ active: 1, queued: 0 });

    // The slot the timed-out waiter would have taken goes back to the pool.
    hold.resolve();
    await running;
    expect(gate.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  it("clears a waiter's timer when it is handed a slot", async () => {
    const gate = createConcurrencyGate({ name: 'decode', limit: 1, maxQueue: 1, queueTimeoutMs: 100 });
    const hold = deferred();
    const running = gate.run(() => hold.promise);
    const waiting = gate.run(async () => 'ran');
    await settle();

    hold.resolve();
    await running;
    await expect(waiting).resolves.toBe('ran');
    // The hand-off cleared the waiter's timer: nothing is left to fire.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(gate.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  it('releases the slot when the work throws', async () => {
    const gate = createConcurrencyGate({ name: 'decode', limit: 1, maxQueue: 0, queueTimeoutMs: 1000 });
    await expect(gate.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(gate.snapshot()).toMatchObject({ active: 0, queued: 0 });
    await expect(gate.run(async () => 'next')).resolves.toBe('next');
  });

  describe('per-key share', () => {
    it("caps one key's running-plus-waiting callers and leaves other keys and unkeyed callers alone", async () => {
      const gate = createConcurrencyGate({ name: 'k', limit: 4, maxQueue: 4, queueTimeoutMs: 1000, perKeyLimit: 1 });
      const hold = deferred();
      const a1 = gate.run(() => hold.promise, 'a');
      await settle();

      await expect(gate.run(async () => 'a2', 'a')).rejects.toMatchObject({ reason: 'key_limit' });
      await expect(gate.run(async () => 'b1', 'b')).resolves.toBe('b1');
      await expect(gate.run(async () => 'unkeyed')).resolves.toBe('unkeyed');
      expect(gate.snapshot()).toMatchObject({ active: 1, keys: 1, perKeyLimit: 1 });

      hold.resolve();
      await a1;
      await expect(gate.run(async () => 'a3', 'a')).resolves.toBe('a3');
      expect(gate.snapshot()).toMatchObject({ active: 0, keys: 0 });
    });

    it('counts a waiting caller against its key and frees the share when it times out', async () => {
      const gate = createConcurrencyGate({ name: 'k', limit: 1, maxQueue: 2, queueTimeoutMs: 100, perKeyLimit: 2 });
      const hold = deferred();
      const running = gate.run(() => hold.promise, 'a');
      const waiting = gate.run(async () => 'w', 'a').catch((error: unknown) => error);
      await settle();
      expect(gate.snapshot()).toMatchObject({ active: 1, queued: 1, keys: 1 });

      await expect(gate.run(async () => 'third', 'a')).rejects.toMatchObject({ reason: 'key_limit' });

      await vi.advanceTimersByTimeAsync(100);
      expect(await waiting).toMatchObject({ reason: 'queue_timeout' });

      // The timed-out waiter no longer counts, so the key can queue again.
      const again = gate.run(async () => 'again', 'a');
      await settle();
      expect(gate.snapshot()).toMatchObject({ active: 1, queued: 1, keys: 1 });

      hold.resolve();
      await running;
      await expect(again).resolves.toBe('again');
      expect(gate.snapshot()).toMatchObject({ active: 0, queued: 0, keys: 0 });
    });

    it('keeps the share for a waiter that is handed a slot until its work settles', async () => {
      const gate = createConcurrencyGate({ name: 'k', limit: 1, maxQueue: 2, queueTimeoutMs: 1000, perKeyLimit: 2 });
      const hold = deferred();
      const holdAgain = deferred();
      const running = gate.run(() => hold.promise, 'a');
      const waiting = gate.run(() => holdAgain.promise, 'a');
      await settle();

      hold.resolve();
      await running;
      await settle();
      // The waiter now runs and still counts as one of the key's two.
      expect(gate.snapshot()).toMatchObject({ active: 1, queued: 0, keys: 1 });
      // A second caller for the key may queue behind it (limit 1), taking the
      // key's last share, so a third is refused.
      const queued = gate.run(async () => 'x', 'a');
      await settle();
      expect(gate.snapshot()).toMatchObject({ active: 1, queued: 1, keys: 1 });
      await expect(gate.run(async () => 'y', 'a')).rejects.toMatchObject({ reason: 'key_limit' });

      holdAgain.resolve();
      await waiting;
      await expect(queued).resolves.toBe('x');
      expect(gate.snapshot()).toMatchObject({ active: 0, queued: 0, keys: 0 });
    });
  });

  it('rejects invalid options', () => {
    expect(() => createConcurrencyGate({ name: 'x', limit: 0, maxQueue: 0, queueTimeoutMs: 1 })).toThrow(RangeError);
    expect(() => createConcurrencyGate({ name: 'x', limit: 1, maxQueue: -1, queueTimeoutMs: 1 })).toThrow(RangeError);
    expect(() => createConcurrencyGate({ name: 'x', limit: 1, maxQueue: 0, queueTimeoutMs: 0 })).toThrow(RangeError);
    expect(() => createConcurrencyGate({ name: 'x', limit: 1, maxQueue: 0, queueTimeoutMs: 1, perKeyLimit: 0 })).toThrow(RangeError);
  });
});
