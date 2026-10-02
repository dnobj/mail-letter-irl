/**
 * The letter card's envelope reveal (#576): while the preview's _meta turns
 * it on, the page opens from a window envelope the first time the card shows
 * a draft, and folds back into it once the letter is sent. Framed by a fake
 * MCP Apps host, as letterPreviewCardStyle.test.ts is.
 */

import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';
import { inlineHostBridge } from '../../../src/mcp/widgetHost.js';
import { stampPreviewTool } from '../../../src/mcp/registerTools.js';

const WIDGET_DIR = path.resolve(__dirname, '../../../widgets');
const REVEAL = 'letterirl/envelopeReveal';

type Json = Record<string, any>;

const recipient = { name: 'Sam Rivera', addressLine1: '1 Main St', city: 'Springfield', state: 'IL', postalCode: '62701' };
const ARGS = { recipient, bodyText: 'Dear Sam,', signOff: 'Pat' };
const PAGE =
  '<!DOCTYPE html><html><body data-renderer="pdf-1">' +
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 612 792" role="img"><title>Dear Sam,\nPat</title>' +
  '<rect width="612" height="792" fill="#fff"/></svg>' +
  '<div hidden><div class="letter-body">Dear Sam,</div><div class="sign-off">Pat</div></div></body></html>';

const output = {
  draftId: 'draft_0001',
  layoutType: 'text_only',
  lettersRequired: 1,
  canSendNow: true,
  sendEligibility: {
    payAndSend: { available: false, unavailableReason: "Pay & Send isn't available in this app." },
    letterPack: { available: false, purchaseUrl: 'https://letterirl.example/packs' }
  }
};

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise(resolve => setImmediate(resolve));
}

/** The card as served, in a fake MCP Apps host; `still` turns on reduced motion. */
function mount(options: { still?: boolean } = {}) {
  const served = stampPreviewTool(
    inlineHostBridge(fs.readFileSync(path.join(WIDGET_DIR, 'LetterPreviewCard.html'), 'utf-8'), WIDGET_DIR),
    'quote_and_preview_letter'
  );
  const sent: Json[] = [];
  const parent = { postMessage: (message: Json) => sent.push(JSON.parse(JSON.stringify(message))) };
  const dom = new JSDOM(served.replace('<script type="module">', '<script>'), {
    runScripts: 'dangerously',
    beforeParse(window) {
      Object.defineProperty(window, 'parent', { value: parent, configurable: true });
      Object.defineProperty(window.document, 'hidden', { get: () => false });
      (window as any).setTimeout = () => 0;
      (window as any).clearTimeout = () => undefined;
      (window as any).matchMedia = (query: string) => ({ matches: !!options.still && query.includes('reduce'), addEventListener() {}, removeEventListener() {} });
    }
  });
  const window = dom.window as any;
  const document = window.document as Document;
  const deliver = async (message: Json) => {
    window.dispatchEvent(new window.MessageEvent('message', { data: { jsonrpc: '2.0', ...message }, source: parent }));
    await flush();
  };
  const lastRequest = (method: string, name?: string) =>
    [...sent].reverse().find(message => message.method === method && message.id !== undefined && (name === undefined || message.params?.name === name));
  let initialized = false;
  const view = () => document.querySelector('.letter-page-view') as HTMLElement;
  return {
    document,
    lastRequest,
    async show(meta: Json) {
      await flush();
      if (!initialized) {
        initialized = true;
        await deliver({
          id: lastRequest('ui/initialize')!.id,
          result: { protocolVersion: '2026-01-26', hostInfo: { name: 'fake' }, hostContext: {}, hostCapabilities: {} }
        });
        await deliver({ method: 'ui/notifications/tool-input', params: { arguments: ARGS } });
      }
      await deliver({
        method: 'ui/notifications/tool-result',
        params: { content: [{ type: 'text', text: 'Preview ready.' }], structuredContent: output, _meta: meta }
      });
    },
    async answer(reply: Json, name: string) {
      const request = lastRequest('tools/call', name);
      if (!request) throw new Error(`the card sent no ${name}`);
      await deliver({ id: request.id, ...reply });
    },
    async click(element: Element) {
      element.dispatchEvent(new window.Event('click'));
      await flush();
    },
    view,
    page: () => document.querySelector('.letter-page') as HTMLElement,
    envelope: () => document.querySelector('.letter-page > svg.envelope'),
    states: () => [...view().classList].filter(name => name.startsWith('envelope-')),
    zoomLabel: () => document.querySelector('.page-zoom')!.textContent,
    end: () => document.querySelector('.letter-page')!.dispatchEvent(new window.Event('animationend', { bubbles: true }))
  };
}

const ON = { previewHtml: PAGE, [REVEAL]: true };
const sendButton = (card: ReturnType<typeof mount>) => card.document.getElementById('send-button')!;

