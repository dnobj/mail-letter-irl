import { readFileSync } from 'node:fs';
import { create, type Font } from 'fontkit';

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
