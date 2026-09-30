/**
 * The renderer's two outputs (#534): the PDF PostGrid prints and the SVG the
 * person previews. Both draw the glyphs glyphs.ts places, so they cannot
 * disagree; these tests hold them to that.
 */

import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { layoutLetter, type TextRun } from '../../../src/render/layout.js';
import { placeGlyphs } from '../../../src/render/glyphs.js';
import { renderPdf, RENDERER_VERSION } from '../../../src/render/pdf.js';
import { renderPreviewSvg } from '../../../src/render/preview.js';
import { missingCharacters } from '../../../src/render/fonts.js';
import { readImage, readImageDataUri, type RenderImage } from '../../../src/render/images.js';

/** A valid 8-bit grayscale PNG of the given size, built rather than hand-written. */
function makePng(width: number, height: number): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, body: Buffer) => {
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([length, typed, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth; colour type 0 (grayscale) and the rest stay 0
  const rows = Buffer.alloc((width + 1) * height, 0x80);
  for (let row = 0; row < height; row++) rows[row * (width + 1)] = 0; // filter type 0 per row
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))
  ]);
}

const PNG = makePng(2, 1);
const LETTER = 'Dear Sam,\n\nThis is a test of the renderer.\n\nWarmly,\nTest';

async function openPdf(bytes: Buffer) {
  return pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, isEvalSupported: false }).promise;
}

describe('the PDF (#534)', () => {
  it('is one US Letter page, stamped with the renderer version', async () => {
    const pdf = await openPdf(await renderPdf(layoutLetter({ text: LETTER, layoutType: 'text_only' })));
    expect(pdf.numPages).toBe(1);
    const page = await pdf.getPage(1);
    const [, , width, height] = page.view;
    expect([width, height]).toEqual([612, 792]);
    const { info } = await pdf.getMetadata() as { info: { Producer?: string } };
    expect(info.Producer).toContain(RENDERER_VERSION);
  });

  it('draws every placed glyph as a filled outline, and hands no text to a font', async () => {
    const layout = layoutLetter({ text: LETTER, layoutType: 'text_only' });
    const glyphs = layout.pages[0].items.flatMap(item => (item.kind === 'text' ? placeGlyphs(item) : []));
    const page = await (await openPdf(await renderPdf(layout))).getPage(1);
    const ops = await page.getOperatorList();
    // pdfjs folds the paint operator into constructPath as its first argument.
    const fills = ops.fnArray.filter((fn, index) =>
      fn === pdfjs.OPS.constructPath && [pdfjs.OPS.fill, pdfjs.OPS.eoFill].includes(ops.argsArray[index][0])).length;
    const shown = ops.fnArray.filter(fn => fn === pdfjs.OPS.showText || fn === pdfjs.OPS.showSpacedText).length;
    expect(glyphs.length).toBeGreaterThan(40);
    expect(fills).toBe(glyphs.length);
    expect(shown).toBe(0);
    expect((await page.getTextContent()).items).toEqual([]);
  });

  it('moves to each glyph\'s own position before filling it', async () => {
    const layout = layoutLetter({ text: LETTER, layoutType: 'text_only' });
    const glyphs = layout.pages[0].items.flatMap(item => (item.kind === 'text' ? placeGlyphs(item) : []));
    const ops = await (await (await openPdf(await renderPdf(layout))).getPage(1)).getOperatorList();
    // pdfkit flips the page to a top-left origin with one transform, then
    // each glyph's translate is its own [1 0 0 1 x y].
    const translates = ops.fnArray
      .map((fn, index) => (fn === pdfjs.OPS.transform ? ops.argsArray[index] as number[] : null))
      .filter((args): args is number[] => !!args && args[0] === 1 && args[3] === 1);
    expect(translates.length).toBe(glyphs.length);
    translates.forEach((args, index) => {
      expect(args[4]).toBeCloseTo(glyphs[index].x, 3);
      expect(args[5]).toBeCloseTo(glyphs[index].y, 3);
    });
  });

  it('paints the header image in its box', async () => {
    const image = readImage(PNG);
    const layout = layoutLetter({ text: LETTER, layoutType: 'header_image', image });
    const [box] = layout.pages[0].items.filter(item => item.kind === 'image');
    if (box.kind !== 'image') throw new Error('no image');
    const ops = await (await (await openPdf(await renderPdf(layout))).getPage(1)).getOperatorList();
    const paint = ops.fnArray.findIndex(fn => fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintInlineImageXObject);
    expect(paint).toBeGreaterThan(0);
    const scaling = ops.argsArray.slice(0, paint).reverse().find((args, offset) => ops.fnArray[paint - 1 - offset] === pdfjs.OPS.transform) as number[];
    // pdfkit draws an image through [w 0 0 -h x y+h] in its top-left space.
    expect(scaling[0]).toBeCloseTo(box.width, 3);
    expect(scaling[3]).toBeCloseTo(-box.height, 3);
    expect(scaling[4]).toBeCloseTo(box.x, 3);
    expect(scaling[5]).toBeCloseTo(box.top + box.height, 3);
  });
});

