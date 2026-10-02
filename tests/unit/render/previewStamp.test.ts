/**
 * A preview draws the addresses where PostGrid stamps them (#534 Phase 3), so
 * the page shows what prints: Open Sans at 9pt, in upper case, from x 0.70in,
 * the return address from 0.438in and the recipient from 2.094in, 0.177in a
 * line (probe P6). The PDF leaves the zone to PostGrid.
 */

import { describe, expect, it } from 'vitest';
import { layoutLetter, layoutPostcard, POSTCARD_GEOMETRY, POSTCARD_STAMP, renderPreviewSvg } from '../../../src/render/index.js';
import {
  renderLetterPreviewDocument,
  renderPostcardPreviewDocument,
  stampedAddressLines,
  stampedPostcardReturnLines
} from '../../../src/services/previewService.js';
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

  it("stamps a postcard's back with the postcard's geometry, on the page asked for (#534 Phase 4)", () => {
    const image = { bytes: Buffer.alloc(0), mime: 'image/png' as const, width: 2700, height: 1800 };
    const [front, back] = renderPreviewSvg(layoutPostcard({ message: 'Hi', image }), {
      addresses: { from: ['RETURN TO:', ...ADDRESSES.from], to: ADDRESSES.to },
      stamp: { page: 1, geometry: POSTCARD_STAMP }
    });
    expect(texts(front)).toEqual([]);
    // A page without text is named by its title, for screen readers.
    expect(front).toContain('<title>The front of the postcard</title>');
    // Probes P9 and P11: from x 5.725in, "RETURN TO:" at 0.958in and the
    // recipient at 4.937in, 0.177in a line, each block from its first line.
    expect(texts(back)).toEqual([
      { x: 412.2, y: 68.98, text: 'RETURN TO:' },
      { x: 412.2, y: 81.72, text: 'PAT EXAMPLE' },
      { x: 412.2, y: 94.46, text: '1600 PENNSYLVANIA AVE NW' },
      { x: 412.2, y: 107.21, text: 'WASHINGTON, DC 20500' },
      { x: 412.2, y: 355.46, text: 'SAM RIVERA' },
      { x: 412.2, y: 368.21, text: '350 FIFTH AVE' },
      { x: 412.2, y: 380.95, text: 'SUITE 3300' },
      { x: 412.2, y: 393.7, text: 'NEW YORK, NY 10118' }
    ]);
    expect(back).toContain('font-size="9"');
  });

  it.each([
    // Probe P14: from x 3.925in on a 6x4, the recipient 1.313in above the bottom edge.
    ['6x4', 282.6, [68.98, 81.72, 94.46, 107.21], [211.46, 224.21, 236.95, 249.7]],
    // From x 5.725in on a 9x6, as probes P9 and P11 found.
    ['6x9', 412.2, [68.98, 81.72, 94.46, 107.21], [355.46, 368.21, 380.95, 393.7]],
    // And from x 7.725in on an 11x6, the recipient where it is on a 9x6.
    ['6x11', 556.2, [68.98, 81.72, 94.46, 107.21], [355.46, 368.21, 380.95, 393.7]]
  ] as const)('stamps a %s back where PostGrid prints it (#594)', (size, x, returnLines, recipientLines) => {
    const image = { bytes: Buffer.alloc(0), mime: 'image/png' as const, width: 2700, height: 1800 };
    const [, back] = renderPreviewSvg(layoutPostcard({ message: 'Hi', image, size }), {
      addresses: { from: ['RETURN TO:', ...ADDRESSES.from], to: ADDRESSES.to },
      stamp: { page: 1, geometry: POSTCARD_GEOMETRY[size].stamp }
    });
    const stamped = texts(back);
    expect(stamped.map(line => line.x)).toEqual(Array(8).fill(x));
    expect(stamped.map(line => line.y)).toEqual([...returnLines, ...recipientLines]);
    expect(stamped.map(line => line.text)).toEqual(['RETURN TO:', ...ADDRESSES.from, ...ADDRESSES.to]);
  });

  it("heads a postcard's return address RETURN TO:, as PostGrid does", () => {
    const sender: Address = { name: 'Pat Example', addressLine1: '1600 Pennsylvania Ave NW', city: 'Washington', state: 'DC', postalCode: '20500', country: 'US' };
    expect(stampedPostcardReturnLines(sender)).toEqual(['RETURN TO:', ...stampedAddressLines(sender)]);
  });

  it('wraps a postcard in the same document as a letter, without the hidden letter text', () => {
    const html = renderPostcardPreviewDocument(['<svg a></svg>', '<svg b></svg>']);
    expect(html).toContain('<body data-renderer="pdf-1">\n<svg a></svg>\n<svg b></svg>\n</body>');
    expect(html).not.toContain('hidden');
    // A letter's keeps its hidden text after its pages.
    const letter = renderLetterPreviewDocument(['<svg a></svg>'], { bodyText: 'Hi', signOff: 'P' });
    expect(letter).toContain('<svg a></svg>\n  <div hidden>\n    <div class="letter-body">Hi</div>\n    <div class="sign-off">P</div>\n  </div>\n</body>');
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
    const layout = layoutLetter({ text: 'Dear Sam,', layoutType: 'text_only' });
    expect(renderPreviewSvg(layout)[0]).not.toContain('<text');
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
    // Each kept line is trimmed.
    expect(stampedAddressLines(address({ name: '  Pat  ' }))[0]).toBe('PAT');
  });

  it('marks the document as drawn by the renderer, which the card keys on', () => {
    const document = renderLetterPreviewDocument(['<svg></svg>'], { bodyText: 'Hi', signOff: 'Pat' });
    expect(document).toContain('<body data-renderer="pdf-1">');
  });
});
