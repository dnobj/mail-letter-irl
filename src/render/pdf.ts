import PDFDocument from 'pdfkit';
import { placeGlyphs } from './glyphs.js';
import type { Layout } from './layout.js';

/**
 * Recorded on every draft and letter the new renderer lays out (Phase 2), so a
 * letter prints with the renderer it was previewed with, however long it waits.
 */
export const RENDERER_VERSION = 'pdf-1';

/**
 * Every renderer version this build can print. A letter keeps the version its
 * preview was drawn with however long it waits (arrive-by, #535), so a new
 * version is added here, beside the old version's renderer, never in its
 * place. A test holds this set to every value migration 039's CHECK (or its
 * successor) admits.
 */
export const PRINTABLE_RENDERER_VERSIONS: ReadonlySet<string> = new Set([RENDERER_VERSION]);

/**
 * Draws a layout as a PDF: images as given, and every glyph filled as its
 * outline at the position glyphs.ts gives it, the same positions the SVG
 * preview uses. No text is handed to pdfkit, which would re-shape it word by
 * word and guess each word's direction. PostGrid flattens an uploaded page to
 * a 300 dpi image anyway (#534 Phase 0), so outlines print exactly as text
 * would, with nothing left to embed.
 */
export async function renderPdf(layout: Layout): Promise<Buffer> {
  const doc = new PDFDocument({
    size: [layout.width, layout.height],
    margin: 0,
    autoFirstPage: false,
    info: { Title: 'Letter', Creator: 'Letter IRL', Producer: `Letter IRL renderer ${RENDERER_VERSION}` }
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
        doc.image(item.image.bytes, item.x, item.top, options);
        continue;
      }
      for (const glyph of placeGlyphs(item)) {
        doc.save().translate(glyph.x, glyph.y).path(glyph.outline).fill('black').restore();
      }
    }
  }
  doc.end();
  return done;
}
