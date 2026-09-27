/**
 * A photo sent through our upload card, in chunks (#474, phase 3).
 *
 * MCP Apps gives a card no file store, so in Claude the upload card shrinks
 * the photo itself and sends it through the card-only tool
 * upload_photo_chunk, one chunk per call. Chunks are held here, in this
 * process's memory, until the last one arrives; the photo is then checked,
 * kept in the private image store as the account's one uploaded photo, and
 * recorded as its recent upload, so a preview tool called with no image uses
 * it (src/services/previewImageSource.ts).
 *
 * Limits, per account unless noted:
 * - one upload at a time: a new upload (chunk 0) drops the one in progress,
 *   and is refused while the last photo is still being checked and kept, so
 *   photos are kept in the order they were sent;
 * - one photo held: a finished upload replaces the photo held before it;
 * - DAILY uploads started in a rolling 24 hours (dailyPhotoUploadsPerAccount);
 * - a chunk of at most MAX_CHUNK_CHARS base64, at most MAX_CHUNKS chunks and
 *   MAX_PHOTO_BYTES in all, finished within UPLOAD_WINDOW_MS;
 * - across all accounts, at most MAX_PENDING_BYTES held in memory.
 *
 * Every call comes through the MCP server, so only a signed-in account with
 * the mail:draft scope reaches this. In-memory by design: the API runs as one
 * process, a partial photo never touches storage, and a restart mid-upload
 * only means choosing the photo again.
 */

import { dailyPhotoUploadsPerAccount } from '../config/cardUpload.js';
import { inspectUploadedPhoto } from './imageService.js';
import { setRecentUploadedImage } from './recentUploadStore.js';
import { storeUploadedPhoto, UPLOADED_PHOTO_REFERENCE } from './tempImageStore.js';

/** 512 Ki characters of base64: 384 KiB of photo, well under the 1 MB MCP body cap. */
export const MAX_CHUNK_CHARS = 512 * 1024;
export const MAX_CHUNKS = 24;
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
export const UPLOAD_WINDOW_MS = 10 * 60 * 1000;
export const MAX_PENDING_BYTES = 64 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

export type PhotoContext = 'postcard' | 'header_image' | 'inline_image';
const CONTEXTS: ReadonlySet<string> = new Set(['postcard', 'header_image', 'inline_image']);

const UPLOAD_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64_SHAPE = /^[A-Za-z0-9+/]*={0,2}$/;

export interface PhotoChunkInput {
  uploadId: string;
  index: number;
  total: number;
  data: string;
  context?: string;
}

export interface PhotoChunkResult {
  uploadId: string;
  received: number;
  total: number;
  done: boolean;
  width?: number;
  height?: number;
}

/** A refusal the card shows as it is: plain words, nothing internal. */
export class PhotoUploadRefusedError extends Error {
  readonly diagnosticClass: string;

  constructor(
    readonly code:
      | 'UNAVAILABLE'
      | 'BAD_CHUNK'
      | 'OUT_OF_ORDER'
      | 'TOO_LARGE'
      | 'DAILY_LIMIT'
      | 'BUSY'
      | 'STILL_SAVING'
      | 'FAILED',
    message: string
  ) {
    super(message);
    this.name = 'PhotoUploadRefusedError';
    this.diagnosticClass = code;
  }
}

interface PendingUpload {
  uploadId: string;
  total: number;
  context: PhotoContext | undefined;
  chunks: Buffer[];
  bytes: number;
  startedAtMs: number;
}

const pending = new Map<string, PendingUpload>();
const startedAt = new Map<string, number[]>();
interface Finishing {
  uploadId: string;
  /** The photo's size: in memory, and counted against the budget, until it is kept. */
  bytes: number;
  answer: Promise<PhotoChunkResult>;
}

// The account's one upload whose photo is being checked and kept (an account
// never has two: a new upload waits for it), and its last finished one, so a
// chunk of either sent again (the answer was lost on the way back, or a client
// sends in parallel) gets the same answer, rather than "interrupted" or a
// second start.
const finishing = new Map<string, Finishing>();
const finished = new Map<string, { result: PhotoChunkResult; atMs: number }>();

