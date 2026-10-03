/**
 * A signature on a letter (#608): layoutLetter draws the person's signature
 * in a band of three lines under the sign-off's first line, left with the
 * text; counts the band in the page's lines, so the fit and room to write
 * see it; and never parts it from the closing above it across a page. A
 * letter without one is laid out exactly as before.
 */

import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { layoutLetter, pageFit, type Layout, type LayoutItem, type LetterContent, type TextRun } from '../../../src/render/layout.js';
import { renderPdf } from '../../../src/render/pdf.js';
import { renderPreviewSvg } from '../../../src/render/preview.js';
import {
  BODY_BOTTOM, BODY_TOP, CONTINUATION_TOP, LINE_PITCH, SIDE_MARGIN, SIGNATURE_LINES, SIGNATURE_MAX_WIDTH, SIGNATURE_PADDING
} from '../../../src/render/geometry.js';
import { readImage, type RenderImage } from '../../../src/render/images.js';

/** A PNG's signature and header: enough for the layout to size it. */
function pngHeader(width: number, height: number): RenderImage {
  const bytes = Buffer.alloc(33);
  bytes.writeUInt32BE(0x89504e47, 0);
  bytes.writeUInt32BE(0x0d0a1a0a, 4);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return { bytes, mime: 'image/png', width, height };
}

/** A signature as the cleaning writes one: wide, short, one grey channel. */
const SIGNATURE = pngHeader(1200, 300);

const texts = (items: LayoutItem[]) => items.filter((item): item is TextRun => item.kind === 'text');
const images = (items: LayoutItem[]) => items.filter(item => item.kind === 'image');
const lineOf = (layout: Layout, page: number, source: string) => texts(layout.pages[page].items).find(run => run.source === source)!;

function letter(text: string, closingParagraph: number, extra: Partial<LetterContent> = {}): LetterContent {
  return { text, layoutType: 'text_only', signature: { image: SIGNATURE, closingParagraph }, ...extra };
}

