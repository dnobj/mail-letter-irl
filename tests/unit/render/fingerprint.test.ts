import { describe, expect, it } from 'vitest';

import {
  fingerprintScheme,
  isLayoutFingerprint,
  LAYOUT_FINGERPRINT_SCHEME,
  layoutFingerprint,
  layoutGiftPage,
  layoutLetter,
  PDF_CREATION_DATE,
  readImageDataUri,
  renderPdf,
  RENDERER_VERSION,
  type Layout
} from '../../../src/render/index.js';
import { giftLetterPageCopy } from '../../../src/services/giftCardRenderer.js';

/**
 * The fingerprint of what a print draws (#697): the same layout gives the
 * same fingerprint however its fields are ordered and whatever a position's
 * last bits; a moved line, page or picture gives another. And the PDF of one
 * layout is the same bytes every time, so a stored PDF can be checked by its
 * hash.
 */

const letter = (text: string) => layoutLetter({ text, layoutType: 'text_only' });

/** The same layout with every object's keys in reverse order. */
function reordered(value: unknown): unknown {
  if (Buffer.isBuffer(value) || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(reordered);
  return Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reordered((value as Record<string, unknown>)[key])]));
}

describe('layoutFingerprint (#697)', () => {
  it('is the scheme and a SHA-256, and the same for the same layout', () => {
    const fingerprint = layoutFingerprint(letter('Hello Sam'), RENDERER_VERSION);
    expect(fingerprint).toMatch(/^fp1:[0-9a-f]{64}$/);
    expect(isLayoutFingerprint(fingerprint)).toBe(true);
    expect(fingerprintScheme(fingerprint)).toBe(LAYOUT_FINGERPRINT_SCHEME);
    expect(layoutFingerprint(letter('Hello Sam'), RENDERER_VERSION)).toBe(fingerprint);
  });

  it('does not depend on the order of fields, or on a position past a thousandth of a point', () => {
    const layout = letter('Hello Sam,\nSee you soon.');
    const fingerprint = layoutFingerprint(layout, RENDERER_VERSION);
    expect(layoutFingerprint(reordered(layout) as Layout, RENDERER_VERSION)).toBe(fingerprint);
    const nudged = structuredClone(layout);
    const run = nudged.pages[0].items.find((item) => item.kind === 'text')!;
    (run as { x: number }).x += 0.0001;
    expect(layoutFingerprint(nudged, RENDERER_VERSION)).toBe(fingerprint);
  });

  it('changes with a line, a position, a page, a picture or the renderer version', () => {
    const base = letter('Hello Sam,\nSee you soon.');
    const fingerprint = layoutFingerprint(base, RENDERER_VERSION);
    expect(layoutFingerprint(letter('Hello Sam, see you soon.'), RENDERER_VERSION)).not.toBe(fingerprint);

    const moved = structuredClone(base);
    const run = moved.pages[0].items.find((item) => item.kind === 'text')!;
    (run as { baseline: number }).baseline += 0.01;
    expect(layoutFingerprint(moved, RENDERER_VERSION)).not.toBe(fingerprint);

    const longer = structuredClone(base);
    longer.pages.push(structuredClone(base.pages[0]));
    expect(layoutFingerprint(longer, RENDERER_VERSION)).not.toBe(fingerprint);

    expect(layoutFingerprint(base, 'pdf-2')).not.toBe(fingerprint);
    expect(layoutFingerprint({ ...base, width: base.width + 1 }, RENDERER_VERSION)).not.toBe(fingerprint);
    expect(layoutFingerprint({ ...base, height: base.height + 1 }, RENDERER_VERSION)).not.toBe(fingerprint);

    const picture = (bytes: Buffer): Layout => ({
      ...structuredClone(base),
      pages: [{ ...base.pages[0], items: [{ kind: 'image', x: 0, top: 0, width: 10, height: 10, image: { bytes, mime: 'image/png', width: 1, height: 1 } }] }]
    });
    expect(layoutFingerprint(picture(Buffer.from([1, 2, 3])), RENDERER_VERSION)).not.toBe(
      layoutFingerprint(picture(Buffer.from([1, 2, 4])), RENDERER_VERSION)
    );
  });

  it('counts a picture by its bytes, whatever kind of byte array holds them', () => {
    const base = letter('Hello Sam');
    const picture = (bytes: Uint8Array): Layout => ({
      ...structuredClone(base),
      pages: [{ ...base.pages[0], items: [{ kind: 'image', x: 0, top: 0, width: 10, height: 10, image: { bytes: bytes as Buffer, mime: 'image/png', width: 1, height: 1 } }] }]
    });
    const fromBuffer = layoutFingerprint(picture(Buffer.from([1, 2, 3])), RENDERER_VERSION);
    expect(layoutFingerprint(picture(new Uint8Array([1, 2, 3])), RENDERER_VERSION)).toBe(fromBuffer);
    expect(layoutFingerprint(picture(new Uint8Array([1, 2, 4])), RENDERER_VERSION)).not.toBe(fromBuffer);
  });

  it('tells a position that is not a number from zero, and from each other', () => {
    const base = letter('Hello Sam');
    const at = (x: number) => {
      const layout = structuredClone(base);
      (layout.pages[0].items.find((item) => item.kind === 'text') as { x: number }).x = x;
      return layoutFingerprint(layout, RENDERER_VERSION);
    };
    const prints = [at(0), at(Number.NaN), at(Number.POSITIVE_INFINITY), at(Number.NEGATIVE_INFINITY)];
    expect(new Set(prints).size).toBe(4);
    expect(at(-0)).toBe(at(0));
  });

  it('names no scheme for a value with no colon', () => {
    expect(fingerprintScheme('fp1')).toBe('');
    expect(fingerprintScheme('')).toBe('');
    expect(fingerprintScheme(`fp2:${'a'.repeat(64)}`)).toBe('fp2');
  });

  it('knows a fingerprint of any scheme by its shape, and nothing else', () => {
    expect(isLayoutFingerprint(`fp2:${'a'.repeat(64)}`)).toBe(true);
    for (const value of [`fp1:${'a'.repeat(63)}`, `fp0:${'a'.repeat(64)}`, `fp1:${'A'.repeat(64)}`, 'fp1:', '', null, 7]) {
      expect(isLayoutFingerprint(value), String(value)).toBe(false);
    }
  });
});

