/**
 * A photo sent through our upload card, in chunks (#474, phase 3).
 *
 * The card shrinks the photo and sends it through upload_photo_chunk; this
 * service holds the chunks, finishes the upload on the last one, and keeps
 * the photo as the account's one uploaded photo and its recent upload. The
 * limits are the point: one upload at a time and one photo per account, a
 * daily count, and caps on chunk size, chunk count, photo size, time, and
 * memory across accounts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/imageService.js', () => ({
  inspectUploadedPhoto: vi.fn(async () => ({ width: 2400, height: 1600, format: 'jpeg' }))
}));
vi.mock('../../../src/services/tempImageStore.js', () => ({
  UPLOADED_PHOTO_REFERENCE: 'letterirl-upload:latest',
  storeUploadedPhoto: vi.fn(async () => undefined)
}));
vi.mock('../../../src/services/recentUploadStore.js', () => ({
  setRecentUploadedImage: vi.fn(async () => undefined)
}));

import { inspectUploadedPhoto } from '../../../src/services/imageService.js';
import { storeUploadedPhoto } from '../../../src/services/tempImageStore.js';
import { setRecentUploadedImage } from '../../../src/services/recentUploadStore.js';
import {
  MAX_CHUNK_CHARS,
  MAX_CHUNKS,
  MAX_PENDING_BYTES,
  MAX_PHOTO_BYTES,
  PhotoUploadRefusedError,
  photoUploadsHeld,
  receivePhotoChunk,
  resetPhotoUploads,
  UPLOAD_WINDOW_MS
} from '../../../src/services/photoUploadService.js';

const USER = 'auth0|owner';
const ID = '7b0e3f2a-9c1d-4e5f-8a6b-1c2d3e4f5a6b';
const OTHER_ID = '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0';
const NOW = Date.parse('2026-09-27T18:00:00Z');

/** Base64 of `bytes` bytes, each of value `fill`. */
const b64 = (bytes: number, fill = 7) => Buffer.alloc(bytes, fill).toString('base64');

async function refusal(promise: Promise<unknown>): Promise<PhotoUploadRefusedError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PhotoUploadRefusedError);
    return error as PhotoUploadRefusedError;
  }
  throw new Error('expected a refusal');
}

