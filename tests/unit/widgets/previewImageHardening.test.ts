/**
 * Card hardening (#684). A legacy preview's picture reaches a card only as a data URL of a raster image, put in place
 * with DOM calls; a postcard's legacy front gives the card its picture and nothing else; and no page may frame a card
 * from the public widget route.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';
import type { ServerResponse } from 'http';
import { inlineHostBridge } from '../../../src/mcp/widgetHost.js';
import { serveWidget } from '../../../src/mcp/httpServer.js';

const WIDGET_DIR = path.resolve(__dirname, '../../../widgets');
const GOOD = 'data:image/png;base64,iVBORw0KGgo=';
const HOSTILE = [
  `${GOOD}" onerror="window.__pwned = 1`,
  'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIj48L3N2Zz4=',
  'javascript:window.__pwned = 1',
  'https://evil.example/t.png',
  `${GOOD} `,
  ''
];

const doms: JSDOM[] = [];
afterEach(() => {
  for (const dom of doms.splice(0)) dom.window.close();
});

function cardHtml(file: string): string {
  const html = inlineHostBridge(fs.readFileSync(path.join(WIDGET_DIR, file), 'utf-8'), WIDGET_DIR);
  return html.replace('<script type="module">', '<script>');
}

function mountLetter(layoutType: 'header_image' | 'inline_image', picture: string): JSDOM {
  const key = layoutType === 'header_image' ? 'headerImagePreview' : 'inlineImagePreview';
  const dom = new JSDOM(cardHtml('LetterPreviewCard.html'), {
    runScripts: 'dangerously',
    beforeParse(window) {
      (window as unknown as Record<string, unknown>).openai = {
        theme: 'light',
        toolOutput: { draftId: 'draft_test_0684', layoutType, lettersRequired: 1, canSendNow: true },
        toolResponseMetadata: { previewHtml: '<div class="letter-body">Hello</div><div class="sign-off">Bye</div>', [key]: picture },
        callTool: async () => ({})
      };
    }
  });
  dom.window.dispatchEvent(new dom.window.Event('openai:set_globals'));
  doms.push(dom);
  return dom;
}

function mountPostcard(previewFrontHtml: string): JSDOM {
  const dom = new JSDOM(cardHtml('PostcardPreviewCard.html'), {
    runScripts: 'dangerously',
    beforeParse(window) {
      (window as unknown as Record<string, unknown>).openai = {
        theme: 'light',
        toolOutput: { draftId: 'draft_test_0684', lettersRequired: 1, canSendNow: true, message: 'Hi' },
        toolResponseMetadata: { previewFrontHtml },
        callTool: async () => ({})
      };
    }
  });
  dom.window.dispatchEvent(new dom.window.Event('openai:set_globals'));
  doms.push(dom);
  return dom;
}

describe("the letter card's legacy preview pictures (#684)", () => {
  it.each([['header_image' as const, '.header-image-wrapper'], ['inline_image' as const, '.inline-image-wrapper']])(
    '%s: a data URL of a raster image is shown, made with DOM calls',
    (layout, wrapper) => {
      const slot = mountLetter(layout, GOOD).window.document.querySelector(wrapper)!;
      expect(slot.querySelector('img')?.getAttribute('src')).toBe(GOOD);
    }
  );

  it.each(HOSTILE.flatMap(value => [['header_image' as const, '.header-image-wrapper', value], ['inline_image' as const, '.inline-image-wrapper', value]]))(
    '%s: refuses %s',
    async (layout, wrapper, value) => {
      const dom = mountLetter(layout, value);
      const slot = dom.window.document.querySelector(wrapper)!;
      expect(slot.querySelector('img')).toBeNull();
      expect(slot.textContent).toContain('Image not shown on this card');
      // Nothing the value carried became markup: jsdom loads no images, so a handler is checked for, not waited on.
      expect(dom.window.document.querySelector('[onerror], [onload]')).toBeNull();
    }
  );
});

describe("the postcard card's legacy front (#684)", () => {
  const front = (src: string, extra = '') =>
    `<!DOCTYPE html><html><body><div class="postcard-front"><img src="${src}" alt="Postcard front" /></div>${extra}</body></html>`;

  it('shows the picture alone, made with DOM calls', () => {
    const pane = mountPostcard(front(GOOD)).window.document.getElementById('preview-front')!;
    expect(pane.querySelector('.postcard-front img')?.getAttribute('src')).toBe(GOOD);
  });

  it('takes nothing else of the document: no script, handler or other element', async () => {
    const dom = mountPostcard(
      front(GOOD, '<script>window.__pwned = 1</script><img src=x onerror="window.__pwned = 1"><a href="https://evil.example">x</a>')
    );
    const pane = dom.window.document.getElementById('preview-front')!;
    expect(pane.querySelectorAll('img')).toHaveLength(1);
    expect(pane.querySelector('script, a, [onerror]')).toBeNull();
  });

  it.each(HOSTILE)('refuses a front whose picture is %s', async value => {
    const dom = mountPostcard(front(value.replace(/"/g, '&quot;')));
    const pane = dom.window.document.getElementById('preview-front')!;
    expect(pane.querySelector('img')).toBeNull();
    expect(pane.textContent).toContain('No image preview available');
    expect(dom.window.document.querySelector('[onerror], [onload]')).toBeNull();
  });

  it('refuses a front with markup but no picture', () => {
    const pane = mountPostcard('<html><body><div class="postcard-front"><b onclick="x()">bold</b></div></body></html>').window.document.getElementById('preview-front')!;
    expect(pane.querySelector('b')).toBeNull();
    expect(pane.textContent).toContain('No image preview available');
  });
});

describe('the public widget route (#684)', () => {
  it('forbids every page from framing a card', async () => {
    const headers: Record<string, string> = {};
    const res = {
      statusCode: 0,
      setHeader: (name: string, value: string) => {
        headers[name.toLowerCase()] = value;
      },
      end: () => {}
    } as unknown as ServerResponse;
    expect(await serveWidget('LetterPreviewCard.html', res)).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(headers['content-security-policy']).toBe("frame-ancestors 'none'");
    expect(headers['x-frame-options']).toBe('DENY');
  });
});
