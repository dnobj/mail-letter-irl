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
      if (item.clip) {
        // A nested viewport cuts the image to its box, as the PDF's clip does;
        // the card's cleaner keeps an svg, where it would drop a clipPath.
        const { x, top, width, height } = item.clip;
        drawn.push(
          `<svg x="${round(x)}" y="${round(top)}" width="${round(width)}" height="${round(height)}">` +
          `<image href="${href}" x="${round(item.x - x)}" y="${round(item.top - top)}" width="${round(item.width)}" height="${round(item.height)}" preserveAspectRatio="none"/>` +
          '</svg>'
        );
      } else {
        // A signature is marked before its href, so renderedPageImage, which
        // looks for a letter's picture by `<image href=`, never takes it (#608).
        // The card's cleaner drops the mark and keeps the image.
        const role = item.role === 'signature' ? 'data-role="signature" ' : '';
        drawn.push(`<image ${role}href="${href}" x="${round(item.x)}" y="${round(item.top)}" width="${round(item.width)}" height="${round(item.height)}" preserveAspectRatio="none"/>`);
      }
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
    if (item.kind === 'path') {
      const stroke = item.stroke ? ` stroke="${item.stroke}" stroke-width="${round(item.strokeWidth ?? 1)}"` : '';
      drawn.push(`<path d="${item.d}" fill="${item.fill}"${stroke}/>`);
      continue;
    }
    spoken.push(item.source);
    const uses = placeGlyphs(item).map(glyph => {
      outlines.set(glyph.key, glyph.outline);
      return `<use href="#${glyph.key}" x="${round(glyph.x)}" y="${round(glyph.y)}"/>`;
    });
    // A coloured run's glyphs take its fill from a group; the rest stay black.
    drawn.push(item.fill ? `<g fill="${item.fill}">${uses.join('')}</g>` : uses.join(''));
  }
  const defs = [...outlines].map(([id, d]) => `<path id="${id}" d="${d}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${layout.height}" role="img">` +
    // A page's text is its name for screen readers; a page without text has its title.
    // An unspoken run (a lettering's shadow, #594) adds nothing to it.
    `<title>${escapeXml(spoken.filter(Boolean).join('\n') || (page.title ?? ''))}</title>` +
    `<defs>${defs}</defs>` +
    `<rect width="${layout.width}" height="${layout.height}" fill="#fff"/>` +
    drawn.join('') +
    (stamp ? addressStamp(stamp) : '') +
    '</svg>';
}
