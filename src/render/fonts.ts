import { readFileSync } from 'node:fs';
import { create, type Font } from 'fontkit';
import { withoutInvisible } from './bidi.js';

/**
 * The fonts the renderer ships, under assets/fonts with their licences.
 * Tinos is metric-compatible with Times New Roman, which the legacy HTML
 * named, so today's line calibration carries over (SIL OFL 1.1).
 */
export const FONT_FILES = {
  'Tinos-Regular': 'Tinos-Regular.ttf'
} as const;

export type FontName = keyof typeof FONT_FILES;

const bytesCache = new Map<FontName, Buffer>();
const fontCache = new Map<FontName, Font>();

/**
 * src/render and dist/render both sit two levels below the repository root,
 * so the same relative URL finds assets/ in tests and in the built service.
 */
function assetUrl(file: string): URL {
  return new URL(`../../assets/fonts/${file}`, import.meta.url);
}

export function fontBytes(name: FontName): Buffer {
  let bytes = bytesCache.get(name);
  if (!bytes) {
    bytes = readFileSync(assetUrl(FONT_FILES[name]));
    bytesCache.set(name, bytes);
  }
  return bytes;
}

export function loadFont(name: FontName): Font {
  let font = fontCache.get(name);
  if (!font) {
    font = create(fontBytes(name));
    fontCache.set(name, font);
  }
  return font;
}

/**
 * The distinct characters of `text` that the font has no glyph for, in order,
 * judged as the renderer draws it: line breaks start new lines, tabs become
 * spaces, and characters that print nothing are dropped, so none of those
 * count as missing.
 */
export function missingCharacters(name: FontName, text: string): string[] {
  const font = loadFont(name);
  const missing: string[] = [];
  for (const character of withoutInvisible(text.replace(/[\r\n]/g, '').replace(/\t/g, ' '))) {
    const codePoint = character.codePointAt(0)!;
    if (!font.hasGlyphForCodePoint(codePoint) && !missing.includes(character)) missing.push(character);
  }
  return missing;
}