describe('the envelope reveal on the letter card (#576)', () => {
  it('lets presses through the envelope, and clips to its height whatever the pages: a gift letter folds to one envelope (#577 review round 1)', () => {
    const served = inlineHostBridge(fs.readFileSync(path.join(WIDGET_DIR, 'LetterPreviewCard.html'), 'utf-8'), WIDGET_DIR);
    expect(served).toMatch(/\.letter-page svg\.envelope\{[^}]*pointer-events:none/);
    expect(served).toContain('.envelope-opening,.envelope-sealing,.envelope-sealed{container-type:inline-size}');
    // 264/612 of the width: the envelope's own height, never a share of a two-page box.
    expect(served).toContain('@keyframes envelope-unfold{from{clip-path:inset(0 0 calc(100% - 43.137cqw) 0)}to{clip-path:inset(0)}}');
    expect(served).toContain('@keyframes envelope-fold{from{clip-path:inset(0)}to{clip-path:inset(0 0 calc(100% - 43.137cqw) 0)}}');
    expect(served).not.toContain('66.67%');
    expect((612 * 0.43137).toFixed(1)).toBe('264.0');
  });

  it("plays the opening on through a redraw that changes nothing: the card's own get_draft_status answer, or the host's (#577 review round 1)", async () => {
    const card = mount();
    await card.show(ON);
    const opening = card.view();
    expect(card.states()).toEqual(['envelope-opening']);
    await card.answer(
      { result: { content: [], structuredContent: { draftId: 'draft_0001', status: 'ready', deliveryEstimate: 'Mailed in 1-2 business days' } } },
      'get_draft_status'
    );
    expect(card.view()).toBe(opening);
    expect(card.states()).toEqual(['envelope-opening']);
    await card.show(ON);
    expect(card.view()).toBe(opening);
    expect(card.states()).toEqual(['envelope-opening']);
    card.end();
    expect(card.states()).toEqual([]);
  });

  it('plays the fold on through a redraw too (#577 review round 1)', async () => {
    const card = mount();
    await card.show(ON);
    card.end();
    await card.click(sendButton(card));
    await card.answer({ result: { content: [], structuredContent: { orderId: 'ord_0001' } } }, 'send_letter');
    const folding = card.view();
    expect(card.states()).toEqual(['envelope-sealing']);
    await card.show(ON);
    expect(card.view()).toBe(folding);
    expect(card.states()).toEqual(['envelope-sealing']);
    card.end();
    expect(card.states()).toEqual(['envelope-sealed']);
  });

  it('draws the page anew when it changes, and does not open it again', async () => {
    const card = mount();
    await card.show(ON);
    card.end();
    const before = card.view();
    await card.show({ ...ON, previewHtml: PAGE.replace('Dear Sam,\nPat', 'Dear Sam,\nAgain,\nPat') });
    expect(card.view()).not.toBe(before);
    expect(card.states()).toEqual([]);
  });

  it("opens the page from the envelope the first time it shows a draft, while the preview's _meta turns it on", async () => {
    const card = mount();
    await card.show(ON);
    expect(card.states()).toEqual(['envelope-opening']);
    expect(card.envelope()).not.toBeNull();
    card.end();
    expect(card.states()).toEqual([]);
    expect(card.envelope()).toBeNull();
    expect(card.zoomLabel()).toBe('Enlarge');
  });

  it('does not open again when the host draws the card again', async () => {
    const card = mount();
    await card.show(ON);
    card.end();
    await card.show(ON);
    expect(card.states()).toEqual([]);
    expect(card.envelope()).toBeNull();
  });

  it('is the page as it always was while the reveal is off', async () => {
    const card = mount();
    await card.show({ previewHtml: PAGE });
    expect(card.states()).toEqual([]);
    expect(card.envelope()).toBeNull();
    await card.click(sendButton(card));
    await card.answer({ result: { content: [], structuredContent: { orderId: 'ord_0001' } } }, 'send_letter');
    expect(card.states()).toEqual([]);
    expect(card.zoomLabel()).toBe('Enlarge');
  });

  it('moves nothing with reduced motion: the page shows at once, and a sent letter is sealed at once', async () => {
    const card = mount({ still: true });
    await card.show(ON);
    expect(card.states()).toEqual([]);
    expect(card.envelope()).toBeNull();
    await card.click(sendButton(card));
    await card.answer({ result: { content: [], structuredContent: { orderId: 'ord_0001' } } }, 'send_letter');
    expect(card.states()).toEqual(['envelope-sealed']);
  });

  it('keeps Send working while the page opens', async () => {
    const card = mount();
    await card.show(ON);
    expect(card.states()).toEqual(['envelope-opening']);
    await card.click(sendButton(card));
    expect(card.lastRequest('tools/call', 'send_letter')).toBeDefined();
  });

  it('folds a sent letter into the envelope, keeps it sealed through a redraw, and shows it again on a press', async () => {
    const card = mount();
    await card.show(ON);
    card.end();
    await card.click(sendButton(card));
    await card.answer({ result: { content: [], structuredContent: { orderId: 'ord_0001' } } }, 'send_letter');
    expect(card.states()).toEqual(['envelope-sealing']);
    expect(card.envelope()).not.toBeNull();
    card.end();
    expect(card.states()).toEqual(['envelope-sealed']);
    expect(card.zoomLabel()).toBe('Show the letter');

    await card.show(ON);
    expect(card.states()).toEqual(['envelope-sealed']);

    await card.click(card.page());
    expect(card.states()).toEqual([]);
    expect(card.envelope()).toBeNull();
    expect(card.zoomLabel()).toBe('Enlarge');
    // Not enlarged by the same press.
    expect(card.view().classList.contains('zoomed')).toBe(false);
  });

  it('folds a scheduled letter in too', async () => {
    const card = mount();
    await card.show(ON);
    card.end();
    await card.click(sendButton(card));
    await card.answer(
      {
        result: {
          content: [],
          structuredContent: { orderId: 'ord_0001', currentStatus: 'scheduled', schedule: { arriveBy: '2026-10-16', mailOn: '2026-10-06' }, cancellable: true }
        }
      },
      'send_letter'
    );
    expect(card.states()).toEqual(['envelope-sealing']);
  });

  it('leaves the page open when the send is refused', async () => {
    const card = mount();
    await card.show(ON);
    card.end();
    await card.click(sendButton(card));
    await card.answer({ result: { isError: true, content: [{ type: 'text', text: 'Not enough letters.' }] } }, 'send_letter');
    expect(card.states()).toEqual([]);
    expect(card.envelope()).toBeNull();
  });
});
