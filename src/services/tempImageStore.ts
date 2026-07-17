/** Restart-safe temporary image storage backed by a private S3-compatible bucket. */

import { randomBytes } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

const TTL_MS = 15 * 60 * 1000;
const OBJECT_PREFIX = 'temp-images/';

interface StoredImage {
  base64Data: string;
  expiresAt: number;
}

interface BucketConfig {
  bucket: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const memoryStore = new Map<string, StoredImage>();
let s3Client: S3Client | null = null;

function bucketConfig(): BucketConfig | null {
  const bucket = process.env.TEMP_IMAGE_BUCKET_NAME || process.env.AWS_S3_BUCKET_NAME || process.env.BUCKET;
  const endpoint = process.env.TEMP_IMAGE_BUCKET_ENDPOINT || process.env.AWS_ENDPOINT_URL_S3 || process.env.AWS_ENDPOINT_URL || process.env.ENDPOINT;
  const region = process.env.TEMP_IMAGE_BUCKET_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || process.env.REGION || 'auto';
  const accessKeyId = process.env.TEMP_IMAGE_BUCKET_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || process.env.ACCESS_KEY_ID;
  const secretAccessKey = process.env.TEMP_IMAGE_BUCKET_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || process.env.SECRET_ACCESS_KEY;

  if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) return null;
  return { bucket, endpoint, region, accessKeyId, secretAccessKey };
}

function storageMode(): 'bucket' | 'memory' {
  const configured = bucketConfig();
  const requested = process.env.TEMP_IMAGE_STORE;

  if (requested === 'memory') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('TEMP_IMAGE_STORE=memory is not allowed in production');
    }
    return 'memory';
  }
  if (configured) return 'bucket';
  if (process.env.NODE_ENV === 'production' || requested === 'bucket') {
    throw new Error('Temporary image bucket credentials are required in production');
  }
  return 'memory';
}

function client(config: BucketConfig): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }
  return s3Client;
}

function objectKey(token: string): string {
  return `${OBJECT_PREFIX}${token}`;
}

function isNotFound(error: unknown): boolean {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate?.name === 'NoSuchKey' || candidate?.$metadata?.httpStatusCode === 404;
}

export async function storeImage(base64Data: string): Promise<string> {
  const token = randomBytes(16).toString('hex');
  const expiresAt = Date.now() + TTL_MS;

  if (storageMode() === 'memory') {
    memoryStore.set(token, { base64Data, expiresAt });
    return token;
  }

  const config = bucketConfig()!;
  await client(config).send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: objectKey(token),
      Body: Buffer.from(base64Data, 'base64'),
      ContentType: 'image/jpeg',
      CacheControl: 'private, max-age=900',
      Metadata: { expiresat: String(expiresAt) },
    })
  );
  return token;
}

export async function getImage(token: string): Promise<string | null> {
  if (storageMode() === 'memory') {
    const entry = memoryStore.get(token);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      memoryStore.delete(token);
      return null;
    }
    return entry.base64Data;
  }

  const config = bucketConfig()!;
  try {
    const response = await client(config).send(
      new GetObjectCommand({ Bucket: config.bucket, Key: objectKey(token) })
    );
    const expiresAt = Number.parseInt(response.Metadata?.expiresat || '', 10);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      await client(config).send(
        new DeleteObjectCommand({ Bucket: config.bucket, Key: objectKey(token) })
      );
      return null;
    }
    if (!response.Body) return null;
    const bytes = await response.Body.transformToByteArray();
    return Buffer.from(bytes).toString('base64');
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function cleanupExpiredImages(): Promise<number> {
  const now = Date.now();
  if (storageMode() === 'memory') {
    let deleted = 0;
    for (const [token, entry] of memoryStore) {
      if (entry.expiresAt <= now) {
        memoryStore.delete(token);
        deleted += 1;
      }
    }
    return deleted;
  }

  const config = bucketConfig()!;
  let continuationToken: string | undefined;
  let deleted = 0;
  do {
    const listed = await client(config).send(
      new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: OBJECT_PREFIX,
        ContinuationToken: continuationToken,
      })
    );
    for (const object of listed.Contents || []) {
      if (!object.Key || !object.LastModified) continue;
      if (object.LastModified.getTime() + TTL_MS > now) continue;
      await client(config).send(
        new DeleteObjectCommand({ Bucket: config.bucket, Key: object.Key })
      );
      deleted += 1;
    }
    continuationToken = listed.NextContinuationToken;
  } while (continuationToken);

  return deleted;
}

export function getStoreSize(): number {
  return memoryStore.size;
}

export function closeTempImageStore(): void {
  s3Client?.destroy();
  s3Client = null;
}
