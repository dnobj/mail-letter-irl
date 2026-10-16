import qrcode from 'qrcode-generator';

/** ISO/IEC 18004 asks for a quiet zone of four modules. */
export const QUIET_ZONE_MODULES = 4;
/** Q recovers about 25% of the symbol: enough for a crease or a scuff. */
const ERROR_CORRECTION = 'Q' as const;

/** A QR symbol's dark modules, without the quiet zone. */
export interface QrMatrix {
  count: number;
  isDark(row: number, col: number): boolean;
}

/** The symbol for `text`, encoded as bytes at error correction Q. */
export function qrMatrix(text: string): QrMatrix {
  const qr = qrcode(0, ERROR_CORRECTION);
  qr.addData(text, 'Byte');
  qr.make();
  const count = qr.getModuleCount();
  return { count, isDark: (row, col) => qr.isDark(row, col) };
}

/**
 * The dark modules as one rectangle per horizontal run, in module units with
 * the quiet zone added: the most conservative shape to draw, in an SVG, an
 * HTML-to-PDF renderer or a PDF of our own.
 */
export function qrRuns(matrix: QrMatrix): Array<{ x: number; y: number; width: number }> {
  const runs: Array<{ x: number; y: number; width: number }> = [];
  for (let row = 0; row < matrix.count; row += 1) {
    let col = 0;
    while (col < matrix.count) {
      if (!matrix.isDark(row, col)) {
        col += 1;
        continue;
      }
      const start = col;
      while (col < matrix.count && matrix.isDark(row, col)) col += 1;
      runs.push({ x: start + QUIET_ZONE_MODULES, y: row + QUIET_ZONE_MODULES, width: col - start });
    }
  }
  return runs;
}
