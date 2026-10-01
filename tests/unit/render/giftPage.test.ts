/**
 * The gift card as the letter's second page, drawn by our renderer (#534 PR 5):
 * the legacy card's words (giftLetterPageCopy) and geometry, with the QR as
 * vector rectangles from src/render/qr.ts.
 */

import jsQR from 'jsqr';
import sharp from 'sharp';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { layoutGiftPage, layoutLetter, renderPdf, renderPreviewSvg, type GiftPageCopy } from '../../../src/render/index.js';
import type { BoxItem, RectsItem, TextRun } from '../../../src/render/layout.js';
import { placeGlyphs } from '../../../src/render/glyphs.js';
import { QUIET_ZONE_MODULES, qrMatrix, qrRuns } from '../../../src/render/qr.js';
import { giftLetterPageCopy, qrSvg } from '../../../src/services/giftCardRenderer.js';

const FUNDED = giftLetterPageCopy(
  { state: 'funded', code: 'K7M2QX9A', url: 'https://letterirl.com/g/K7M2QX9A', displayUrl: 'letterirl.com/g', redeemBy: '2026-12-31' },
  'Pat Example'
);
const UNFUNDED = giftLetterPageCopy({ state: 'unfunded', url: 'https://letterirl.com', displayUrl: 'letterirl.com' }, 'Pat Example');

const inch = (inches: number) => inches * 72;
const runs = (copy: GiftPageCopy) => layoutGiftPage(copy).items.filter((item): item is TextRun => item.kind === 'text');
const box = (copy: GiftPageCopy) => layoutGiftPage(copy).items.find((item): item is BoxItem => item.kind === 'box')!;
const qr = (copy: GiftPageCopy) => layoutGiftPage(copy).items.find((item): item is RectsItem => item.kind === 'rects')!;

