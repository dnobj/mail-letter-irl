/**
 * What an uploaded photo is for, read from a model's free text (#474).
 *
 * In CLIENT-01 step 14 Claude filled upload_image's `context` with a
 * sentence ("Postcard to Sam Rivera, ..."). The card passed it on, and
 * upload_photo_chunk, which takes only the three names, refused the upload.
 */

import { describe, expect, it } from 'vitest';
import { normalizeUploadContext } from '../../../src/utils/uploadContext.js';

describe('normalizeUploadContext', () => {
  it('keeps the three names as they are', () => {
    for (const name of ['postcard', 'header_image', 'inline_image'] as const) {
      expect(normalizeUploadContext(name)).toBe(name);
    }
    expect(normalizeUploadContext('  Postcard ')).toBe('postcard');
  });

  it('reads a description in the model’s own words as one of the three', () => {
    expect(normalizeUploadContext('Postcard to Sam Rivera, 1 Main St, Springfield, IL 62701, message: "Wish you were here!"')).toBe(
      'postcard'
    );
    expect(normalizeUploadContext('header image for a letter to Mom')).toBe('header_image');
    expect(normalizeUploadContext('photo enclosed in the letter')).toBe('inline_image');
    expect(normalizeUploadContext('inline image')).toBe('inline_image');
    // A postcard has no header.
    expect(normalizeUploadContext('postcard header photo')).toBe('postcard');
  });

  it('reads anything else as no context at all', () => {
    for (const value of [undefined, null, 42, '', '   ', 'a letter', 'photo for Sam']) {
      expect(normalizeUploadContext(value), String(value)).toBeUndefined();
    }
  });
});
