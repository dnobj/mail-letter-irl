/**
 * The photo an account uploaded through our card, in the image service (#474).
 *
 * The account's recent upload names UPLOADED_PHOTO_REFERENCE rather than an
 * address. The image service resolves it to the photo of the account the
 * image is processed for, and no other, straight from the private store: no
 * fetch, and no way to reach another account's photo. An upload that has gone
 * says so in words the person can act on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

vi.mock('../../../src/services/tempImageStore.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/tempImageStore.js')>()),
  getUploadedPhoto: vi.fn()
}));

import { getUploadedPhoto, UPLOADED_PHOTO_REFERENCE } from '../../../src/services/tempImageStore.js';
import {
  downloadAndProcessLetterImageWithPreview,
  downloadAndProcessPostcardImageWithPreview,
  ImageProcessingError,
  inspectUploadedPhoto
} from '../../../src/services/imageService.js';

const jpeg = (width = 640, height = 480) =>
  sharp({ create: { width, height, channels: 3, background: { r: 30, g: 60, b: 90 } } }).jpeg().toBuffer();

async function processingError(promise: Promise<unknown>): Promise<ImageProcessingError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ImageProcessingError);
    return error as ImageProcessingError;
  }
  throw new Error('expected an ImageProcessingError');
}

describe('an uploaded photo in the image service (#474)', () => {
  const fetchSpy = vi.fn(async () => {
    throw new Error('the uploaded photo must never be fetched');
  });

  beforeEach(() => {
    vi.mocked(getUploadedPhoto).mockReset();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchSpy.mockClear();
  });

  it('makes a postcard from the caller’s own photo, without a fetch', async () => {
    vi.mocked(getUploadedPhoto).mockResolvedValue(await jpeg());
    const processed = await downloadAndProcessPostcardImageWithPreview({ url: UPLOADED_PHOTO_REFERENCE }, '6x9', {
      actorId: 'auth0|owner'
    });
    expect(getUploadedPhoto).toHaveBeenCalledWith('auth0|owner');
    expect(processed.base64DataUri.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(processed.previewDataUri.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('makes a letter image from it too', async () => {
    vi.mocked(getUploadedPhoto).mockResolvedValue(await jpeg());
    const processed = await downloadAndProcessLetterImageWithPreview({ url: UPLOADED_PHOTO_REFERENCE }, 'header', {
      actorId: 'auth0|owner'
    });
    expect(getUploadedPhoto).toHaveBeenCalledWith('auth0|owner');
    expect(processed.base64DataUri.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('says an upload that has gone has expired', async () => {
    vi.mocked(getUploadedPhoto).mockResolvedValue(null);
    const error = await processingError(
      downloadAndProcessPostcardImageWithPreview({ url: UPLOADED_PHOTO_REFERENCE }, '6x9', { actorId: 'auth0|owner' })
    );
    expect(error.code).toBe('DOWNLOAD_FAILED');
    expect(error.userMessage).toBe(
      'That uploaded photo has expired: uploads are kept for 15 minutes. Please upload it again.'
    );
  });

  it('reads no photo at all for a request that names no account', async () => {
    const error = await processingError(
      downloadAndProcessLetterImageWithPreview({ url: UPLOADED_PHOTO_REFERENCE }, 'inline', {})
    );
    expect(error.code).toBe('DOWNLOAD_FAILED');
    expect(getUploadedPhoto).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('checks a photo before it is kept: an image by its own bytes, big enough to print', async () => {
    await expect(inspectUploadedPhoto(await jpeg(), 'auth0|owner')).resolves.toMatchObject({
      width: 640,
      height: 480,
      format: 'jpeg'
    });
    expect((await processingError(inspectUploadedPhoto(Buffer.from('not a photo at all'), 'auth0|owner'))).code).toBe(
      'UNSUPPORTED_FORMAT'
    );
    expect((await processingError(inspectUploadedPhoto(await jpeg(40, 40), 'auth0|owner'))).code).toBe('IMAGE_TOO_SMALL');
  });
});
