/**
 * A signature's picture, cleaned for print (#608): dark ink on white, cropped
 * to the ink, upright, and no larger than 1200 x 400; a picture with no
 * signature in it refused in words the person can act on. Synthetic pictures
 * drawn with sharp stand in for photographs.
 */

import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  cleanSignatureImage,
  closing,
  rankFilter,
  SignatureImageError,
  SIGNATURE_MAX_SIZE
} from '../../../src/services/signatureImage.js';
import { ImageProcessingError } from '../../../src/services/imageService.js';

/** A scribble across x 120..900 and y 120..330 of a 1000 x 400 sheet, like a signature. */
const STROKE =
  'M 120 260 C 180 120, 240 120, 260 240 S 330 330, 380 200 C 420 110, 470 140, 470 230 C 470 300, 540 300, 600 180 C 640 100, 690 170, 700 240 L 900 210';

function sheet(
  width: number,
  height: number,
  options: { ink?: string; paper?: string; shadow?: boolean; path?: string; strokeWidth?: number } = {}
): Buffer {
  const { ink = '#1b2a6b', paper, shadow = false, path = STROKE, strokeWidth = 7 } = options;
  const background = paper ? `<rect width="100%" height="100%" fill="${paper}"/>` : '';
  const shade = shadow
    ? '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/>' +
      '<stop offset="1" stop-color="#000" stop-opacity="0.45"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/>'
    : '';
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${background}` +
      `<path d="${path}" fill="none" stroke="${ink}" stroke-width="${strokeWidth}" stroke-linecap="round"/>${shade}</svg>`
  );
}

const jpeg = (svg: Buffer) => sharp(svg).jpeg({ quality: 80 }).toBuffer();

/** The cleaned picture's pixels, one grey level each, and how many channels the file has. */
async function pixels(png: Buffer) {
  const { channels } = await sharp(png).metadata();
  const { data, info } = await sharp(png).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
  return { data, info: { ...info, channels } };
}

/** The darkest grey level. */
const darkest = (data: Buffer) => data.reduce((least, level) => Math.min(least, level), 255);

/** Of the ink (darker than 160), the share that is solid black (under 16): a stroke is black, its edges grey. */
function solidInk(data: Buffer): number {
  let ink = 0;
  let black = 0;
  for (const level of data) {
    if (level < 160) ink += 1;
    if (level < 16) black += 1;
  }
  return black / ink;
}

/** The mean grey level of a box of the cleaned picture. */
function mean(data: Buffer, width: number, box: { left: number; top: number; width: number; height: number }) {
  let sum = 0;
  for (let y = box.top; y < box.top + box.height; y += 1) {
    for (let x = box.left; x < box.left + box.width; x += 1) sum += data[y * width + x];
  }
  return sum / (box.width * box.height);
}

async function refusal(input: Buffer): Promise<unknown> {
  return cleanSignatureImage(input).then(
    () => undefined,
    (error: unknown) => error
  );
}

describe('cleanSignatureImage', () => {
  it('turns grey paper white, keeps the ink dark, and crops to the ink, as a one-channel PNG', async () => {
    const cleaned = await cleanSignatureImage(await jpeg(sheet(1000, 400, { paper: '#d9d4c8' })));
    // The stroke spans about 780 x 210 px, and a margin of 2% of the short side goes around it.
    expect(cleaned.width).toBeGreaterThan(780);
    expect(cleaned.width).toBeLessThan(820);
    expect(cleaned.height).toBeGreaterThan(195);
    expect(cleaned.height).toBeLessThan(240);
    expect(cleaned.png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    const { data, info } = await pixels(cleaned.png);
    expect(info.channels).toBe(1);
    expect([info.width, info.height]).toEqual([cleaned.width, cleaned.height]);
    expect(darkest(data)).toBeLessThan(40);
    expect(solidInk(data)).toBeGreaterThan(0.5);
    // Every corner is white paper.
    for (const left of [0, info.width - 10]) {
      for (const top of [0, info.height - 10]) {
        expect(mean(data, info.width, { left, top, width: 10, height: 10 })).toBeGreaterThan(250);
      }
    }
  });

  it('lifts a shadow across the paper to white', async () => {
    const cleaned = await cleanSignatureImage(await jpeg(sheet(1000, 400, { ink: '#222222', paper: '#e8e4dc', shadow: true })));
    // Cropped to the ink, not to the shadow.
    expect(cleaned.width).toBeLessThan(820);
    expect(cleaned.height).toBeLessThan(240);
    const { data, info } = await pixels(cleaned.png);
    // The darkest corner of the photograph, under the ink's end, is white.
    expect(mean(data, info.width, { left: info.width - 40, top: info.height - 30, width: 40, height: 30 })).toBeGreaterThan(245);
  });

  it('puts a transparent PNG on white', async () => {
    const transparent = await sharp(sheet(1000, 400, { ink: '#000000' })).png().toBuffer();
    const cleaned = await cleanSignatureImage(transparent);
    const { data, info } = await pixels(cleaned.png);
    expect(mean(data, info.width, { left: 0, top: 0, width: 10, height: 10 })).toBeGreaterThan(250);
    expect(darkest(data)).toBeLessThan(40);
    expect(solidInk(data)).toBeGreaterThan(0.5);
  });

  it('turns a photograph upright by its EXIF orientation', async () => {
    // Stored on its side, with orientation 8 saying to turn it back.
    const sideways = await sharp(await sharp(sheet(1000, 400, { paper: '#dcd8d0' })).rotate(90).jpeg().toBuffer())
      .withMetadata({ orientation: 8 })
      .jpeg()
      .toBuffer();
    const cleaned = await cleanSignatureImage(sideways);
    expect(cleaned.width).toBeGreaterThan(cleaned.height * 3);
  });

  it('fits a large signature inside 1200 x 400', async () => {
    const big = await jpeg(
      sheet(3000, 1200, { paper: '#e0dcd4', strokeWidth: 20, path: 'M 200 900 C 700 100, 1300 100, 1500 700 S 2400 1000, 2800 400' })
    );
    const cleaned = await cleanSignatureImage(big);
    expect(cleaned.width).toBeLessThanOrEqual(SIGNATURE_MAX_SIZE.width);
    expect(cleaned.height).toBeLessThanOrEqual(SIGNATURE_MAX_SIZE.height);
    expect(Math.max(cleaned.width / SIGNATURE_MAX_SIZE.width, cleaned.height / SIGNATURE_MAX_SIZE.height)).toBeGreaterThan(0.99);
  });

  it('refuses blank paper, and light ink on dark, as no signature found', async () => {
    const blank = await sharp({ create: { width: 800, height: 300, channels: 3, background: '#e0dcd4' } }).jpeg().toBuffer();
    const lightOnDark = await jpeg(sheet(800, 300, { ink: '#f0f0f0', paper: '#304050' }));
    for (const input of [blank, lightOnDark]) {
      const error = await refusal(input);
      expect(error).toBeInstanceOf(SignatureImageError);
      expect(error).toMatchObject({ code: 'NO_SIGNATURE_FOUND' });
      expect((error as Error).message).toContain('Sign in dark ink');
    }
  });

  it('refuses a photograph, whose detail fills its own box, as not a signature', async () => {
    // Noise from a fixed seed: detail everywhere, as a photograph has.
    let seed = 7;
    const noise = Buffer.alloc(600 * 400);
    for (let i = 0; i < noise.length; i += 1) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      noise[i] = seed % 256;
    }
    const photo = await sharp(noise, { raw: { width: 600, height: 400, channels: 1 } }).png().toBuffer();
    expect(await refusal(photo)).toMatchObject({ code: 'NOT_A_SIGNATURE' });
  });

  it('refuses a picture too small to hold a signature, and ink too narrow to print well', async () => {
    const tiny = await jpeg(sheet(140, 60, { paper: '#ffffff', path: 'M 10 30 L 130 30' }));
    expect(await refusal(tiny)).toMatchObject({ code: 'SIGNATURE_TOO_SMALL' });
    // Long enough, but under 50 px on its short side.
    const short = await jpeg(sheet(400, 40, { paper: '#ffffff', path: 'M 10 20 L 390 20' }));
    expect(await refusal(short)).toMatchObject({ code: 'SIGNATURE_TOO_SMALL' });
    // A mark 40 px wide on a sheet big enough.
    const narrow = await jpeg(sheet(300, 150, { ink: '#000000', paper: '#ffffff', strokeWidth: 3, path: 'M 130 55 L 170 95 M 170 55 L 130 95' }));
    expect(await refusal(narrow)).toMatchObject({ code: 'SIGNATURE_TOO_SMALL' });
  });

  it('refuses bytes that are not a PNG, JPEG or WebP before opening them', async () => {
    const gif = Buffer.from('474946383961010001000000002c00000000010001000002', 'hex');
    const error = await refusal(gif);
    expect(error).toBeInstanceOf(ImageProcessingError);
    expect(error).toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
  });

  // #609 review round 1: photographs a flat sheet in even light is not.
  /** A sheet drawn as an SVG, with the scribble placed by `transform`, as a JPEG. */
  const photograph = (width: number, height: number, body: string) =>
    sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${body}</svg>`)).jpeg({ quality: 80 }).toBuffer();
  const scribble = (transform = '', strokeWidth = 7, ink = '#1b2a6b') =>
    `<g transform="${transform}"><path d="${STROKE}" fill="none" stroke="${ink}" stroke-width="${strokeWidth}" stroke-linecap="round"/></g>`;

  it('crops to the signature on a sheet that darkens to one side', async () => {
    const ramp = await photograph(
      1000,
      400,
      '<defs><linearGradient id="g"><stop offset="0" stop-color="#787878"/><stop offset="1" stop-color="#ffffff"/></linearGradient></defs>' +
        '<rect width="100%" height="100%" fill="url(#g)"/>' + scribble()
    );
    const cleaned = await cleanSignatureImage(ramp);
    expect(cleaned.width).toBeLessThan(820);
    expect(cleaned.height).toBeLessThan(240);
    const { data, info } = await pixels(cleaned.png);
    // The darkest end of the sheet, at the left, is white.
    expect(mean(data, info.width, { left: 0, top: info.height - 30, width: 30, height: 30 })).toBeGreaterThan(245);
    expect(solidInk(data)).toBeGreaterThan(0.5);
  });

  it("whitens a hard shadow across the sheet, its edge included", async () => {
    // A phone's shadow under a lamp: 45% darker, with a sharp edge through the signature.
    const shadowed = await photograph(
      1000,
      400,
      '<rect width="100%" height="100%" fill="#f0eee8"/>' + scribble() + '<rect x="560" y="0" width="440" height="400" fill="#000" fill-opacity="0.45"/>'
    );
    const cleaned = await cleanSignatureImage(shadowed);
    expect(cleaned.width).toBeLessThan(820);
    expect(cleaned.height).toBeLessThan(240);
    const { data, info } = await pixels(cleaned.png);
    // The shadow's edge (x 560 of the sheet) crosses the crop's paper below the stroke: white.
    const edge = Math.round(((560 - 120) / 780) * info.width);
    expect(mean(data, info.width, { left: edge - 10, top: info.height - 12, width: 20, height: 10 })).toBeGreaterThan(245);
  });

  it('crops away a desk around the paper', async () => {
    const desk = await photograph(
      1600,
      1200,
      '<rect width="100%" height="100%" fill="#7a5a3c"/><rect x="200" y="250" width="1200" height="700" fill="#f2f0ea"/>' + scribble('translate(350,400)')
    );
    const cleaned = await cleanSignatureImage(desk);
    // The signature, not the sheet: the stroke is about 780 x 210 at this size.
    expect(cleaned.width).toBeLessThan(900);
    expect(cleaned.height).toBeLessThan(260);
  });

  it('finds a small signature on a whole sheet photographed at once', async () => {
    // An A4 sheet's proportions, the signature a third of its width with thin strokes.
    const sheetPhoto = await photograph(1414, 2000, '<rect width="100%" height="100%" fill="#f4f2ee"/>' + scribble('translate(700,1500) scale(0.5)', 5, '#111111'));
    const cleaned = await cleanSignatureImage(sheetPhoto);
    expect(cleaned.width).toBeGreaterThan(300);
    expect(cleaned.width).toBeLessThan(500);
  });

  it('leaves a stray mark out of the crop, and keeps a dot near the signature', async () => {
    const speck = '<circle cx="1560" cy="40" r="6" fill="#111111"/>';
    const withSpeck = await cleanSignatureImage(
      await photograph(1600, 800, '<rect width="100%" height="100%" fill="#f4f2ee"/>' + scribble('translate(300,250)') + speck)
    );
    expect(withSpeck.width).toBeLessThan(840);
    expect(withSpeck.height).toBeLessThan(240);
    // An i's dot about 50 px above the stroke belongs to it (the stroke's top is near y 397).
    const dot = '<circle cx="420" cy="340" r="6" fill="#1b2a6b"/>';
    const withDot = await cleanSignatureImage(
      await photograph(1600, 800, '<rect width="100%" height="100%" fill="#f4f2ee"/>' + scribble('translate(300,250)') + dot)
    );
    expect(withDot.height).toBeGreaterThan(withSpeck.height + 40);
  });

  it("keeps a marker's thick strokes solid and filled", async () => {
    const marker = await photograph(1200, 500, '<rect width="100%" height="100%" fill="#eeeeee"/>' + scribble('', 28, '#000000'));
    const { data } = await pixels((await cleanSignatureImage(marker)).png);
    expect(solidInk(data)).toBeGreaterThan(0.7);
    // Filled, not hollowed to its edges: ink is about a fifth of the crop, as the stroke is.
    expect(data.filter(level => level < 160).length / data.length).toBeGreaterThan(0.15);
  });

  it('leaves a black object beside the sheet out: ink shows only against light paper', async () => {
    // A phone, crushed to black by the camera, 100 px from the signature (#609 review round 2).
    const phone = await photograph(
      1600,
      800,
      '<rect width="100%" height="100%" fill="#f4f2ee"/>' + scribble('translate(300,250)') + '<rect x="1300" y="300" width="200" height="200" fill="#000000"/>'
    );
    const cleaned = await cleanSignatureImage(phone);
    expect(cleaned.width).toBeLessThan(840);
    expect(cleaned.height).toBeLessThan(240);
  });

  it("leaves lined paper's faint rules out of the signature", async () => {
    // Rules at 70% of the paper's light, every 40 px, across the whole sheet.
    const rules = Array.from({ length: 19 }, (_, index) => `<rect x="0" y="${20 + index * 40}" width="1600" height="2" fill="#aaaaaa"/>`).join('');
    const lined = await photograph(1600, 800, '<rect width="100%" height="100%" fill="#f4f2ee"/>' + rules + scribble('translate(300,250)'));
    const cleaned = await cleanSignatureImage(lined);
    expect(cleaned.width).toBeLessThan(840);
    expect(cleaned.height).toBeLessThan(240);
  });

  it('cleans a large photograph in well under the decode gate\'s wait', async () => {
    const large = await photograph(4000, 4000, '<rect width="100%" height="100%" fill="#e8e4dc"/>' + scribble('translate(400,1400) scale(3)'));
    const started = Date.now();
    const cleaned = await cleanSignatureImage(large);
    expect(Date.now() - started).toBeLessThan(10_000);
    // Looked at 1600 px across: the stroke, three times the usual size, is about 940 px of it.
    expect(cleaned.width).toBeGreaterThan(900);
    expect(cleaned.width).toBeLessThanOrEqual(SIGNATURE_MAX_SIZE.width);
    expect(cleaned.height).toBeLessThanOrEqual(SIGNATURE_MAX_SIZE.height);
  });
});

