import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  cleanupExpiredImages,
  deleteUploadedPhoto,
  getImage,
  getStoreSize,
  getUploadedPhoto,
  storeImage,
  storeUploadedPhoto,
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

// Photos people upload through our card (#474, phase 3): one per account,
// replaced by the next, gone after fifteen minutes, never served by URL.
describe('tempImageStore uploaded photos (memory)', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.TEMP_IMAGE_STORE = 'memory';
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.TEMP_IMAGE_STORE;
  });

  it('keeps an account one photo, and a new one replaces it', async () => {
    await storeUploadedPhoto('auth0|a', Buffer.from('first'), 'image/jpeg');
    await storeUploadedPhoto('auth0|a', Buffer.from('second'), 'image/jpeg');
    expect((await getUploadedPhoto('auth0|a'))?.toString()).toBe('second');
  });

  it('keeps each account to its own photo', async () => {
    await storeUploadedPhoto('auth0|a', Buffer.from('mine'), 'image/jpeg');
    await storeUploadedPhoto('auth0|b', Buffer.from('theirs'), 'image/png');
    expect((await getUploadedPhoto('auth0|a'))?.toString()).toBe('mine');
    expect((await getUploadedPhoto('auth0|b'))?.toString()).toBe('theirs');
    await expect(getUploadedPhoto('auth0|nobody')).resolves.toBeNull();
  });

  it('forgets a photo after fifteen minutes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    await storeUploadedPhoto('auth0|a', Buffer.from('brief'), 'image/jpeg');
    vi.setSystemTime(new Date('2026-01-01T00:14:59Z'));
    expect((await getUploadedPhoto('auth0|a'))?.toString()).toBe('brief');
    vi.setSystemTime(new Date('2026-01-01T00:15:01Z'));
    await expect(getUploadedPhoto('auth0|a')).resolves.toBeNull();
  });

  it('sweeps an expired photo with the other temporary images', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    await storeUploadedPhoto('auth0|swept', Buffer.from('old'), 'image/jpeg');
    vi.setSystemTime(new Date('2026-01-01T00:16:00Z'));
    expect(await cleanupExpiredImages()).toBeGreaterThanOrEqual(1);
    await expect(getUploadedPhoto('auth0|swept')).resolves.toBeNull();
  });

  it('deletes a photo on request', async () => {
    await storeUploadedPhoto('auth0|a', Buffer.from('gone soon'), 'image/jpeg');
    await deleteUploadedPhoto('auth0|a');
    await expect(getUploadedPhoto('auth0|a')).resolves.toBeNull();
    await expect(deleteUploadedPhoto('auth0|never')).resolves.toBeUndefined();
  });

  it('is never reachable through the capability URL route', async () => {
    await storeUploadedPhoto('auth0|a', Buffer.from('private'), 'image/jpeg');
    const digest = createHash('sha256').update('auth0|a').digest('hex').slice(0, 32);
    await expect(getImage(digest)).resolves.toBeNull();
  });
});
