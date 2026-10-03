/**
 * A postcard preview's collage photos (#616): the `images` and `imageUrls` it
 * takes, checked, and turned into the inputs the compositor downloads
 * (downloadAndProcessCollageWithPreview). Two to four photos make a collage;
 * the arrangement follows the count. They come as attachments (`images`) or as
 * links (`imageUrls`), never both, and never beside the single photo's `image`
 * or `imageUrl`.
 *
 * Offered only while LETTER_IRL_POSTCARD_COLLAGES_ENABLED is on. While it is
 * not, the served schema leaves both out and stays open to unknown keys, so a
 * collage from a schema cached while they were served reaches the preview,
 * which refuses it here rather than printing a postcard of one photo.
 */

import type { ToolContext } from '../contracts/types.js';
import { isPostcardCollagesOffered } from '../config/postcardCollages.js';
import { COLLAGE_MAX_PHOTOS, COLLAGE_MIN_PHOTOS } from '../services/collageArrangement.js';
import type { ImageInput } from '../services/imageService.js';
import { usableImageFile } from '../utils/imageFileParam.js';

/** The photos of a collage, in the order given, as the compositor takes them. */
export interface CollageSources {
  inputs: ImageInput[];
  /** Which argument carried them. */
  via: 'images' | 'imageUrls';
}

const ORDINALS = ['first', 'second', 'third', 'fourth'] as const;

function refusal(message: string, reason: string, context: ToolContext): Error {
  context.logger.warn(
    { correlationId: context.correlationId, event: 'quote.postcard.collage_refused', reason },
    'A postcard collage was refused'
  );
  return Object.assign(new Error(message), { diagnosticClass: 'validation_error' });
}

/**
 * Whether a photo argument was given: present, and not empty or blank, which
 * models send for one left unset (an empty list, an empty string).
 */
function given(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * The collage a preview asks for, or undefined when it asks for none. A
 * collage that cannot be made as asked is refused, in words that say what to
 * send instead, before any photo is downloaded.
 */
export function collageSources(
  input: { image?: unknown; imageUrl?: unknown; images?: unknown; imageUrls?: unknown },
  context: ToolContext
): CollageSources | undefined {
  const hasImages = given(input.images);
  const hasUrls = given(input.imageUrls);
  if (!hasImages && !hasUrls) return undefined;

  if (!isPostcardCollagesOffered()) {
    throw refusal('Collages are not offered here. Give one photo, in image or imageUrl.', 'collages_off', context);
  }
  if (hasImages && hasUrls) {
    throw refusal('Give the photos in images or in imageUrls, not both.', 'both_sources', context);
  }
  if (given(input.image) || given(input.imageUrl)) {
    throw refusal(
      'A collage takes images or imageUrls, not image or imageUrl as well. ' +
        'Give one photo in image or imageUrl, or two to four in images or imageUrls.',
      'single_and_collage',
      context
    );
  }

  const via = hasImages ? 'images' : 'imageUrls';
  const list = hasImages ? input.images : input.imageUrls;
  if (!Array.isArray(list)) {
    throw refusal(`${via} must be a list of photos.`, 'not_a_list', context);
  }
  if (list.length < COLLAGE_MIN_PHOTOS || list.length > COLLAGE_MAX_PHOTOS) {
    throw refusal(
      `A collage takes ${COLLAGE_MIN_PHOTOS} to ${COLLAGE_MAX_PHOTOS} photos; ${list.length} ${list.length === 1 ? 'was' : 'were'} given.`,
      'photo_count',
      context
    );
  }

  const inputs: ImageInput[] = [];
  for (const [index, entry] of list.entries()) {
    const place = ORDINALS[index];
    if (via === 'images') {
      const file = usableImageFile(entry);
      if (!file) {
        throw refusal(
          `The ${place} photo could not be read from the conversation. Attach it again, or give links in imageUrls.`,
          'unreadable_attachment',
          context
        );
      }
      inputs.push(file);
    } else {
      if (typeof entry !== 'string' || entry.trim() === '') {
        throw refusal(`The ${place} link is empty. Give each photo as a public image link.`, 'empty_link', context);
      }
      inputs.push({ url: entry.trim() });
    }
  }
  return { inputs, via };
}