describe('photo uploads through the card (#474)', () => {
  beforeEach(() => {
    resetPhotoUploads();
    vi.mocked(inspectUploadedPhoto).mockClear();
    vi.mocked(storeUploadedPhoto).mockClear();
    vi.mocked(setRecentUploadedImage).mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('finishes a one-chunk upload: checks the photo, keeps it, and makes it the recent upload', async () => {
    const data = b64(300);
    await expect(
      receivePhotoChunk(USER, { uploadId: ID, index: 0, total: 1, data, context: 'postcard' }, NOW)
    ).resolves.toEqual({ uploadId: ID, received: 1, total: 1, done: true, width: 2400, height: 1600 });

    const photo = Buffer.from(data, 'base64');
    expect(inspectUploadedPhoto).toHaveBeenCalledWith(photo, USER);
    expect(storeUploadedPhoto).toHaveBeenCalledWith(USER, photo, 'image/jpeg');
    expect(setRecentUploadedImage).toHaveBeenCalledWith(USER, 'letterirl-upload:latest', 'postcard');
  });

  it('puts the chunks together in order and finishes on the last', async () => {
    const parts = [b64(300, 1), b64(300, 2), b64(120, 3)];
    for (const [index, data] of parts.entries()) {
      const answer = await receivePhotoChunk(USER, { uploadId: ID, index, total: 3, data }, NOW);
      expect(answer.received).toBe(index + 1);
      expect(answer.done).toBe(index === 2);
    }
    const stored = vi.mocked(storeUploadedPhoto).mock.calls[0][1] as Buffer;
    expect(stored.equals(Buffer.concat(parts.map(part => Buffer.from(part, 'base64'))))).toBe(true);
    expect(storeUploadedPhoto).toHaveBeenCalledTimes(1);
    // No context from the card: the recent upload has none either.
    expect(setRecentUploadedImage).toHaveBeenCalledWith(USER, 'letterirl-upload:latest', undefined);
  });

  it('answers a chunk sent again as before, and keeps it once', async () => {
    await receivePhotoChunk(USER, { uploadId: ID, index: 0, total: 2, data: b64(300, 1) }, NOW);
    await expect(
      receivePhotoChunk(USER, { uploadId: ID, index: 0, total: 2, data: b64(300, 1) }, NOW)
    ).resolves.toEqual({ uploadId: ID, received: 1, total: 2, done: false });
    await receivePhotoChunk(USER, { uploadId: ID, index: 1, total: 2, data: b64(300, 2) }, NOW);
    expect((vi.mocked(storeUploadedPhoto).mock.calls[0][1] as Buffer).length).toBe(600);
  });

  it('answers the last chunk sent again with the finished upload, and keeps the photo once', async () => {
    const first = await receivePhotoChunk(USER, { uploadId: ID, index: 0, total: 1, data: b64(300) }, NOW);
    await expect(
      receivePhotoChunk(USER, { uploadId: ID, index: 0, total: 1, data: b64(300) }, NOW + 1000)
    ).resolves.toEqual(first);
    expect(storeUploadedPhoto).toHaveBeenCalledTimes(1);
  });

  it('answers any chunk of the upload just finished the same way, and starts nothing', async () => {
    await receivePhotoChunk(USER, { uploadId: ID, index: 0, total: 2, data: b64(300, 1) }, NOW);
    const done = await receivePhotoChunk(USER, { uploadId: ID, index: 1, total: 2, data: b64(300, 2) }, NOW);
    await expect(receivePhotoChunk(USER, { uploadId: ID, index: 0, total: 2, data: b64(300, 1) }, NOW)).resolves.toEqual(done);
    expect(storeUploadedPhoto).toHaveBeenCalledTimes(1);
    // Not a new upload: nothing in progress, and one start counted.
    expect(photoUploadsHeld()).toEqual({ pending: 0, finishing: 0, finished: 1, counted: 1, starts: 1, bytes: 0 });
  });

  describe('a chunk sent again while the photo is being checked and kept', () => {
    /** Hold the photo's check open until release() is called. */
    function holdTheCheck(outcome: () => Promise<{ width: number; height: number; format: string }>) {
      let release!: () => void;
      const gate = new Promise<void>(resolve => (release = resolve));
      vi.mocked(inspectUploadedPhoto).mockImplementationOnce(async () => {
        await gate;
        return outcome();
      });
      return () => release();
    }

    it('waits for the same answer, and the photo is checked and kept once', async () => {
      const release = holdTheCheck(async () => ({ width: 2400, height: 1600, format: 'jpeg' }));
      await receivePhotoChunk(USER, { uploadId: ID, index: 0, total: 2, data: b64(300, 1) }, NOW);
      const first = receivePhotoChunk(USER, { uploadId: ID, index: 1, total: 2, data: b64(300, 2) }, NOW);
      const again = receivePhotoChunk(USER, { uploadId: ID, index: 1, total: 2, data: b64(300, 2) }, NOW);
      // Still held, and counted against the memory budget, until it is kept.
      expect(photoUploadsHeld()).toEqual({ pending: 0, finishing: 1, finished: 0, counted: 1, starts: 1, bytes: 600 });
      release();
      const answer = await first;
      await expect(again).resolves.toEqual(answer);
      expect(answer).toMatchObject({ done: true });
      expect(inspectUploadedPhoto).toHaveBeenCalledTimes(1);
      expect(storeUploadedPhoto).toHaveBeenCalledTimes(1);
      expect(photoUploadsHeld()).toEqual({ pending: 0, finishing: 0, finished: 1, counted: 1, starts: 1, bytes: 0 });
    });

    it('does not start a one-chunk upload again, or count it twice', async () => {
      const release = holdTheCheck(async () => ({ width: 2400, height: 1600, format: 'jpeg' }));
      const first = receivePhotoChunk(USER, { uploadId: ID, index: 0, total: 1, data: b64(300) }, NOW);
      const again = receivePhotoChunk(USER, { uploadId: ID, index: 0, total: 1, data: b64(300) }, NOW);
      release();
      await expect(again).resolves.toEqual(await first);
      expect(inspectUploadedPhoto).toHaveBeenCalledTimes(1);
      expect(photoUploadsHeld()).toMatchObject({ counted: 1, starts: 1 });
    });

    it('refuses to start a new upload until the last photo is kept, and counts nothing for it', async () => {
      const release = holdTheCheck(async () => ({ width: 2400, height: 1600, format: 'jpeg' }));
      const first = receivePhotoChunk(USER, { uploadId: ID, index: 0, total: 1, data: b64(300, 1) }, NOW);
      const refused = await refusal(
        receivePhotoChunk(USER, { uploadId: OTHER_ID, index: 0, total: 2, data: b64(300, 2) }, NOW)
      );
      expect(refused.code).toBe('STILL_SAVING');
      expect(refused.message).toBe('Your last photo is still being saved. Please try again in a moment.');
      expect(photoUploadsHeld()).toMatchObject({ pending: 0, finishing: 1, starts: 1, bytes: 300 });
      // Another account is not held back.
      await expect(
        receivePhotoChunk('auth0|other', { uploadId: OTHER_ID, index: 0, total: 1, data: b64(300, 3) }, NOW)
      ).resolves.toMatchObject({ done: true });
      release();
      await first;
      // Once it is kept, the new upload starts, and its photo is kept after the first.
      await receivePhotoChunk(USER, { uploadId: OTHER_ID, index: 0, total: 2, data: b64(300, 2) }, NOW);
      await expect(
        receivePhotoChunk(USER, { uploadId: OTHER_ID, index: 1, total: 2, data: b64(300, 2) }, NOW)
      ).resolves.toMatchObject({ uploadId: OTHER_ID, done: true });
      const kept = vi
        .mocked(storeUploadedPhoto)
        .mock.calls.filter(([user]) => user === USER)
        .map(([, photo]) => (photo as Buffer)[0]);
      expect(kept).toEqual([1, 2]);
    });

    it('takes a new upload once the last photo has failed its check', async () => {
      const failed = new Error('Unsupported image format. Please use PNG, JPEG, or WebP.');
      const release = holdTheCheck(async () => {
        throw failed;
      });
      const first = receivePhotoChunk(USER, { uploadId: ID, index: 0, total: 1, data: b64(300, 1) }, NOW);
      release();
      await expect(first).rejects.toBe(failed);
      await expect(
        receivePhotoChunk(USER, { uploadId: OTHER_ID, index: 0, total: 1, data: b64(300, 2) }, NOW)
      ).resolves.toMatchObject({ uploadId: OTHER_ID, done: true });
      expect(vi.mocked(storeUploadedPhoto).mock.calls.map(([, photo]) => (photo as Buffer)[0])).toEqual([2]);
    });

    it('gets the same refusal when the photo fails its check', async () => {
      const refused = new Error('Unsupported image format. Please use PNG, JPEG, or WebP.');
      const release = holdTheCheck(async () => {
        throw refused;
      });
      const first = receivePhotoChunk(USER, { uploadId: ID, index: 0, total: 1, data: b64(300) }, NOW);
      const again = receivePhotoChunk(USER, { uploadId: ID, index: 0, total: 1, data: b64(300) }, NOW);
      release();
      await expect(first).rejects.toBe(refused);
      await expect(again).rejects.toBe(refused);
      expect(storeUploadedPhoto).not.toHaveBeenCalled();
      expect(photoUploadsHeld()).toEqual({ pending: 0, finishing: 0, finished: 0, counted: 1, starts: 1, bytes: 0 });
    });
  });

  it('keeps the photo under the type its own bytes show', async () => {
    vi.mocked(inspectUploadedPhoto).mockResolvedValueOnce({ width: 2400, height: 1600, format: 'png' });
    await receivePhotoChunk(USER, { uploadId: ID, index: 0, total: 1, data: b64(300) }, NOW);
    expect(storeUploadedPhoto).toHaveBeenCalledWith(USER, expect.any(Buffer), 'image/png');
  });

  it('refuses a chunk out of order, and the upload must start again', async () => {
    await receivePhotoChunk(USER, { uploadId: ID, index: 0, total: 3, data: b64(300) }, NOW);
    const skipped = await refusal(receivePhotoChunk(USER, { uploadId: ID, index: 2, total: 3, data: b64(300) }, NOW));
    expect(skipped.code).toBe('OUT_OF_ORDER');
    const after = await refusal(receivePhotoChunk(USER, { uploadId: ID, index: 1, total: 3, data: b64(300) }, NOW));
    expect(after.code).toBe('OUT_OF_ORDER');
  });

  it('refuses a chunk for an upload it does not hold, or with another total', async () => {
    expect((await refusal(receivePhotoChunk(USER, { uploadId: ID, index: 1, total: 2, data: b64(300) }, NOW))).code).toBe(
      'OUT_OF_ORDER'
    );
    await receivePhotoChunk(USER, { uploadId: ID, index: 0, total: 3, data: b64(300) }, NOW);
    expect((await refusal(receivePhotoChunk(USER, { uploadId: ID, index: 1, total: 4, data: b64(300) }, NOW))).code).toBe(
      'OUT_OF_ORDER'
    );
  });

  it('lets a new upload replace the one in progress: one upload at a time', async () => {
    await receivePhotoChunk(USER, { uploadId: ID, index: 0, total: 2, data: b64(300, 1) }, NOW);
    await receivePhotoChunk(USER, { uploadId: OTHER_ID, index: 0, total: 2, data: b64(300, 5) }, NOW);
    expect((await refusal(receivePhotoChunk(USER, { uploadId: ID, index: 1, total: 2, data: b64(300) }, NOW))).code).toBe(
      'OUT_OF_ORDER'
    );
    await receivePhotoChunk(USER, { uploadId: OTHER_ID, index: 1, total: 2, data: b64(300, 6) }, NOW);
    const stored = vi.mocked(storeUploadedPhoto).mock.calls[0][1] as Buffer;
    expect(stored[0]).toBe(5);
  });

  it('keeps each account to its own upload', async () => {
    await receivePhotoChunk(USER, { uploadId: ID, index: 0, total: 2, data: b64(300, 1) }, NOW);
    await receivePhotoChunk('auth0|other', { uploadId: ID, index: 0, total: 2, data: b64(300, 9) }, NOW);
    await receivePhotoChunk(USER, { uploadId: ID, index: 1, total: 2, data: b64(300, 2) }, NOW);
    const stored = vi.mocked(storeUploadedPhoto).mock.calls[0];
    expect(stored[0]).toBe(USER);
    expect((stored[1] as Buffer)[0]).toBe(1);
  });

  it('drops an upload not finished within the window', async () => {
    await receivePhotoChunk(USER, { uploadId: ID, index: 0, total: 2, data: b64(300) }, NOW);
    const late = await refusal(
      receivePhotoChunk(USER, { uploadId: ID, index: 1, total: 2, data: b64(300) }, NOW + UPLOAD_WINDOW_MS + 1)
    );
    expect(late.code).toBe('OUT_OF_ORDER');
    expect(late.message).toBe('That upload was interrupted. Choose the photo again.');
  });

  it.each([
    ['an upload id that is not a UUID', { uploadId: 'upload-1' }],
    ['a negative index', { index: -1 }],
    ['an index past the total', { index: 2, total: 2 }],
    ['a fractional index', { index: 0.5 }],
    ['no data', { data: '' }],
    ['data that is not base64', { data: 'not base64!' }],
    ['base64 cut mid-quantum', { data: 'QUJD' + 'QQ' }],
    ['a context no preview uses', { context: 'avatar' }]
  ])('refuses %s', async (_label, overrides) => {
    const error = await refusal(
      receivePhotoChunk(USER, { uploadId: ID, index: 0, total: 1, data: b64(300), ...overrides } as never, NOW)
    );
    expect(error.code).toBe('BAD_CHUNK');
    expect(storeUploadedPhoto).not.toHaveBeenCalled();
  });

  it('refuses a chunk over the size a call may carry', async () => {
    const error = await refusal(
      receivePhotoChunk(USER, { uploadId: ID, index: 0, total: 1, data: 'A'.repeat(MAX_CHUNK_CHARS + 4) }, NOW)
    );
    expect(error.code).toBe('BAD_CHUNK');
  });

  it('refuses more chunks than a photo may have', async () => {
    const error = await refusal(
      receivePhotoChunk(USER, { uploadId: ID, index: 0, total: MAX_CHUNKS + 1, data: b64(300) }, NOW)
    );
    expect(error.code).toBe('TOO_LARGE');
  });

  it('refuses a photo over the size cap, and drops it', async () => {
    const chunk = b64(3 * (MAX_CHUNK_CHARS / 4));
    const perChunk = Buffer.from(chunk, 'base64').length;
    const fits = Math.floor(MAX_PHOTO_BYTES / perChunk);
    for (let index = 0; index < fits; index++) {
      await receivePhotoChunk(USER, { uploadId: ID, index, total: MAX_CHUNKS, data: chunk }, NOW);
    }
    const error = await refusal(receivePhotoChunk(USER, { uploadId: ID, index: fits, total: MAX_CHUNKS, data: chunk }, NOW));
    expect(error.code).toBe('TOO_LARGE');
    expect((await refusal(receivePhotoChunk(USER, { uploadId: ID, index: fits, total: MAX_CHUNKS, data: chunk }, NOW))).code).toBe(
      'OUT_OF_ORDER'
    );
  });

  it('counts the uploads an account starts in a day, and lets it start again the next', async () => {
    vi.stubEnv('LETTER_IRL_PHOTO_UPLOADS_PER_DAY', '3');
    const ids = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444'
    ];
    for (const id of ids.slice(0, 3)) {
      await receivePhotoChunk(USER, { uploadId: id, index: 0, total: 1, data: b64(300) }, NOW);
    }
    const capped = await refusal(receivePhotoChunk(USER, { uploadId: ids[3], index: 0, total: 1, data: b64(300) }, NOW));
    expect(capped.code).toBe('DAILY_LIMIT');
    // Another account is not affected.
    await expect(
      receivePhotoChunk('auth0|other', { uploadId: ids[3], index: 0, total: 1, data: b64(300) }, NOW)
    ).resolves.toMatchObject({ done: true });
    // A day later the first account may upload again.
    await expect(
      receivePhotoChunk(USER, { uploadId: ids[3], index: 0, total: 1, data: b64(300) }, NOW + 24 * 60 * 60 * 1000 + 1)
    ).resolves.toMatchObject({ done: true });
  });

  it('refuses a new upload while uploads in progress fill the memory budget', async () => {
    const chunk = b64(3 * (MAX_CHUNK_CHARS / 4));
    const perChunk = Buffer.from(chunk, 'base64').length;
    const perAccount = Math.floor(MAX_PHOTO_BYTES / perChunk);
    let held = 0;
    let account = 0;
    let index = 0;
    // Fill memory with unfinished uploads, chunk by chunk, across accounts,
    // until less than a chunk of room is left.
    while (held + perChunk <= MAX_PENDING_BYTES) {
      if (index === perAccount) {
        account += 1;
        index = 0;
      }
      await receivePhotoChunk(`auth0|filler-${account}`, { uploadId: ID, index, total: MAX_CHUNKS, data: chunk }, NOW);
      held += perChunk;
      index += 1;
    }
    const busy = await refusal(receivePhotoChunk(USER, { uploadId: ID, index: 0, total: 2, data: chunk }, NOW));
    expect(busy.code).toBe('BUSY');
    expect(busy.message).toBe('Photo uploads are busy right now. Please try again in a minute.');
    // Refused before it began: it does not count against the account's day.
    expect(photoUploadsHeld().counted).toBe(account + 1);
  });

  it('drops an upload in progress when the memory budget fills before its next chunk', async () => {
    const chunk = b64(3 * (MAX_CHUNK_CHARS / 4));
    const perChunk = Buffer.from(chunk, 'base64').length;
    const perAccount = Math.floor(MAX_PHOTO_BYTES / perChunk);
    // The account starts with a small first chunk while there is room.
    await receivePhotoChunk(USER, { uploadId: OTHER_ID, index: 0, total: 2, data: b64(300) }, NOW);
    let held = 300;
    let account = 0;
    let index = 0;
    while (held + perChunk <= MAX_PENDING_BYTES) {
      if (index === perAccount) {
        account += 1;
        index = 0;
      }
      await receivePhotoChunk(`auth0|filler-${account}`, { uploadId: ID, index, total: MAX_CHUNKS, data: chunk }, NOW);
      held += perChunk;
      index += 1;
    }
    const busy = await refusal(receivePhotoChunk(USER, { uploadId: OTHER_ID, index: 1, total: 2, data: chunk }, NOW));
    expect(busy.code).toBe('BUSY');
    expect(storeUploadedPhoto).not.toHaveBeenCalled();
    // The upload is gone: its next chunk finds nothing to continue.
    expect((await refusal(receivePhotoChunk(USER, { uploadId: OTHER_ID, index: 1, total: 2, data: b64(300) }, NOW))).code).toBe(
      'OUT_OF_ORDER'
    );
  });

  it('keeps nothing when the photo fails its check', async () => {
    vi.mocked(inspectUploadedPhoto).mockRejectedValueOnce(new Error('Unsupported image format. Please use PNG, JPEG, or WebP.'));
    await expect(receivePhotoChunk(USER, { uploadId: ID, index: 0, total: 1, data: b64(300) }, NOW)).rejects.toThrow(
      'Unsupported image format'
    );
    expect(storeUploadedPhoto).not.toHaveBeenCalled();
    expect(setRecentUploadedImage).not.toHaveBeenCalled();
  });

  it('holds nothing for an account once its upload, its answer and its day have passed', async () => {
    await receivePhotoChunk(USER, { uploadId: ID, index: 0, total: 1, data: b64(300) }, NOW);
    await receivePhotoChunk('auth0|slow', { uploadId: OTHER_ID, index: 0, total: 2, data: b64(300) }, NOW);
    expect(photoUploadsHeld()).toEqual({ pending: 1, finishing: 0, finished: 1, counted: 2, starts: 2, bytes: 300 });

    // Any account's next chunk sweeps the rest.
    const later = NOW + UPLOAD_WINDOW_MS + 1;
    await receivePhotoChunk('auth0|third', { uploadId: ID, index: 0, total: 2, data: b64(300) }, later);
    expect(photoUploadsHeld()).toEqual({ pending: 1, finishing: 0, finished: 0, counted: 3, starts: 3, bytes: 300 });

    const nextDay = NOW + 24 * 60 * 60 * 1000 + 1;
    await receivePhotoChunk('auth0|fourth', { uploadId: ID, index: 0, total: 2, data: b64(300) }, nextDay);
    // The third's upload has run out of time, and the first two have left
    // the day's count; the third still counts against its own day.
    expect(photoUploadsHeld()).toEqual({ pending: 1, finishing: 0, finished: 0, counted: 2, starts: 2, bytes: 300 });
  });
});
