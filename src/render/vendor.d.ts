// Minimal declarations for the three renderer dependencies that ship no types.
// Only what src/render uses is declared.

declare module 'fontkit' {
  export interface PathCommand {
    command: 'moveTo' | 'lineTo' | 'quadraticCurveTo' | 'bezierCurveTo' | 'closePath';
    args: number[];
  }
  export interface Path {
    commands: PathCommand[];
    toSVG(): string;
    scale(scaleX: number, scaleY?: number): Path;
  }
  export interface Glyph {
    id: number;
    path: Path;
    advanceWidth: number;
    codePoints: number[];
  }
  export interface GlyphPosition {
    xAdvance: number;
    yAdvance: number;
    xOffset: number;
    yOffset: number;
  }
  export interface GlyphRun {
    glyphs: Glyph[];
    positions: GlyphPosition[];
    advanceWidth: number;
  }
  export interface Font {
    postscriptName: string;
    unitsPerEm: number;
    ascent: number;
    descent: number;
    characterSet: number[];
    hasGlyphForCodePoint(codePoint: number): boolean;
    glyphForCodePoint(codePoint: number): Glyph;
    layout(
      text: string,
      features?: string[] | Record<string, boolean>,
      script?: string,
      language?: string,
      direction?: 'ltr' | 'rtl'
    ): GlyphRun;
  }
  export function create(buffer: Buffer | Uint8Array): Font;
}

declare module 'linebreak' {
  interface Break {
    position: number;
    required: boolean;
  }
  export default class LineBreaker {
    constructor(text: string);
    nextBreak(): Break | null;
  }
}

declare module 'bidi-js' {
  interface EmbeddingLevels {
    levels: Uint8Array;
    paragraphs: Array<{ start: number; end: number; level: number }>;
  }
  interface Bidi {
    getEmbeddingLevels(text: string, explicitDirection?: 'ltr' | 'rtl'): EmbeddingLevels;
    /** [start, end] pairs, inclusive, to reverse in order; indices into the whole text. */
    getReorderSegments(text: string, embeddingLevels: EmbeddingLevels, start?: number, end?: number): Array<[number, number]>;
    /** Takes the `levels` array itself: it indexes it, and mirrors nothing given the result object. */
    getMirroredCharactersMap(text: string, levels: Uint8Array, start?: number, end?: number): Map<number, string>;
  }
  export default function bidiFactory(): Bidi;
}
