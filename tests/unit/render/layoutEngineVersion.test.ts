import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { LAYOUT_ENGINE_VERSION, layoutFingerprint, layoutGiftPage, layoutLetter, layoutPostcard } from '../../../src/render/index.js';
import { fontDigests } from '../../../src/render/fingerprint.js';
import { FONT_FILES, type FontName } from '../../../src/render/fonts.js';
import { placeGlyphs } from '../../../src/render/glyphs.js';
import type { RenderImage } from '../../../src/render/images.js';
import type { Layout } from '../../../src/render/layout.js';
import { giftLetterPageCopy, giftPostcardStripCopy } from '../../../src/services/giftCardRenderer.js';

/**
 * Held mail prints as previewed (#697): a letter held for its date records
 * the fingerprint of what the print draws, and the print compares what it
 * lays out now. The layout engine's version is part of that fingerprint, so
 * it must change whenever the engine's output does. This test pins, beside the
 * version and in one assertion:
 * - the golden layouts: the letter matrix in layoutPages.test.ts and the 6x9
 *   postcard backs;
 * - the fingerprints of a wider set below: a letter on three pages, signed
 *   letters, the gift page, every postcard size and front, and a gift strip;
 * - where fontkit places the glyphs of a sample in every font, which no
 *   layout records: a kerning change moves glyphs inside a line whose
 *   position stays the same;
 * - the fonts' bytes, which the fingerprint counts too.
 *
 * When any of it changes, this fails: bump LAYOUT_ENGINE_VERSION in
 * src/render/fingerprint.ts and record the new digest, together. Recording the
 * digest alone would let letters fingerprinted by the old engine print from
 * the new one unremarked.
 */

const FONTS = new URL('../../../assets/fonts/', import.meta.url);

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

const GIFT_CARD = {
  state: 'funded' as const,
  code: 'K7M2QX9A',
  url: 'https://letterirl.com/g/K7M2QX9A',
  displayUrl: 'letterirl.com/g',
  redeemBy: '2026-12-16'
};

const SIGNATURE = pngHeader(1200, 300);
const PHOTO = pngHeader(1600, 1000);
const LONG = Array.from({ length: 45 }, (_, index) => `Paragraph ${index + 1}: the quick brown fox jumps over the lazy dog, again and again.`).join('\n\n');
/** Three pages with room for the signature's band under the closing. */
const SIGNED_LONG = LONG.split('\n\n').slice(0, 40).join('\n\n');
const CROPS ={ '6x4': [1800, 1200], '6x9': [2700, 1800], '6x11': [3300, 1800] } as const;

/** Layouts the golden matrices leave out, by name. */
function widerLayouts(): Record<string, Layout> {
  const layouts: Record<string, Layout> = {
    'letter-three-pages': layoutLetter({ text: LONG, layoutType: 'text_only' }, { maxPages: 3 }),
    'letter-signed': layoutLetter(
      { text: 'Dear Sam,\n\nSee you soon.\n\nWarmly,\nTest', layoutType: 'text_only', signature: { image: SIGNATURE, closingParagraph: 2 } },
      { maxPages: 3 }
    ),
    'letter-signed-botanical-header': layoutLetter(
      {
        text: 'Dear Sam,\n\nSee you soon.\n\nWarmly,\nTest',
        layoutType: 'header_image',
        image: PHOTO,
        stationery: { theme: 'botanical', dateLine: 'October 1, 2026' },
        signature: { image: SIGNATURE, closingParagraph: 2 }
      },
      { maxPages: 3 }
    ),
    'letter-signed-three-pages': layoutLetter(
      { text: `${SIGNED_LONG}\n\nWarmly,\nTest`, layoutType: 'text_only', signature: { image: SIGNATURE, closingParagraph: 40 } },
      { maxPages: 3 }
    ),
    'gift-page': { width: 612, height: 792, pages: [layoutGiftPage(giftLetterPageCopy(GIFT_CARD, 'Test Sender'))] } as Layout
  };
  for (const size of ['6x4', '6x9', '6x11'] as const) {
    const image = pngHeader(CROPS[size][0], CROPS[size][1]);
    layouts[`postcard-${size}-full-bleed`] = layoutPostcard({ message: 'Dear Sam,\nWish you were here.', image, size });
    layouts[`postcard-${size}-border`] = layoutPostcard({ message: 'Dear Sam,', image, size, layout: 'border', caption: 'Cape Cod' });
    layouts[`postcard-${size}-greetings`] = layoutPostcard({ message: 'Dear Sam,', image, size, layout: 'greetings', place: 'Asheville' });
  }
  layouts['postcard-6x9-gift-strip'] = layoutPostcard({
    message: 'Dear Sam,',
    image: pngHeader(2700, 1800),
    strip: giftPostcardStripCopy(GIFT_CARD, 'Test Sender')
  });
  return layouts;
}