function pendingBytes(): number {
  let bytes = 0;
  for (const upload of pending.values()) bytes += upload.bytes;
  for (const finish of finishing.values()) bytes += finish.bytes;
  return bytes;
}

/** Forget what no longer counts, so memory stays bounded by recent use. */
function dropExpired(nowMs: number): void {
  for (const [userId, upload] of pending) {
    if (nowMs - upload.startedAtMs > UPLOAD_WINDOW_MS) pending.delete(userId);
  }
  for (const [userId, done] of finished) {
    if (nowMs - done.atMs > UPLOAD_WINDOW_MS) finished.delete(userId);
  }
  for (const userId of startedAt.keys()) recentStarts(userId, nowMs);
}

function recentStarts(userId: string, nowMs: number): number[] {
  const starts = (startedAt.get(userId) ?? []).filter((at) => nowMs - at < DAY_MS);
  if (starts.length > 0) startedAt.set(userId, starts);
  else startedAt.delete(userId);
  return starts;
}

function checkShape(input: PhotoChunkInput): PhotoContext | undefined {
  const bad = (message: string) => new PhotoUploadRefusedError('BAD_CHUNK', message);
  if (typeof input.uploadId !== 'string' || !UPLOAD_ID_SHAPE.test(input.uploadId)) {
    throw bad('That upload could not be read. Choose the photo again.');
  }
  if (!Number.isInteger(input.total) || input.total < 1 || input.total > MAX_CHUNKS) {
    throw new PhotoUploadRefusedError('TOO_LARGE', 'That photo is too large to upload. Choose a smaller one.');
  }
  if (!Number.isInteger(input.index) || input.index < 0 || input.index >= input.total) {
    throw bad('That upload could not be read. Choose the photo again.');
  }
  if (typeof input.data !== 'string' || input.data.length === 0 || input.data.length > MAX_CHUNK_CHARS) {
    throw bad('That upload could not be read. Choose the photo again.');
  }
  if (input.data.length % 4 !== 0 || !BASE64_SHAPE.test(input.data)) {
    throw bad('That upload could not be read. Choose the photo again.');
  }
  if (input.context !== undefined && !CONTEXTS.has(input.context)) {
    throw bad('That upload could not be read. Choose the photo again.');
  }
  return input.context as PhotoContext | undefined;
}

/**
 * Take one chunk from an account. Chunk 0 starts an upload, later chunks
 * continue it in order, and the last one finishes it. The chunk just received,
 * or any chunk of the upload being finished or just finished, sent again,
 * answers as before and changes nothing, so the card may retry a call whose
 * answer it lost.
 */
