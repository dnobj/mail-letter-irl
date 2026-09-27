/**
 * Uploaded photos in the private bucket (#474, phase 3): the store every
 * deployed environment uses. The S3 client is a fake that keeps objects in a
 * map and records each command, so this checks the keys, headers and expiry
 * the store asks of the bucket.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const bucket = vi.hoisted(() => ({
  objects: new Map<
    string,
    { body: Buffer; metadata: Record<string, string>; contentType?: string; cacheControl?: string; lastModified: Date }
  >(),
  sent: [] as Array<{ command: string; input: Record<string, any> }>,
  failNext: null as Error | null
}));

vi.mock('@aws-sdk/client-s3', () => {
  class Command {
    constructor(readonly input: Record<string, any>) {}
  }
  class PutObjectCommand extends Command {}
  class GetObjectCommand extends Command {}
  class DeleteObjectCommand extends Command {}
  class ListObjectsV2Command extends Command {}
  class S3Client {
    async send(command: Command) {
      const input = command.input;
      bucket.sent.push({ command: command.constructor.name, input });
      if (bucket.failNext) {
        const failure = bucket.failNext;
        bucket.failNext = null;
        throw failure;
      }
      if (command instanceof PutObjectCommand) {
        bucket.objects.set(input.Key, {
          body: Buffer.from(input.Body),
          metadata: input.Metadata,
          contentType: input.ContentType,
          cacheControl: input.CacheControl,
          lastModified: new Date()
        });
        return {};
      }
      if (command instanceof GetObjectCommand) {
        const object = bucket.objects.get(input.Key);
        if (!object) throw Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' });
        return { Metadata: object.metadata, Body: { transformToByteArray: async () => new Uint8Array(object.body) } };
      }
      if (command instanceof DeleteObjectCommand) {
        bucket.objects.delete(input.Key);
        return {};
      }
      if (command instanceof ListObjectsV2Command) {
        return {
          Contents: [...bucket.objects.entries()]
            .filter(([key]) => key.startsWith(input.Prefix))
            .map(([Key, object]) => ({ Key, LastModified: object.lastModified }))
        };
      }
      throw new Error('unexpected command');
    }
    destroy() {}
  }
  return { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command };
});

import {
  cleanupExpiredImages,
  closeTempImageStore,
  deleteUploadedPhoto,
  getUploadedPhoto,
  storeUploadedPhoto
} from '../../../src/services/tempImageStore.js';

const keyFor = (userId: string) => `uploaded-photos/${createHash('sha256').update(userId).digest('hex').slice(0, 32)}`;

describe('uploaded photos in the bucket (#474)', () => {
  beforeEach(() => {
    bucket.objects.clear();
    bucket.sent.length = 0;
    bucket.failNext = null;
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TEMP_IMAGE_STORE', '');
    vi.stubEnv('TEMP_IMAGE_BUCKET_NAME', 'test-bucket');
    vi.stubEnv('TEMP_IMAGE_BUCKET_ENDPOINT', 'https://bucket.test');
    vi.stubEnv('TEMP_IMAGE_BUCKET_ACCESS_KEY_ID', 'test-key-id');
    vi.stubEnv('TEMP_IMAGE_BUCKET_SECRET_ACCESS_KEY', 'test-secret');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    closeTempImageStore();
  });

  it('keeps one photo per account under a key that does not name the account, never to be cached', async () => {
    await storeUploadedPhoto('auth0|a', Buffer.from('first'), 'image/jpeg');
    await storeUploadedPhoto('auth0|a', Buffer.from('second'), 'image/png');
    await storeUploadedPhoto('auth0|b', Buffer.from('theirs'), 'image/jpeg');

    expect([...bucket.objects.keys()].sort()).toEqual([keyFor('auth0|a'), keyFor('auth0|b')].sort());
    expect([...bucket.objects.keys()].join()).not.toContain('auth0');
    const mine = bucket.objects.get(keyFor('auth0|a'))!;
    expect(mine.body.toString()).toBe('second');
    expect(mine).toMatchObject({ contentType: 'image/png', cacheControl: 'private, no-store' });
    expect((await getUploadedPhoto('auth0|a'))?.toString()).toBe('second');
    expect((await getUploadedPhoto('auth0|b'))?.toString()).toBe('theirs');
  });

  it('reads a photo for 15 minutes, then deletes it on the next read', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-27T18:00:00Z'));
    await storeUploadedPhoto('auth0|a', Buffer.from('brief'), 'image/jpeg');
    expect(bucket.objects.get(keyFor('auth0|a'))!.metadata.expiresat).toBe(String(Date.parse('2026-09-27T18:15:00Z')));

    vi.setSystemTime(new Date('2026-09-27T18:14:59Z'));
    expect((await getUploadedPhoto('auth0|a'))?.toString()).toBe('brief');
    vi.setSystemTime(new Date('2026-09-27T18:15:00Z'));
    await expect(getUploadedPhoto('auth0|a')).resolves.toBeNull();
    expect(bucket.objects.has(keyFor('auth0|a'))).toBe(false);
  });

  it('treats a photo with no readable expiry as expired', async () => {
    bucket.objects.set(keyFor('auth0|a'), { body: Buffer.from('odd'), metadata: {}, lastModified: new Date() });
    await expect(getUploadedPhoto('auth0|a')).resolves.toBeNull();
    expect(bucket.objects.has(keyFor('auth0|a'))).toBe(false);
  });

  it('reads nothing for an account that holds no photo, and passes on any other failure', async () => {
    await expect(getUploadedPhoto('auth0|nobody')).resolves.toBeNull();
    bucket.failNext = Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
    await expect(getUploadedPhoto('auth0|a')).rejects.toThrow('Access Denied');
  });

  it('deletes a photo on request, is content when there is none, and passes on any other failure', async () => {
    await storeUploadedPhoto('auth0|a', Buffer.from('gone soon'), 'image/jpeg');
    await deleteUploadedPhoto('auth0|a');
    expect(bucket.objects.size).toBe(0);
    bucket.failNext = Object.assign(new Error('missing'), { name: 'NoSuchKey' });
    await expect(deleteUploadedPhoto('auth0|a')).resolves.toBeUndefined();
    bucket.failNext = Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
    await expect(deleteUploadedPhoto('auth0|a')).rejects.toThrow('Access Denied');
  });

  it('sweeps photos older than 15 minutes with the other temporary images', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-27T18:00:00Z'));
    await storeUploadedPhoto('auth0|old', Buffer.from('old'), 'image/jpeg');
    vi.setSystemTime(new Date('2026-09-27T18:10:00Z'));
    await storeUploadedPhoto('auth0|new', Buffer.from('new'), 'image/jpeg');

    vi.setSystemTime(new Date('2026-09-27T18:16:00Z'));
    expect(await cleanupExpiredImages()).toBe(1);
    expect([...bucket.objects.keys()]).toEqual([keyFor('auth0|new')]);
    expect(bucket.sent.filter(({ command }) => command === 'ListObjectsV2Command').map(({ input }) => input.Prefix)).toContain(
      'uploaded-photos/'
    );
  });
});