describe('rankFilter and closing', () => {
  /** The same filter, the slow way. */
  function brute(source: Uint8Array, width: number, height: number, size: number, rows: boolean, max: boolean) {
    const out = new Uint8Array(source.length);
    const half = size >> 1;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let best = max ? 0 : 255;
        for (let d = -half; d <= half; d += 1) {
          const nx = rows ? x + d : x;
          const ny = rows ? y : y + d;
          const v = nx < 0 || ny < 0 || nx >= width || ny >= height ? (max ? 0 : 255) : source[ny * width + nx];
          best = max ? Math.max(best, v) : Math.min(best, v);
        }
        out[y * width + x] = best;
      }
    }
    return out;
  }

  it('takes the maximum or minimum over the window, as the slow way does, at every size', () => {
    let seed = 11;
    const [width, height] = [37, 23];
    const source = new Uint8Array(width * height).map(() => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % 256;
    });
    for (const size of [1, 3, 5, 9, 15, 41]) {
      for (const rows of [true, false]) {
        for (const max of [true, false]) {
          expect(
            Array.from(rankFilter(source, width, height, size, rows ? 'rows' : 'columns', max ? 'max' : 'min')),
            `${size} ${rows ? 'rows' : 'columns'} ${max ? 'max' : 'min'}`
          ).toEqual(Array.from(brute(source, width, height, size, rows, max)));
        }
      }
    }
  });

  it('closes a stroke narrower than the window into its paper, and keeps a dark area wider than it', () => {
    const [width, height] = [60, 60];
    const image = new Uint8Array(width * height).fill(220);
    // A stroke 3 px wide, and a dark square 30 px across.
    for (let y = 5; y < 55; y += 1) for (let x = 10; x < 13; x += 1) image[y * width + x] = 30;
    for (let y = 20; y < 50; y += 1) for (let x = 25; x < 55; x += 1) image[y * width + x] = 90;
    const paper = closing(image, width, height, 9);
    expect(paper[30 * width + 11]).toBe(220);
    expect(paper[35 * width + 40]).toBe(90);
    // Its edge stays where it was.
    expect(paper[35 * width + 24]).toBe(220);
    expect(paper[35 * width + 25]).toBe(90);
  });
});
