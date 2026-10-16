import { BODY_BOTTOM, CONTENT_WIDTH, POINTS_PER_INCH, SIDE_MARGIN } from './geometry.js';
import { baselineOffset, wrapText, type LayoutItem, type LayoutPage } from './layout.js';
import { QUIET_ZONE_MODULES, qrMatrix, qrRuns } from './qr.js';

/**
 * The gift page's words (giftLetterPageCopy in src/services/giftCardRenderer.ts,
 * which the legacy HTML takes them from too). Plain text.
 */
export interface GiftPageCopy {
  eyebrow: string;
  title: string;
  lede: string;
  steps: Array<{ text: string; kind: 'plain' | 'url' | 'code' }>;
  fine?: string;
  /** What the QR encodes. */
  qrUrl: string;
}

const inch = (inches: number): number => inches * POINTS_PER_INCH;

/**
 * The card sits in the upper part of the page, as the legacy HTML put it:
 * PostGrid prints its integrity QR and sequence ids in the bottom-left corner
 * of letter pages, and the card stays clear of them.
 */
const CARD = { left: SIDE_MARGIN, top: inch(1), width: CONTENT_WIDTH, padX: inch(0.5), padY: inch(0.45) } as const;
const INNER_LEFT = CARD.left + CARD.padX;
const INNER_WIDTH = CARD.width - 2 * CARD.padX;
const QR_SIZE = inch(1.4);
const QR_GAP = inch(0.35);
const STEPS_LEFT = INNER_LEFT + QR_SIZE + QR_GAP;
const STEPS_WIDTH = INNER_WIDTH - QR_SIZE - QR_GAP;

/**
 * Each block's size, line pitch and the space after it, from the legacy CSS:
 * every step, the code too, takes the steps' line-height of 1.4.
 */
const STYLE = {
  eyebrow: { size: 10, pitch: 12, after: 8 },
  title: { size: 22, pitch: 26.4, after: 12 },
  lede: { size: 12.5, pitch: 18.75, after: 20 },
  plain: { size: 12, pitch: 16.8, after: 4 },
  url: { size: 13, pitch: 18.2, after: 4 },
  code: { size: 24, pitch: 33.6, after: 4 },
  fine: { size: 9.5, pitch: 13.78, after: 0 }
} as const;
const CODE_ABOVE = 6;
const CLAIM_AFTER = 18;

type Style = (typeof STYLE)[keyof typeof STYLE];

/**
 * A card that would run past the bottom margin, where the letter's own text
 * stops and PostGrid's marks begin. The card's words are ours but for the
 * sender's name, so only a name about a thousand characters long makes one:
 * the preview refuses it, and a print holds it.
 */
export class GiftPageOverflow extends Error {
  constructor(readonly overflow: number) {
    super(`The gift card runs ${(overflow / POINTS_PER_INCH).toFixed(2)}in past the page's bottom margin.`);
    this.name = 'GiftPageOverflow';
  }
}

/** Lines of `text` in `style`, from `top`, as text runs; returns the height used. */
function block(items: LayoutItem[], text: string, style: Style, left: number, width: number, top: number): number {
  const lines = wrapText(text, style.size, width);
  const offset = baselineOffset(style.size, style.pitch);
  lines.forEach(({ source, drawn }, index) => {
    if (drawn.trim() === '') return;
    items.push({ kind: 'text', font: 'Tinos-Regular', size: style.size, x: left, baseline: top + index * style.pitch + offset, text: drawn, source });
  });
  return lines.length * style.pitch;
}

function stepsHeight(copy: GiftPageCopy): number {
  return copy.steps.reduce((total, step) => {
    const style = STYLE[step.kind];
    const lines = wrapText(step.text, style.size, STEPS_WIDTH).length;
    return total + (step.kind === 'code' ? CODE_ABOVE : 0) + lines * style.pitch + style.after;
  }, 0);
}

/**
 * The gift card as a page of its own, the letter's second (docs/gift-letters.md):
 * a bordered card with its eyebrow, title and lede, the QR beside the steps,
 * then the fine print. Drawn by the same glyphs as the letter, so the preview
 * and the print agree; the QR is vector rectangles from src/render/qr.ts.
 */
export function layoutGiftPage(copy: GiftPageCopy): LayoutPage {
  const items: LayoutItem[] = [];
  let y = CARD.top + CARD.padY;
  y += block(items, copy.eyebrow.toUpperCase(), STYLE.eyebrow, INNER_LEFT, INNER_WIDTH, y) + STYLE.eyebrow.after;
  y += block(items, copy.title, STYLE.title, INNER_LEFT, INNER_WIDTH, y) + STYLE.title.after;
  y += block(items, copy.lede, STYLE.lede, INNER_LEFT, INNER_WIDTH, y) + STYLE.lede.after;

  // The QR and the steps share a row, each centred on the taller.
  const steps = stepsHeight(copy);
  const row = Math.max(QR_SIZE, steps);
  const qrTop = y + (row - QR_SIZE) / 2;
  const matrix = qrMatrix(copy.qrUrl);
  const module = QR_SIZE / (matrix.count + 2 * QUIET_ZONE_MODULES);
  // Each edge rounded once, so neighbouring modules share it exactly and no
  // hairline seam shows between rows.
  const edge = (value: number) => Math.round(value * 100) / 100;
  items.push({
    kind: 'rects',
    fill: '#000',
    rects: qrRuns(matrix).map(run => {
      const [left, right] = [edge(INNER_LEFT + run.x * module), edge(INNER_LEFT + (run.x + run.width) * module)];
      const [top, bottom] = [edge(qrTop + run.y * module), edge(qrTop + (run.y + 1) * module)];
      return { x: left, top, width: edge(right - left), height: edge(bottom - top) };
    })
  });
  let stepTop = y + (row - steps) / 2;
  for (const step of copy.steps) {
    const style = STYLE[step.kind];
    if (step.kind === 'code') stepTop += CODE_ABOVE;
    stepTop += block(items, step.text, style, STEPS_LEFT, STEPS_WIDTH, stepTop) + style.after;
  }
  y += row + CLAIM_AFTER;

  if (copy.fine !== undefined) {
    y += block(items, copy.fine, STYLE.fine, INNER_LEFT, INNER_WIDTH, y);
  }
  const bottom = y + CARD.padY;
  if (bottom > BODY_BOTTOM + 1e-6) throw new GiftPageOverflow(bottom - BODY_BOTTOM);
  items.unshift({
    kind: 'box',
    x: CARD.left,
    top: CARD.top,
    width: CARD.width,
    height: bottom - CARD.top,
    radius: 12,
    stroke: '#1f1a15',
    strokeWidth: 1.5
  });
  return { items, linesUsed: 0, linesAvailable: 0 };
}
