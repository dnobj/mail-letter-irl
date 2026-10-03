import { describe, expect, it } from 'vitest';
import {
  preprocessImageFileElement,
  preprocessImageFileParam,
  preprocessPhotoList,
  UNRESOLVED_IMAGE_FILE_ID
} from '../../../src/utils/imageFileParam.js';

/**
 * The preprocess steps of the image arguments before the served schema reads them: the single `image`'s (#414),
 * and a collage's lists and photos (#616), which differ on purpose in what a blank string means.
 */

const MARKER = { download_url: '', file_id: UNRESOLVED_IMAGE_FILE_ID };

describe('preprocessImageFileParam (the single image)', () => {
  it('reads the empty string as no picture, and any other string as one that cannot be opened', () => {
    expect(preprocessImageFileParam('')).toBeUndefined();
    expect(preprocessImageFileParam('/mnt/data/photo.png')).toEqual(MARKER);
    expect(preprocessImageFileParam('chat_upload://image_0')).toEqual(MARKER);
  });

  it('leaves a file object as it is', () => {
    const file = { download_url: 'https://files.example/1.jpg', file_id: 'file-1' };
    expect(preprocessImageFileParam(file)).toBe(file);
  });
});

describe('preprocessPhotoList (a collage\'s whole list)', () => {
  it.each(['', ' ', '   ', '\n\t'])('reads the blank string %j as no list', value => {
    expect(preprocessPhotoList(value)).toBeUndefined();
  });

  it('leaves everything else for the schema to judge, a path string included', () => {
    for (const value of ['x', '/mnt/data/a.png', [], ['a', 'b'], undefined, null, 0, {}]) {
      expect(preprocessPhotoList(value)).toBe(value);
    }
  });
});

describe('preprocessImageFileElement (one photo of a collage)', () => {
  it.each(['', ' ', '/mnt/data/a.png', 'chat_upload://image_0'])('turns the string %j into the photo that cannot be opened', value => {
    // Unlike the single image, a blank slot in a list is still a slot, so the refusal can name its place.
    expect(preprocessImageFileElement(value)).toEqual(MARKER);
  });

  it('leaves a file object, and anything else, as it is', () => {
    const file = { download_url: 'https://files.example/1.jpg', file_id: 'file-1' };
    expect(preprocessImageFileElement(file)).toBe(file);
    for (const value of [null, undefined, 3, ['x']]) {
      expect(preprocessImageFileElement(value)).toBe(value);
    }
  });
});
