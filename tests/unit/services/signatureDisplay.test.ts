/**
 * The small copy of the signature a letter's preview draws (#614): no wider
 * than twice the band's widest CSS width, in grey, as a PNG; the box, and so
 * the page, unchanged; the letter's own picture and the print left alone.
 */

import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { readImage, type RenderImage } from '../../../src/render/images.js';
import type { Layout } from '../../../src/render/layout.js';
import { SIGNATURE_DISPLAY_WIDTH, signatureDisplayCopy, withDisplaySignature } from '../../../src/services/signatureDisplay.js';

/** A signature as the cleaner stores one: ink strokes on white, in grey, as a PNG. */
async function signature(width: number, height: number): Promise<RenderImage> {
  const strokes = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#fff"/>` +
      `<path d="M10 ${height * 0.7} C ${width * 0.3} 0, ${width * 0.6} ${height}, ${width - 10} ${height * 0.3}" stroke="#000" stroke-width="6" fill="none"/></svg>`
  );
  return readImage(await sharp(strokes).grayscale().png().toBuffer());
}

function layoutWith(items: Layout['pages'][number]['items']): Layout {
  return { width: 612, height: 792, pages: [{ items }] } as unknown as Layout;
}

describe('the signature the preview draws (#614)', () => {
  it('is twice the band\'s widest CSS width across, in grey, as a PNG, and smaller than the stored copy', async () => {
    const stored = await signature(1200, 400);
    const small = await signatureDisplayCopy(stored);
    expect(SIGNATURE_DISPLAY_WIDTH).toBe(480);
    expect(small.mime).toBe('image/png');
    expect([small.width, small.height]).toEqual([480, 160]);
    expect(small.bytes.length).toBeLessThan(stored.bytes.length);
    const meta = await sharp(small.bytes).metadata();
    expect(meta.channels).toBe(1);
  });

  it('keeps a signature no wider than that as it is stored', async () => {
    for (const width of [480, 300]) {
      const stored = await signature(width, 120);
      expect(await signatureDisplayCopy(stored)).toBe(stored);
    }
  });

  it('draws the small copy in the signature\'s own box, and leaves the letter\'s picture and the rest alone', async () => {
    const stored = await signature(1200, 400);
    const picture = await signature(900, 600);
    const signed = { kind: 'image', x: 72, top: 600, width: 180, height: 60, image: stored, role: 'signature' } as const;
    const photo = { kind: 'image', x: 72, top: 100, width: 300, height: 200, image: picture } as const;
    const text = { kind: 'text', font: 'classic', size: 12, x: 72, baseline: 400, text: 'Dear Sam,', source: 'Dear Sam,' } as const;
    const layout = layoutWith([photo, text, signed] as never);

    const shown = await withDisplaySignature(layout);

    const items = shown.pages[0].items as unknown as Array<Record<string, unknown>>;
    expect(items[0]).toBe(photo);
    expect(items[1]).toBe(text);
    expect(items[2]).toMatchObject({ x: 72, top: 600, width: 180, height: 60, role: 'signature' });
    expect((items[2].image as RenderImage).width).toBe(480);
    // The layout it was made from, the print's, is not changed.
    expect(layout.pages[0].items[2]).toBe(signed);
    expect(signed.image).toBe(stored);
  });

  it('returns a layout without a signature, or with a narrow one, as it is', async () => {
    const plain = layoutWith([{ kind: 'image', x: 72, top: 100, width: 300, height: 200, image: await signature(900, 600) }] as never);
    expect(await withDisplaySignature(plain)).toBe(plain);
    const narrow = layoutWith([{ kind: 'image', x: 72, top: 600, width: 180, height: 60, image: await signature(400, 120), role: 'signature' }] as never);
    expect(await withDisplaySignature(narrow)).toBe(narrow);
  });

  it('draws the stored copy when the small one cannot be made', async () => {
    const broken: RenderImage = { bytes: Buffer.from('not an image'), mime: 'image/png', width: 1200, height: 400 };
    const layout = layoutWith([{ kind: 'image', x: 72, top: 600, width: 180, height: 60, image: broken, role: 'signature' }] as never);
    expect(await withDisplaySignature(layout)).toBe(layout);
  });
});