describe('renderPdf (#697)', () => {
  it('gives the same bytes for the same layout, every time', async () => {
    const layout = letter('Hello Sam,\nSee you soon.');
    const first = await renderPdf(layout, RENDERER_VERSION);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await renderPdf(layout, RENDERER_VERSION);
    expect(second.equals(first)).toBe(true);
  });

  it('gives the same bytes for a letter with a picture and a gift card, every time', async () => {
    const png = readImageDataUri('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==');
    const layout = layoutLetter({ text: 'Hello Sam,\nSee you soon.', layoutType: 'header_image', image: png });
    layout.pages.push(layoutGiftPage(giftLetterPageCopy({
      state: 'funded',
      code: 'K7M2QX9A',
      url: 'https://letterirl.com/g/K7M2QX9A',
      displayUrl: 'letterirl.com/g',
      redeemBy: '2026-12-16'
    }, 'Test Sender')));
    const first = await renderPdf(layout, RENDERER_VERSION);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await renderPdf(layout, RENDERER_VERSION)).equals(first)).toBe(true);
  });

  it('stamps its fixed date, not the time it ran', async () => {
    const pdf = (await renderPdf(letter('Hello'), RENDERER_VERSION)).toString('latin1');
    // pdfkit writes it as its own object: the date's string is in the file, the time it ran is not.
    expect(pdf).toContain('(D:20260101000000Z)');
    expect(PDF_CREATION_DATE.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});