describe('the SVG preview (#534)', () => {
  it('draws exactly the placed glyphs, at the same positions as the PDF', () => {
    const layout = layoutLetter({ text: LETTER, layoutType: 'text_only' });
    const [svg] = renderPreviewSvg(layout);
    const uses = [...svg.matchAll(/<use href="#([^"]+)" x="([\d.-]+)" y="([\d.-]+)"\/>/g)]
      .map(([, key, x, y]) => ({ key, x: Number(x), y: Number(y) }));
    const glyphs = layout.pages[0].items.flatMap(item => (item.kind === 'text' ? placeGlyphs(item as TextRun) : []));
    expect(uses.length).toBe(glyphs.length);
    uses.forEach((use, index) => {
      expect(use.key).toBe(glyphs[index].key);
      expect(use.x).toBeCloseTo(glyphs[index].x, 2);
      expect(use.y).toBeCloseTo(glyphs[index].y, 2);
    });
  });

  it('defines each glyph it uses exactly once', () => {
    const [svg] = renderPreviewSvg(layoutLetter({ text: LETTER, layoutType: 'text_only' }));
    const defined = [...svg.matchAll(/<path id="([^"]+)"/g)].map(match => match[1]);
    const used = new Set([...svg.matchAll(/<use href="#([^"]+)"/g)].map(match => match[1]));
    expect(new Set(defined).size).toBe(defined.length);
    expect(new Set(defined)).toEqual(used);
  });

  it('carries the text only as escaped title content', () => {
    const [svg] = renderPreviewSvg(layoutLetter({ text: 'Hi <script>alert("x")</script> & "you"', layoutType: 'text_only' }));
    expect(svg).not.toContain('<script');
    expect(svg).toContain('<title>Hi &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &quot;you&quot;</title>');
  });

  it('embeds the image in its fitted box', () => {
    const image = readImage(PNG);
    const [svg] = renderPreviewSvg(layoutLetter({ text: LETTER, layoutType: 'header_image', image }));
    expect(svg).toMatch(/<image href="data:image\/png;base64,[A-Za-z0-9+/=]+" x="[\d.]+" y="216" width="1.5" height="0.75"/);
  });
});

describe('images and fonts (#534)', () => {
  it('reads a PNG and a JPEG size from their headers', () => {
    expect(readImage(PNG)).toMatchObject({ mime: 'image/png', width: 2, height: 1 });
    // SOI, an APP0 segment of length 4, then SOF0: length 17, precision 8, height 3, width 5.
    const jpeg = Buffer.from('ffd8ffe000040000ffc000110800030005', 'hex');
    expect(readImage(Buffer.concat([jpeg, Buffer.alloc(16)]))).toMatchObject({ mime: 'image/jpeg', width: 5, height: 3 });
  });

  it('reads a data URI, and refuses anything that is not a JPEG or PNG', () => {
    const image: RenderImage = readImageDataUri(`data:image/png;base64,${PNG.toString('base64')}`);
    expect(image.width).toBe(2);
    expect(() => readImageDataUri('data:image/gif;base64,R0lGOD')).toThrow();
    expect(() => readImage(Buffer.from('not an image'))).toThrow();
  });

  it('knows which characters Tinos cannot draw', () => {
    const party = String.fromCodePoint(0x1f389);
    const wang = String.fromCodePoint(0x738b);
    expect(missingCharacters('Tinos-Regular', `Café ${party} ${wang} ${party}`)).toEqual([party, wang]);
    const hebrew = String.fromCodePoint(0x05e9, 0x05dc, 0x05d5, 0x05dd);
    expect(missingCharacters('Tinos-Regular', `Kalimera ${String.fromCodePoint(0x03ba, 0x03b1)} ${hebrew} ${String.fromCodePoint(0x2011, 0x202f)}`)).toEqual([]);
  });
});
