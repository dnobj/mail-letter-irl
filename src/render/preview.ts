import { ADDRESS_STAMP, type StampGeometry } from './geometry.js';
import { placeGlyphs } from './glyphs.js';
import type { Layout, LayoutPage } from './layout.js';

export interface PreviewOptions {
  /**
   * The address lines PostGrid stamps, as it prints them (upper case), drawn
   * where PostGrid stamps them. The print leaves them out: PostGrid adds them.
   */
  addresses?: { from: string[]; to: string[] };
  /** Which page carries the stamp, and its geometry: a letter's first page unless given. */
  stamp?: { page: number; geometry: StampGeometry };
}

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
 * readers, and the addresses only as escaped `<text>`; nothing is spliced
 * into markup unescaped.
 */
export function renderPreviewSvg(layout: Layout, options: PreviewOptions = {}): string[] {
  const { page: stampPage, geometry } = options.stamp ?? { page: 0, geometry: ADDRESS_STAMP };
  return layout.pages.map((page, index) =>
    renderPage(layout, page, index === stampPage && options.addresses ? { ...options.addresses, geometry } : undefined));
}

type Stamp = { from: string[]; to: string[]; geometry: StampGeometry };

/** The addresses in PostGrid's stamp: its font, size and lines (geometry.ts). */
function addressStamp({ from, to, geometry }: Stamp): string {
  const lines = (texts: string[], baseline: number) => texts
    .map((text, index) => `<text x="${round(geometry.x)}" y="${round(baseline + index * geometry.pitch)}">${escapeXml(text)}</text>`)
    .join('');
  return `<g font-family="'Open Sans', Arial, Helvetica, sans-serif" font-size="${geometry.size}" fill="#000">` +
    lines(from, geometry.returnBaseline) +
    lines(to, geometry.recipientBaseline) +
    '</g>';
}

function renderPage(layout: Layout, page: LayoutPage, stamp?: Stamp): string {
  const outlines = new Map<string, string>();
  const drawn: string[] = [];
  const spoken: string[] = [];
  for (const item of page.items) {
    if (item.kind === 'image') {
      const href = `data:${item.image.mime};base64,${item.image.bytes.toString('base64')}`;
      drawn.push(`<image href="${href}" x="${round(item.x)}" y="${round(item.top)}" width="${round(item.width)}" height="${round(item.height)}" preserveAspectRatio="none"/>`);
      continue;
    }
    if (item.kind === 'box') {
      drawn.push(`<rect x="${round(item.x)}" y="${round(item.top)}" width="${round(item.width)}" height="${round(item.height)}" rx="${round(item.radius)}" fill="none" stroke="${item.stroke}" stroke-width="${round(item.strokeWidth)}"/>`);
      continue;
    }
    if (item.kind === 'rects') {
      const rects = item.rects.map(rect => `<rect x="${round(rect.x)}" y="${round(rect.top)}" width="${round(rect.width)}" height="${round(rect.height)}"/>`);
      drawn.push(`<g fill="${item.fill}">${rects.join('')}</g>`);
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
    // A page's text is its name for screen readers; a page without text has its title.
    `<title>${escapeXml(spoken.join('\n') || (page.title ?? ''))}</title>` +
    `<defs>${defs}</defs>` +
    `<rect width="${layout.width}" height="${layout.height}" fill="#fff"/>` +
    drawn.join('') +
    (stamp ? addressStamp(stamp) : '') +
    '</svg>';
}
