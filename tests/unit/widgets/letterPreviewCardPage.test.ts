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
    const page = container.querySelector('button.letter-page');
    expect(page).not.toBeNull();
    expect(container.querySelector('.letter-mockup')).toBeNull();

    const svg = page!.querySelector('svg')!;
    expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(svg.getAttribute('viewBox')).toBe('0 0 612 792');
    expect(svg.querySelectorAll('use').length).toBeGreaterThan(10);
    expect([...svg.querySelectorAll('text')].map(text => text.textContent)).toEqual([
      'PAT EXAMPLE',
      'SAM RIVERA',
      'NEW YORK, NY 10118'
    ]);
    // The hidden legacy text is not shown: the page is.
    expect(container.querySelector('.letter-body')).toBeNull();
    expect(page!.querySelector('.layout-badge')!.textContent).toBe('Text');
  });

  it('enlarges the page on a select, and restores it on the next', () => {
    const dom = mount(RENDERED);
    const page = dom.window.document.querySelector('button.letter-page') as HTMLButtonElement;
    expect(page.getAttribute('aria-pressed')).toBe('false');
    page.click();
    expect(page.classList.contains('zoomed')).toBe(true);
    expect(page.getAttribute('aria-pressed')).toBe('true');
    page.click();
    expect(page.classList.contains('zoomed')).toBe(false);
    expect(page.getAttribute('aria-pressed')).toBe('false');
  });

  it('keeps the mockup for a legacy preview', () => {
    const dom = mount(LEGACY);
    const container = dom.window.document.getElementById('mockup-container')!;
    expect(container.querySelector('.letter-page')).toBeNull();
    expect(container.querySelector('.letter-mockup')).not.toBeNull();
    expect(container.textContent).toContain('Hello');
  });

  it('keeps the mockup for a document without the renderer mark, even with an SVG in it', () => {
    // A legacy gift preview carries the card page as an SVG.
    const dom = mount(`<body>${'<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'}${LEGACY}</body>`);
    const container = dom.window.document.getElementById('mockup-container')!;
    expect(container.querySelector('.letter-page')).toBeNull();
    expect(container.querySelector('.letter-mockup')).not.toBeNull();
  });

  it('shows only what the renderer draws: no script, no foreign content, no handlers, no outside links', () => {
    const hostile = `<!DOCTYPE html><html><body data-renderer="pdf-1">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 612 792" onload="window.__pwned = 1">
        <script>window.__pwned = 1</script>
        <foreignObject width="10" height="10"><img src="x" onerror="window.__pwned = 1"></foreignObject>
        <defs><path id="tr12-1" d="M0 0L1 1Z"/></defs>
        <use href="#tr12-1" x="1" y="2"/>
        <use href="https://evil.example/sprite.svg#a" x="1" y="2"/>
        <image href="javascript:window.__pwned = 1" x="0" y="0" width="1" height="1" onerror="window.__pwned = 1"/>
        <image href="data:image/png;base64,iVBORw0KGgo=" x="0" y="0" width="1" height="1"/>
        <a href="javascript:window.__pwned = 1"><text x="1" y="1">click</text></a>
      </svg></body></html>`;
    const dom = mount(hostile);
    const page = dom.window.document.querySelector('button.letter-page')!;
    expect(page).not.toBeNull();
    expect(page.querySelector('script')).toBeNull();
    expect(page.querySelector('foreignObject')).toBeNull();
    expect(page.querySelector('a')).toBeNull();
    for (const element of page.querySelectorAll('*')) {
      for (const attribute of element.attributes) expect(attribute.name.startsWith('on'), attribute.name).toBe(false);
    }
    const links = [...page.querySelectorAll('use, image')].map(element => element.getAttribute('href'));
    expect(links).toEqual(['#tr12-1', null, null, 'data:image/png;base64,iVBORw0KGgo=']);
    expect((dom.window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});