/** Where every font's glyphs fall in a sample with kerning pairs and ligatures, to a thousandth. */
function glyphPlacements(): string {
  const sample = 'AVATAR To Wa Ty fi fl ffi — “quoted” 1/2 Ünïcödé';
  return (Object.keys(FONT_FILES) as FontName[])
    .map((font) => {
      const glyphs = placeGlyphs({ kind: 'text', font, size: 12, x: 72, baseline: 100, text: sample } as never);
      return `${font}:${glyphs.map((glyph) => `${glyph.key}@${glyph.x.toFixed(3)},${glyph.y.toFixed(3)}#${createHash('sha256').update(glyph.outline).digest('hex').slice(0, 8)}`).join(' ')}`;
    })
    .join('\n');
}

function goldenDigest(): string {
  const source = readFileSync(new URL('./layoutPages.test.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const recorded = /const RECORDED: Record<string, string> = \{\n([\s\S]*?)\n\};/.exec(source);
  if (!recorded) throw new Error('layoutPages.test.ts no longer records its layouts as RECORDED');
  const entries = [...recorded[1].matchAll(/'([^']+)': '([0-9a-f]{16})'/g)].map((match) => `${match[1]}=${match[2]}`).sort();
  // Every recorded line read, so a reformatted RECORDED cannot drop out of the digest unnoticed.
  const lines = recorded[1].split('\n').filter((line) => line.trim() !== '' && !line.trim().startsWith('//'));
  if (entries.length === 0 || entries.length !== lines.length) {
    throw new Error(`layoutPages.test.ts records ${lines.length} layouts, and ${entries.length} were read`);
  }
  const postcards = readFileSync(new URL('../../fixtures/postcardBacks6x9.497afe2.json', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const wider = Object.entries(widerLayouts())
    .map(([name, layout]) => `${name}=${layoutFingerprint(layout, 'golden')}`)
    .sort();
  return createHash('sha256')
    .update(`${entries.join('\n')}\n--\n${postcards}\n--\n${wider.join('\n')}\n--\n${glyphPlacements()}`)
    .digest('hex')
    .slice(0, 12);
}

/** The SHA-256 of every font file the renderer names, read from disk. */
function fontFileDigests(): Record<string, string> {
  return Object.fromEntries(
    Object.values(FONT_FILES).map((file) => [file, createHash('sha256').update(readFileSync(new URL(file, FONTS))).digest('hex')])
  );
}

describe('the layout engine version (#697)', () => {
  it('changes whenever a golden layout, a glyph placement or a font does', () => {
    expect({ version: LAYOUT_ENGINE_VERSION, digest: goldenDigest(), fonts: fontFileDigests() }).toEqual({
      version: 'layout-1',
      digest: 'a01c2468d39f',
      fonts: {
        'Caveat-Regular.ttf': '7af58d70e539c9195cc328617a68c9961ed804a4404b0b818989ba7c013e8776',
        'Cousine-Regular.ttf': '1da22250675fc4c42fcf3a9736c44bc0570516105331443b663fd5cfbd1412fe',
        'Tinos-Regular.ttf': '60a0e8ef0c04dd5dd69ffe91025fa2ae5836cbd35600a82ba031977557e2cb61'
      }
    });
  });

  it('is a name the database accepts', () => {
    expect(LAYOUT_ENGINE_VERSION).toMatch(/^layout-[1-9][0-9]{0,5}$/);
  });

  it('lays the wider set out without an overflow, so it pins what prints', () => {
    for (const [name, layout] of Object.entries(widerLayouts())) {
      expect(layout.overflowLines ?? 0, name).toBe(0);
    }
    expect(widerLayouts()['letter-three-pages'].pages).toHaveLength(3);
    expect(widerLayouts()['letter-signed-three-pages'].pages).toHaveLength(3);
  });
});

describe('the fonts the fingerprint counts (#697)', () => {
  it('are the files the renderer draws with, byte for byte', () => {
    const byFile = fontFileDigests();
    expect(fontDigests()).toEqual(
      Object.fromEntries(Object.entries(FONT_FILES).map(([name, file]) => [name, byFile[file]]))
    );
  });
});
