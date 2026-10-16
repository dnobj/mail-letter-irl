/**
 * What an uploaded photo is for (#474): the front of a postcard, a letter's
 * header image, or a photo enclosed in a letter.
 *
 * `upload_image` and `confirm_uploaded_image` take it as free text, and a
 * model may describe it in its own words ("Postcard to Sam Rivera, ...")
 * rather than name one. Read as one of the three, or as none: an unrecognised
 * context would otherwise keep a recent upload from matching its preview
 * (recentUploadStore's matchContext), and be refused by upload_photo_chunk,
 * which takes only these three.
 */
export type UploadContext = 'postcard' | 'header_image' | 'inline_image';

export function normalizeUploadContext(raw: unknown): UploadContext | undefined {
  if (typeof raw !== 'string') return undefined;
  // The three names read as themselves, each by its own word. Text naming
  // more than one ("a postcard-sized photo for my letter's header") reads as
  // none: a wrong context keeps the upload from its preview, where none
  // matches any preview.
  const text = raw.toLowerCase();
  const named: UploadContext[] = [];
  if (text.includes('postcard')) named.push('postcard');
  if (text.includes('header')) named.push('header_image');
  if (text.includes('inline') || text.includes('enclos')) named.push('inline_image');
  return named.length === 1 ? named[0] : undefined;
}
