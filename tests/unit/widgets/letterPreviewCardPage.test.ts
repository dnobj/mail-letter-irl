/**
 * The letter card shows the page our renderer drew (#534 Phase 3), the same
 * SVG the website's confirm page shows, instead of a mockup drawn from the
 * text. A legacy preview, and a gift send's, keep the mockup.
 *
 * This mounts the real card in jsdom (the letterPreviewCardEscaping pattern),
 * with a preview made by the real renderer and preview service.
 */

import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';
import { inlineHostBridge } from '../../../src/mcp/widgetHost.js';
import { layoutLetter, renderPreviewSvg } from '../../../src/render/index.js';
import { renderLetterPreviewDocument } from '../../../src/services/previewService.js';

const WIDGET_DIR = path.resolve(__dirname, '../../../widgets');

const RENDERED = renderLetterPreviewDocument(
  renderPreviewSvg(layoutLetter({ text: 'Dear Sam,\nSee you soon.\nPat', layoutType: 'text_only' }), {
    addresses: { from: ['PAT EXAMPLE'], to: ['SAM RIVERA', 'NEW YORK, NY 10118'] }
  }),
  { bodyText: 'Dear Sam,\nSee you soon.', signOff: 'Pat' }
);

const LEGACY = '<div class="letter-body">Hello</div><div class="sign-off">Bye</div>';

function mount(previewHtml: string) {
  const html = inlineHostBridge(
    fs.readFileSync(path.join(WIDGET_DIR, 'LetterPreviewCard.html'), 'utf-8'),
    WIDGET_DIR
  );
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

describe('LetterPreviewCard: the page as it prints', () => {
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
    expect(zoom().getAttribute('aria-pressed')).toBe('false');
    expect(zoom().textContent).toBe('Enlarge');

    zoom().click();
    expect(view().classList.contains('zoomed')).toBe(true);
    expect(zoom().getAttribute('aria-pressed')).toBe('true');
    expect(zoom().textContent).toBe('Show smaller');

    // A status update re-renders the card: the page stays enlarged, and drawn once.
    dom.window.dispatchEvent(new dom.window.Event('openai:set_globals'));
    expect(document.getElementById('mockup-container')!.children).toHaveLength(1);
    expect(view().classList.contains('zoomed')).toBe(true);

    (document.querySelector('.letter-page') as HTMLElement).click();
    expect(view().classList.contains('zoomed')).toBe(false);
    expect(zoom().getAttribute('aria-pressed')).toBe('false');
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
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 612 792" onload="window.__pwned = 1" style="background:url(https://x.example/p.png)">
        <script>window.__pwned = 1</script>
        <foreignObject width="10" height="10"><img src="x" onerror="window.__pwned = 1"></foreignObject>
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

    const allowed = new Set(['xmlns', 'viewbox', 'role', 'id', 'd', 'x', 'y', 'width', 'height', 'preserveaspectratio', 'fill', 'font-family', 'font-size', 'href']);
    for (const element of page.querySelectorAll('svg, svg *')) {
      for (const attribute of element.attributes) expect(allowed.has(attribute.name.toLowerCase()), attribute.name).toBe(true);
    }
    expect(page.querySelector('svg')!.hasAttribute('style')).toBe(false);
    expect(page.querySelector('path[d="M0 0Z"]')!.hasAttribute('fill')).toBe(false);

    const links = [...page.querySelectorAll('use, image')].map(element => element.getAttribute('href'));
    expect(links).toEqual(['#lirl-page-tr12-1', null, null, null, null, 'data:image/png;base64,iVBORw0KGgo=']);

    // The page cannot stand in for the card's own Send button.
    expect(page.querySelector('#lirl-page-send-button')).not.toBeNull();
    expect(document.getElementById('send-button')!.closest('.letter-page')).toBeNull();
    expect((dom.window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});
