import PDFDocument from 'pdfkit';
import { placeGlyphs } from './glyphs.js';
import type { Layout } from './layout.js';
import type { DrawnStationery } from './stationery.js';

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
 * Every renderer version this build can print. A letter keeps the version its
 * preview was drawn with however long it waits (arrive-by, #535), so a new
 * version is added here, beside the old version's renderer, never in its
 * place. A test holds this set to every value migration 039's CHECK (or its
 * successor) admits.
 */
export const PRINTABLE_RENDERER_VERSIONS: ReadonlySet<string> = new Set([RENDERER_VERSION, STATIONERY_RENDERER_VERSION]);

/** The version a preview records: pdf-2 when drawn in a theme other than Classic, else pdf-1. */
export function rendererVersionFor(stationery?: DrawnStationery | null): string {
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
        doc.image(item.image.bytes, item.x, item.top, options);
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
      for (const glyph of placeGlyphs(item)) {
        doc.save().translate(glyph.x, glyph.y).path(glyph.outline).fill('black').restore();
      }
    }
  }
  doc.end();
  return done;
}
