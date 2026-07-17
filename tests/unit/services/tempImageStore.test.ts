import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupExpiredImages,
  getImage,
  getStoreSize,
  storeImage,
} from '../../../src/services/tempImageStore.js';

describe('tempImageStore memory fallback', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.TEMP_IMAGE_STORE = 'memory';
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.TEMP_IMAGE_STORE;
  });

  it('returns unique 32-character capability tokens', async () => {
    const token1 = await storeImage('data1');
    const token2 = await storeImage('data2');
    expect(token1).toMatch(/^[a-f0-9]{32}$/);
    expect(token2).not.toBe(token1);
  });

  it('retrieves the same image more than once', async () => {
    const token = await storeImage('reusableData');
    await expect(getImage(token)).resolves.toBe('reusableData');
    await expect(getImage(token)).resolves.toBe('reusableData');
  });

  it('returns null for an unknown token', async () => {
    await expect(getImage('nonexistent1234567890abcdef12345')).resolves.toBeNull();
  });

  it('expires and removes images after fifteen minutes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const token = await storeImage('expiringData');
    vi.setSystemTime(new Date('2026-01-01T00:16:00Z'));

    await expect(getImage(token)).resolves.toBeNull();
    expect(await cleanupExpiredImages()).toBeGreaterThanOrEqual(0);
  });

  it('reports the in-memory fallback size', async () => {
    const before = getStoreSize();
    await storeImage('newImage');
    expect(getStoreSize()).toBeGreaterThanOrEqual(before + 1);
  });
});
