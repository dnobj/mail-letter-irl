import { describe, expect, it } from 'vitest';

import { isWakeConnectionError } from '../../../src/db/wakeRetry.js';

describe('Neon wake-up retry classification', () => {
  it.each(['57P03', '08001', 'ECONNREFUSED', 'ETIMEDOUT'])(
    'retries recognized connection code %s',
    (code) => {
      expect(isWakeConnectionError(Object.assign(new Error('connect failed'), { code }))).toBe(true);
    }
  );

  it('retries the connection-acquisition timeout returned by pg-pool', () => {
    const error = new Error('Connection terminated due to connection timeout', {
      cause: new Error('Connection terminated unexpectedly'),
    });

    expect(isWakeConnectionError(error)).toBe(true);
  });

  it('recognizes a safe wake-up error nested in a wrapper', () => {
    const cause = Object.assign(new Error('database is starting'), { code: '57P03' });
    expect(isWakeConnectionError(new Error('pool connection failed', { cause }))).toBe(true);
  });

  it.each([
    new Error('Connection terminated unexpectedly'),
    Object.assign(new Error('statement timeout'), { code: '57014' }),
    new Error('duplicate key value violates unique constraint'),
  ])('does not retry an error with an ambiguous query outcome', (error) => {
    expect(isWakeConnectionError(error)).toBe(false);
  });
});
