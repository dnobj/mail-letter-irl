/**
 * Held mail's PDFs in the private bucket (#697): the store every deployed
 * environment uses. The S3 client is a fake that keeps objects in a map and
 * records each command, so this checks the keys, headers and time limits the
 * store asks of the bucket, and that the image cleanup leaves these alone.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bucket = vi.hoisted(() => ({
  objects: new Map<string, { body: Buffer; contentType?: string; cacheControl?: string; lastModified: Date }>(),
  sent: [] as Array<{ command: string; input: Record<string, any>; options?: Record<string, any> }>,
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
    async send(command: Command, options?: Record<string, any>) {
      const input = command.input;
      bucket.sent.push({ command: command.constructor.name, input, options });
      if (bucket.failNext) {
        const failure = bucket.failNext;
        bucket.failNext = null;
        throw failure;
      }
      if (command instanceof PutObjectCommand) {
        bucket.objects.set(input.Key, {
          body: Buffer.from(input.Body),
          contentType: input.ContentType,
          cacheControl: input.CacheControl,
          lastModified: new Date()
        });
        return {};
      }
      if (command instanceof GetObjectCommand) {
        const object = bucket.objects.get(input.Key);
        if (!object) throw Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' });
        return { Metadata: {}, Body: { transformToByteArray: async () => new Uint8Array(object.body) } };
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
  deleteHeldPdf,
  getHeldPdf,
  HELD_PDF_REQUEST_TIMEOUT_MS,
  heldPdfKey,
  listHeldPdfs,
  storeHeldPdf
} from '../../../src/services/tempImageStore.js';

const ID = '0b7c6a52-1d2e-4f3a-9b8c-7d6e5f4a3b2c';

describe('held PDFs in the bucket (#697)', () => {
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
    vi.unstubAllEnvs();
    closeTempImageStore();
  });

  it("keeps a letter's PDF under held-pdf/<letter id>.pdf, never to be cached, each request time-limited", async () => {
    await expect(storeHeldPdf(ID, Buffer.from('%PDF- one'))).resolves.toBe(true);
    const object = bucket.objects.get(`held-pdf/${ID}.pdf`)!;
    expect(object.body.toString()).toBe('%PDF- one');
    expect(object).toMatchObject({ contentType: 'application/pdf', cacheControl: 'private, no-store' });
    expect((await getHeldPdf(ID))?.toString()).toBe('%PDF- one');
    await deleteHeldPdf(ID);
    expect(bucket.objects.size).toBe(0);
    expect(bucket.sent.map(sent => sent.command)).toEqual(['PutObjectCommand', 'GetObjectCommand', 'DeleteObjectCommand']);
    for (const sent of bucket.sent) expect(sent.options?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(HELD_PDF_REQUEST_TIMEOUT_MS).toBe(20_000);
  });

  it('reads none for a letter with none, and deletes none without a failure', async () => {
    await expect(getHeldPdf(ID)).resolves.toBeNull();
    await expect(deleteHeldPdf(ID)).resolves.toBeUndefined();
  });

  it('passes on a failure that is not a missing object', async () => {
    bucket.failNext = Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
    await expect(getHeldPdf(ID)).rejects.toThrow('Access Denied');
    bucket.failNext = Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
    await expect(deleteHeldPdf(ID)).rejects.toThrow('Access Denied');
  });

  it('never makes a key of an id that could leave its prefix or name another object', async () => {
    for (const id of ['', '../temp-images/x', 'a/b', 'a.pdf', 'x'.repeat(129), 'a b']) {
      expect(heldPdfKey(id), id).toBeNull();
      await expect(storeHeldPdf(id, Buffer.from('%PDF-'))).resolves.toBe(false);
      await expect(getHeldPdf(id)).resolves.toBeNull();
      await expect(deleteHeldPdf(id)).resolves.toBeUndefined();
    }
    expect(bucket.sent).toEqual([]);
    expect(heldPdfKey(ID)).toBe(`held-pdf/${ID}.pdf`);
  });

  it('lists every held PDF by its letter, and only those', async () => {
    const stored = new Date('2026-10-17T12:00:00Z');
    bucket.objects.set(`held-pdf/${ID}.pdf`, { body: Buffer.from('a'), lastModified: stored });
    bucket.objects.set('held-pdf/notes.txt', { body: Buffer.from('b'), lastModified: stored });
    bucket.objects.set('temp-images/abc', { body: Buffer.from('c'), lastModified: stored });
    await expect(listHeldPdfs()).resolves.toEqual([{ letterId: ID, storedAt: stored }]);
    expect(bucket.sent[0]).toMatchObject({ command: 'ListObjectsV2Command', input: { Prefix: 'held-pdf/' } });
  });

  it('is never swept by the image cleanup, however old', async () => {
    const old = new Date('2020-01-01T00:00:00Z');
    bucket.objects.set(`held-pdf/${ID}.pdf`, { body: Buffer.from('a'), lastModified: old });
    bucket.objects.set('temp-images/abc', { body: Buffer.from('c'), lastModified: old });
    await expect(cleanupExpiredImages()).resolves.toBe(1);
    expect([...bucket.objects.keys()]).toEqual([`held-pdf/${ID}.pdf`]);
    expect(bucket.sent.filter(sent => sent.command === 'ListObjectsV2Command').map(sent => sent.input.Prefix)).not.toContain('held-pdf/');
  });
});
