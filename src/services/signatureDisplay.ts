/**
 * The small copy of a person's signature that a letter's preview draws (#614).
 *
 * The preview (`preview_html`, and the card's `_meta.previewHtml`) drew the
 * signature from the draft's own copy, at its stored size: a cleaned signature
 * is about 37 to 39 KB as PNG, about 50 KiB as a data URI, so a signed preview
 * carried half as much again as an unsigned one on every card trip. The band
 * is at most 2.5 in wide (SIGNATURE_MAX_WIDTH), 240 CSS pixels, so the copy is
 * twice that across, enough for a screen at twice the pixel density, in grey,
 * as a PNG. The print's PDF keeps the stored copy: only the layout the preview
 * draws from is changed, and the box stays the print's.
 *
 * The signature is at most 1200 x 400 pixels and 1 MB (migration 050), so it is
 * reduced without the decode gate, whose refusal would fail a preview for a
 * picture this small. If the reduction fails, the preview draws the stored
 * copy, as before #614.
 */

import { SIGNATURE_MAX_WIDTH } from '../render/geometry.js';
import { readImage, type RenderImage } from '../render/images.js';
import type { Layout } from '../render/layout.js';
import { openImage } from './imageService.js';
import { classifyDiagnosticError, writeDiagnostic } from '../utils/diagnosticLog.js';

/** Twice the band's widest CSS width, in pixels: its 2.5 in at 96 CSS pixels to the inch (72 points), 480. */
export const SIGNATURE_DISPLAY_WIDTH = Math.round((SIGNATURE_MAX_WIDTH / 72) * 96 * 2);

/** The signature reduced for the preview, or the stored copy when it is no wider than that. */
export async function signatureDisplayCopy(image: RenderImage): Promise<RenderImage> {
  if (image.width <= SIGNATURE_DISPLAY_WIDTH) return image;
  const bytes = await openImage(image.bytes)
    .resize({ width: SIGNATURE_DISPLAY_WIDTH, withoutEnlargement: true })
    // On the white page, in one grey channel: the cleaner's copy is grey ink on white already.
    .flatten({ background: '#ffffff' })
    .toColourspace('b-w')
    .png({ compressionLevel: 9 })
    .toBuffer();
  return readImage(bytes);
}

/**
 * The layout with its signature drawn from the small copy: the same box, so the
 * page is still the print's. A layout without a signature is returned as it is.
 * The letter's own picture is left to withDisplayImage (letterHelpers.ts).
 */
export async function withDisplaySignature(layout: Layout): Promise<Layout> {
  const stored = layout.pages
    .flatMap(page => page.items)
    .find(item => item.kind === 'image' && item.role === 'signature');
  if (!stored || stored.kind !== 'image') return layout;
  let small: RenderImage;
  try {
    small = await signatureDisplayCopy(stored.image);
  } catch (error) {
    writeDiagnostic('warn', 'preview.signature_display_failed', { errorClass: classifyDiagnosticError(error) });
    return layout;
  }
  if (small === stored.image) return layout;
  return {
    ...layout,
    pages: layout.pages.map(page => ({
      ...page,
      items: page.items.map(item => (item.kind === 'image' && item.role === 'signature' ? { ...item, image: small } : item))
    }))
  };
}
