/**
 * A postcard's front in each layout (#594), after Demo 3's postcard maker:
 * the photo across the whole front (full_bleed, every postcard's front before
 * the layouts), in a white border with its caption below (border), or under
 * "Greetings from" a place (greetings), at each of PostGrid's sizes.
 * POSTCARD_FRONT in geometry.ts holds the proportions.
 */

import { deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { layoutPostcard, PostcardFrontOverflow, renderPdf, renderPreviewSvg } from '../../../src/render/index.js';
import { loadFont } from '../../../src/render/fonts.js';
import { shape } from '../../../src/render/glyphs.js';
import { POSTCARD_BLEED, POSTCARD_FRONT, POSTCARD_GEOMETRY } from '../../../src/render/geometry.js';
import { readImage, type RenderImage } from '../../../src/render/images.js';
import type { ImageBox, TextRun } from '../../../src/render/layout.js';

/** imageService's crop for each size, at 300 dpi. */
const CROPS = { '6x4': [1800, 1200], '6x9': [2700, 1800], '6x11': [3300, 1800] } as const;
const SIZES = ['6x4', '6x9', '6x11'] as const;
const photo = (size: (typeof SIZES)[number]): RenderImage => ({ bytes: Buffer.alloc(0), mime: 'image/jpeg', width: CROPS[size][0], height: CROPS[size][1] });

function front(content: Partial<Parameters<typeof layoutPostcard>[0]> & { size?: (typeof SIZES)[number] } = {}) {
  const size = content.size ?? '6x9';
  return layoutPostcard({ message: 'Dear Sam,', image: photo(size), ...content }).pages[0];
}
const texts = (items: ReturnType<typeof front>['items']) => items.filter((item): item is TextRun => item.kind === 'text');
const widthOf = (run: TextRun) => {
  const face = loadFont(run.font);
  return shape(face, run.text).advanceWidth * (run.size / face.unitsPerEm);
};
const trimOf = (size: (typeof SIZES)[number]) => {
  const page = POSTCARD_GEOMETRY[size];
  return { x: POSTCARD_BLEED, top: POSTCARD_BLEED, width: page.width - 2 * POSTCARD_BLEED, height: page.height - 2 * POSTCARD_BLEED, page };
};

describe('the full-bleed front (#594)', () => {
  it.each(SIZES)('is the front every %s had before the layouts: the photo alone, covering the page', size => {
    const named = front({ size, layout: 'full_bleed' });
    expect(named).toEqual(front({ size }));
    expect(named.items).toHaveLength(1);
    const [image] = named.items as ImageBox[];
    expect(image.clip).toBeUndefined();
    const { page } = trimOf(size);
    expect(Math.min(image.width - page.width, image.height - page.height)).toBeCloseTo(0, 6);
    expect(image.x + image.width / 2).toBeCloseTo(page.width / 2, 9);
    expect(image.top + image.height / 2).toBeCloseTo(page.height / 2, 9);
  });

  it('draws no caption or place it was given', () => {
    expect(front({ layout: 'full_bleed', caption: 'Cape Cod', place: 'Asheville' })).toEqual(front());
  });
});

describe('the bordered front (#594)', () => {
  it.each(SIZES)('cuts the %s photo to a box inside a white border, the caption strip below it', size => {
    const { items } = front({ size, layout: 'border' });
    const trim = trimOf(size);
    const margin = 0.04 * trim.width;
    const strip = 0.18 * trim.height;
    const box = { x: trim.x + margin, top: trim.top + margin, width: trim.width - 2 * margin, height: trim.height - margin - 0.02 * trim.height - strip };
    expect(items).toHaveLength(1);
    const image = items[0] as ImageBox;
    expect(image.clip).toEqual(box);
    // Covering the box exactly, centred, never squeezed.
    expect(Math.min(image.width - box.width, image.height - box.height)).toBeCloseTo(0, 6);
    expect(image.x + image.width / 2).toBeCloseTo(box.x + box.width / 2, 9);
    expect(image.top + image.height / 2).toBeCloseTo(box.top + box.height / 2, 9);
    expect(image.width / image.height).toBeCloseTo(CROPS[size][0] / CROPS[size][1], 9);
    // The border is as wide on the top and sides.
    expect(box.x - trim.x).toBeCloseTo(trim.x + trim.width - (box.x + box.width), 9);
    expect(box.top - trim.top).toBeCloseTo(box.x - trim.x, 9);
  });

  it.each(SIZES)("writes the %s caption in near-black Caveat, centred in its strip, on one line", size => {
    const { items } = front({ size, layout: 'border', caption: '  Cape Cod,\n August  2026 ' });
    const trim = trimOf(size);
    const strip = 0.18 * trim.height;
    const [caption] = texts(items);
    expect(texts(items)).toHaveLength(1);
    expect(caption).toMatchObject({ font: 'Caveat-Regular', size: 0.44 * strip, fill: '#1E1A16', text: 'Cape Cod, August 2026', source: 'Cape Cod, August 2026' });
    expect(caption.x + widthOf(caption) / 2).toBeCloseTo(trim.x + trim.width / 2, 6);
    // Its baseline inside the strip, below the photo.
    const stripTop = trim.top + trim.height - strip;
    expect(caption.baseline).toBeGreaterThan(stripTop);
    expect(caption.baseline).toBeLessThan(stripTop + strip);
    expect(caption.baseline).toBeGreaterThan((items[0] as ImageBox).clip!.top + (items[0] as ImageBox).clip!.height);
    // Centred in the strip as a line box is: Caveat's ascent and descent
    // around its baseline, halfway down the strip.
    const face = loadFont('Caveat-Regular');
    const scale = caption.size / face.unitsPerEm;
    expect((caption.baseline - face.ascent * scale + caption.baseline - face.descent * scale) / 2).toBeCloseTo(stripTop + strip / 2, 6);
  });

  it('draws no caption when there is none, or only white space', () => {
    for (const caption of [undefined, '', ' \n\t ']) expect(texts(front({ layout: 'border', caption }).items), String(caption)).toEqual([]);
  });

  it.each(SIZES)('refuses a %s caption just wider than the photo, though narrower than the trim, saying by how much', size => {
    const trim = trimOf(size);
    const photoWidth = trim.width - 2 * 0.04 * trim.width;
    const size_ = 0.44 * 0.18 * trim.height;
    const face = loadFont('Caveat-Regular');
    const width = (text: string) => shape(face, text).advanceWidth * (size_ / face.unitsPerEm);
    // The shortest run of x's wider than the photo: one x more than fits.
    let count = 1;
    while (width('x'.repeat(count)) <= photoWidth) count += 1;
    expect(width('x'.repeat(count))).toBeLessThan(trim.width);
    expect(() => front({ size, layout: 'border', caption: 'x'.repeat(count - 1) })).not.toThrow();
    const thrown = (() => {
      try {
        front({ size, layout: 'border', caption: 'x'.repeat(count) });
      } catch (error) {
        return error;
      }
    })() as PostcardFrontOverflow;
    expect(thrown).toBeInstanceOf(PostcardFrontOverflow);
    expect(thrown.part).toBe('caption');
    expect(thrown.overflow).toBeCloseTo(width('x'.repeat(count)) - photoWidth, 6);
    expect(thrown.message).toBe(`The caption runs ${(thrown.overflow / 72).toFixed(2)}in past its room on the front.`);
  });
});

describe('the greetings front (#594)', () => {
  it.each(SIZES)('covers the %s page with the photo, "Greetings from" over it in white Caveat', size => {
    const { items } = front({ size, layout: 'greetings', place: 'Asheville' });
    const trim = trimOf(size);
    const image = items[0] as ImageBox;
    expect(image.clip).toBeUndefined();
    expect(Math.min(image.width - trim.page.width, image.height - trim.page.height)).toBeCloseTo(0, 6);
    const [lead] = texts(items);
    expect(lead).toMatchObject({ font: 'Caveat-Regular', size: 0.0885 * trim.height, fill: '#FFFFFF', text: 'Greetings from' });
    expect(lead.baseline).toBeCloseTo(trim.top + 0.27 * trim.height, 9);
    expect(lead.x + widthOf(lead) / 2).toBeCloseTo(trim.page.width / 2, 6);
  });

  it.each(SIZES)('letters the %s place in capitals, pale gold over its rust shadow, centred halfway down', size => {
    const { items } = front({ size, layout: 'greetings', place: 'Asheville' });
    const trim = trimOf(size);
    const [, shadow, place] = texts(items);
    expect(texts(items)).toHaveLength(3);
    expect(place).toMatchObject({ font: 'Tinos-Regular', text: 'ASHEVILLE', source: 'Asheville', fill: '#F6E3A1' });
    expect(place.baseline).toBeCloseTo(trim.top + 0.5 * trim.height, 9);
    expect(place.x + widthOf(place) / 2).toBeCloseTo(trim.page.width / 2, 6);
    // The shadow: the same lettering, unspoken, offset down and right.
    const offset = 0.0104 * trim.height;
    expect(shadow).toMatchObject({ font: place.font, size: place.size, text: place.text, source: '', fill: '#A8461F' });
    expect(shadow.x - place.x).toBeCloseTo(offset, 9);
    expect(shadow.baseline - place.baseline).toBeCloseTo(offset, 9);
    // As large as it may be, and no wider than 88% of the trim.
    expect(place.size).toBeLessThanOrEqual(0.21 * trim.height + 1e-9);
    expect(widthOf(place)).toBeLessThanOrEqual(0.88 * trim.width + 1e-6);
    expect(place.size === 0.21 * trim.height || Math.abs(widthOf(place) - 0.88 * trim.width) < 1e-6).toBe(true);
  });

  it('draws a short place at its largest, and shrinks a long one to the width', () => {
    const trim = trimOf('6x9');
    const short = texts(front({ layout: 'greetings', place: 'Rye' }).items)[2];
    expect(short.size).toBeCloseTo(0.21 * trim.height, 9);
    const long = texts(front({ layout: 'greetings', place: 'Massachusetts' }).items)[2];
    expect(long.size).toBeLessThan(0.21 * trim.height);
    expect(widthOf(long)).toBeCloseTo(0.88 * trim.width, 6);
  });

  it('draws only "Greetings from" when there is no place', () => {
    expect(texts(front({ layout: 'greetings' }).items).map(run => run.text)).toEqual(['Greetings from']);
  });

  it.each(SIZES)('refuses a %s place that would have to shrink below 7% of the height, saying by how much', size => {
    const trim = trimOf(size);
    const largest = 0.21 * trim.height;
    const smallest = 0.07 * trim.height;
    const room = 0.88 * trim.width;
    const face = loadFont('Tinos-Regular');
    const widthAt = (text: string, at: number) => shape(face, text).advanceWidth * (at / face.unitsPerEm);
    // The shortest run of W's that would have to be drawn smaller than 7%: one more than may.
    let count = 1;
    while ((largest * room) / widthAt('W'.repeat(count), largest) >= smallest) count += 1;
    const fits = texts(front({ size, layout: 'greetings', place: 'W'.repeat(count - 1) }).items)[2];
    expect(fits.size).toBeGreaterThanOrEqual(smallest);
    const thrown = (() => {
      try {
        front({ size, layout: 'greetings', place: 'W'.repeat(count) });
      } catch (error) {
        return error;
      }
    })() as PostcardFrontOverflow;
    expect(thrown).toBeInstanceOf(PostcardFrontOverflow);
    expect(thrown.part).toBe('place');
    // How much wider than its room the place is at the smallest size.
    expect(thrown.overflow).toBeCloseTo(widthAt('W'.repeat(count), smallest) - room, 6);
  });
});

describe('the fronts as they print and preview (#594)', () => {
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
  const image = readImage(png(300, 200));
  const streams = (pdf: Buffer) => [...pdf.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)].map(match => {
    try {
      return inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1');
    } catch {
      return '';
    }
  });

  it("cuts a bordered photo to its box in the PDF, and colours the front's lettering", async () => {
    const borderedLayout = layoutPostcard({ message: 'Hi', image, layout: 'border', caption: 'Cape Cod' });
    const bordered = streams(await renderPdf(borderedLayout));
    // The photo is drawn inside a clip of exactly its box (pdfkit writes
    // numbers to six places), and the clip is closed (the second Q) before
    // anything else on the front is drawn.
    const { clip } = borderedLayout.pages[0].items[0] as ImageBox;
    const number = (value: number) => String(Math.round(value * 1e6) / 1e6).replace('.', '\\.');
    const clipped = new RegExp(
      `^1 0 0 -1 0 ${number(borderedLayout.height)} cm\\nq\\n${number(clip!.x)} ${number(clip!.top)} ${number(clip!.width)} ${number(clip!.height)} re\\n` +
      'W n\\nq\\n[^\\n]+ cm\\n\\/I\\d+ Do\\nQ\\nQ\\n'
    );
    const frontStream = bordered.find(stream => / re\n/.test(stream))!;
    expect(frontStream).toMatch(clipped);
    // The caption in #1E1A16 (0.1176, 0.1019, 0.0862), after the clip is closed.
    const caption = frontStream.search(/0\.1176\d* 0\.1019\d* 0\.0862\d* scn/);
    expect(caption).toBeGreaterThan(frontStream.indexOf('Do\nQ\nQ\n'));

    const greeting = streams(await renderPdf(layoutPostcard({ message: 'Hi', image, layout: 'greetings', place: 'Asheville' }))).join('\n');
    expect(greeting).toMatch(/1 1 1 scn/);
    expect(greeting).toMatch(/0\.9647\d* 0\.8901\d* 0\.6313\d* scn/);
    expect(greeting).toMatch(/0\.6588\d* 0\.2745\d* 0\.1215\d* scn/);
    // The full-bleed front cuts nothing, and paints its back's words black, as before.
    const plain = streams(await renderPdf(layoutPostcard({ message: 'Hi', image }))).join('\n');
    expect(plain).not.toMatch(/W n/);
    expect(plain).toMatch(/0 0 0 scn/);
  });

  it('previews a bordered photo in a viewport of its own, and the lettering in its colours', () => {
    const borderedLayout = layoutPostcard({ message: 'Hi', image, layout: 'border', caption: 'Cape Cod' });
    const [bordered] = renderPreviewSvg(borderedLayout);
    const trim = trimOf('6x9');
    const margin = 0.04 * trim.width;
    const round = (value: number) => Math.round(value * 100) / 100;
    expect(bordered).toContain(`<svg x="${round(trim.x + margin)}" y="${round(trim.top + margin)}" `);
    // The image placed in the viewport's own coordinates, from its corner.
    const box = borderedLayout.pages[0].items[0] as ImageBox;
    expect(bordered).toContain(
      `width="${round(box.clip!.width)}" height="${round(box.clip!.height)}"><image href="data:image/png;base64,`
    );
    expect(bordered).toContain(
      `" x="${round(box.x - box.clip!.x)}" y="${round(box.top - box.clip!.top)}" width="${round(box.width)}" height="${round(box.height)}" preserveAspectRatio="none"/></svg>`
    );
    expect(bordered).toMatch(/<svg x="[\d.]+" y="[\d.]+" width="[\d.]+" height="[\d.]+"><image href="data:image\/png;base64,[^"]+" x="-?[\d.]+" y="-?[\d.]+" width="[\d.]+" height="[\d.]+" preserveAspectRatio="none"\/><\/svg>/);
    expect(bordered).toMatch(/<g fill="#1E1A16">(<use [^>]+\/>)+<\/g>/);
    expect(bordered).toContain('<title>Cape Cod</title>');

    const [greeting] = renderPreviewSvg(layoutPostcard({ message: 'Hi', image, layout: 'greetings', place: 'Asheville' }));
    expect(greeting).toMatch(/<g fill="#FFFFFF">(<use [^>]+\/>)+<\/g><g fill="#A8461F">(<use [^>]+\/>)+<\/g><g fill="#F6E3A1">(<use [^>]+\/>)+<\/g>/);
    // Spoken as written, the shadow not at all.
    expect(greeting).toContain('<title>Greetings from\nAsheville</title>');

    // The full-bleed front, as before: no viewport, no group, titled as a front.
    const [plain] = renderPreviewSvg(layoutPostcard({ message: 'Hi', image }));
    expect(plain).not.toContain('<svg x=');
    expect(plain).not.toContain('<g fill=');
    expect(plain).toContain('<title>The front of the postcard</title>');
  });

  it('places every front on its page: a bordered or greetings front is still two pages with its back', () => {
    for (const layout of ['border', 'greetings'] as const) {
      for (const size of SIZES) {
        const drawn = layoutPostcard({ message: 'Dear Sam,', image: photo(size), size, layout, caption: 'Cape Cod', place: 'Rye' });
        expect([drawn.width, drawn.height], `${layout} ${size}`).toEqual([POSTCARD_GEOMETRY[size].width, POSTCARD_GEOMETRY[size].height]);
        expect(drawn.pages, `${layout} ${size}`).toHaveLength(2);
        expect(drawn.pages[1]).toEqual(layoutPostcard({ message: 'Dear Sam,', image: photo(size), size }).pages[1]);
      }
    }
  });

  it('keeps POSTCARD_FRONT as Demo 3 drew it', () => {
    expect(POSTCARD_FRONT).toEqual({
      border: { margin: 0.04, gap: 0.02, strip: 0.18, captionSize: 0.44, captionColor: '#1E1A16' },
      greetings: {
        leadSize: 0.0885, leadBaseline: 0.27, leadColor: '#FFFFFF', placeMaxSize: 0.21, placeMinSize: 0.07,
        placeBaseline: 0.5, placeWidth: 0.88, placeColor: '#F6E3A1', shadowColor: '#A8461F', shadowOffset: 0.0104
      }
    });
  });
});
