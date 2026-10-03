/**
 * A signature's picture, cleaned for print (#608): dark ink on white, cropped
 * to the ink, upright, and no larger than 1200 x 400; a picture with no
 * signature in it refused in words the person can act on. Synthetic pictures
 * drawn with sharp stand in for photographs.
 */

import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { cleanSignatureImage, SignatureImageError, SIGNATURE_MAX_SIZE } from '../../../src/services/signatureImage.js';
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
    const short = await jpeg(sheet(140, 49, { paper: '#ffffff', path: 'M 10 25 L 130 25' }));
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
});
