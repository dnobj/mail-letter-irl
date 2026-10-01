/**
 * A 9x6 postcard drawn by our renderer (#534 Phase 4): two pages at 9.25 x
 * 6.25in with their bleed, as PostGrid takes them (probe P9), the front image
 * covering the first and the message in the back's left half, a gift send's
 * card in a strip at its foot.
 */

import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { GiftStripOverflow, layoutPostcard, layoutPostcardBack, renderPdf, type GiftStripCopy } from '../../../src/render/index.js';
import { loadFont } from '../../../src/render/fonts.js';
import { shape } from '../../../src/render/glyphs.js';
import { baselineOffset, type ImageBox, type RectsItem, type TextRun } from '../../../src/render/layout.js';
import { qrMatrix } from '../../../src/render/qr.js';
import { POSTCARD_HALF, POSTCARD_LINE_PITCH, POSTCARD_MESSAGE, POSTCARD_STRIP } from '../../../src/render/geometry.js';
import { readImage, type RenderImage } from '../../../src/render/images.js';

const inch = (inches: number) => inches * 72;
/** The size imageService crops a 6x9 postcard's front to: 9 x 6in at 300 dpi. */
const FRONT: RenderImage = { bytes: Buffer.alloc(0), mime: 'image/jpeg', width: 2700, height: 1800 };
const lines = (count: number) => Array.from({ length: count }, (_, index) => `Line ${index + 1}`).join('\n');
const back = (message: string) => layoutPostcard({ message, image: FRONT }).pages[1];
const text = (message: string) => back(message).items.filter((item): item is TextRun => item.kind === 'text');

