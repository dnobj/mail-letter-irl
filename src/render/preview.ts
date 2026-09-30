import { placeGlyphs } from './glyphs.js';
import type { Layout, LayoutPage } from './layout.js';

const round = (value: number): number => Math.round(value * 100) / 100;

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);
}

/**
 * Draws a layout as one SVG per page, from the same placed glyphs as the PDF
 * (glyphs.ts), so the preview is the print. The glyphs are the font's own
 * outlines: the preview needs no font of its own and renders the same in
 * every card, iframe and client.
 *
 * Each distinct glyph is defined once and reused. Its id names the font, size
 * and glyph, so the same id always means the same outline, and pages from
 * different SVGs can share one document (a letter and its gift page).
 *
 * The letter's text appears only as escaped `<title>` content, for screen
 * readers; it is never spliced into markup.
 */
export function renderPreviewSvg(layout: Layout): string[] {
  return layout.pages.map(page => renderPage(layout, page));
}

function renderPage(layout: Layout, page: LayoutPage): string {
  const outlines = new Map<string, string>();
  const drawn: string[] = [];
  const spoken: string[] = [];
  for (const item of page.items) {
    if (item.kind === 'image') {
      const href = `data:${item.image.mime};base64,${item.image.bytes.toString('base64')}`;
      drawn.push(`<image href="${href}" x="${round(item.x)}" y="${round(item.top)}" width="${round(item.width)}" height="${round(item.height)}" preserveAspectRatio="none"/>`);
      continue;
    }
    spoken.push(item.source);
    for (const glyph of placeGlyphs(item)) {
      outlines.set(glyph.key, glyph.outline);
      drawn.push(`<use href="#${glyph.key}" x="${round(glyph.x)}" y="${round(glyph.y)}"/>`);
    }
  }
  const defs = [...outlines].map(([id, d]) => `<path id="${id}" d="${d}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${layout.height}" role="img">` +
    `<title>${escapeXml(spoken.join('\n'))}</title>` +
    `<defs>${defs}</defs>` +
    `<rect width="${layout.width}" height="${layout.height}" fill="#fff"/>` +
    drawn.join('') +
    '</svg>';
}
