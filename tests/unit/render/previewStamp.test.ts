/**
 * A preview draws the addresses where PostGrid stamps them (#534 Phase 3), so
 * the page shows what prints: Open Sans at 9pt, in upper case, from x 0.70in,
 * the return address from 0.438in and the recipient from 2.094in, 0.177in a
 * line (probe P6). The PDF leaves the zone to PostGrid.
 */

import { describe, expect, it } from 'vitest';
import { layoutLetter, renderPdf, renderPreviewSvg } from '../../../src/render/index.js';
import { renderLetterPreviewDocument, stampedAddressLines } from '../../../src/services/previewService.js';
import type { Address } from '../../../src/contracts/types.js';

const ADDRESSES = {
  from: ['PAT EXAMPLE', '1600 PENNSYLVANIA AVE NW', 'WASHINGTON, DC 20500'],
  to: ['SAM RIVERA', '350 FIFTH AVE', 'SUITE 3300', 'NEW YORK, NY 10118']
};

const texts = (svg: string) =>
  [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)">([^<]*)<\/text>/g)].map(([, x, y, text]) => ({ x: Number(x), y: Number(y), text }));

describe('the address stamp on a preview', () => {
  it("draws each line where PostGrid stamps it, in PostGrid's font and size", () => {
    const [page] = renderPreviewSvg(layoutLetter({ text: 'Dear Sam,', layoutType: 'text_only' }), { addresses: ADDRESSES });
    expect(page).toContain(`<g font-family="'Open Sans', Arial, Helvetica, sans-serif" font-size="9" fill="#000">`);
    expect(texts(page)).toEqual([
      { x: 50.4, y: 31.54, text: 'PAT EXAMPLE' },
      { x: 50.4, y: 44.28, text: '1600 PENNSYLVANIA AVE NW' },
      { x: 50.4, y: 57.02, text: 'WASHINGTON, DC 20500' },
      { x: 50.4, y: 150.77, text: 'SAM RIVERA' },
      { x: 50.4, y: 163.51, text: '350 FIFTH AVE' },
      { x: 50.4, y: 176.26, text: 'SUITE 3300' },
      { x: 50.4, y: 189, text: 'NEW YORK, NY 10118' }
    ]);
  });

  it('escapes what the addresses carry', () => {
    const [page] = renderPreviewSvg(layoutLetter({ text: 'Hi', layoutType: 'text_only' }), {
      addresses: { from: ['A & B <C>'], to: ['"D" \'E\''] }
    });
    expect(page).toContain('<text x="50.4" y="31.54">A &amp; B &lt;C&gt;</text>');
    expect(page).toContain('<text x="50.4" y="150.77">&quot;D&quot; &apos;E&apos;</text>');
    expect(page).not.toContain('<C>');
  });

  it('is drawn only when asked for, and on the first page only', () => {
    // renderPdf takes the layout alone, so the print never carries it.
    const layout = layoutLetter({ text: 'Dear Sam,', layoutType: 'text_only' });
    expect(renderPreviewSvg(layout)[0]).not.toContain('<text');
    expect(renderPdf.length).toBe(1);
    const twoPages = { ...layout, pages: [layout.pages[0], layout.pages[0]] };
    const [first, second] = renderPreviewSvg(twoPages, { addresses: ADDRESSES });
    expect(texts(first)).toHaveLength(7);
    expect(second).not.toContain('<text');
  });

  it('formats an address as PostGrid prints it: upper case, the city line with a comma', () => {
    const address = (overrides: Partial<Address> = {}): Address => ({
      name: 'José Muñoz',
      addressLine1: '350 Fifth Ave',
      addressLine2: 'Suite 3300',
      city: 'New York',
      state: 'NY',
      postalCode: '10118',
      country: 'US',
      ...overrides
    });
    expect(stampedAddressLines(address())).toEqual(['JOSÉ MUÑOZ', '350 FIFTH AVE', 'SUITE 3300', 'NEW YORK, NY 10118']);
    // No second street line: none drawn.
    expect(stampedAddressLines(address({ addressLine2: undefined }))).toEqual(['JOSÉ MUÑOZ', '350 FIFTH AVE', 'NEW YORK, NY 10118']);
    expect(stampedAddressLines(address({ addressLine2: '  ' }))).toEqual(['JOSÉ MUÑOZ', '350 FIFTH AVE', 'NEW YORK, NY 10118']);
  });

  it('marks the document as drawn by the renderer, which the card keys on', () => {
    const document = renderLetterPreviewDocument(['<svg></svg>'], { bodyText: 'Hi', signOff: 'Pat' });
    expect(document).toContain('<body data-renderer="pdf-1">');
  });
});