/** A funded gift card's strip, in the words giftPostcardStripCopy gives it. */
const STRIP: GiftStripCopy = {
  lead: 'A gift from Pat:',
  lines: [
    { text: 'a letter of your own, printed and mailed free. Scan, or visit letterirl.com/g and enter', kind: 'plain' },
    { text: 'K7M2-QX9A', kind: 'code' },
    { text: 'Redeem by December 16, 2026. One use.', kind: 'plain' }
  ],
  qrUrl: 'https://letterirl.com/g/K7M2QX9A'
};
/** A strip of a lead and `count` one-line plain lines. */
const plainStrip = (count: number): GiftStripCopy => ({
  lead: 'A gift from Pat:',
  lines: Array.from({ length: count }, (_, index) => ({ text: `Line ${index + 1}`, kind: 'plain' as const })),
  qrUrl: 'https://letterirl.com/g'
});
const giftBack = (message: string, strip: GiftStripCopy = STRIP) => layoutPostcardBack(message, strip).page;
const rightEdge = (run: TextRun) => {
  const font = loadFont(run.font);
  return run.x + shape(font, run.text).advanceWidth * (run.size / font.unitsPerEm);
};
// The strip, from the legacy CSS: 1.75in at the foot of the message, which
// ends 0.4in above the card's bottom edge, 0.125in of bleed below that.
const STRIP_TOP = inch(0.525 + 5.2 - 1.75);
const ROW_TOP = STRIP_TOP + 1 + inch(0.14);
const ROOM = inch(1.75) - 1 - inch(0.14);

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

  it('measures the back alone exactly as the postcard lays it out, before any image', () => {
    for (const message of ['Hello', lines(16), lines(19), 'One\n\nThree\n\n']) {
      const whole = layoutPostcard({ message, image: FRONT });
      expect(layoutPostcardBack(message)).toEqual({ page: whole.pages[1], overflowLines: whole.overflowLines });
    }
  });

  it('measures the back alone exactly as the postcard lays it out, a gift strip included', () => {
    for (const message of ['Hello', lines(11), lines(13)]) {
      const whole = layoutPostcard({ message, image: FRONT, strip: STRIP });
      expect(layoutPostcardBack(message, STRIP)).toEqual({ page: whole.pages[1], overflowLines: whole.overflowLines });
    }
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

describe("a gift postcard's strip on our renderer", () => {
  it('takes the foot of the message half: 11 lines above it, where the back holds 16 without', () => {
    expect(giftBack(lines(11))).toMatchObject({ linesUsed: 11, linesAvailable: 11 });
    expect(layoutPostcardBack(lines(11), STRIP).overflowLines).toBe(0);
    expect(layoutPostcardBack(lines(12), STRIP).overflowLines).toBe(1);
    expect(layoutPostcard({ message: lines(14), image: FRONT, strip: STRIP }).overflowLines).toBe(3);
    // The eleventh line's box ends above the strip's rule.
    expect(inch(0.525) + 11 * POSTCARD_LINE_PITCH).toBeLessThanOrEqual(STRIP_TOP);
    expect(STRIP_TOP).toBeCloseTo(POSTCARD_MESSAGE.top + POSTCARD_MESSAGE.height - POSTCARD_STRIP.height, 9);
  });

  it('reads the message first, then the strip: a rule, the QR, and its words in order', () => {
    const page = giftBack('Dear Sam,\nWish you were here.');
    expect(page.items.map(item => item.kind)).toEqual(['text', 'text', 'rects', 'rects', ...Array(page.items.length - 4).fill('text')]);
    const runs = page.items.filter((item): item is TextRun => item.kind === 'text');
    expect(runs.slice(0, 2).map(run => run.source)).toEqual(['Dear Sam,', 'Wish you were here.']);
    const words = runs.slice(2).map(run => run.source.trim()).join(' ');
    expect(words).toBe('A gift from Pat: a letter of your own, printed and mailed free. Scan, or visit letterirl.com/g and enter K7M2-QX9A Redeem by December 16, 2026. One use.');
    // The lead at 10pt, the code at 12pt, the rest at 9pt, as the legacy CSS sizes them.
    expect(runs.slice(2).map(run => [run.source.trim(), run.size]).filter(([, size]) => size !== 9)).toEqual([['A gift from Pat:', 10], ['K7M2-QX9A', 12]]);
  });

  it('draws the rule across the message half, at the top of the strip', () => {
    const [rule] = giftBack('Hello').items.filter((item): item is RectsItem => item.kind === 'rects');
    expect(rule.fill).toBe('#b9ad99');
    expect(rule.rects).toHaveLength(1);
    expect(rule.rects[0].x).toBeCloseTo(inch(0.525), 9);
    expect(rule.rects[0].top).toBeCloseTo(STRIP_TOP, 9);
    expect(rule.rects[0].width).toBeCloseTo(inch(3.7), 9);
    expect(rule.rects[0].height).toBe(1);
  });

  it('draws the QR 0.95in square at the left, its words 0.18in beyond it, all inside the message half', () => {
    const page = giftBack('Hello');
    const qr = page.items.filter((item): item is RectsItem => item.kind === 'rects')[1];
    expect(qr.fill).toBe('#000');
    // The symbol's dark modules (its finder patterns reach three of its
    // edges), inside a quiet zone of four modules on every side.
    const { count } = qrMatrix(STRIP.qrUrl);
    const module = inch(0.95) / (count + 8);
    const left = Math.min(...qr.rects.map(rect => rect.x));
    const right = Math.max(...qr.rects.map(rect => rect.x + rect.width));
    const top = Math.min(...qr.rects.map(rect => rect.top));
    const bottom = Math.max(...qr.rects.map(rect => rect.top + rect.height));
    expect(left).toBeCloseTo(inch(0.525) + 4 * module, 1);
    expect(right).toBeCloseTo(inch(0.525) + (count + 4) * module, 1);
    expect(bottom - top).toBeCloseTo(count * module, 1);
    expect(top - 4 * module).toBeGreaterThanOrEqual(ROW_TOP - 0.01);
    expect(bottom + 4 * module).toBeLessThanOrEqual(inch(0.525 + 5.2) + 0.01);
    const strip = page.items.filter((item): item is TextRun => item.kind === 'text').slice(1);
    for (const run of strip) {
      expect(run.x).toBeCloseTo(inch(0.525 + 0.95 + 0.18), 9);
      expect(rightEdge(run)).toBeLessThanOrEqual(inch(0.525 + 3.7) + 1e-6);
      expect(rightEdge(run)).toBeLessThan(POSTCARD_HALF);
      expect(run.baseline).toBeGreaterThan(ROW_TOP);
      expect(run.baseline).toBeLessThan(inch(0.525 + 5.2));
    }
  });

  it('centres the QR and its words on each other, as the legacy CSS does', () => {
    // Words shorter than the QR: the QR starts the row, and the words sit in its middle.
    const short = giftBack('', plainStrip(2));
    const shortQr = short.items.filter((item): item is RectsItem => item.kind === 'rects')[1].rects;
    const shortRuns = short.items.filter((item): item is TextRun => item.kind === 'text');
    const shortHeight = 13.5 + 2 * 12.15;
    expect(shortRuns[0].baseline).toBeCloseTo(ROW_TOP + (inch(0.95) - shortHeight) / 2 + baselineOffset(10, 13.5), 6);
    expect(shortRuns[1].baseline).toBeCloseTo(ROW_TOP + (inch(0.95) - shortHeight) / 2 + 13.5 + baselineOffset(9, 12.15), 6);
    // Words taller than the QR: they start the row, and the QR sits in their middle.
    const tall = giftBack('', plainStrip(6));
    const tallQr = tall.items.filter((item): item is RectsItem => item.kind === 'rects')[1].rects;
    const tallRuns = tall.items.filter((item): item is TextRun => item.kind === 'text');
    const tallHeight = 13.5 + 6 * 12.15;
    expect(tallRuns[0].baseline).toBeCloseTo(ROW_TOP + baselineOffset(10, 13.5), 6);
    const topOf = (rects: Array<{ top: number }>) => Math.min(...rects.map(rect => rect.top));
    // The same symbol, moved down by half the difference.
    expect(topOf(tallQr) - topOf(shortQr)).toBeCloseTo((tallHeight - inch(0.95)) / 2, 1);
  });

  it('throws GiftStripOverflow, by how much, when its words run past its room', () => {
    // A lead and eight lines fit: 13.5 + 8 x 12.15 = 110.7 of 114.92pt.
    expect(() => giftBack('', plainStrip(8))).not.toThrow();
    const error = (() => {
      try {
        giftBack('', plainStrip(9));
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(GiftStripOverflow);
    expect((error as GiftStripOverflow).overflow).toBeCloseTo(13.5 + 9 * 12.15 - ROOM, 6);
    expect((error as Error).message).toBe('The gift strip runs 0.11in past its room.');
    // A long name wraps the lead until it does not fit, whatever the message.
    expect(() => layoutPostcard({ message: 'Hi', image: FRONT, strip: { ...STRIP, lead: `A gift from ${'Pat Example '.repeat(30)}:` } }))
      .toThrow(GiftStripOverflow);
  });

  it('prints its rule and QR as filled rectangles in the PDF', async () => {
    const image = readImage(png(300, 200));
    const plain = (await renderPdf(layoutPostcard({ message: 'Hello', image }))).toString('latin1');
    const gift = (await renderPdf(layoutPostcard({ message: 'Hello', image, strip: STRIP }))).toString('latin1');
    expect(gift).toMatch(/\/Count 2/);
    expect(gift.length).toBeGreaterThan(plain.length);
  });
});
