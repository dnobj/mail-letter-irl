/**
 * A letter over more than one page (#586, room to write): layoutLetter's
 * maxPages. A letter that fits one page is laid out exactly as it always was,
 * pinned here by the layouts recorded before the change; a longer one flows on
 * to pages 2 and 3, which start at CONTINUATION_TOP.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { layoutLetter, pageFit, type Layout, type LetterContent, type TextRun } from '../../../src/render/layout.js';
import { renderPdf } from '../../../src/render/pdf.js';
import {
  BODY_BOTTOM, BODY_TOP, CONTINUATION_TOP, IMAGE_GAP, LINE_PITCH, MAX_LETTER_PAGES
} from '../../../src/render/geometry.js';
import type { RenderImage } from '../../../src/render/images.js';
import type { Stationery } from '../../../src/render/stationery.js';

/** A PNG's signature and header: enough for the renderer to size it. */
function pngBytes(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  bytes.writeUInt32BE(0x89504e47, 0);
  bytes.writeUInt32BE(0x0d0a1a0a, 4);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

const PARAGRAPH =
  'The garden finally gave up its last tomatoes this week, and I thought of you the whole time I was canning them. ' +
  'I used your trick with the lemon juice and every jar sealed on the first try.';

/** n paragraphs of the same prose, a blank line between each, and a sign-off. */
function letterText(paragraphs: number): string {
  return ['Dear Ruth,', ...Array.from({ length: paragraphs }, () => PARAGRAPH), 'With love,\nDaniel'].join('\n\n');
}

const image: RenderImage = { bytes: pngBytes(1200, 800), mime: 'image/png', width: 1200, height: 800 };

const THEMES: Array<[string, Stationery | undefined]> = [
  ['classic', undefined],
  ['monogram', { theme: 'monogram', dateLine: 'October 2, 2026', monogram: 'DR' }],
  ['botanical', { theme: 'botanical', dateLine: 'October 2, 2026' }],
  ['celebration', { theme: 'celebration', dateLine: 'October 2, 2026', headline: 'Happy birthday, Ruth!' }],
  ['typewriter', { theme: 'typewriter', dateLine: 'October 2, 2026' }],
  ['handwritten', { theme: 'handwritten', dateLine: 'October 2, 2026' }]
];
const LAYOUTS = ['text_only', 'header_image', 'inline_image'] as const;
const LENGTHS: Array<[string, number]> = [['short', 1], ['long', 6], ['overflowing', 14]];

/** Every layout, every theme, at three lengths: one short, one near full, one past the page. */
const MATRIX: Array<{ name: string; content: LetterContent }> = THEMES.flatMap(([themeName, stationery]) =>
  LAYOUTS.flatMap(layoutType =>
    LENGTHS.map(([lengthName, paragraphs]) => ({
      name: `${themeName}/${layoutType}/${lengthName}`,
      content: {
        text: letterText(paragraphs),
        layoutType,
        ...(layoutType === 'text_only' ? {} : { image }),
        ...(stationery ? { stationery } : {})
      }
    }))
  )
);

/**
 * Each layout's hash, recorded on 2026-10-02 from the renderer as it was
 * before #586 (dev 4711f90): the page every letter has printed on.
 */
const RECORDED: Record<string, string> = {
  'classic/text_only/short': '87c8a7ec1d2b1262',
  'classic/text_only/long': '42b16edc53de1e58',
  'classic/text_only/overflowing': '6d2b5624a62b52eb',
  'classic/header_image/short': 'ed6b492acb4bcf59',
  'classic/header_image/long': '96780b4a977e8d9a',
  'classic/header_image/overflowing': '28111959516f62e3',
  'classic/inline_image/short': '3d0511733080bc04',
  'classic/inline_image/long': '67754bc3d69216b4',
  'classic/inline_image/overflowing': 'b487fb1eaed832d8',
  'monogram/text_only/short': '90bff17b987e249a',
  'monogram/text_only/long': '94d440979e6fe22c',
  'monogram/text_only/overflowing': '2a5b115afd029cbf',
  'monogram/header_image/short': 'c1fe3e86416ac1b0',
  'monogram/header_image/long': 'f3ef21651db4d06a',
  'monogram/header_image/overflowing': '89708a26659e1582',
  'monogram/inline_image/short': 'ae8234cbfaf186fd',
  'monogram/inline_image/long': '4eb6d039eb5d3810',
  'monogram/inline_image/overflowing': '915fd04e2c3f14c7',
  'botanical/text_only/short': '752e5c6b38b45c02',
  'botanical/text_only/long': 'aecc13883b7951e3',
  'botanical/text_only/overflowing': 'ace8cc93d5aad705',
  'botanical/header_image/short': '7ec1c0ede9310f17',
  'botanical/header_image/long': '057fdca2ba80c150',
  'botanical/header_image/overflowing': 'ebe80bfa0aed349e',
  'botanical/inline_image/short': 'e8769c33e3612dc3',
  'botanical/inline_image/long': '1300167452013699',
  'botanical/inline_image/overflowing': 'f38a7c8b2dcd11c3',
  'celebration/text_only/short': '84c08db79923457f',
  'celebration/text_only/long': '1274e551e51edc0b',
  'celebration/text_only/overflowing': '6258a23f9e6efe83',
  'celebration/header_image/short': 'ac8d942739fa4f0d',
  'celebration/header_image/long': '658dba014a3e3c73',
  'celebration/header_image/overflowing': 'e838858ff5d8f33e',
  'celebration/inline_image/short': 'bcff3802eb9c3eb2',
  'celebration/inline_image/long': '9c66085c6bdc7596',
  'celebration/inline_image/overflowing': '390fb5069a5b5afa',
  'typewriter/text_only/short': 'd8d074756c3cf6d7',
  'typewriter/text_only/long': '1598d76374c44ac9',
  'typewriter/text_only/overflowing': '28fd6d399d0cc5b2',
  'typewriter/header_image/short': '79e79cd2b12c840e',
  'typewriter/header_image/long': 'c5b7891ca0f793c3',
  'typewriter/header_image/overflowing': 'c80fea99a8f2f572',
  'typewriter/inline_image/short': '9931065baae6ff15',
  'typewriter/inline_image/long': '289fe48ef1b38ccd',
  'typewriter/inline_image/overflowing': '5977ec936154d348',
  'handwritten/text_only/short': '0afd0987956cf2e7',
  'handwritten/text_only/long': 'a90d908bc025e44c',
  'handwritten/text_only/overflowing': '8530577ea75cbb10',
  'handwritten/header_image/short': '49c63fe46c8e8020',
  'handwritten/header_image/long': '5be6362b83c05c1f',
  'handwritten/header_image/overflowing': '15644030654500d5',
  'handwritten/inline_image/short': 'f5cc0a0dc87de1ef',
  'handwritten/inline_image/long': '5bc80d60806b45e1',
  'handwritten/inline_image/overflowing': '75e0bc23d07448d0'
};

const hashOf = (layout: Layout) => createHash('sha256').update(JSON.stringify(layout)).digest('hex').slice(0, 16);
const runs = (layout: Layout, page: number) => layout.pages[page].items.filter((item): item is TextRun => item.kind === 'text');
const images = (layout: Layout, page: number) => layout.pages[page].items.filter(item => item.kind === 'image');
const paths = (layout: Layout, page: number) => layout.pages[page].items.filter(item => item.kind === 'path');
/** `count` short lines, one wrapped line each, with no blank line between. */
const numberedLines = (count: number) => Array.from({ length: count }, (_, index) => `Line ${index + 1}`).join('\n');
/** Where Handwritten's rules sit on a page, top to bottom: each rule is "Mx yLx y". */
const ruleYs = (layout: Layout, page: number) =>
  paths(layout, page).flatMap(item => [...(item as { d: string }).d.matchAll(/M[\d.]+ ([\d.]+)L/g)].map(match => Number(match[1])));

describe('a letter that fits one page, whatever the limit (#586)', () => {
  it('records every case', () => {
    expect(Object.keys(RECORDED).sort()).toEqual(MATRIX.map(({ name }) => name).sort());
  });

  it.each(MATRIX.map(({ name, content }) => [name, content] as const))('%s is laid out as before #586', (name, content) => {
    expect(hashOf(layoutLetter(content))).toBe(RECORDED[name]);
    expect(hashOf(layoutLetter(content, { maxPages: 1 }))).toBe(RECORDED[name]);
    const single = layoutLetter(content);
    if (single.overflowLines === 0) {
      // Room to write changes nothing for a letter that fits.
      expect(layoutLetter(content, { maxPages: MAX_LETTER_PAGES })).toEqual(single);
    }
  });
});

describe('a letter over several pages (#586)', () => {
  const CAPACITY_LATER = Math.floor((BODY_BOTTOM - CONTINUATION_TOP + 1e-6) / LINE_PITCH);

  it('holds 33 lines on each later page', () => {
    expect(CAPACITY_LATER).toBe(33);
    const layout = layoutLetter({ text: numberedLines(26 + 33 + 5), layoutType: 'text_only' }, { maxPages: 3 });
    expect(layout.pages.map(page => [page.linesUsed, page.linesAvailable])).toEqual([[26, 26], [33, 33], [5, 33]]);
    expect(layout.overflowLines).toBe(0);
  });

  it('flows a letter too long for one page on to the next, starting it at the continuation top with words', () => {
    const content: LetterContent = { text: letterText(10), layoutType: 'text_only' };
    expect(layoutLetter(content).overflowLines).toBeGreaterThan(0);
    const layout = layoutLetter(content, { maxPages: 3 });
    expect(layout.overflowLines).toBe(0);
    expect(layout.pages).toHaveLength(2);
    expect(layout.pages[0].linesUsed).toBe(layout.pages[0].linesAvailable);
    expect(layout.pages[0].linesAvailable).toBe(26);
    expect(layout.pages[1].linesAvailable).toBe(33);
    const first = runs(layout, 0)[0];
    expect(first.baseline).toBeGreaterThan(BODY_TOP);
    expect(first.baseline).toBeLessThan(BODY_TOP + LINE_PITCH);
    const second = runs(layout, 1)[0];
    expect(second.baseline).toBeGreaterThan(CONTINUATION_TOP);
    expect(second.baseline).toBeLessThan(CONTINUATION_TOP + LINE_PITCH);
    expect(second.source.trim()).not.toBe('');
    // Nothing lost: every line of words is drawn once, in order.
    const wrapped = runs(layoutLetter(content), 0).map(run => run.source);
    expect([...runs(layout, 0), ...runs(layout, 1)].map(run => run.source)).toEqual(wrapped);
    for (const page of [0, 1]) for (const run of runs(layout, page)) expect(run.baseline).toBeLessThan(BODY_BOTTOM);
  });

  it('starts a later page with the words that follow, not the blank line between paragraphs', () => {
    // 26 lines fill page 1; the 27th is blank; page 2 starts with the 28th.
    const before = Array.from({ length: 26 }, (_, index) => `Line ${index + 1}`);
    const text = [...before, '', '', 'Line 27', 'Line 28'].join('\n');
    const layout = layoutLetter({ text, layoutType: 'text_only' }, { maxPages: 3 });
    expect(layout.pages).toHaveLength(2);
    expect(runs(layout, 0).at(-1)!.source).toBe('Line 26');
    expect(runs(layout, 1).map(run => run.source)).toEqual(['Line 27', 'Line 28']);
    expect(runs(layout, 1)[0].baseline).toBeLessThan(CONTINUATION_TOP + LINE_PITCH);
    expect(layout.pages[1].linesUsed).toBe(2);
  });

  it('keeps the blank lines at the top of the first page, as before', () => {
    const layout = layoutLetter({ text: ['', 'Hello', ...Array.from({ length: 30 }, () => 'More')].join('\n'), layoutType: 'text_only' }, { maxPages: 3 });
    expect(runs(layout, 0)[0].source).toBe('Hello');
    expect(runs(layout, 0)[0].baseline).toBeGreaterThan(BODY_TOP + LINE_PITCH);
  });

  it('fills three pages at most, and says by how much a longer letter runs past them', () => {
    const layout = layoutLetter({ text: letterText(40), layoutType: 'text_only' }, { maxPages: 3 });
    expect(layout.pages).toHaveLength(3);
    expect(layout.overflowLines).toBeGreaterThan(0);
    expect(layout.pages[2].linesUsed - layout.pages[2].linesAvailable).toBe(layout.overflowLines);
    const two = layoutLetter({ text: letterText(40), layoutType: 'text_only' }, { maxPages: 2 });
    expect(two.pages).toHaveLength(2);
    expect(two.overflowLines).toBeGreaterThan(layout.overflowLines);
  });

  it("keeps the theme's corner, date and headline on the first page only", () => {
    const content: LetterContent = { text: letterText(10), layoutType: 'text_only', stationery: { theme: 'botanical', dateLine: 'October 2, 2026' } };
    const layout = layoutLetter(content, { maxPages: 3 });
    expect(paths(layout, 0).length).toBeGreaterThan(0);
    expect(paths(layout, 1)).toHaveLength(0);
    expect(runs(layout, 0).some(run => run.source === 'October 2, 2026')).toBe(true);
    expect(runs(layout, 1).some(run => run.source === 'October 2, 2026')).toBe(false);
  });

  it('rules every page for the handwritten theme, a later page from its top, and never across the image', () => {
    const handwritten = { theme: 'handwritten' as const, dateLine: 'October 2, 2026' };
    const layout = layoutLetter({ text: letterText(10), layoutType: 'text_only', stationery: handwritten }, { maxPages: 3 });
    expect(layout.pages.length).toBeGreaterThan(1);
    for (let page = 0; page < layout.pages.length; page += 1) expect(paths(layout, page).length).toBeGreaterThan(0);
    // Page 2's first rule sits under its first line, a line's pitch below the continuation top at most.
    const later = ruleYs(layout, 1);
    expect(later[0]).toBeGreaterThan(CONTINUATION_TOP);
    expect(later[0]).toBeLessThan(CONTINUATION_TOP + LINE_PITCH);
    expect(later.length).toBe(33);

    // With the enclosed image after the text on page 2, no rule crosses it.
    const withImage = layoutLetter({ text: numberedLines(26 + 5), layoutType: 'inline_image', image, stationery: handwritten }, { maxPages: 3 });
    expect(withImage.pages).toHaveLength(2);
    const [box] = images(withImage, 1) as Array<{ top: number; height: number }>;
    const ys = ruleYs(withImage, 1);
    expect(ys.length).toBeGreaterThan(5);
    expect(ys.filter(y => y > box.top && y < box.top + box.height)).toEqual([]);
    expect(ys.some(y => y > box.top + box.height)).toBe(true);
  });

  it('keeps a header image on the first page only', () => {
    const layout = layoutLetter({ text: letterText(10), layoutType: 'header_image', image }, { maxPages: 3 });
    expect(layout.pages.length).toBeGreaterThan(1);
    expect(images(layout, 0)).toHaveLength(1);
    for (let page = 1; page < layout.pages.length; page += 1) expect(images(layout, page)).toHaveLength(0);
  });

  it('puts the enclosed image after the last line when it fits there', () => {
    const layout = layoutLetter({ text: letterText(10), layoutType: 'inline_image', image }, { maxPages: 3 });
    const last = layout.pages.length - 1;
    expect(last).toBe(1);
    expect(runs(layout, last).length).toBeGreaterThan(0);
    expect(layout.overflowLines).toBe(0);
    const [box] = images(layout, last) as Array<{ top: number; height: number }>;
    const lastRun = runs(layout, last).at(-1)!;
    expect(box.top).toBeGreaterThan(lastRun.baseline);
    expect(box.top + box.height).toBeLessThanOrEqual(BODY_BOTTOM + 1e-6);
    // The page's lines leave room for the image, as one page's always have.
    expect(layout.pages[last].linesAvailable).toBe(
      Math.floor((BODY_BOTTOM - CONTINUATION_TOP - IMAGE_GAP - box.height + 1e-6) / LINE_PITCH)
    );
    for (let page = 0; page < last; page += 1) expect(images(layout, page)).toHaveLength(0);
  });

  it('starts a page with the enclosed image when the last page has no room left for it, never splitting it', () => {
    // A letter that ends near the bottom of page 1 without room for the image.
    let checked = false;
    for (let paragraphs = 5; paragraphs <= 7 && !checked; paragraphs += 1) {
      const content: LetterContent = { text: letterText(paragraphs), layoutType: 'inline_image', image };
      const layout = layoutLetter(content, { maxPages: 3 });
      if (layout.pages.length !== 2 || runs(layout, 1).length > 0) continue;
      checked = true;
      expect(images(layout, 1)).toHaveLength(1);
      const [box] = images(layout, 1) as Array<{ top: number }>;
      expect(box.top).toBe(CONTINUATION_TOP);
      expect(layout.pages[1].linesUsed).toBe(0);
    }
    expect(checked).toBe(true);
  });

  it('counts a letter with an enclosed image and no page left for it as over by the lines past the room its last page keeps', () => {
    // The image's room on a later page: the lines that still fit above it.
    const height = (images(layoutLetter({ text: 'Hello', layoutType: 'inline_image', image }), 0)[0] as { height: number }).height;
    const room = Math.floor((BODY_BOTTOM - CONTINUATION_TOP - IMAGE_GAP - height + 1e-6) / LINE_PITCH);
    expect(room).toBeGreaterThan(0);
    for (const maxPages of [2, 3]) {
      const before = 26 + 33 * (maxPages - 2);
      // As one page counts it: the last page's lines past its room, then cutting that many fits.
      for (const extra of [1, 2, 7, room + 3, 33 - room, 40]) {
        const lines = before + room + extra;
        const layout = layoutLetter({ text: numberedLines(lines), layoutType: 'inline_image', image }, { maxPages });
        const last = layout.pages[maxPages - 1];
        expect(layout.pages, `${lines} lines`).toHaveLength(maxPages);
        expect(layout.overflowLines, `${lines} lines`).toBe(extra);
        expect(last.linesUsed - last.linesAvailable, `${lines} lines`).toBe(layout.overflowLines);
        const cut = layoutLetter({ text: numberedLines(lines - extra), layoutType: 'inline_image', image }, { maxPages });
        expect(cut.overflowLines, `${lines - extra} lines`).toBe(0);
        expect(cut.pages, `${lines - extra} lines`).toHaveLength(maxPages);
      }
    }
  });

  it('never starts a page past the limit for the enclosed image: text that fills the last page leaves it as overflow', () => {
    // 26 lines fill page 1 and 33 fill page 2, the last page allowed.
    const text = Array.from({ length: 59 }, (_, index) => `Line ${index + 1}`).join('\n');
    const layout = layoutLetter({ text, layoutType: 'inline_image', image }, { maxPages: 2 });
    expect(layout.pages).toHaveLength(2);
    expect(layout.pages[1].linesUsed).toBe(33);
    const height = (images(layout, 1)[0] as { height: number }).height;
    expect(layout.overflowLines).toBe(33 - Math.floor((BODY_BOTTOM - CONTINUATION_TOP - IMAGE_GAP - height + 1e-6) / LINE_PITCH));
  });

  it('lays a letter out on its own page count exactly as on the most pages (#589 review round 1)', () => {
    // A property of the layout, for text whose last line draws something. Text
    // that ends in a line drawing nothing differs: at its own page count that
    // line is overflow, while flowing on drops it from the top of a later page.
    // letterPrintText trims whitespace but not invisible characters, so the
    // print does not rely on this: it lays a letter out at the most pages, as
    // the previews do (#589 review round 3). The counts here never end
    // blankRuns on a blank line (a count that is a multiple of 7).
    const blankRuns = (count: number) =>
      Array.from({ length: count }, (_, index) => (index % 7 === 6 ? '' : `Line ${index + 1} of a letter`)).join('\n');
    let compared = 0;
    for (const stationery of [undefined, { theme: 'botanical' as const, dateLine: 'October 2, 2026' }, { theme: 'handwritten' as const, dateLine: 'October 2, 2026' }]) {
      for (const layoutType of ['text_only', 'header_image', 'inline_image'] as const) {
        for (const count of [20, 26, 27, 40, 45, 59, 60, 66, 80, 92]) {
          for (const text of [numberedLines(count), blankRuns(count)]) {
            const content: LetterContent = { text, layoutType, ...(layoutType === 'text_only' ? {} : { image }), stationery };
            const most = layoutLetter(content, { maxPages: MAX_LETTER_PAGES });
            if (most.overflowLines > 0) continue;
            expect(layoutLetter(content, { maxPages: most.pages.length }), `${stationery?.theme ?? 'classic'} ${layoutType} ${count}`).toEqual(most);
            compared += 1;
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(100);
    // Some 180 layouts: 3.6 s alone, but past the global 10 s when the whole unit
    // suite runs in parallel on a busy machine (twice in a row, 2026-10-03).
  }, 30_000);

  it.each([0, 4, 1.5, Number.NaN, -1])('refuses a limit of %s pages', maxPages => {
    expect(() => layoutLetter({ text: 'Hello', layoutType: 'text_only' }, { maxPages })).toThrow(RangeError);
  });
});

describe('how full a letter is (#586)', () => {
  it('counts the room left on a one-page letter, in lines and about how many characters', () => {
    const layout = layoutLetter({ text: letterText(1), layoutType: 'text_only' });
    const fit = pageFit(layout);
    expect(fit).toMatchObject({ pages: 1, sheets: 1, doubleSided: false });
    expect(fit.lines).toEqual([{ used: layout.pages[0].linesUsed, available: 26 }]);
    expect(fit.roomLines).toBe(26 - layout.pages[0].linesUsed);
    expect(fit.charactersPerLine).toBeGreaterThan(70);
    expect(fit.charactersPerLine).toBeLessThan(110);
    expect(fit.roomCharacters).toBe(fit.roomLines * fit.charactersPerLine);
  });

  it('prints two pages on one sheet, both sides, and three on two', () => {
    const two = pageFit(layoutLetter({ text: letterText(10), layoutType: 'text_only' }, { maxPages: 3 }));
    expect(two).toMatchObject({ pages: 2, sheets: 1, doubleSided: true });
    const three = pageFit(layoutLetter({ text: letterText(20), layoutType: 'text_only' }, { maxPages: 3 }));
    expect(three).toMatchObject({ pages: 3, sheets: 2, doubleSided: true });
    expect(three.lines.map(page => page.available)).toEqual([26, 33, 33]);
  });

  it('has no room left on a letter past its pages', () => {
    const fit = pageFit(layoutLetter({ text: letterText(40), layoutType: 'text_only' }, { maxPages: 3 }));
    expect(fit.roomLines).toBe(0);
    expect(fit.roomCharacters).toBe(0);
  });

  it("measures a line in the theme's own face: a typed line holds fewer characters", () => {
    const layout = layoutLetter({ text: letterText(1), layoutType: 'text_only' });
    const classic = pageFit(layout).charactersPerLine;
    const typed = pageFit(layout, { theme: 'typewriter' }).charactersPerLine;
    expect(typed).toBeLessThan(classic);
  });
});

describe('the PDF of a longer letter (#586)', () => {
  it('has one US Letter page per page of the letter', async () => {
    const layout = layoutLetter({ text: letterText(20), layoutType: 'text_only' }, { maxPages: 3 });
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(await renderPdf(layout)), disableFontFace: true, isEvalSupported: false }).promise;
    expect(pdf.numPages).toBe(3);
    for (let page = 1; page <= 3; page += 1) {
      const [, , width, height] = (await pdf.getPage(page)).view;
      expect([width, height]).toEqual([612, 792]);
    }
  });
});
