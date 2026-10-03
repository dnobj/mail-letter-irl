import { afterEach, describe, expect, it, vi } from 'vitest';
import { collageSources } from '../../../src/tools/collageSources.js';
import { UNRESOLVED_IMAGE_FILE_ID } from '../../../src/utils/imageFileParam.js';
import type { ToolContext } from '../../../src/contracts/types.js';

/**
 * A postcard preview's collage photos (#616): `images` and `imageUrls`,
 * checked before any photo is fetched, in words that say what to send instead.
 */

function context(): ToolContext {
  return {
    correlationId: 'corr-1',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never
  } as unknown as ToolContext;
}

const file = (n: number) => ({ download_url: `https://files.example/${n}.jpg`, file_id: `file-${n}` });
const link = (n: number) => `https://photos.example/${n}.jpg`;

function offered() {
  vi.stubEnv('LETTER_IRL_POSTCARD_COLLAGES_ENABLED', 'true');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('collageSources', () => {
  describe('when no collage is asked for', () => {
    it.each([
      ['nothing', {}],
      ['an empty list', { images: [] }],
      ['empty lists', { images: [], imageUrls: [] }],
      ['undefined', { images: undefined, imageUrls: undefined }],
      ['null', { images: null, imageUrls: null }],
      ['a blank string', { imageUrls: '  ' }],
      ['a list of one blank', { images: [''] }],
      ['a list of blanks', { imageUrls: ['', '  '] }],
    ])('returns undefined for %s, whether or not collages are offered', (_name, input) => {
      expect(collageSources(input, context())).toBeUndefined();
      offered();
      expect(collageSources(input, context())).toBeUndefined();
    });

    it('leaves a single photo to the single path', () => {
      offered();
      expect(collageSources({ image: file(1), imageUrl: link(1) }, context())).toBeUndefined();
    });
  });

  describe('while collages are not offered', () => {
    it.each([['images', { images: [file(1), file(2)] }], ['imageUrls', { imageUrls: [link(1), link(2)] }]])(
      'refuses %s, saying to give one photo',
      (_name, input) => {
        const ctx = context();
        expect(() => collageSources(input, ctx)).toThrow('Collages are not offered here. Give one photo, in image or imageUrl.');
        expect(ctx.logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ event: 'quote.postcard.collage_refused', reason: 'collages_off' }),
          expect.any(String)
        );
      }
    );

    it('marks the refusal as a validation error', () => {
      try {
        collageSources({ imageUrls: [link(1), link(2)] }, context());
        throw new Error('expected a refusal');
      } catch (error) {
        expect((error as Error & { diagnosticClass?: string }).diagnosticClass).toBe('validation_error');
      }
    });
  });

  describe('while they are offered', () => {
    it.each([2, 3, 4])('takes %i links, in the order given, trimmed', count => {
      offered();
      const links = Array.from({ length: count }, (_, i) => `  ${link(i + 1)}  `);
      const sources = collageSources({ imageUrls: links }, context());
      expect(sources).toEqual({ via: 'imageUrls', inputs: links.map((_, i) => ({ url: link(i + 1) })) });
    });

    it.each([2, 3, 4])('takes %i attachments, as they came', count => {
      offered();
      const files = Array.from({ length: count }, (_, i) => file(i + 1));
      expect(collageSources({ images: files }, context())).toEqual({ via: 'images', inputs: files });
    });

    it.each([
      [1, 'A collage takes 2 to 4 photos; 1 was given.'],
      [5, 'A collage takes 2 to 4 photos; 5 were given.'],
    ])('refuses %i photos', (count, message) => {
      offered();
      expect(() => collageSources({ imageUrls: Array.from({ length: count }, (_, i) => link(i + 1)) }, context())).toThrow(message);
      expect(() => collageSources({ images: Array.from({ length: count }, (_, i) => file(i + 1)) }, context())).toThrow(message);
    });

    it('refuses both lists', () => {
      offered();
      expect(() => collageSources({ images: [file(1), file(2)], imageUrls: [link(1), link(2)] }, context())).toThrow(
        'Give the photos in images or in imageUrls, not both.'
      );
    });

    it.each([
      ['an image', { image: file(9) }],
      ['an imageUrl', { imageUrl: link(9) }],
      ['an unresolved image reference', { image: { download_url: '', file_id: UNRESOLVED_IMAGE_FILE_ID } }],
    ])('refuses a collage beside %s', (_name, extra) => {
      offered();
      expect(() => collageSources({ imageUrls: [link(1), link(2)], ...extra }, context())).toThrow(
        'A collage takes images or imageUrls, not image or imageUrl as well.'
      );
    });

    it('does not count a blank imageUrl, which models send for one left unset', () => {
      offered();
      expect(collageSources({ imageUrls: [link(1), link(2)], imageUrl: '  ' }, context())).toMatchObject({ via: 'imageUrls' });
    });

    it('names an attachment it cannot read, by its place', () => {
      offered();
      const unresolved = { download_url: '', file_id: UNRESOLVED_IMAGE_FILE_ID };
      expect(() => collageSources({ images: [file(1), unresolved, file(3)] }, context())).toThrow(
        'The second photo could not be read from the conversation. Attach it again, or give links in imageUrls.'
      );
      expect(() => collageSources({ images: [file(1), file(2), 'not a file'] }, context())).toThrow(/^The third photo could not be read/);
    });

    it('names an empty link, by its place', () => {
      offered();
      expect(() => collageSources({ imageUrls: [link(1), link(2), ' '] }, context())).toThrow(
        'The third link is empty. Give each photo as a public image link.'
      );
      expect(() => collageSources({ imageUrls: [link(1), 7 as never] }, context())).toThrow('The second link is empty.');
    });

    it('refuses a list that is not a list', () => {
      offered();
      expect(() => collageSources({ imageUrls: link(1) }, context())).toThrow('imageUrls must be a list of photos.');
      expect(() => collageSources({ images: { download_url: 'x' } }, context())).toThrow('images must be a list of photos.');
    });

    it('logs each refusal by its reason, with no address in it', () => {
      offered();
      const ctx = context();
      expect(() => collageSources({ imageUrls: [link(1)] }, ctx)).toThrow();
      const [fields] = vi.mocked(ctx.logger.warn).mock.calls[0] as unknown as [Record<string, unknown>];
      expect(fields).toEqual({ correlationId: 'corr-1', event: 'quote.postcard.collage_refused', reason: 'photo_count' });
    });
  });
});
