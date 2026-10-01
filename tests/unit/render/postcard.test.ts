/**
 * A 9x6 postcard drawn by our renderer (#534 Phase 4): two pages at 9.25 x
 * 6.25in with their bleed, as PostGrid takes them (probe P9), the front image
 * covering the first and the message in the back's left half.
 */

import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { layoutPostcard, renderPdf } from '../../../src/render/index.js';
import { loadFont } from '../../../src/render/fonts.js';
import { shape } from '../../../src/render/glyphs.js';
import { baselineOffset, type ImageBox, type TextRun } from '../../../src/render/layout.js';
import { POSTCARD_HALF, POSTCARD_LINE_PITCH, POSTCARD_MESSAGE } from '../../../src/render/geometry.js';
import { readImage, type RenderImage } from '../../../src/render/images.js';

const inch = (inches: number) => inches * 72;
/** The size imageService crops a 6x9 postcard's front to: 9 x 6in at 300 dpi. */
const FRONT: RenderImage = { bytes: Buffer.alloc(0), mime: 'image/jpeg', width: 2700, height: 1800 };
const lines = (count: number) => Array.from({ length: count }, (_, index) => `Line ${index + 1}`).join('\n');
const back = (message: string) => layoutPostcard({ message, image: FRONT }).pages[1];
const text = (message: string) => back(message).items.filter((item): item is TextRun => item.kind === 'text');

/** A valid 8-bit grayscale PNG, for the PDF. */
function png(width: number, height: number): Buffer {
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
  header[8] = 8;
  const rows = Buffer.alloc((width + 1) * height, 0x80);
  for (let row = 0; row < height; row++) rows[row * (width + 1)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))
  ]);
}

describe('a postcard on our renderer', () => {
  it('is two pages, front then back, each 9.25 x 6.25in: the card and its bleed', () => {
    const layout = layoutPostcard({ message: 'Hello', image: FRONT });
    expect([layout.width, layout.height]).toEqual([inch(9.25), inch(6.25)]);
    expect(layout.pages).toHaveLength(2);
    expect(layout.pages[0].items.map(item => item.kind)).toEqual(['image']);
    expect(layout.pages[1].items.map(item => item.kind)).toEqual(['text']);
  });

  it('covers the whole front with the image, bleed included, cropped evenly', () => {
    const box = layoutPostcard({ message: '', image: FRONT }).pages[0].items[0] as ImageBox;
    // 2700 x 1800 at a quarter point a pixel: 675 x 450pt, 4.5pt cropped off each side.
    expect(box).toMatchObject({ x: -4.5, top: 0, width: 675, height: 450, image: FRONT });

    // A tall image is cropped top and bottom instead, never squeezed.
    const tall = layoutPostcard({ message: '', image: { ...FRONT, width: 1800, height: 2700 } }).pages[0].items[0] as ImageBox;
    expect(tall.width).toBeCloseTo(inch(9.25), 6);
    expect(tall.height / tall.width).toBeCloseTo(1.5, 6);
    expect(tall.x).toBeCloseTo(0, 6);
    expect(tall.top).toBeCloseTo((inch(6.25) - tall.height) / 2, 6);
  });

  it("writes the message where the legacy back did: its left half, inside 0.4in, 14pt at a pitch of 22.4", () => {
    const runs = text('Dear Sam,\nWish you were here.\nPat');
    expect(runs.map(run => [run.source, run.size])).toEqual([['Dear Sam,', 14], ['Wish you were here.', 14], ['Pat', 14]]);
    // 0.125in of bleed and 0.4in of padding from the page's edge.
    for (const run of runs) expect(run.x).toBeCloseTo(inch(0.525), 9);
    const first = inch(0.525) + baselineOffset(14, 22.4);
    runs.forEach((run, index) => expect(run.baseline).toBeCloseTo(first + index * 22.4, 6));
  });

  it('keeps the right half of the back empty, where PostGrid stamps the addresses', () => {
    const long = 'the quick brown fox jumps over the lazy dog '.repeat(8);
    const runs = text(long);
    expect(runs.length).toBeGreaterThan(3);
    for (const run of runs) {
      const font = loadFont(run.font);
      const right = run.x + shape(font, run.text).advanceWidth * (run.size / font.unitsPerEm);
      expect(right).toBeLessThanOrEqual(POSTCARD_MESSAGE.left + POSTCARD_MESSAGE.width + 1e-6);
      expect(right).toBeLessThan(POSTCARD_HALF);
    }
    expect(POSTCARD_HALF).toBe(inch(4.625));
  });

  it('holds 16 lines, and counts how many more a message takes', () => {
    expect(back(lines(16))).toMatchObject({ linesUsed: 16, linesAvailable: 16 });
    expect(layoutPostcard({ message: lines(16), image: FRONT }).overflowLines).toBe(0);
    expect(layoutPostcard({ message: lines(19), image: FRONT }).overflowLines).toBe(3);
    // The last line's box ends inside the message area.
    expect(POSTCARD_MESSAGE.top + 16 * POSTCARD_LINE_PITCH).toBeLessThanOrEqual(POSTCARD_MESSAGE.top + POSTCARD_MESSAGE.height);
  });

  it('counts blank lines inside the message, but not trailing ones, which draw nothing', () => {
    expect(back('One\n\nThree')).toMatchObject({ linesUsed: 3 });
    // A blank line takes its pitch and draws no run.
    expect(text('One\n\nThree').map(run => run.source)).toEqual(['One', 'Three']);
    const [one, three] = text('One\n\nThree');
    expect(three.baseline - one.baseline).toBeCloseTo(2 * POSTCARD_LINE_PITCH, 9);
    expect(back(`${lines(16)}\n\n\n  \n`)).toMatchObject({ linesUsed: 16 });
    expect(layoutPostcard({ message: `${lines(16)}\n\n`, image: FRONT }).overflowLines).toBe(0);
  });

  it('prints as a two-page PDF of that size', async () => {
    const image = readImage(png(300, 200));
    const pdf = (await renderPdf(layoutPostcard({ message: 'Dear Sam,\nWish you were here.', image }))).toString('latin1');
    expect(pdf).toMatch(/\/Type \/Pages[\s\S]*?\/Count 2/);
    const boxes = [...pdf.matchAll(/\/MediaBox \[([^\]]+)\]/g)].map(match => match[1].trim().split(/\s+/).map(Number));
    expect(boxes).toEqual([[0, 0, 666, 450], [0, 0, 666, 450]]);
    expect(pdf).toMatch(/\/Subtype\s*\/Image/);
    // pdfkit writes the title as an object of its own.
    const title = /\/Title (\d+) 0 R/.exec(pdf)!;
    expect(new RegExp(`\\n${title[1]} 0 obj\\n\\(([^)]*)\\)\\nendobj`).exec(pdf)?.[1]).toBe('Postcard');
  });
});