describe('the gift page on our renderer', () => {
  it('draws the card: its border, then every line of the copy, in its size', () => {
    const page = layoutGiftPage(FUNDED);
    expect(page.items[0]).toMatchObject({ kind: 'box', x: 72, top: 72, width: 468, radius: 12, stroke: '#1f1a15', strokeWidth: 1.5 });
    const text = runs(FUNDED).map(run => [run.source, run.size]);
    expect(text).toContainEqual(['A GIFT INSIDE THIS LETTER', 10]);
    expect(text).toContainEqual(['A letter for you to send', 22]);
    expect(text).toContainEqual(['Scan the code, or visit', 12]);
    expect(text).toContainEqual(['letterirl.com/g', 13]);
    expect(text).toContainEqual(['and enter', 12]);
    expect(text).toContainEqual(['K7M2-QX9A', 24]);
    // The lede and the fine print, wrapped, at their sizes.
    expect(runs(FUNDED).filter(run => run.size === 12.5).map(run => run.source).join(' ')).toBe(FUNDED.lede);
    expect(runs(FUNDED).filter(run => run.size === 9.5).map(run => run.source).join(' ')).toBe(FUNDED.fine);
  });

  it('lays the card out as the legacy CSS did: these positions, in points from the top left', () => {
    const r = (value: number) => Math.round(value * 100) / 100;
    const geometry = (copy: GiftPageCopy) => layoutGiftPage(copy).items.map(item => {
      if (item.kind === 'text') return [item.source, item.size, r(item.x), r(item.baseline)];
      if (item.kind === 'box') return ['box', r(item.x), r(item.top), r(item.width), r(item.height)];
      if (item.kind === 'rects') {
        const edges = (pick: (rect: RectsItem['rects'][number]) => number) => item.rects.map(pick);
        return ['qr', Math.min(...edges(rect => rect.x)), Math.min(...edges(rect => rect.top)),
          r(Math.max(...edges(rect => rect.x + rect.width))), r(Math.max(...edges(rect => rect.top + rect.height)))];
      }
      return [item.kind];
    });
    expect(geometry(FUNDED)).toEqual([
      ['box', 72, 72, 468, 328.86],
      ['A GIFT INSIDE THIS LETTER', 10, 108, 113.77],
      ['A letter for you to send', 22, 108, 145.02],
      ['Pat Example sent this letter with Letter IRL and included one more: a letter of', 12.5, 108, 176.39],
      ['your own, printed and mailed for you at no cost.', 12.5, 108, 195.14],
      // The QR's dark modules, inside its quiet zone; the steps are the taller, so the QR is centred on them.
      ['qr', 118.9, 232.1, 197.9, 311.1],
      ['Scan the code, or visit', 12, 234, 232.75],
      ['letterirl.com/g', 13, 234, 254.59],
      ['and enter', 12, 234, 275.75],
      ['K7M2-QX9A', 24, 234, 312.6],
      ['Redeem by December 31, 2026. The code works once. You write your letter with your AI assistant, and', 9.5, 108, 351],
      ['we print and mail it.', 9.5, 108, 364.78]
    ]);
    // Here the QR is the taller, so the steps are centred on it.
    expect(geometry(UNFUNDED)).toEqual([
      ['box', 72, 72, 468, 281.5],
      ['SENT WITH LETTER IRL', 10, 108, 113.77],
      ['This letter began as a conversation', 22, 108, 145.02],
      ['Pat Example wrote it with Letter IRL, which turns a conversation with an AI', 12.5, 108, 176.39],
      ['assistant into a real letter, printed and mailed.', 12.5, 108, 195.14],
      ['qr', 118.9, 231.2, 197.9, 310.2],
      ['See how it works at', 12, 234, 261.65],
      ['letterirl.com', 13, 234, 283.49]
    ]);
  });

  it('keeps everything inside the card, the steps beside the QR, and the card off the bottom of the page', () => {
    const border = box(FUNDED);
    for (const run of runs(FUNDED)) {
      expect(run.x).toBeGreaterThanOrEqual(border.x + inch(0.5));
      expect(run.baseline).toBeGreaterThan(border.top + inch(0.45));
      expect(run.baseline).toBeLessThan(border.top + border.height - inch(0.45) + 1e-6);
      // No line wider than the space it was wrapped to.
      const right = Math.max(...placeGlyphs(run).map(glyph => glyph.x));
      expect(right).toBeLessThanOrEqual(border.x + border.width - inch(0.5));
    }
    const steps = runs(FUNDED).filter(run => ['Scan the code, or visit', 'letterirl.com/g', 'and enter', 'K7M2-QX9A'].includes(run.source));
    for (const step of steps) expect(step.x).toBeCloseTo(inch(1.5) + inch(1.4) + inch(0.35), 6);
    // The card keeps the letter's one-inch margins.
    expect(border.top + border.height).toBeLessThanOrEqual(inch(10));
  });

  it('draws the QR as the legacy card did: the same modules, 1.4in square with its quiet zone', () => {
    const symbol = qrMatrix(FUNDED.qrUrl);
    const drawn = qr(FUNDED);
    expect(drawn.fill).toBe('#000');
    expect(drawn.rects).toHaveLength(qrRuns(symbol).length);
    // The legacy card's SVG draws one rect per run, plus its white ground.
    expect(qrSvg(FUNDED.qrUrl, 1.4).match(/<rect /g)).toHaveLength(qrRuns(symbol).length + 1);
    const module = inch(1.4) / (symbol.count + 2 * QUIET_ZONE_MODULES);
    const left = inch(1.5);
    const minX = Math.min(...drawn.rects.map(rect => rect.x));
    const maxX = Math.max(...drawn.rects.map(rect => rect.x + rect.width));
    expect(minX).toBeCloseTo(left + QUIET_ZONE_MODULES * module, 1);
    expect(maxX).toBeCloseTo(left + (QUIET_ZONE_MODULES + symbol.count) * module, 1);
    // Edges are rounded once, so neighbouring rows meet exactly.
    for (const rect of drawn.rects) {
      for (const value of [rect.x, rect.top, rect.width, rect.height]) expect(Math.round(value * 100) / 100).toBe(value);
    }
    const rows = [...new Set(drawn.rects.map(rect => rect.top))].sort((a, b) => a - b);
    const heights = new Map(drawn.rects.map(rect => [rect.top, rect.height]));
    for (let index = 1; index < rows.length; index += 1) {
      const above = rows[index - 1];
      if (rows[index] - above < module * 1.5) expect(Math.round((above + heights.get(above)!) * 100) / 100).toBe(rows[index]);
    }
  });

  it.each([
    ['a funded card', FUNDED],
    ['an unfunded card', UNFUNDED]
  ] as const)('draws a QR on %s that decodes to its link, as the page shows it', async (_name, copy) => {
    const layout = layoutLetter({ text: 'Dear Sam,', layoutType: 'text_only' });
    layout.pages.push(layoutGiftPage(copy));
    const page = renderPreviewSvg(layout)[1];
    const symbol = qrMatrix(copy.qrUrl);
    const module = inch(1.4) / (symbol.count + 2 * QUIET_ZONE_MODULES);
    const top = Math.min(...qr(copy).rects.map(rect => rect.top)) - QUIET_ZONE_MODULES * module;
    // Only the symbol and its quiet zone, at four pixels a point.
    const view = `viewBox="${inch(1.5)} ${top} ${inch(1.4)} ${inch(1.4)}" width="${inch(1.4) * 4}" height="${inch(1.4) * 4}"`;
    const cropped = page.replace(`viewBox="0 0 ${layout.width} ${layout.height}"`, view);
    expect(cropped).not.toBe(page);
    const { data, info } = await sharp(Buffer.from(cropped))
      .flatten({ background: '#ffffff' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data).toBe(copy.qrUrl);
  });

  it('draws an unfunded card without a code or fine print, and shorter', () => {
    const text = runs(UNFUNDED).map(run => run.source);
    expect(text).toContain('SENT WITH LETTER IRL');
    expect(text).toContain('This letter began as a conversation');
    expect(text).toContain('See how it works at');
    expect(text).toContain('letterirl.com');
    expect(runs(UNFUNDED).some(run => run.size === 24 || run.size === 9.5)).toBe(false);
    expect(box(UNFUNDED).height).toBeLessThan(box(FUNDED).height);
  });

  it('names glyphs without a dot at a fractional size, so the letter card keeps them', () => {
    const lede = runs(FUNDED).find(run => run.size === 12.5)!;
    const keys = placeGlyphs(lede).map(glyph => glyph.key);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(key).toMatch(/^tr12_5-\d+$/);
  });

  it('strokes the border and fills the QR in the PDF', async () => {
    const layout = layoutLetter({ text: 'Dear Sam,', layoutType: 'text_only' });
    layout.pages.push(layoutGiftPage(FUNDED));
    const pdf = (await renderPdf(layout)).toString('latin1');
    // Each page's content is one deflated stream; the gift page's is the one with rectangles.
    const streams = [...pdf.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)]
      .map(match => {
        try {
          return inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1');
        } catch {
          return '';
        }
      });
    const card = streams.find(stream => / re\b/.test(stream))!;
    expect(card).toBeDefined();
    // The border: 1.5pt, in the card's ink (#1f1a15), stroked.
    expect(card).toMatch(/\n1\.5 w\n\/DeviceRGB CS\n0\.12156\d* 0\.10196\d* 0\.08235\d* SCN\nS\n/);
    // The QR: one rectangle a run, then a single black fill.
    expect(card.match(/ re\n/g)).toHaveLength(qr(FUNDED).rects.length);
    expect(card).toMatch(/ re\n\/DeviceRGB cs\n0 0 0 scn\nf\n/);
  });

  it('prints as the PDF\'s second page and previews as the second SVG', async () => {
    const layout = layoutLetter({ text: 'Dear Sam,\nHello.\nPat', layoutType: 'text_only' });
    layout.pages.push(layoutGiftPage(FUNDED));
    const pdf = (await renderPdf(layout)).toString('latin1');
    expect(pdf).toMatch(/\/Type \/Pages[\s\S]*?\/Count 2/);
    const [first, second] = renderPreviewSvg(layout, { addresses: { from: ['PAT'], to: ['SAM'] } });
    expect(first).toContain('<text');
    expect(second).not.toContain('<text');
    expect(second).toContain('<rect x="72" y="72" width="468" height="');
    expect(second).toContain('rx="12" fill="none" stroke="#1f1a15" stroke-width="1.5"/>');
    expect(second).toMatch(/<g fill="#000">(<rect x="[\d.]+" y="[\d.]+" width="[\d.]+" height="[\d.]+"\/>)+<\/g>/);
    expect(second).toContain('<title>A GIFT INSIDE THIS LETTER\nA letter for you to send');
  });
});
