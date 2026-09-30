/**
 * The renderer's two outputs (#534): the PDF PostGrid prints and the SVG the
 * person previews. Both draw the glyphs glyphs.ts places, so they cannot
 * disagree; these tests hold them to that.
 */

import { deflateSync, inflateSync } from 'node:zlib';
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

/**
 * A JPEG header pdfkit accepts without decoding: SOI, an Exif APP1 with the
 * given orientation, a baseline SOF, EOI. pdfkit reads EXIF orientation from
 * the APP1 segment and never decodes the pixels.
 */
function jpegWithOrientation(width: number, height: number, orientation: number): Buffer {
  const u16 = (value: number) => Buffer.from([value >> 8, value & 0xff]);
  const tiff = Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0]);
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const frame = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, ...u16(height), ...u16(width), 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), u16(exif.length + 2), exif, frame, Buffer.from([0xff, 0xd9])]);
}

/** The PDF's Flate-compressed streams (page content), inflated. */
function contentStreams(pdf: Buffer): string[] {
  const text = pdf.toString('latin1');
  const streams: string[] = [];
  for (const match of text.matchAll(/stream\r?\n/g)) {
    const start = match.index! + match[0].length;
    const end = text.indexOf('endstream', start);
    try {
      streams.push(inflateSync(pdf.subarray(start, end).subarray(0, text.slice(start, end).trimEnd().length)).toString('latin1'));
    } catch {
      // not a Flate stream: an image or metadata
    }
  }
  return streams;
}
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

  it('draws curves as exact cubics: no v or y operators, and outlines of M, L, C and Z only (review round 1)', async () => {
    // pdfkit writes an SVG Q as the PDF v operator, which is not the same
    // curve; outlines are converted to cubics so the PDF and SVG agree.
    const layout = layoutLetter({ text: 'Round letters: ooo QQQ Ôb 8&@', layoutType: 'text_only' });
    for (const glyph of layout.pages[0].items.flatMap(item => (item.kind === 'text' ? placeGlyphs(item) : []))) {
      expect(glyph.outline).toMatch(/^[MLCZ0-9 .-]+$/);
    }
    const tokens = contentStreams(await renderPdf(layout)).join('\n').split(/\s+/);
    expect(tokens.filter(token => token === 'c').length).toBeGreaterThan(100);
    expect(tokens.filter(token => token === 'v' || token === 'y')).toEqual([]);
  });

  it('turns a quadratic into the exact cubic', async () => {
    const { cubicOutline } = await import('../../../src/render/glyphs.js');
    const path = { commands: [
      { command: 'moveTo', args: [0, 0] },
      { command: 'quadraticCurveTo', args: [3, 6, 6, 0] },
      { command: 'closePath', args: [] }
    ] } as unknown as Parameters<typeof cubicOutline>[0];
    // Controls two thirds of the way from each end to the quadratic's control point.
    expect(cubicOutline(path)).toBe('M0 0C2 4 4 4 6 0Z');
  });

  it('draws an image in its box whatever its EXIF orientation says', async () => {
    const image = readImage(jpegWithOrientation(400, 200, 6));
    const layout = layoutLetter({ text: LETTER, layoutType: 'header_image', image });
    const [box] = layout.pages[0].items.filter(item => item.kind === 'image');
    if (box.kind !== 'image') throw new Error('no image');
    const content = contentStreams(await renderPdf(layout)).join('\n');
    const matrices = [...content.matchAll(/([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) cm\s+\/\S+ Do/g)];
    expect(matrices).toHaveLength(1);
    const [, a, b, c, d, e, f] = matrices[0].map(Number);
    expect([a, b, c]).toEqual([box.width, 0, 0]);
    expect(d).toBeCloseTo(-box.height, 3);
    expect(e).toBeCloseTo(box.x, 3);
    expect(f).toBeCloseTo(box.top + box.height, 3);
    // No rotation anywhere before it.
    expect(content).not.toMatch(/\b0 1 -1 0 [-\d.]+ [-\d.]+ cm/);
  });

  it('rejects, rather than throwing, when an image cannot be drawn', async () => {
    const broken: RenderImage = { bytes: Buffer.from('not an image at all'), mime: 'image/png', width: 10, height: 10 };
    const layout = layoutLetter({ text: LETTER, layoutType: 'header_image', image: broken });
    await expect(renderPdf(layout)).rejects.toBeDefined();
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

  it('refuses an empty image or one over 50 megapixels', () => {
    expect(() => readImage(makePng(0, 3))).toThrow(/empty or over/);
    expect(() => readImage(Buffer.concat([Buffer.from('ffd8ffc0001108000300000301220002110103110100', 'hex'), Buffer.alloc(16)]))).toThrow(/empty or over/);
    const huge = makePng(1, 1);
    huge.writeUInt32BE(10000, 16);
    huge.writeUInt32BE(5001, 20);
    expect(() => readImage(huge)).toThrow(/empty or over/);
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

  it('does not count what the renderer handles itself as missing (review round 1)', () => {
    // Line breaks start new lines, tabs become spaces, and characters that
    // print nothing are dropped.
    const text = `a\nb\r\nc\td${String.fromCodePoint(0xfe0f)}e${String.fromCodePoint(0x061c)}f`;
    expect(missingCharacters('Tinos-Regular', text)).toEqual([]);
  });
});
