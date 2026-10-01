/**
 * The postcard card shows the pages our renderer drew (#534 Phase 4): the
 * front and the back as they print, the addresses where PostGrid stamps them,
 * cleaned by the same shared code as the letter card's page
 * (widgets/shared/pages.js). A legacy preview keeps the card's own front and
 * its mockup of the back.
 *
 * This mounts the real card in jsdom (the letterPreviewCardPage pattern), with
 * a document made by the real renderer and preview service.
 */

import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';
import { inlineHostBridge } from '../../../src/mcp/widgetHost.js';
import { layoutPostcard, POSTCARD_STAMP, renderPreviewSvg } from '../../../src/render/index.js';
import { renderPostcardPreviewDocument } from '../../../src/services/previewService.js';
import { giftPostcardStripCopy } from '../../../src/services/giftCardRenderer.js';

const WIDGET_DIR = path.resolve(__dirname, '../../../widgets');

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

const RENDERED = renderPostcardPreviewDocument(renderPreviewSvg(
  layoutPostcard({
    message: 'Dear Sam,\nWish you were here.\nPat',
    image: { bytes: pngBytes(540, 360), mime: 'image/png', width: 540, height: 360 }
  }),
  {
    addresses: { from: ['RETURN TO:', 'PAT EXAMPLE', '1 MAIN ST', 'SPRINGFIELD, IL 62701'], to: ['SAM RIVERA', '350 FIFTH AVE', 'NEW YORK, NY 10118'] },
    stamp: { page: 1, geometry: POSTCARD_STAMP }
  }
));

/** A gift postcard's preview: its card in a strip at the foot of the message (#534 PR 8). */
const GIFT_RENDERED = renderPostcardPreviewDocument(renderPreviewSvg(
  layoutPostcard({
    message: 'Dear Sam,\nWish you were here.',
    image: { bytes: pngBytes(540, 360), mime: 'image/png', width: 540, height: 360 },
    strip: giftPostcardStripCopy(
      { state: 'funded', url: 'https://letterirl.com/g', displayUrl: 'letterirl.com/g', redeemBy: '2026-12-30', sample: true },
      'Pat Example'
    )
  }),
  {
    addresses: { from: ['RETURN TO:', 'PAT EXAMPLE', '1 MAIN ST', 'SPRINGFIELD, IL 62701'], to: ['SAM RIVERA', '350 FIFTH AVE', 'NEW YORK, NY 10118'] },
    stamp: { page: 1, geometry: POSTCARD_STAMP }
  }
));

const LEGACY_FRONT = '<html><body><div class="postcard-front"><img src="data:image/png;base64,AAAA" alt="Postcard front" /></div></body></html>';

function mount(meta: Record<string, unknown>, { withPages = true } = {}) {
  const card = fs.readFileSync(path.join(WIDGET_DIR, 'PostcardPreviewCard.html'), 'utf-8');
  const html = inlineHostBridge(withPages ? card : card.replace('<!-- letter-irl:pages -->', ''), WIDGET_DIR);
  // jsdom does not execute module scripts; the card's script parses as a classic one.
  const runnable = html.replace('<script type="module">', '<script>');
  const dom = new JSDOM(runnable, {
    runScripts: 'dangerously',
    beforeParse(window) {
      (window as unknown as Record<string, unknown>).openai = {
        theme: 'light',
        toolOutput: {
          draftId: 'draft_test_postcard',
          lettersRequired: 1,
          canSendNow: true,
          message: 'Dear Sam,\nWish you were here.\nPat',
          recipientName: 'Sam Rivera',
          recipientAddressLine1: '350 Fifth Ave',
          recipientCity: 'New York',
          recipientState: 'NY',
          recipientPostalCode: '10118',
          senderName: 'Pat Example'
        },
        toolResponseMetadata: meta,
        callTool: async () => ({})
      };
    }
  });
  dom.window.dispatchEvent(new dom.window.Event('openai:set_globals'));
  return dom;
}

/** The page shown is the page given: the same elements, attributes and text, ids and outline links prefixed. */
function expectSameDrawing(original: Element, shown: Element) {
  const walk = (root: Element) => [root, ...root.querySelectorAll('*')];
  const before = walk(original);
  const after = walk(shown);
  expect(after.map(element => element.localName)).toEqual(before.map(element => element.localName));
  const prefixed = (name: string, value: string) =>
    name === 'id' ? `lirl-page-${value}` : name === 'href' && value.startsWith('#') ? `#lirl-page-${value.slice(1)}` : value;
  before.forEach((element, index) => {
    const attributes = (target: Element) => [...target.attributes].map(attribute => [attribute.name, attribute.value]);
    expect(attributes(after[index])).toEqual(attributes(element).map(([name, value]) => [name, prefixed(name, value)]));
    if (element.children.length === 0) expect(after[index].textContent).toBe(element.textContent);
  });
}

