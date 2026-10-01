/**
 * The letter card shows the page our renderer drew (#534 Phase 3), the same
 * SVG the website's confirm page shows, instead of a mockup drawn from the
 * text; a gift send's card is its second page (PR 5). A legacy preview keeps
 * the mockup.
 *
 * This mounts the real card in jsdom (the letterPreviewCardEscaping pattern),
 * with a preview made by the real renderer and preview service.
 */

import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';
import { inlineHostBridge } from '../../../src/mcp/widgetHost.js';
import { layoutGiftPage, layoutLetter, renderPreviewSvg } from '../../../src/render/index.js';
import { renderLetterPreviewDocument } from '../../../src/services/previewService.js';
import { giftLetterPageCopy } from '../../../src/services/giftCardRenderer.js';

const WIDGET_DIR = path.resolve(__dirname, '../../../widgets');

const RENDERED = renderLetterPreviewDocument(
  renderPreviewSvg(layoutLetter({ text: 'Dear Sam,\nSee you soon.\nPat', layoutType: 'text_only' }), {
    addresses: { from: ['PAT EXAMPLE'], to: ['SAM RIVERA', 'NEW YORK, NY 10118'] }
  }),
  { bodyText: 'Dear Sam,\nSee you soon.', signOff: 'Pat' }
);

const LEGACY = '<div class="letter-body">Hello</div><div class="sign-off">Bye</div>';

function mount(previewHtml: string, { withPages = true } = {}) {
  const card = fs.readFileSync(path.join(WIDGET_DIR, 'LetterPreviewCard.html'), 'utf-8');
  const html = inlineHostBridge(withPages ? card : card.replace('<!-- letter-irl:pages -->', ''), WIDGET_DIR);
  // jsdom does not execute module scripts; the card's script parses as a classic one.
  const runnable = html.replace('<script type="module">', '<script>');
  const dom = new JSDOM(runnable, {
    runScripts: 'dangerously',
    beforeParse(window) {
      (window as unknown as Record<string, unknown>).openai = {
        theme: 'light',
        toolOutput: {
          draftId: 'draft_test_page',
          layoutType: 'text_only',
          lettersRequired: 1,
          canSendNow: true,
          deliveryClass: 'USPS First-Class Mail',
          deliveryEstimate: '1-2 weeks'
        },
        toolResponseMetadata: { previewHtml },
        callTool: async () => ({})
      };
    }
  });
  dom.window.dispatchEvent(new dom.window.Event('openai:set_globals'));
  return dom;
}

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

/**
 * The page the card shows is the page it was given: the same elements, the
 * same attributes and the same text, with only ids and outline links prefixed.
 */
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
  return before;
}

