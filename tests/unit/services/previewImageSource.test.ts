/**
 * Where the image preview tools get their picture (#414), and what the
 * served schema does with a string `image`.
 *
 * A request that names a picture the server cannot open (a sandbox path, a
 * mobile placeholder) must not silently print an older upload, which may be a
 * different picture. It may still use an upload made within the last five
 * minutes: that is the upload card answering this very failure.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

vi.mock('../../../src/services/recentUploadStore.js', () => ({
  getRecentUploadedImage: vi.fn()
}));

vi.mock('../../../src/services/imageService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/imageService.js')>()),
  downloadAndProcessLetterImageWithPreview: vi.fn(),
  downloadAndProcessPostcardImageWithPreview: vi.fn()
}));

import { getRecentUploadedImage } from '../../../src/services/recentUploadStore.js';
import {
  downloadAndProcessLetterImageWithPreview,
  downloadAndProcessPostcardImageWithPreview
} from '../../../src/services/imageService.js';
import {
  resolvePreviewImageSource,
  UNRESOLVED_REFERENCE_UPLOAD_WINDOW_MS
} from '../../../src/services/previewImageSource.js';
import {
  isUnresolvedImageReference,
  preprocessImageFileParam,
  UNRESOLVED_IMAGE_FILE_ID,
  usableImageFile
} from '../../../src/utils/imageFileParam.js';
import { getZodInputShape } from '../../../src/mcp/registerTools.js';
import { toolInputSchemas } from '../../../src/mcp/toolSchemas.js';
import { quoteAndPreviewLetterWithImageTool } from '../../../src/tools/quoteAndPreviewLetterWithImage.js';
import { quoteAndPreviewLetterWithHeaderImageTool } from '../../../src/tools/quoteAndPreviewLetterWithHeaderImage.js';
import { quoteAndPreviewPostcardTool } from '../../../src/tools/quoteAndPreviewPostcard.js';
import type { ToolContext } from '../../../src/contracts/types.js';

const recentUpload = vi.mocked(getRecentUploadedImage);
const UPLOAD_URL = 'https://files.example/uploaded-by-the-card';
const MARKER = { download_url: '', file_id: UNRESOLVED_IMAGE_FILE_ID };
const MINUTE = 60 * 1000;

function uploadAged(ageMs: number) {
  recentUpload.mockResolvedValue({ imageUrl: UPLOAD_URL, context: 'inline_image', ageMs });
}

beforeEach(() => {
  vi.clearAllMocks();
  recentUpload.mockResolvedValue(null);
});

describe('preprocessImageFileParam', () => {
  it('reads the empty string as no picture', () => {
    expect(preprocessImageFileParam('')).toBeUndefined();
  });

  it.each(['attached', 'chat_upload', 'chat_upload://image_0', '/mnt/data/photo.png', 'file_0000abcd', ' '])(
    'turns %j into the unresolved marker',
    value => {
      expect(preprocessImageFileParam(value)).toEqual(MARKER);
    }
  );

  it('passes everything else through untouched', () => {
    const file = { download_url: 'https://files.example/f1', file_id: 'file_1' };
    expect(preprocessImageFileParam(file)).toBe(file);
    expect(preprocessImageFileParam(undefined)).toBeUndefined();
    expect(preprocessImageFileParam(null)).toBeNull();
  });

  it('tells a readable file from an unreadable reference', () => {
    const file = { download_url: 'https://files.example/f1', file_id: 'file_1' };
    expect(usableImageFile(file)).toBe(file);
    expect(isUnresolvedImageReference(file)).toBe(false);
    expect(usableImageFile(MARKER)).toBeNull();
    expect(isUnresolvedImageReference(MARKER)).toBe(true);
    expect(isUnresolvedImageReference('/mnt/data/photo.png')).toBe(true);
    expect(usableImageFile('/mnt/data/photo.png')).toBeNull();
    expect(isUnresolvedImageReference({ file_id: 'file_1' })).toBe(true);
    for (const absent of [undefined, null, '']) {
      expect(usableImageFile(absent)).toBeNull();
      expect(isUnresolvedImageReference(absent)).toBe(false);
    }
  });
});

describe.each(['quote_and_preview_letter_with_header_image', 'quote_and_preview_letter_with_image', 'quote_and_preview_postcard'])(
  '%s image argument at both schema layers',
  tool => {
    const extras = tool === 'quote_and_preview_postcard' ? { message: 'hi' } : { bodyText: 'hi', signOff: 'bye' };
    const base = {
      recipient: { name: 'R', addressLine1: '1 Main St', city: 'KC', state: 'MO', postalCode: '64111', country: 'US' },
      ...extras
    };
    const layers = [
      ['served', z.object(getZodInputShape(tool)!)],
      ['typed', toolInputSchemas[tool as keyof typeof toolInputSchemas]]
    ] as const;

    it.each(layers)('%s layer keeps a named picture as the marker', (_label, schema) => {
      expect((schema.parse({ ...base, image: '/mnt/data/photo.png' }) as { image?: unknown }).image).toEqual(MARKER);
      expect((schema.parse({ ...base, image: '' }) as { image?: unknown }).image).toBeUndefined();
    });
  }
);

describe('resolvePreviewImageSource', () => {
  it('prefers a readable file, without looking for an upload', async () => {
    const file = { download_url: 'https://files.example/f1', file_id: 'file_1' };
    uploadAged(MINUTE);
    await expect(
      resolvePreviewImageSource({ image: file, imageUrl: 'https://example.com/other.jpg' }, 'user-1', 'inline_image')
    ).resolves.toEqual({ kind: 'file', url: file.download_url, file });
    expect(recentUpload).not.toHaveBeenCalled();
  });

  it('uses imageUrl next, even beside an unreadable reference', async () => {
    uploadAged(MINUTE);
    await expect(
      resolvePreviewImageSource({ image: MARKER, imageUrl: 'https://example.com/photo.jpg' }, 'user-1', 'postcard')
    ).resolves.toEqual({ kind: 'url', url: 'https://example.com/photo.jpg' });
    expect(recentUpload).not.toHaveBeenCalled();
  });

  it('falls back to an upload of any readable age when no picture was named', async () => {
    uploadAged(50 * MINUTE);
    await expect(resolvePreviewImageSource({}, 'user-1', 'header_image')).resolves.toEqual({
      kind: 'recent_upload',
      url: UPLOAD_URL,
      ageMs: 50 * MINUTE,
      unresolvedReference: false
    });
    expect(recentUpload).toHaveBeenCalledWith('user-1', 'header_image');
  });

  it('uses an upload exactly at the window for a named picture it cannot open', async () => {
    uploadAged(UNRESOLVED_REFERENCE_UPLOAD_WINDOW_MS);
    await expect(resolvePreviewImageSource({ image: MARKER }, 'user-1', 'postcard')).resolves.toEqual({
      kind: 'recent_upload',
      url: UPLOAD_URL,
      ageMs: UNRESOLVED_REFERENCE_UPLOAD_WINDOW_MS,
      unresolvedReference: true
    });
    expect(recentUpload).toHaveBeenCalledWith('user-1', 'postcard');
  });

  it('refuses an older upload for a named picture it cannot open', async () => {
    uploadAged(UNRESOLVED_REFERENCE_UPLOAD_WINDOW_MS + 1);
    await expect(resolvePreviewImageSource({ image: MARKER }, 'user-1', 'inline_image')).resolves.toEqual({
      kind: 'none',
      unresolvedReference: true,
      skippedUploadAgeMs: UNRESOLVED_REFERENCE_UPLOAD_WINDOW_MS + 1
    });
  });

  it('treats a file object without a download address as a named picture', async () => {
    uploadAged(30 * MINUTE);
    await expect(
      resolvePreviewImageSource({ image: { download_url: '', file_id: 'file_1' } }, 'user-1', 'inline_image')
    ).resolves.toMatchObject({ kind: 'none', unresolvedReference: true });
  });

  it('reports no picture when there is no upload', async () => {
    await expect(resolvePreviewImageSource({ image: MARKER }, 'user-1', 'inline_image')).resolves.toEqual({
      kind: 'none',
      unresolvedReference: true
    });
    await expect(resolvePreviewImageSource({}, 'user-1', 'inline_image')).resolves.toEqual({
      kind: 'none',
      unresolvedReference: false
    });
  });

  it('treats a raw string as a named picture', async () => {
    // A caller that skips the served schema must not regain the fallback.
    uploadAged(30 * MINUTE);
    await expect(resolvePreviewImageSource({ image: '/mnt/data/photo.png' }, 'user-1', 'inline_image')).resolves.toEqual({
      kind: 'none',
      unresolvedReference: true,
      skippedUploadAgeMs: 30 * MINUTE
    });
    uploadAged(30 * MINUTE);
    await expect(resolvePreviewImageSource({ image: '' }, 'user-1', 'inline_image')).resolves.toMatchObject({
      kind: 'recent_upload',
      unresolvedReference: false
    });
  });

  it('keeps the five-minute window', () => {
    expect(UNRESOLVED_REFERENCE_UPLOAD_WINDOW_MS).toBe(5 * MINUTE);
  });
});

function context(): ToolContext {
  return {
    user: { userId: 'user-1' } as ToolContext['user'],
    correlationId: 'corr-1',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never,
    now: () => new Date('2026-09-17T00:00:00Z'),
    persist: vi.fn(),
    isMobile: false
  } as unknown as ToolContext;
}

const recipient = { name: 'R', addressLine1: '1 Main St', city: 'KC', state: 'MO', postalCode: '64111', country: 'US' };
const DOWNLOAD_STOPPED = new Error('download stopped by the test');

const LETTER_DOWNLOAD_FAILED = 'Could not process image. Please try a different image.';

describe.each([
  ['quote_and_preview_letter_with_image', quoteAndPreviewLetterWithImageTool, { bodyText: 'hi', signOff: 'bye' }, 'inline_image', LETTER_DOWNLOAD_FAILED],
  ['quote_and_preview_letter_with_header_image', quoteAndPreviewLetterWithHeaderImageTool, { bodyText: 'hi', signOff: 'bye' }, 'header_image', 'Could not process header image. Please try a different image.'],
  // The postcard rethrows a download failure that is not an ImageProcessingError.
  ['quote_and_preview_postcard', quoteAndPreviewPostcardTool, { message: 'hi' }, 'postcard', DOWNLOAD_STOPPED.message]
] as const)('%s handler', (_name, tool, extras, uploadContext, downloadFailed) => {
  const download = () =>
    _name === 'quote_and_preview_postcard'
      ? vi.mocked(downloadAndProcessPostcardImageWithPreview)
      : vi.mocked(downloadAndProcessLetterImageWithPreview);

  beforeEach(() => {
    download().mockRejectedValue(DOWNLOAD_STOPPED);
  });

  // A sender in the request keeps the postcard handler, which checks the
  // addresses before the picture, away from the saved-address lookup. Every
  // download is stopped, so a handler that got as far as the picture fails
  // with its own download error.
  const run = (image: unknown) =>
    (tool.handler as (input: unknown, ctx: ToolContext) => Promise<unknown>)(
      { sender: { ...recipient }, recipient: { ...recipient }, ...extras, image },
      context()
    );

  it('asks for the picture instead of printing an older upload', async () => {
    uploadAged(UNRESOLVED_REFERENCE_UPLOAD_WINDOW_MS + MINUTE);
    await expect(run(MARKER)).rejects.toThrow(/IMAGE UPLOAD NEEDED/);
    expect(recentUpload).toHaveBeenCalledWith('user-1', uploadContext);
    expect(download()).not.toHaveBeenCalled();
  });

  it('asks for the picture when a raw string reaches it', async () => {
    uploadAged(UNRESOLVED_REFERENCE_UPLOAD_WINDOW_MS + MINUTE);
    await expect(run('/mnt/data/beach.png')).rejects.toThrow(/IMAGE UPLOAD NEEDED/);
    expect(download()).not.toHaveBeenCalled();
  });

  it('uses the upload the card just made', async () => {
    uploadAged(MINUTE);
    await expect(run(MARKER)).rejects.toThrow(downloadFailed);
    expect(recentUpload).toHaveBeenCalledWith('user-1', uploadContext);
    expect(download()).toHaveBeenCalledTimes(1);
    expect(download().mock.calls[0][0]).toEqual({ url: UPLOAD_URL });
  });

  it('still uses an older upload when no picture was named', async () => {
    uploadAged(50 * MINUTE);
    await expect(run(undefined)).rejects.toThrow(downloadFailed);
    expect(download()).toHaveBeenCalledTimes(1);
    expect(download().mock.calls[0][0]).toEqual({ url: UPLOAD_URL });
  });

  it('downloads a readable file itself', async () => {
    const file = { download_url: 'https://files.example/f1', file_id: 'file_1' };
    uploadAged(MINUTE);
    await expect(run(file)).rejects.toThrow(downloadFailed);
    expect(download()).toHaveBeenCalledTimes(1);
    const source = download().mock.calls[0][0] as { download_url?: string; url?: string };
    expect(source.download_url ?? source.url).toBe(file.download_url);
    expect(recentUpload).not.toHaveBeenCalled();
  });
});