describe('PostcardPreviewCard: the postcard as it prints', () => {
  it("shows the front and back our renderer drew, whole, in place of its own front and mockup", () => {
    const dom = mount({ previewHtml: RENDERED, previewFrontHtml: LEGACY_FRONT, previewBackHtml: '<p>legacy back</p>' });
    const document = dom.window.document;
    const originals = new dom.window.DOMParser().parseFromString(RENDERED, 'text/html').body.querySelectorAll(':scope > svg');
    const front = document.querySelector('#preview-front .postcard-page svg')!;
    const back = document.querySelector('#preview-back .postcard-page svg')!;
    expect(front).not.toBeNull();
    expect(back).not.toBeNull();
    expectSameDrawing(originals[0], front);
    expectSameDrawing(originals[1], back);

    // The front: the picture to the edges, bleed included.
    expect(front.getAttribute('viewBox')).toBe('0 0 666 450');
    expect(front.querySelector('image')!.getAttribute('href')!.startsWith('data:image/png;base64,')).toBe(true);
    // The back: the message's outlines, and the stamp where PostGrid puts it.
    expect(back.querySelectorAll('use').length).toBeGreaterThan(10);
    expect([...back.querySelectorAll('text')].map(text => text.textContent)).toEqual([
      'RETURN TO:', 'PAT EXAMPLE', '1 MAIN ST', 'SPRINGFIELD, IL 62701', 'SAM RIVERA', '350 FIFTH AVE', 'NEW YORK, NY 10118'
    ]);
    // Neither the legacy front nor the mockup.
    expect(document.querySelector('.postcard-front')).toBeNull();
    expect(document.querySelector('.postcard-back-mockup')).toBeNull();
  });

  it("shows a gift postcard's card on the back, whole: the rule, the QR and its words (#534 PR 8)", () => {
    const dom = mount({ previewHtml: GIFT_RENDERED, previewFrontHtml: LEGACY_FRONT });
    const document = dom.window.document;
    const original = new dom.window.DOMParser().parseFromString(GIFT_RENDERED, 'text/html').body.querySelectorAll(':scope > svg')[1];
    const back = document.querySelector('#preview-back .postcard-page svg')!;
    expectSameDrawing(original, back);
    const rects = (fill: string) => back.querySelectorAll(`g[fill="${fill}"] > rect`).length;
    expect(rects('#b9ad99')).toBe(1);
    expect(rects('#000')).toBeGreaterThan(50);
    expect(back.querySelector('title')!.textContent).toContain('Wish you were here.\nA gift from Pat Example:');
    // The card's own mockup, which draws the legacy strip, is not shown beside it.
    expect(document.querySelector('.postcard-back-mockup')).toBeNull();
  });

  it('names each page for screen readers, the front by its title', () => {
    const dom = mount({ previewHtml: RENDERED, previewFrontHtml: LEGACY_FRONT });
    const groups = [...dom.window.document.querySelectorAll('.postcard-page')];
    expect(groups.map(group => [group.getAttribute('role'), group.getAttribute('aria-label')])).toEqual([
      ['group', 'The front of your postcard, as it prints'],
      ['group', 'The back of your postcard, as it prints']
    ]);
    expect(groups[0].querySelector('svg > title')!.textContent).toBe('The front of the postcard');
    expect(groups[1].querySelector('svg > title')!.textContent).toBe('Dear Sam,\nWish you were here.\nPat');
  });

  it('falls back to its own front and mockup, never an uncleaned page, if the shared pages did not run', () => {
    const dom = mount({ previewHtml: RENDERED, previewFrontHtml: LEGACY_FRONT }, { withPages: false });
    const document = dom.window.document;
    expect(document.querySelector('.postcard-page')).toBeNull();
    expect(document.querySelector('#preview-front .postcard-front img')).not.toBeNull();
    expect(document.querySelector('#preview-back .postcard-back-mockup')).not.toBeNull();
  });

  it('keeps its own front and the mockup of the back for a legacy preview', () => {
    const dom = mount({ previewFrontHtml: LEGACY_FRONT, previewBackHtml: '<p>legacy back</p>' });
    const document = dom.window.document;
    expect(document.querySelector('.postcard-page')).toBeNull();
    expect(document.querySelector('#preview-front .postcard-front img')).not.toBeNull();
    expect(document.querySelector('#preview-back .postcard-back-mockup')).not.toBeNull();
  });

  it('cleans what a page carries before showing it, with the letter card\'s rules', () => {
    const hostile = `<!DOCTYPE html><html><body data-renderer="pdf-1">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 666 450" onload="window.__pwned = 1">
        <script>window.__pwned = 1</script>
        <image href="https://evil.example/t.png" x="0" y="0" width="1" height="1"/>
        <rect id="send-button" width="666" height="450" fill="url(#p)" style="cursor:pointer"/>
      </svg>
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 666 450">
        <foreignObject width="10" height="10"><img src="x" onerror="window.__pwned = 1"></foreignObject>
        <text x="1" y="1" onclick="window.__pwned = 1">RETURN TO:</text>
      </svg></body></html>`;
    const dom = mount({ previewHtml: hostile });
    const document = dom.window.document;
    const [front, back] = [...document.querySelectorAll('.postcard-page svg')];
    expect(front.hasAttribute('onload')).toBe(false);
    expect(front.querySelector('script')).toBeNull();
    expect(front.querySelector('image')!.hasAttribute('href')).toBe(false);
    const rect = front.querySelector('rect')!;
    expect([rect.getAttribute('id'), rect.hasAttribute('fill'), rect.hasAttribute('style')]).toEqual(['lirl-page-send-button', false, false]);
    expect(back.querySelector('foreignObject')).toBeNull();
    expect(back.querySelector('text')!.hasAttribute('onclick')).toBe(false);
    expect((dom.window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});
