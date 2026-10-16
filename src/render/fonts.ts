import { readFileSync } from 'node:fs';
import { create, type Font } from 'fontkit';

/**
 * The fonts the renderer ships, under assets/fonts, each beside its licence
 * (`<Family>-OFL.txt`, the SIL Open Font License 1.1):
 * - Tinos, metric-compatible with Times New Roman, which the legacy HTML
 *   named, so today's line calibration carries over;
 * - Cousine, the monospace of the same family, for Typewriter (#563);
 * - Caveat, a handwriting face, for Handwritten (#563).
 *
 * Each is the file Google Fonts ships: Tinos and Cousine from google/fonts
 * (ofl/tinos, ofl/cousine), and Caveat's static Regular from
 * googlefonts/caveat at 59745e8, the commit google/fonts takes its variable
 * font from.
 */
export const FONT_FILES = {
  'Tinos-Regular': 'Tinos-Regular.ttf',
  'Cousine-Regular': 'Cousine-Regular.ttf',
  'Caveat-Regular': 'Caveat-Regular.ttf'
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
