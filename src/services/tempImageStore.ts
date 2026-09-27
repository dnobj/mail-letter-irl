/** Restart-safe temporary image storage backed by a private S3-compatible bucket. */

import { createHash, randomBytes } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

const TTL_MS = 15 * 60 * 1000;
const OBJECT_PREFIX = 'temp-images/';
/**
 * Photos people upload through our card (#474, phase 3). One per account,
 * under a key made from the account, so a new upload replaces the last one.
 * GET /api/temp-image/:token reads OBJECT_PREFIX only, so nothing here is
 * ever served by URL; the preview tools read an account's own photo directly
 * (src/services/imageService.ts). Kept as long as the temporary images: long
 * enough to make the preview, which keeps its own copy.
 */
const UPLOADED_PHOTO_PREFIX = 'uploaded-photos/';
export const UPLOADED_PHOTO_TTL_MS = TTL_MS;

/**
 * What an account's recent upload records for a photo it sent through our
 * card: not an address anyone can fetch, but a reference the image service
 * resolves to the CALLER's own photo (src/services/imageService.ts). A model
 * that passes it as imageUrl reaches only its own person's photo.
 */
export const UPLOADED_PHOTO_REFERENCE = 'letterirl-upload:latest';

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

/**
 * Non-throwing probe for callers that must degrade gracefully instead of
 * erroring mid-flight (generate_image_for_mail preflights this BEFORE
 * reserving a credit or calling the paid provider - review finding on
 * PR #247: a prod misconfig here must not burn money silently).
 */
export function isTempImageStoreConfigured(): boolean {
  try {
    storageMode();
    return true;
  } catch {
    return false;
  }
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

/**
 * Time limits on every bucket request. The SDK's default is to wait for ever,
 * so a request lost on the network would hold a generated image, or an
 * account's photo upload (which then refuses the next one), indefinitely.
 * requestTimeout only warns unless throwOnRequestTimeout is set.
 */
export const BUCKET_REQUEST_LIMITS = {
  connectionTimeout: 5_000,
  requestTimeout: 30_000,
  throwOnRequestTimeout: true,
} as const;

function client(config: BucketConfig): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      requestHandler: { ...BUCKET_REQUEST_LIMITS },
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
    for (const store of [memoryStore, uploadedPhotoMemory]) {
      for (const [key, entry] of store) {
        if (entry.expiresAt <= now) {
          store.delete(key);
          deleted += 1;
        }
      }
    }
    return deleted;
  }

  const config = bucketConfig()!;
  let deleted = 0;
  for (const prefix of [OBJECT_PREFIX, UPLOADED_PHOTO_PREFIX]) {
    let continuationToken: string | undefined;
    do {
      const listed = await client(config).send(
        new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: prefix,
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
  }

  return deleted;
}

// ---------------------------------------------------------------------------
// Uploaded photos (#474, phase 3): one per account, never served by URL.
// ---------------------------------------------------------------------------

const uploadedPhotoMemory = new Map<string, StoredImage>();

function uploadedPhotoKey(userId: string): string {
  // The account id is not a safe object key (auth0|..., google-oauth2|...),
  // and the key should not name the account. A digest is both.
  return `${UPLOADED_PHOTO_PREFIX}${createHash('sha256').update(userId).digest('hex').slice(0, 32)}`;
}

/** Keep an account's photo, replacing the one it held. */
export async function storeUploadedPhoto(userId: string, bytes: Buffer, contentType: string): Promise<void> {
  const expiresAt = Date.now() + UPLOADED_PHOTO_TTL_MS;
  const key = uploadedPhotoKey(userId);

  if (storageMode() === 'memory') {
    uploadedPhotoMemory.set(key, { base64Data: bytes.toString('base64'), expiresAt });
    return;
  }

  const config = bucketConfig()!;
  await client(config).send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: bytes,
      ContentType: contentType,
      CacheControl: 'private, no-store',
      Metadata: { expiresat: String(expiresAt) },
    })
  );
}

/** An account's photo while it lasts, or null. */
export async function getUploadedPhoto(userId: string): Promise<Buffer | null> {
  const key = uploadedPhotoKey(userId);

  if (storageMode() === 'memory') {
    const entry = uploadedPhotoMemory.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      uploadedPhotoMemory.delete(key);
      return null;
    }
    return Buffer.from(entry.base64Data, 'base64');
  }

  const config = bucketConfig()!;
  try {
    const response = await client(config).send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
    const expiresAt = Number.parseInt(response.Metadata?.expiresat || '', 10);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      await client(config).send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
      return null;
    }
    if (!response.Body) return null;
    return Buffer.from(await response.Body.transformToByteArray());
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** Forget an account's photo, if it holds one. */
export async function deleteUploadedPhoto(userId: string): Promise<void> {
  const key = uploadedPhotoKey(userId);
  if (storageMode() === 'memory') {
    uploadedPhotoMemory.delete(key);
    return;
  }
  const config = bucketConfig()!;
  try {
    await client(config).send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

export function getStoreSize(): number {
  return memoryStore.size;
}

export function closeTempImageStore(): void {
  s3Client?.destroy();
  s3Client = null;
}