describe('LetterPreviewCard: the page as it prints', () => {
  // Every production image letter's preview carries a JPEG (imageService's
  // small copy); PNG is the other type the renderer reads (#542 review round 3).
  it.each(['image/jpeg', 'image/png'] as const)('keeps everything a real page draws, its %s image and stamp too, with only ids and outline links prefixed', mime => {
    // The renderer embeds the bytes it is given under the type it is told.
    const image = { bytes: pngBytes(1950, 900), mime, width: 1950, height: 900 };
    const source = renderLetterPreviewDocument(
      renderPreviewSvg(
        layoutLetter({ text: 'Dear Sam,\nThe picture is below.\nPat', layoutType: 'inline_image', image }),
        { addresses: { from: ['PAT EXAMPLE', '1 MAIN ST', 'SPRINGFIELD, IL 62701'], to: ['SAM RIVERA', '350 FIFTH AVE', 'SUITE 3300', 'NEW YORK, NY 10118'] } }
      ),
      { bodyText: 'Dear Sam,\nThe picture is below.', signOff: 'Pat' }
    );
    const dom = mount(source);
    const original = new dom.window.DOMParser().parseFromString(source, 'text/html').body.querySelector('svg')!;
    const shown = dom.window.document.querySelector('.letter-page svg')!;
    const before = expectSameDrawing(original, shown);
    // What the comparison covered: outlines with negative numbers, the image, the stamp.
    expect(before.some(element => element.localName === 'path' && /-\d/.test(element.getAttribute('d') ?? ''))).toBe(true);
    expect(shown.querySelector('image')!.getAttribute('href')!.startsWith(`data:${mime};base64,`)).toBe(true);
    expect(shown.querySelector('image')!.getAttribute('preserveAspectRatio')).toBe('none');
    expect(shown.querySelectorAll('text')).toHaveLength(7);
  });

  it.each(['monogram', 'botanical', 'celebration'] as const)("keeps a %s page whole: its theme's paths, strokes and every size of outline (#563)", theme => {
    const layout = layoutLetter({
      text: 'Dear Sam,\nSee you soon.\nPat',
      layoutType: 'text_only',
      stationery: { theme, dateLine: 'October 1, 2026', monogram: 'PE', headline: 'Happy Birthday, Sam!' }
    });
    const source = renderLetterPreviewDocument(
      renderPreviewSvg(layout, { addresses: { from: ['PAT EXAMPLE'], to: ['SAM RIVERA', 'NEW YORK, NY 10118'] } }),
      { bodyText: 'Dear Sam,\nSee you soon.', signOff: 'Pat' }
    );
    const dom = mount(source);
    const [original] = new dom.window.DOMParser().parseFromString(source, 'text/html').body.querySelectorAll(':scope > svg');
    const [shown] = dom.window.document.querySelectorAll('.letter-page svg');
    expectSameDrawing(original, shown);

    const drawn = layout.pages[0].items.filter(item => item.kind === 'path');
    const kept = [...shown.querySelectorAll(':scope > path')];
    expect(drawn.length).toBeGreaterThan(1);
    expect(kept.map(path => path.getAttribute('d'))).toEqual(drawn.map(path => path.d));
    expect(kept.some(path => path.getAttribute('stroke') === '#222222' && path.getAttribute('fill') === 'none')).toBe(theme !== 'celebration');
    const defined = new Set([...shown.querySelectorAll('defs path')].map(path => `#${path.getAttribute('id')}`));
    for (const link of [...shown.querySelectorAll('use')].map(use => use.getAttribute('href')!)) expect(defined.has(link)).toBe(true);
  });

  it("keeps a gift send's card whole, as the second page: its border, its QR, its outlines at every size", () => {
    const layout = layoutLetter({ text: 'Dear Sam,\nSee you soon.\nPat', layoutType: 'text_only' });
    const card = {
      state: 'funded' as const,
      code: 'K7M2QX9A',
      url: 'https://letterirl.com/g/K7M2QX9A',
      displayUrl: 'letterirl.com/g',
      redeemBy: '2026-12-16'
    };
    layout.pages.push(layoutGiftPage(giftLetterPageCopy(card, 'Pat Example')));
    const source = renderLetterPreviewDocument(
      renderPreviewSvg(layout, { addresses: { from: ['PAT EXAMPLE'], to: ['SAM RIVERA', 'NEW YORK, NY 10118'] } }),
      { bodyText: 'Dear Sam,\nSee you soon.', signOff: 'Pat' }
    );
    const dom = mount(source);
    const originals = new dom.window.DOMParser().parseFromString(source, 'text/html').body.querySelectorAll(':scope > svg');
    const shown = dom.window.document.querySelectorAll('.letter-page svg');
    expect(originals).toHaveLength(2);
    expect(shown).toHaveLength(2);
    expectSameDrawing(originals[0], shown[0]);
    expectSameDrawing(originals[1], shown[1]);

    const page = shown[1];
    const border = page.querySelector('rect[rx]')!;
    expect([border.getAttribute('rx'), border.getAttribute('fill'), border.getAttribute('stroke'), border.getAttribute('stroke-width')])
      .toEqual(['12', 'none', '#1f1a15', '1.5']);
    expect(page.querySelectorAll('g[fill="#000"] > rect').length).toBeGreaterThan(50);
    // Every outline the card uses is defined in it, the lede's 12.5pt ones too.
    const defined = new Set([...page.querySelectorAll('defs path')].map(path => `#${path.getAttribute('id')}`));
    const links = [...page.querySelectorAll('use')].map(use => use.getAttribute('href')!);
    for (const link of links) expect(defined.has(link)).toBe(true);
    expect(links.some(link => /^#lirl-page-tr12_5-\d+$/.test(link))).toBe(true);
    expect(page.querySelector('title')!.textContent).toContain('A GIFT INSIDE THIS LETTER');
  });

  it("shows the renderer's page, with its outlines and the stamped addresses, and no mockup", () => {
    const dom = mount(RENDERED);
    const container = dom.window.document.getElementById('mockup-container')!;
    const page = container.querySelector('.letter-page');
    expect(page).not.toBeNull();
    expect(container.querySelector('.letter-mockup')).toBeNull();

    const svg = page!.querySelector('svg')!;
    expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(svg.getAttribute('viewBox')).toBe('0 0 612 792');
    expect([...svg.querySelectorAll('text')].map(text => text.textContent)).toEqual([
      'PAT EXAMPLE',
      'SAM RIVERA',
      'NEW YORK, NY 10118'
    ]);
    // Every outline the page uses is defined in the page, under its prefixed id.
    const uses = [...svg.querySelectorAll('use')];
    expect(uses.length).toBeGreaterThan(10);
    const defined = new Set([...svg.querySelectorAll('defs path')].map(path => `#${path.getAttribute('id')}`));
    for (const use of uses) {
      expect(use.getAttribute('href')).toMatch(/^#lirl-page-tr12-\d+$/);
      expect(defined.has(use.getAttribute('href')!)).toBe(true);
    }
    // The white page, and the letter's text for screen readers.
    expect(svg.querySelector('rect')).not.toBeNull();
    expect(svg.querySelector('title')!.textContent).toBe('Dear Sam,\nSee you soon.\nPat');
    // The hidden legacy text is not shown: the page is.
    expect(container.querySelector('.letter-body')).toBeNull();
    expect(page!.querySelector('.layout-badge')!.textContent).toBe('Text');
  });

  it('exposes the page to screen readers as a labelled group, not inside a button', () => {
    const dom = mount(RENDERED);
    const page = dom.window.document.querySelector('.letter-page')!;
    expect(page.getAttribute('role')).toBe('group');
    expect(page.getAttribute('aria-label')).toBe('Your letter as it prints');
    expect(page.closest('button')).toBeNull();
    expect(page.querySelector('svg')!.getAttribute('role')).toBe('img');
  });

  it('enlarges the page from the button or the page, and keeps the size across renders', () => {
    const dom = mount(RENDERED);
    const document = dom.window.document;
    const view = () => document.querySelector('.letter-page-view')!;
    const zoom = () => document.querySelector('button.page-zoom') as HTMLButtonElement;
    expect(zoom().hasAttribute('aria-pressed')).toBe(false);
    expect(zoom().textContent).toBe('Enlarge');

    zoom().click();
    expect(view().classList.contains('zoomed')).toBe(true);
    expect(zoom().textContent).toBe('Show smaller');

    // A status update re-renders the card: the page stays enlarged, and drawn once.
    dom.window.dispatchEvent(new dom.window.Event('openai:set_globals'));
    expect(document.getElementById('mockup-container')!.children).toHaveLength(1);
    expect(view().classList.contains('zoomed')).toBe(true);

    (document.querySelector('.letter-page') as HTMLElement).click();
    expect(view().classList.contains('zoomed')).toBe(false);
    expect(zoom().textContent).toBe('Enlarge');
  });

  it('falls back to the mockup, never an uncleaned page, if the shared pages did not run', () => {
    const dom = mount(RENDERED, { withPages: false });
    const container = dom.window.document.getElementById('mockup-container')!;
    expect(container.querySelector('.letter-page')).toBeNull();
    expect(container.querySelector('svg')).toBeNull();
    // The hidden legacy text the renderer's document keeps for this.
    expect(container.textContent).toContain('See you soon.');
  });

  it('keeps the mockup for a legacy preview, even one whose text names the mark', () => {
    const dom = mount('<div class="letter-body">I wrote data-renderer in my letter</div><div class="sign-off">Bye</div>');
    const container = dom.window.document.getElementById('mockup-container')!;
    expect(container.querySelector('.letter-page')).toBeNull();
    expect(container.querySelector('.letter-mockup')).not.toBeNull();
    expect(container.textContent).toContain('I wrote data-renderer in my letter');

    const plain = mount(LEGACY).window.document.getElementById('mockup-container')!;
    expect(plain.querySelector('.letter-mockup')).not.toBeNull();
  });

  it('keeps the mockup for a document without the renderer mark, even with an SVG in it', () => {
    // A legacy gift preview carries the card page as an SVG. Here one sits
    // right under the body, beside text that names the mark: only the body's
    // own attribute makes a document a renderer page.
    const dom = mount(
      `<body><svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>` +
      `<div class="letter-body">My letter says data-renderer="pdf-1"</div><div class="sign-off">Bye</div></body>`
    );
    const container = dom.window.document.getElementById('mockup-container')!;
    expect(container.querySelector('.letter-page')).toBeNull();
    expect(container.querySelector('.letter-mockup')).not.toBeNull();
  });

  it('shows only what the renderer draws: no script, style, handler, paint server, outside link or borrowed id', () => {
    const hostile = `<!DOCTYPE html><html><body data-renderer="pdf-1">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 612 792" onload="window.__pwned = 1" style="background:url(https://x.example/p.png)" constructor="1">
        <script>window.__pwned = 1</script>
        <foreignObject width="10" height="10"><img src="x" onerror="window.__pwned = 1"></foreignObject>
        <rect width="612" height="792" fill="#fff" __proto__="2"/>
        <rect x="1" y="1" width="2" height="2" rx="calc(1px)" stroke="url(https://x.example/s.svg#s)" stroke-width="expression(1)"/>
        <rect x="1" y="1" width="2" height="2" rx="12" fill="none" stroke="#1f1a15" stroke-width="1.5"/>
        <defs><path id="tr12-1" d="M0 0L1 1Z"/></defs>
        <use href="#tr12-1" x="1" y="2"/>
        <use href="https://evil.example/sprite.svg#a" x="1" y="2"/>
        <use XLINK:HREF="https://evil.example/sprite.svg#b" x="1" y="2"/>
        <image href="javascript:window.__pwned = 1" x="0" y="0" width="1" height="1" onerror="window.__pwned = 1"/>
        <image xlink:href="https://evil.example/t.png" x="0" y="0" width="1" height="1"/>
        <image href="data:image/png;base64,iVBORw0KGgo=" x="0" y="0" width="1" height="1"/>
        <path d="M0 0Z" fill="url(https://x.example/p.svg#g)" filter="url(https://x.example/f.svg#f)" mask="url(#m)"/>
        <g id="send-button" cursor="url(https://x.example/c.cur), auto"><text x="1" y="1">fake</text></g>
        <a href="javascript:window.__pwned = 1"><text x="1" y="1">click</text></a>
      </svg></body></html>`;
    const dom = mount(hostile);
    const document = dom.window.document;
    const page = document.querySelector('.letter-page')!;
    expect(page).not.toBeNull();
    expect(page.querySelector('script')).toBeNull();
    expect(page.querySelector('foreignObject')).toBeNull();
    expect(page.querySelector('a')).toBeNull();

    const allowed = new Set(['xmlns', 'viewbox', 'role', 'id', 'd', 'x', 'y', 'width', 'height', 'preserveaspectratio', 'fill', 'rx', 'stroke', 'stroke-width', 'font-family', 'font-size', 'href']);
    for (const element of page.querySelectorAll('svg, svg *')) {
      for (const attribute of element.attributes) expect(allowed.has(attribute.name.toLowerCase()), attribute.name).toBe(true);
    }
    expect(page.querySelector('svg')!.hasAttribute('style')).toBe(false);
    // Prototype names find nothing in the allow-list, rather than throwing.
    expect(page.querySelector('svg')!.hasAttribute('constructor')).toBe(false);
    expect(page.querySelector('rect')!.attributes).toHaveLength(3);
    // A border keeps a radius, a colour and a width, and nothing else in their place.
    const [, hostileBorder, border] = page.querySelectorAll('rect');
    expect([...hostileBorder.attributes].map(attribute => attribute.name)).toEqual(['x', 'y', 'width', 'height']);
    expect([...border.attributes].map(attribute => `${attribute.name}=${attribute.value}`)).toEqual([
      'x=1', 'y=1', 'width=2', 'height=2', 'rx=12', 'fill=none', 'stroke=#1f1a15', 'stroke-width=1.5'
    ]);
    expect(page.querySelector('path[d="M0 0Z"]')!.hasAttribute('fill')).toBe(false);

    const links = [...page.querySelectorAll('use, image')].map(element => element.getAttribute('href'));
    expect(links).toEqual(['#lirl-page-tr12-1', null, null, null, null, 'data:image/png;base64,iVBORw0KGgo=']);

    // The page cannot stand in for the card's own Send button.
    expect(page.querySelector('#lirl-page-send-button')).not.toBeNull();
    expect(document.getElementById('send-button')!.closest('.letter-page')).toBeNull();
    expect((dom.window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});