describe('a signature on a letter (#608)', () => {
  it('sits in three lines under the closing, left with the text, and the name follows it', () => {
    // Paragraphs: "Dear Ruth,", "", "Thank you.", "Sincerely,", "Pat Example". The body has three.
    const text = 'Dear Ruth,\n\nThank you.\nSincerely,\nPat Example';
    const layout = layoutLetter(letter(text, 3));
    const page = layout.pages[0];
    const baseline = lineOf(layout, 0, 'Dear Ruth,').baseline - BODY_TOP;
    expect(lineOf(layout, 0, 'Sincerely,').baseline).toBeCloseTo(BODY_TOP + 3 * LINE_PITCH + baseline, 6);
    expect(lineOf(layout, 0, 'Pat Example').baseline).toBeCloseTo(BODY_TOP + (4 + SIGNATURE_LINES) * LINE_PITCH + baseline, 6);
    expect(images(page.items)).toEqual([
      { kind: 'image', x: SIDE_MARGIN, top: BODY_TOP + 4 * LINE_PITCH + SIGNATURE_PADDING, width: SIGNATURE_MAX_WIDTH, height: 45, image: SIGNATURE }
    ]);
    expect(page.linesUsed).toBe(5 + SIGNATURE_LINES);
  });

  it('follows a one-line sign-off, and the last line of a closing that wraps', () => {
    const oneLine = layoutLetter(letter('Thank you.\nLove, Pat', 1));
    expect(images(oneLine.pages[0].items)[0]).toMatchObject({ top: BODY_TOP + 2 * LINE_PITCH + SIGNATURE_PADDING });
    expect(oneLine.pages[0].linesUsed).toBe(2 + SIGNATURE_LINES);

    const closing =
      'With all my love, and my thanks for every letter you have sent me over all these years, and for every one I know you ' +
      'will send me in the years to come, always,';
    const wrapped = layoutLetter(letter(`Thank you.\n${closing}\nPat`, 1));
    const closingLines = texts(wrapped.pages[0].items).filter(run => closing.includes(run.source) && run.source !== '');
    expect(closingLines.length).toBe(2);
    expect(images(wrapped.pages[0].items)[0]).toMatchObject({ top: BODY_TOP + 3 * LINE_PITCH + SIGNATURE_PADDING });
    expect(lineOf(wrapped, 0, 'Pat').baseline).toBeGreaterThan(BODY_TOP + (3 + SIGNATURE_LINES) * LINE_PITCH);
  });

  it('goes after the last paragraph when the closing is named past the text, and after the first when before it', () => {
    const layout = layoutLetter(letter('Thank you.\nLove, Pat', 9));
    expect(images(layout.pages[0].items)[0]).toMatchObject({ top: BODY_TOP + 2 * LINE_PITCH + SIGNATURE_PADDING });
    const before = layoutLetter(letter('Thank you.\nLove, Pat', -1));
    expect(images(before.pages[0].items)[0]).toMatchObject({ top: BODY_TOP + LINE_PITCH + SIGNATURE_PADDING });
  });

  it('is as large as its band allows, never past CSS pixel size', () => {
    const bandHeight = SIGNATURE_LINES * LINE_PITCH - 2 * SIGNATURE_PADDING;
    const box = (image: RenderImage) => {
      const [item] = images(layoutLetter({ text: 'Love,', layoutType: 'text_only', signature: { image, closingParagraph: 0 } }).pages[0].items);
      return { width: item.kind === 'image' ? item.width : 0, height: item.kind === 'image' ? item.height : 0 };
    };
    // Wide: as wide as allowed. Tall: as tall as the band. Small: 0.75pt a pixel.
    expect(box(pngHeader(1200, 300))).toEqual({ width: SIGNATURE_MAX_WIDTH, height: 45 });
    const tall = box(pngHeader(300, 400));
    expect(tall.height).toBeCloseTo(bandHeight, 6);
    expect(tall.width).toBeCloseTo((300 * bandHeight) / 400, 6);
    expect(box(pngHeader(100, 30))).toEqual({ width: 75, height: 22.5 });
  });

  it('counts its band in the page, so a letter that fit may not, and the room left shrinks', () => {
    // 26 lines fill the first page.
    const full = Array.from({ length: 25 }, (_, index) => `Line ${index + 1}`).concat('Love, Pat').join('\n');
    const plain = layoutLetter({ text: full, layoutType: 'text_only' });
    expect(plain.overflowLines).toBe(0);
    expect(plain.pages[0].linesAvailable).toBe(26);
    const signed = layoutLetter(letter(full, 25));
    expect(signed.overflowLines).toBe(SIGNATURE_LINES);

    const short = 'Thank you.\nLove, Pat';
    expect(pageFit(layoutLetter({ text: short, layoutType: 'text_only' })).roomLines - pageFit(layoutLetter(letter(short, 1))).roomLines).toBe(
      SIGNATURE_LINES
    );
  });

  it('starts a new page with its closing rather than be parted from it', () => {
    // The closing on page 1's lines 24, 25 or 26: the band fits after line 23 only.
    const body = (lines: number) => Array.from({ length: lines }, (_, index) => `Line ${index + 1}`);
    for (const closingLine of [24, 25, 26]) {
      const text = body(closingLine - 1).concat('Sincerely,', 'Pat Example').join('\n');
      const layout = layoutLetter(letter(text, closingLine - 1), { maxPages: 2 });
      expect(layout.pages, `closing on line ${closingLine}`).toHaveLength(2);
      expect(layout.pages[0].linesUsed).toBe(closingLine - 1);
      expect(images(layout.pages[0].items)).toEqual([]);
      expect(lineOf(layout, 1, 'Sincerely,').baseline - CONTINUATION_TOP).toBeLessThan(LINE_PITCH);
      expect(images(layout.pages[1].items)[0]).toMatchObject({ top: CONTINUATION_TOP + LINE_PITCH + SIGNATURE_PADDING });
      expect(layout.overflowLines).toBe(0);
    }
    // On line 23, the band fits on page 1, and only the name goes on.
    const fits = layoutLetter(letter(body(22).concat('Sincerely,', 'Pat Example').join('\n'), 22), { maxPages: 2 });
    expect(images(fits.pages[0].items)[0]).toMatchObject({ top: BODY_TOP + 23 * LINE_PITCH + SIGNATURE_PADDING });
    expect(lineOf(fits, 1, 'Pat Example')).toBeDefined();
  });

  it("keeps Handwritten's rules out of its band", () => {
    const layout = layoutLetter(letter('Thank you.\nSincerely,\nPat', 1, { stationery: { theme: 'handwritten' } }));
    const rules = layout.pages[0].items.find(item => item.kind === 'path');
    expect(rules).toBeDefined();
    const ys = [...(rules as { d: string }).d.matchAll(/M[\d.-]+[ ,]([\d.-]+)/g)].map(match => Number(match[1]));
    const [signature] = images(layout.pages[0].items);
    const bandTop = (signature as { top: number }).top - SIGNATURE_PADDING;
    expect(ys.length).toBeGreaterThan(20);
    expect(ys.filter(y => y > bandTop && y < bandTop + SIGNATURE_LINES * LINE_PITCH)).toEqual([]);
    // The line under the band, the name's, is ruled.
    expect(ys.some(y => y > bandTop + SIGNATURE_LINES * LINE_PITCH && y < bandTop + (SIGNATURE_LINES + 1) * LINE_PITCH)).toBe(true);
  });

  it('leaves a letter without one exactly as it was', () => {
    const text = 'Dear Ruth,\n\nThank you.\nSincerely,\nPat Example';
    expect(layoutLetter({ text, layoutType: 'text_only', signature: undefined })).toEqual(layoutLetter({ text, layoutType: 'text_only' }));
    expect(layoutLetter({ text, layoutType: 'text_only' }).pages[0].linesUsed).toBe(5);
  });

  it('prints in the PDF and the preview as the picture it is', async () => {
    // Drawn, then flattened in a second pass: sharp composites last, which would bring alpha back.
    const drawn = await sharp({ create: { width: 600, height: 150, channels: 3, background: '#ffffff' } })
      .composite([{ input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="150"><path d="M20 120 C 150 10, 300 140, 580 40" stroke="#000" stroke-width="8" fill="none"/></svg>') }])
      .png()
      .toBuffer();
    const png = await sharp(drawn).flatten({ background: '#ffffff' }).toColourspace('b-w').png().toBuffer();
    const image = readImage(png);
    const layout = layoutLetter({ text: 'Thank you.\nLove, Pat', layoutType: 'text_only', signature: { image, closingParagraph: 1 } });
    const pdf = (await renderPdf(layout)).toString('latin1');
    expect(pdf.match(/\/Subtype \/Image/g)?.length).toBe(1);
    expect(pdf).toContain('/DeviceGray');
    const [svg] = renderPreviewSvg(layout);
    expect(svg).toContain(`data:image/png;base64,${png.toString('base64')}`);
    expect(BODY_BOTTOM).toBeGreaterThan(BODY_TOP);
  });
});
