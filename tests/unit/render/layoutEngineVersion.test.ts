import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { LAYOUT_ENGINE_VERSION } from '../../../src/render/index.js';

/**
 * Held mail prints as previewed (#697): a letter held for its date records the
 * layout engine that laid it out, and the print compares what it lays out now.
 * So the engine's version must change whenever its output does. The golden
 * layouts record that output (the letter matrix in layoutPages.test.ts and
 * the 6x9 postcard backs); this test pins their digest beside the version.
 *
 * When a golden layout changes, this fails: bump LAYOUT_ENGINE_VERSION in
 * src/render/fingerprint.ts and record the new digest, together. Recording the
 * digest alone would let letters fingerprinted by the old engine print from
 * the new one unremarked.
 *
 * The fonts are pinned too: a font file swapped for another draws every glyph
 * differently while every position stays the same.
 */

const FONTS = new URL('../../../assets/fonts/', import.meta.url);

function goldenDigest(): string {
  const source = readFileSync(new URL('./layoutPages.test.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const recorded = /const RECORDED: Record<string, string> = \{\n([\s\S]*?)\n\};/.exec(source);
  if (!recorded) throw new Error('layoutPages.test.ts no longer records its layouts as RECORDED');
  const entries = [...recorded[1].matchAll(/'([^']+)': '([0-9a-f]{16})'/g)].map((match) => `${match[1]}=${match[2]}`).sort();
  const postcards = readFileSync(new URL('../../fixtures/postcardBacks6x9.497afe2.json', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(`${entries.join('\n')}\n--\n${postcards}`).digest('hex').slice(0, 12);
}

describe('the layout engine version (#697)', () => {
  it('changes whenever a golden layout does', () => {
    expect({ version: LAYOUT_ENGINE_VERSION, digest: goldenDigest() }).toEqual({
      version: 'layout-1',
      digest: '4eb797f4f7b7'
    });
  });

  it('is a name the database accepts', () => {
    expect(LAYOUT_ENGINE_VERSION).toMatch(/^layout-[1-9][0-9]{0,5}$/);
  });
});

describe('the fonts the renderer draws with (#697)', () => {
  it('are exactly these files, byte for byte', () => {
    const fonts = readdirSync(FONTS).filter((name) => name.endsWith('.ttf')).sort();
    const digests = Object.fromEntries(fonts.map((name) => [name, createHash('sha256').update(readFileSync(new URL(name, FONTS))).digest('hex')]));
    expect(digests).toEqual({
      'Caveat-Regular.ttf': '7af58d70e539c9195cc328617a68c9961ed804a4404b0b818989ba7c013e8776',
      'Cousine-Regular.ttf': '1da22250675fc4c42fcf3a9736c44bc0570516105331443b663fd5cfbd1412fe',
      'Tinos-Regular.ttf': '60a0e8ef0c04dd5dd69ffe91025fa2ae5836cbd35600a82ba031977557e2cb61'
    });
  });
});
