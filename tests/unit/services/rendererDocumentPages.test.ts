/**
 * The pages of a stored preview document (#563, #594): each top-level <svg>
 * exactly as written. A bordered postcard's front holds a viewport of its own
 * for its photo, so a page does not end at the first </svg> it contains.
 */

import { describe, expect, it } from 'vitest';
import { layoutLetter, layoutPostcard, renderPreviewSvg } from '../../../src/render/index.js';
import {
  renderedPageImage,
  rendererDocumentPages,
  renderLetterPreviewDocument,
  renderPostcardPreviewDocument
} from '../../../src/services/previewService.js';

/** A PNG's signature and header: enough for the renderer to size it. */
function pngBytes(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  bytes.writeUInt32BE(0x89504e47, 0);
  bytes.writeUInt32BE(0x0d0a1a0a, 4);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}
const image = { bytes: pngBytes(540, 360), mime: 'image/png' as const, width: 540, height: 360 };

describe('rendererDocumentPages', () => {
  it("returns a bordered postcard's front whole: its photo's own viewport, its caption, its close (#594)", () => {
    const pages = renderPreviewSvg(layoutPostcard({ message: 'Dear Sam,', image, layout: 'border', caption: 'Cape Cod' }));
    // The premise: the front holds an <svg> of its own.
    expect(pages[0].match(/<svg /g)).toHaveLength(2);
    const split = rendererDocumentPages(renderPostcardPreviewDocument(pages));
    expect(split).toEqual(pages);
    expect(split[0]).toContain('<g fill="#1E1A16">');
    // Both closes, the caption drawn after the viewport's.
    expect(split[0].match(/<\/svg>/g)).toHaveLength(2);
    expect(split[0].indexOf('<g fill="#1E1A16">')).toBeGreaterThan(split[0].indexOf('</svg>'));
    // The picture is found in it, as a restyle would look for it.
    expect(renderedPageImage(split[0])).toBe(`data:image/png;base64,${image.bytes.toString('base64')}`);
  });

  it('returns every other page as written: the other fronts, a back, a letter of several pages', () => {
    for (const content of [{}, { layout: 'greetings' as const, place: 'Asheville' }]) {
      const pages = renderPreviewSvg(layoutPostcard({ message: 'Dear Sam,', image, ...content }));
      expect(rendererDocumentPages(renderPostcardPreviewDocument(pages))).toEqual(pages);
    }
    const letter = renderPreviewSvg(layoutLetter({ text: Array.from({ length: 40 }, (_, n) => `Line ${n + 1}`).join('\n'), layoutType: 'text_only' }, { maxPages: 3 }));
    expect(letter.length).toBeGreaterThan(1);
    expect(rendererDocumentPages(renderLetterPreviewDocument(letter, { bodyText: 'Line 1', signOff: '' }))).toEqual(letter);
  });

  it('finds none in a legacy document, and skips a close outside any page', () => {
    expect(rendererDocumentPages('<html><body><div class="postcard-front"></div></body></html>')).toEqual([]);
    expect(rendererDocumentPages(null)).toEqual([]);
    const [page] = renderPreviewSvg(layoutPostcard({ message: 'Hi', image, layout: 'border', caption: 'Rye' }));
    expect(rendererDocumentPages(`<html><body data-renderer="pdf-1">\n</svg>\n${page}\n</body></html>`)).toEqual([page]);
  });
});

describe("the stored document's styles (#598 review round 1)", () => {
  it("size the top-level pages only, never a page's own viewport", () => {
    const document = renderPostcardPreviewDocument(renderPreviewSvg(layoutPostcard({ message: 'Hi', image, layout: 'border', caption: 'Rye' })));
    const style = /<style>([\s\S]*?)<\/style>/.exec(document)![1];
    // Every rule that names svg names it as the body's child.
    const rules = style.split('}').map(rule => rule.trim()).filter(rule => /\bsvg\b/.test(rule));
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) expect(rule, rule).toMatch(/^body > svg( \+ body > svg| \+ svg)? \{/);
  });
});
