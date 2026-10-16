import PDFDocument from 'pdfkit';
import { placeGlyphs } from './glyphs.js';
import type { Layout } from './layout.js';
import type { Stationery } from './stationery.js';

/**
 * Recorded on every draft and letter the new renderer lays out (Phase 2), so a
 * letter prints with the renderer it was previewed with, however long it waits.
 */
export const RENDERER_VERSION = 'pdf-1';

/**
 * Recorded on a letter drawn in stationery other than Classic (#563, migration
 * 044): pdf-1 with themes. A build that cannot draw themes refuses it, so a
 * rollback holds a themed letter instead of printing it as Classic.
 */
export const STATIONERY_RENDERER_VERSION = 'pdf-2';

/**
 * Recorded on a postcard drawn with a front other than full bleed (#594,
 * migration 048): pdf-1 with a border or a greeting. A build that cannot draw
 * fronts refuses it, so a rollback holds such a postcard instead of printing
 * it full bleed.
 */
export const POSTCARD_FRONT_RENDERER_VERSION = 'pdf-3';

/**
 * Recorded on a letter drawn with the person's signature (#608, migration
 * 051): pdf-1 or pdf-2 with a signature, in any theme. A build that cannot draw
 * signatures refuses it, so a rollback holds a signed letter instead of
 * printing it unsigned.
 */
export const SIGNATURE_RENDERER_VERSION = 'pdf-4';

/**
 * Every renderer version this build can print. A letter keeps the version its
 * preview was drawn with however long it waits (arrive-by, #535), so a new
 * version is added here, beside the old version's renderer, never in its
 * place. A test holds this set to every value migration 039's CHECK (or its
 * successor) admits.
 */
export const PRINTABLE_RENDERER_VERSIONS: ReadonlySet<string> = new Set([
  RENDERER_VERSION,
  STATIONERY_RENDERER_VERSION,
  POSTCARD_FRONT_RENDERER_VERSION,
  SIGNATURE_RENDERER_VERSION
]);

/**
 * The version a letter's preview records: pdf-4 when drawn with a signature
 * (#608), whatever its theme; pdf-2 when drawn in a theme other than Classic;
 * else pdf-1.
 */
export function rendererVersionFor(stationery?: Stationery | null, signed = false): string {
  if (signed) return SIGNATURE_RENDERER_VERSION;
  return stationery && stationery.theme !== 'classic' ? STATIONERY_RENDERER_VERSION : RENDERER_VERSION;
}

/**
 * Draws a layout as a PDF: images as given, and every glyph filled as its
 * outline at the position glyphs.ts gives it, the same positions the SVG
 * preview uses. No text is handed to pdfkit, which would re-shape it word by
 * word and guess each word's direction. PostGrid flattens an uploaded page to
 * a 300 dpi image anyway (#534 Phase 0), so outlines print exactly as text
 * would, with nothing left to embed. `version`, the renderer version the
 * layout was drawn as, is named in the file's Producer.
 */
export async function renderPdf(layout: Layout, version: string = RENDERER_VERSION): Promise<Buffer> {
  const doc = new PDFDocument({
    size: [layout.width, layout.height],
    margin: 0,
    autoFirstPage: false,
    info: { Title: layout.title ?? 'Letter', Creator: 'Letter IRL', Producer: `Letter IRL renderer ${version}` }
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  for (const page of layout.pages) {
    doc.addPage({ size: [layout.width, layout.height], margin: 0 });
    for (const item of page.items) {
      if (item.kind === 'image') {
        // The layout sized the box from the pixels as stored; pdfkit would
        // otherwise rotate by EXIF orientation and draw outside it. Images
        // reach the renderer re-encoded without EXIF (imageService), and this
        // keeps that assumption from mattering.
        const options = { width: item.width, height: item.height, ignoreOrientation: true } as PDFKit.Mixins.ImageOption;
        if (item.clip) {
          // Cut to its box, as the preview's own viewport cuts it.
          doc.save().rect(item.clip.x, item.clip.top, item.clip.width, item.clip.height).clip();
          doc.image(item.image.bytes, item.x, item.top, options);
          doc.restore();
        } else {
          doc.image(item.image.bytes, item.x, item.top, options);
        }
        continue;
      }
      if (item.kind === 'box') {
        doc.save().roundedRect(item.x, item.top, item.width, item.height, item.radius).lineWidth(item.strokeWidth).stroke(item.stroke).restore();
        continue;
      }
      if (item.kind === 'rects') {
        doc.save();
        for (const rect of item.rects) doc.rect(rect.x, rect.top, rect.width, rect.height);
        doc.fill(item.fill).restore();
        continue;
      }
      if (item.kind === 'path') {
        const fill = item.fill === 'none' ? null : item.fill;
        // Nothing to paint draws nothing, as in the preview.
        if (!fill && !item.stroke) continue;
        // The graphics state is set before the path: between a path's first
        // operator and its painting one, PDF allows only path operators.
        // SVG's miter limit is 4 and the PDF's 10: set, so a sharp join ends
        // where the preview's does.
        doc.save();
        if (item.stroke) doc.lineWidth(item.strokeWidth ?? 1).miterLimit(4).strokeColor(item.stroke);
        if (fill) doc.fillColor(fill);
        doc.path(item.d);
        if (fill && item.stroke) doc.fillAndStroke();
        else if (fill) doc.fill();
        else doc.stroke();
        doc.restore();
        continue;
      }
      const fill = item.fill ?? 'black';
      for (const glyph of placeGlyphs(item)) {
        doc.save().translate(glyph.x, glyph.y).path(glyph.outline).fill(fill).restore();
      }
    }
  }
  doc.end();
  return done;
}