export async function receivePhotoChunk(
  userId: string,
  input: PhotoChunkInput,
  nowMs: number = Date.now()
): Promise<PhotoChunkResult> {
  const context = checkShape(input);
  dropExpired(nowMs);

  // Any chunk of an upload finishing or just finished, sent again, gets its
  // answer and starts nothing. dropExpired has already let go of a finished
  // one older than the window.
  const inFlight = finishing.get(userId);
  if (inFlight && inFlight.uploadId === input.uploadId) return inFlight.answer;
  const done = finished.get(userId);
  if (done && done.result.uploadId === input.uploadId) return done.result;

  let upload = pending.get(userId);
  if (input.index === 0 && upload?.uploadId !== input.uploadId) {
    // One photo kept at a time per account, so the last upload started is
    // the photo held. The card waits for each answer, so it meets this only
    // when an answer was lost and a new card starts a photo while the last is
    // still being saved; the sentence tells the person what to do.
    if (finishing.has(userId)) {
      throw new PhotoUploadRefusedError(
        'STILL_SAVING',
        'Your last photo is still being saved. Please try again in a moment.'
      );
    }
    // A new upload replaces the one in progress; it counts against the day.
    pending.delete(userId);
    const starts = recentStarts(userId, nowMs);
    if (starts.length >= dailyPhotoUploadsPerAccount()) {
      throw new PhotoUploadRefusedError(
        'DAILY_LIMIT',
        'This account has uploaded as many photos as it can today. Please try again tomorrow, or use a link to the photo.'
      );
    }
    if (pendingBytes() + input.data.length > MAX_PENDING_BYTES) {
      throw new PhotoUploadRefusedError('BUSY', 'Photo uploads are busy right now. Please try again in a minute.');
    }
    startedAt.set(userId, [...starts, nowMs]);
    upload = { uploadId: input.uploadId, total: input.total, context, chunks: [], bytes: 0, startedAtMs: nowMs };
    pending.set(userId, upload);
  }

  if (!upload || upload.uploadId !== input.uploadId || upload.total !== input.total) {
    throw new PhotoUploadRefusedError('OUT_OF_ORDER', 'That upload was interrupted. Choose the photo again.');
  }
  // The chunk just received, sent again: the same answer, nothing appended.
  if (input.index === upload.chunks.length - 1) {
    return { uploadId: upload.uploadId, received: upload.chunks.length, total: upload.total, done: false };
  }
  if (input.index !== upload.chunks.length) {
    pending.delete(userId);
    throw new PhotoUploadRefusedError('OUT_OF_ORDER', 'That upload was interrupted. Choose the photo again.');
  }

  const chunk = Buffer.from(input.data, 'base64');
  if (upload.bytes + chunk.length > MAX_PHOTO_BYTES) {
    pending.delete(userId);
    throw new PhotoUploadRefusedError('TOO_LARGE', 'That photo is too large to upload. Choose a smaller one.');
  }
  if (pendingBytes() + chunk.length > MAX_PENDING_BYTES) {
    pending.delete(userId);
    throw new PhotoUploadRefusedError('BUSY', 'Photo uploads are busy right now. Please try again in a minute.');
  }
  upload.chunks.push(chunk);
  upload.bytes += chunk.length;

  if (upload.chunks.length < upload.total) {
    return { uploadId: upload.uploadId, received: upload.chunks.length, total: upload.total, done: false };
  }

  // The last chunk: the whole photo, checked, then kept in place of the last.
  // Until then it is the account's finish in flight, counted against the
  // memory budget as one buffer rather than its chunks.
  pending.delete(userId);
  const photo = Buffer.concat(upload.chunks);
  upload.chunks = [];
  const finish: Finishing = {
    uploadId: upload.uploadId,
    bytes: photo.length,
    answer: finishUpload(userId, upload, photo, nowMs)
  };
  finishing.set(userId, finish);
  // Off the record once settled: this entry and no other.
  const forget = () => {
    if (finishing.get(userId) === finish) finishing.delete(userId);
  };
  finish.answer.then(forget, forget);
  return finish.answer;
}

async function finishUpload(
  userId: string,
  upload: PendingUpload,
  photo: Buffer,
  nowMs: number
): Promise<PhotoChunkResult> {
  const inspected = await inspectUploadedPhoto(photo, userId);
  await storeUploadedPhoto(userId, photo, `image/${inspected.format}`);
  await setRecentUploadedImage(userId, UPLOADED_PHOTO_REFERENCE, upload.context);
  const result: PhotoChunkResult = {
    uploadId: upload.uploadId,
    received: upload.total,
    total: upload.total,
    done: true,
    width: inspected.width,
    height: inspected.height
  };
  finished.set(userId, { result, atMs: nowMs });
  return result;
}

/** For tests: how many accounts this process holds something for. */
export function photoUploadsHeld(): {
  pending: number;
  finishing: number;
  finished: number;
  counted: number;
  starts: number;
  bytes: number;
} {
  let starts = 0;
  for (const times of startedAt.values()) starts += times.length;
  return {
    pending: pending.size,
    finishing: finishing.size,
    finished: finished.size,
    counted: startedAt.size,
    starts,
    bytes: pendingBytes()
  };
}

/** For tests: start from nothing. */
export function resetPhotoUploads(): void {
  pending.clear();
  startedAt.clear();
  finishing.clear();
  finished.clear();
}
