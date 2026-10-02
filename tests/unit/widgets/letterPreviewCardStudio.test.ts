/**
 * The letter card as a studio (#580): while the preview's _meta carries
 * letterirl/studioCard, the card lays itself out with a header naming the
 * letter, the page beside Style, Words and Delivery tabs, and a footer with
 * the cost and Send. The rows and buttons are the card's own, moved, so each
 * still calls its tool (Principle 2). Without the switch nothing moves.
 * Framed by a fake MCP Apps host, as letterPreviewCardStyle.test.ts is.
 */

import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';
import { inlineHostBridge } from '../../../src/mcp/widgetHost.js';
import { stampPreviewTool } from '../../../src/mcp/registerTools.js';

const WIDGET_DIR = path.resolve(__dirname, '../../../widgets');
const STUDIO = 'letterirl/studioCard';
const REVEAL = 'letterirl/envelopeReveal';

type Json = Record<string, any>;

const recipient = { name: 'Sam Rivera', addressLine1: '1 Main St', city: 'Springfield', state: 'IL', postalCode: '62701' };
const ARGS = { recipient, bodyText: 'Dear Sam,\n\nThe garden is in.', signOff: 'Love,\nPat' };
const svg = (title: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 612 792" role="img"><title>${title}</title><rect width="612" height="792" fill="#fff"/></svg>`;
const document1 = (...titles: string[]) =>
  '<!DOCTYPE html><html><body data-renderer="pdf-1">' +
  titles.map(svg).join('') +
  '<div hidden><div class="letter-body">Dear Sam,</div><div class="sign-off">Pat</div></div></body></html>';
const PAGE = document1('Dear Sam,\nPat');
const GIFT_PAGES = document1('Dear Sam,\nPat', 'A letter for you');
const WINDOW = { earliestArrival: '2026-10-14', latestArrival: '2026-11-30' };

const canSend = {
  canSendNow: true,
  sendEligibility: {
    payAndSend: { available: false, unavailableReason: "Pay & Send isn't available in this app." },
    letterPack: { available: false, purchaseUrl: 'https://letterirl.example/packs' }
  }
};

const output = (extra: Json = {}) => ({
  draftId: 'draft_0001',
  layoutType: 'text_only',
  lettersRequired: 1,
  deliveryClass: 'First Class',
  deliveryEstimate: 'Mailed in 1-2 business days',
  ...canSend,
  ...extra
});

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise(resolve => setImmediate(resolve));
}

/** The card as served, in a fake MCP Apps host. */
function mount() {
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
      (window as any).matchMedia = (query: string) => ({ matches: query.includes('reduce'), addEventListener() {}, removeEventListener() {} });
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
  const byId = (id: string) => document.getElementById(id) as HTMLElement;
  return {
    window,
    document,
    lastRequest,
    byId,
    async show(result: Json, meta: Json, args: Json = ARGS) {
      await flush();
      if (!initialized) {
        initialized = true;
        await deliver({
          id: lastRequest('ui/initialize')!.id,
          result: { protocolVersion: '2026-01-26', hostInfo: { name: 'fake' }, hostContext: {}, hostCapabilities: {} }
        });
        await deliver({ method: 'ui/notifications/tool-input', params: { arguments: args } });
      }
      await deliver({
        method: 'ui/notifications/tool-result',
        params: { content: [{ type: 'text', text: 'Preview ready.' }], structuredContent: result, _meta: meta }
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
    async key(element: Element, key: string) {
      element.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }));
      await flush();
    },
    tab: (name: string) => document.querySelector(`[role="tab"][data-tab="${name}"]`) as HTMLElement,
    selected: () =>
      Array.from(document.querySelectorAll('[role="tab"]'))
        .filter(tab => tab.getAttribute('aria-selected') === 'true')
        .map(tab => tab.getAttribute('data-tab')),
    shownPanels: () =>
      Array.from(document.querySelectorAll('[role="tabpanel"]'))
        .filter(panel => !(panel as HTMLElement).hidden)
        .map(panel => panel.getAttribute('data-tab')),
    within: (id: string) => byId(id)?.parentElement?.closest('.studio-panel, .studio-hd, .studio-ft, .studio-page, .studio-side, .rows, .meta, .bd')
  };
}

const ON = { previewHtml: PAGE, [STUDIO]: true };
const text = (card: ReturnType<typeof mount>, id: string) => card.byId(id).textContent;

/** The card as served, in ChatGPT: window.openai carries the result and its _meta. */
function mountInChatGpt(meta: Json) {
  const served = stampPreviewTool(
    inlineHostBridge(fs.readFileSync(path.join(WIDGET_DIR, 'LetterPreviewCard.html'), 'utf-8'), WIDGET_DIR),
    'quote_and_preview_letter'
  );
  const dom = new JSDOM(served.replace('<script type="module">', '<script>'), {
    runScripts: 'dangerously',
    beforeParse(window) {
      (window as any).setTimeout = () => 0;
      (window as any).clearTimeout = () => undefined;
      (window as any).openai = {
        theme: 'light',
        toolInput: ARGS,
        toolOutput: output(),
        toolResponseMetadata: meta,
        widgetState: null,
        setWidgetState: async () => undefined,
        callTool: async () => ({})
      };
    }
  });
  dom.window.dispatchEvent(new dom.window.Event('openai:set_globals'));
  return dom.window.document;
}

describe('the letter studio in ChatGPT (#580 maker review round 1)', () => {
  it('lays itself out from the switch in toolResponseMetadata, and not without it', async () => {
    const document = mountInChatGpt(ON);
    await flush();
    expect(document.getElementById('card')!.classList.contains('studio')).toBe(true);
    expect(document.getElementById('studio-title')!.textContent).toBe('Letter to Sam Rivera');
    expect(document.getElementById('studio-words')!.textContent).toBe('Dear Sam,\n\nThe garden is in.\n\nLove,\nPat');

    const off = mountInChatGpt({ previewHtml: PAGE });
    await flush();
    expect(off.getElementById('card')!.classList.contains('studio')).toBe(false);
  });
});

describe('the letter card without the studio switch (#580)', () => {
  it('is laid out as it always was: nothing moves and the template stays a template', async () => {
    const card = mount();
    await card.show(output({ stationery: { theme: 'classic', source: 'default' }, arrivalWindow: WINDOW }), { previewHtml: PAGE });
    expect(card.byId('card').classList.contains('studio')).toBe(false);
    expect(card.byId('studio-body')).toBeNull();
    expect(card.document.querySelector('[role="tab"]')).toBeNull();
    expect(card.within('style-row')!.className).toBe('rows');
    expect(card.within('arrives-row')!.className).toBe('rows');
    expect(card.byId('mockup-container').parentElement!.className).toBe('bd');
    expect(card.byId('send-button').parentElement!.className).toBe('meta');
    expect(card.byId('status-pill').parentElement!.id).toBe('status-row');
    expect(card.byId('style-label').textContent).toBe('Style');
  });

  it('shows every page of a longer letter at once, as before', async () => {
    const card = mount();
    await card.show(output(), { previewHtml: GIFT_PAGES });
    const pages = card.document.querySelectorAll('.letter-page > svg[role="img"]');
    expect(pages).toHaveLength(2);
    expect(Array.from(pages).some(page => page.classList.contains('print-page'))).toBe(false);
    expect(card.document.querySelector('.page-tools')).toBeNull();
  });
});

describe('the letter card as a studio (#580)', () => {
  it('names the letter in its header, with the status beside it', async () => {
    const card = mount();
    await card.show(output(), ON);
    expect(card.byId('card').classList.contains('studio')).toBe(true);
    expect(text(card, 'studio-title')).toBe('Letter to Sam Rivera');
    expect(text(card, 'studio-sub')).toBe('Draft · Springfield, IL 62701');
    expect(card.within('status-pill')!.className).toBe('studio-hd');
    expect(text(card, 'status-pill')).toBe('Ready to send');
  });

  it('names the recipient as the server checked the address, and says "Your letter" with no name', async () => {
    const checked = mount();
    await checked.show(
      output({ recipientAddressValidation: { originalAddress: { name: 'Ruth Reed', city: 'Tucson', state: 'AZ', postalCode: '85719' } } }),
      ON
    );
    expect(text(checked, 'studio-title')).toBe('Letter to Ruth Reed');
    expect(text(checked, 'studio-sub')).toBe('Draft · Tucson, AZ 85719');

    const nameless = mount();
    await nameless.show(output(), ON, { ...ARGS, recipient: { ...recipient, name: '  ' } });
    expect(text(nameless, 'studio-title')).toBe('Your letter');
  });

  it("moves the card's own rows into the tabs, and the page and Send beside them", async () => {
    const card = mount();
    await card.show(output({ stationery: { theme: 'classic', source: 'default' }, arrivalWindow: WINDOW }), ON);
    const panel = (id: string) => card.byId(id).closest('.studio-panel')?.getAttribute('data-tab');
    expect(panel('style-row')).toBe('style');
    expect(panel('style-note')).toBe('style');
    expect(panel('layout-row')).toBe('style');
    expect(panel('arrives-row')).toBe('delivery');
    expect(panel('arrives-note')).toBe('delivery');
    expect(panel('scheduled')).toBe('delivery');
    expect(panel('delivery-row')).toBe('delivery');
    expect(panel('id-row')).toBe('delivery');
    expect(card.byId('mockup-container').parentElement!.className).toBe('studio-page');
    for (const id of ['send-button', 'purchase-actions', 'send-page-button', 'send-page-note', 'error-message']) {
      expect(card.byId(id).parentElement!.className, id).toBe('studio-ft');
    }
    expect(card.byId('note').parentElement!.className).toBe('studio-side');
    // Each moved once: no element is left behind or doubled.
    expect(card.document.querySelectorAll('#style-row')).toHaveLength(1);
    expect(card.document.querySelectorAll('[data-slot]')).toHaveLength(0);
  });

  it('opens on Style, with one tab in the tab order and the others reached by arrow keys', async () => {
    const card = mount();
    await card.show(output(), ON);
    expect(card.selected()).toEqual(['style']);
    expect(card.shownPanels()).toEqual(['style']);
    expect(['style', 'words', 'delivery'].map(name => card.tab(name).tabIndex)).toEqual([0, -1, -1]);
    for (const name of ['style', 'words', 'delivery']) {
      const tab = card.tab(name);
      expect(card.byId(tab.getAttribute('aria-controls')!).getAttribute('aria-labelledby')).toBe(tab.id);
    }

    await card.key(card.tab('style'), 'ArrowRight');
    expect(card.selected()).toEqual(['words']);
    expect(card.shownPanels()).toEqual(['words']);
    expect(card.document.activeElement).toBe(card.tab('words'));
    expect(['style', 'words', 'delivery'].map(name => card.tab(name).tabIndex)).toEqual([-1, 0, -1]);
    await card.key(card.tab('words'), 'End');
    expect(card.selected()).toEqual(['delivery']);
    await card.key(card.tab('delivery'), 'ArrowRight');
    expect(card.selected()).toEqual(['style']);
    await card.key(card.tab('style'), 'ArrowLeft');
    expect(card.selected()).toEqual(['delivery']);
    await card.key(card.tab('delivery'), 'Home');
    expect(card.selected()).toEqual(['style']);
    // Any other key leaves the tabs alone.
    await card.key(card.tab('style'), 'ArrowRight');
    await card.key(card.tab('words'), 'ArrowDown');
    expect(card.selected()).toEqual(['words']);
  });

  it("shows the letter's words, as the call gave them, on the Words tab", async () => {
    const card = mount();
    await card.show(output(), ON);
    await card.click(card.tab('words'));
    expect(card.shownPanels()).toEqual(['words']);
    expect(text(card, 'studio-words')).toBe('Dear Sam,\n\nThe garden is in.\n\nLove,\nPat');
  });

  it('says where the words are when the call gave none', async () => {
    const card = mount();
    await card.show(output(), ON, { recipient });
    expect(text(card, 'studio-words')).toBe('The words are on the page.');
  });

  it('opens on Delivery for a letter with a date, and holds it there in the summary', async () => {
    const card = mount();
    await card.show(output({ arrivalWindow: WINDOW, schedule: { arriveBy: '2026-10-20', mailOn: '2026-10-09' } }), ON);
    expect(card.selected()).toEqual(['delivery']);
    expect(text(card, 'studio-summary')).toMatch(/^black and white · held until Fri, Oct 9(, 2026)?$/);
  });

  it('holds a letter the server says is waiting for its mail date, and opens on Delivery', async () => {
    const card = mount();
    await card.show(output(), ON);
    await card.answer(
      {
        result: {
          content: [],
          structuredContent: {
            draftId: 'draft_0001',
            status: 'sent',
            orderId: 'order-1',
            orderStatus: 'scheduled',
            schedule: { arriveBy: '2026-10-20', mailOn: '2026-10-09' },
            cancellable: true
          }
        }
      },
      'get_draft_status'
    );
    expect(card.selected()).toEqual(['delivery']);
    expect(text(card, 'studio-sub')).toBe('Sent · Springfield, IL 62701');
    expect(text(card, 'studio-summary')).toMatch(/^black and white · held until Fri, Oct 9(, 2026)?$/);
  });

  it('says a letter the server says was cancelled will not be mailed, on Delivery', async () => {
    const card = mount();
    await card.show(output(), ON);
    await card.answer(
      {
        result: {
          content: [],
          structuredContent: { draftId: 'draft_0001', status: 'sent', orderId: 'order-1', orderStatus: 'cancelled', schedule: { arriveBy: '2026-10-20', mailOn: '2026-10-09' } }
        }
      },
      'get_draft_status'
    );
    expect(card.selected()).toEqual(['delivery']);
    expect(text(card, 'studio-sub')).toBe('Cancelled · Springfield, IL 62701');
    expect(text(card, 'studio-summary')).toBe('black and white · cancelled, nothing will be mailed');
  });

  it("takes the estimate a cleared date brings, not the dated preview's", async () => {
    const card = mount();
    await card.show(
      output({ arrivalWindow: WINDOW, schedule: { arriveBy: '2026-10-20', mailOn: '2026-10-09' }, deliveryEstimate: 'Goes to the printer Fri, Oct 9.' }),
      ON
    );
    await card.click(card.byId('arrives-asap'));
    expect(card.lastRequest('tools/call', 'set_arrival_date')!.params.arguments).toEqual({ draftId: 'draft_0001' });
    await card.answer(
      { result: { content: [], structuredContent: { draftId: 'draft_0001', schedule: null, deliveryEstimate: 'Mailed in 1-2 business days', message: 'Cleared.' } } },
      'set_arrival_date'
    );
    expect(text(card, 'studio-summary')).toBe('black and white · mailed in 1-2 business days');
  });

  it('keeps the tab the person picked when the preview changes under it', async () => {
    const card = mount();
    await card.show(output({ arrivalWindow: WINDOW }), ON);
    await card.click(card.tab('words'));
    await card.show(output({ arrivalWindow: WINDOW, schedule: { arriveBy: '2026-10-20', mailOn: '2026-10-09' } }), ON);
    expect(card.selected()).toEqual(['words']);
  });

  it('sums the letter up in the footer: its cost, stationery, ink and when it mails', async () => {
    const card = mount();
    await card.show(output({ stationery: { theme: 'botanical', source: 'asked' } }), ON);
    expect(text(card, 'studio-cost')).toBe('1 letter');
    expect(text(card, 'studio-summary')).toBe('Botanical · black and white · mailed in 1-2 business days');
    expect(card.byId('send-button').style.display).toBe('flex');
  });

  it("says how full a letter's pages are on the Words tab, and a longer letter's pages in the footer (#586)", async () => {
    const PAY_AND_SEND = { packPays: false, payAndSend: { available: true, amountCents: 599, currency: 'usd' }, letterPack: { available: false } };
    const two = mount();
    await two.show(output({ pages: 2, canSendNow: false, sendEligibility: PAY_AND_SEND }), { ...ON, pageFit: { pages: 2, sheets: 1 } });
    expect(text(two, 'studio-fit')).toBe('Runs on to the back of the page: printed on both sides of one sheet.');
    expect(two.byId('studio-fit').hidden).toBe(false);
    expect(text(two, 'studio-summary')).toBe('black and white · 2 pages, both sides · mailed in 1-2 business days');
    expect(text(two, 'studio-cost')).toBe('Pay & Send USD 5.99');

    const three = mount();
    await three.show(output({ pages: 3, canSendNow: false, sendEligibility: PAY_AND_SEND }), ON);
    expect(text(three, 'studio-fit')).toBe('Three pages: two sheets, printed on both sides. That is the longest letter we print.');
    expect(text(three, 'studio-summary')).toBe('black and white · 3 pages, both sides · mailed in 1-2 business days');

    // One page: the room it has left, while room to write gives its fit.
    const one = mount();
    await one.show(output(), { ...ON, pageFit: { pages: 1, sheets: 1, roomLines: 20, roomCharacters: 1940, charactersPerLine: 97 } });
    expect(text(one, 'studio-fit')).toBe('Fits on one page, with room for about 1,940 more characters.');
    expect(text(one, 'studio-summary')).toBe('black and white · mailed in 1-2 business days');

    // And nothing where no fit is given, as while room to write is not offered.
    const plain = mount();
    await plain.show(output(), ON);
    expect(text(plain, 'studio-fit')).toBe('');
    expect(plain.byId('studio-fit').hidden).toBe(true);
  });

  it('says a letter with its picture prints in colour (#584 review round 1)', async () => {
    const card = mount();
    await card.show(output({ layoutType: 'header_image', stationery: { theme: 'classic', source: 'default' } }), ON);
    expect(text(card, 'studio-summary')).toBe('Classic · colour · mailed in 1-2 business days');

    const plain = mount();
    await plain.show(output({ layoutType: 'inline_image' }), ON);
    expect(text(plain, 'studio-style-quiet')).toBe('Printed in colour.');
    expect(text(plain, 'studio-summary')).toBe('colour · mailed in 1-2 business days');
  });

  it("says a letter the server has with the printer is there, whatever date its preview had (#584 review round 1)", async () => {
    const card = mount();
    await card.show(
      output({ arrivalWindow: WINDOW, schedule: { arriveBy: '2026-10-20', mailOn: '2026-10-09' }, deliveryEstimate: 'Goes to the printer Fri, Oct 9.' }),
      ON
    );
    await card.answer(
      { result: { content: [], structuredContent: { draftId: 'draft_0001', status: 'sent', orderId: 'order-1', orderStatus: 'sent', schedule: null } } },
      'get_draft_status'
    );
    expect(text(card, 'status-pill')).toBe('With the printer');
    expect(text(card, 'studio-sub')).toBe('Sent · Springfield, IL 62701');
    expect(text(card, 'studio-summary')).toBe('black and white · with the printer');
  });

  it('says a letter its own send put with the printer is there, though the card had a date (#584 review round 1)', async () => {
    const card = mount();
    await card.show(output({ arrivalWindow: WINDOW, schedule: { arriveBy: '2026-10-20', mailOn: '2026-10-09' } }), ON);
    // The chat cleared the date before the send: the send says where the letter is.
    await card.click(card.byId('send-button'));
    await card.answer(
      { result: { content: [{ type: 'text', text: 'Sent.' }], structuredContent: { orderId: 'order-1', currentStatus: 'sent' } } },
      'send_letter'
    );
    expect(text(card, 'studio-summary')).toBe('black and white · with the printer');
  });

  it('says an expired preview has expired (#584 review round 1)', async () => {
    const card = mount();
    await card.show(output(), ON);
    await card.answer({ result: { content: [], structuredContent: { draftId: 'draft_0001', status: 'expired' } } }, 'get_draft_status');
    expect(text(card, 'status-pill')).toBe('Preview expired');
    expect(text(card, 'studio-sub')).toBe('Expired · Springfield, IL 62701');
    expect(text(card, 'studio-summary')).toBe('black and white · the preview has expired');
  });

  it('follows a Pay & Send order: the stationery once its row goes, then paid, then with the printer (#584 review round 1)', async () => {
    const card = mount();
    await card.show(
      output({
        stationery: { theme: 'botanical', source: 'asked' },
        canSendNow: false,
        sendEligibility: { packPays: false, payAndSend: { available: true, amountCents: 599, currency: 'usd' }, letterPack: { available: false } }
      }),
      ON
    );
    expect(text(card, 'studio-cost')).toBe('Pay & Send USD 5.99');
    await card.click(card.byId('pay-send-button'));
    // The Style row goes with the checkout; the tab says what the page is in.
    expect(card.byId('style-row').style.display).toBe('none');
    expect(card.byId('studio-style-quiet').style.display).toBe('');
    expect(text(card, 'studio-style-quiet')).toBe('Botanical stationery, printed in black and white.');
    await card.answer(
      { result: { content: [], structuredContent: { orderId: 'order-1', checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_1' } } },
      'create_mail_checkout'
    );
    expect(text(card, 'studio-sub')).toBe('Draft · Springfield, IL 62701');

    await card.click(card.byId('check-status-button'));
    await card.answer({ result: { content: [], structuredContent: { orderId: 'order-1', purchaseStatus: 'processing' } } }, 'get_purchase_status');
    expect(text(card, 'studio-sub')).toBe('Paid · Springfield, IL 62701');
    expect(text(card, 'studio-cost')).toBe('Paid USD 5.99');
    expect(text(card, 'studio-summary')).toBe('Botanical · black and white · paid, going to the printer');

    await card.click(card.byId('check-status-button'));
    await card.answer({ result: { content: [], structuredContent: { orderId: 'order-1', purchaseStatus: 'submitted' } } }, 'get_purchase_status');
    expect(text(card, 'studio-sub')).toBe('Sent · Springfield, IL 62701');
    expect(text(card, 'studio-summary')).toBe('Botanical · black and white · with the printer');
  });

  it('holds a dated Pay & Send order while it waits, then says it is with the printer (#584 review round 2)', async () => {
    const card = mount();
    await card.show(
      output({
        arrivalWindow: WINDOW,
        schedule: { arriveBy: '2026-10-20', mailOn: '2026-10-09' },
        canSendNow: false,
        sendEligibility: { packPays: false, payAndSend: { available: true, amountCents: 599, currency: 'usd' }, letterPack: { available: false } }
      }),
      ON
    );
    await card.click(card.byId('pay-send-button'));
    await card.answer(
      { result: { content: [], structuredContent: { orderId: 'order-1', checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_1' } } },
      'create_mail_checkout'
    );
    await card.click(card.byId('check-status-button'));
    await card.answer({ result: { content: [], structuredContent: { orderId: 'order-1', purchaseStatus: 'processing' } } }, 'get_purchase_status');
    expect(text(card, 'studio-summary')).toMatch(/^black and white · held until Fri, Oct 9(, 2026)?$/);
    await card.click(card.byId('check-status-button'));
    await card.answer({ result: { content: [], structuredContent: { orderId: 'order-1', purchaseStatus: 'submitted' } } }, 'get_purchase_status');
    expect(text(card, 'studio-sub')).toBe('Sent · Springfield, IL 62701');
    expect(text(card, 'studio-summary')).toBe('black and white · with the printer');
  });

  it.each([
    ['payment_failed', 'Draft', 'the payment did not go through'],
    ['refund_pending', 'Refunded', 'being refunded, nothing will be mailed'],
    ['refunded', 'Refunded', 'refunded, nothing will be mailed'],
    ['on_hold', 'On hold', 'on hold'],
    ['cancelled', 'Cancelled', 'cancelled, nothing will be mailed']
  ])('never promises mail for a Pay & Send order %s (#584 review round 2)', async (status, stage, timing) => {
    const card = mount();
    await card.show(
      output({ canSendNow: false, sendEligibility: { packPays: false, payAndSend: { available: true, amountCents: 599, currency: 'usd' }, letterPack: { available: false } } }),
      ON
    );
    await card.click(card.byId('pay-send-button'));
    await card.answer(
      { result: { content: [], structuredContent: { orderId: 'order-1', checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_1' } } },
      'create_mail_checkout'
    );
    await card.click(card.byId('check-status-button'));
    await card.answer(
      { result: { content: [], structuredContent: { orderId: 'order-1', purchaseStatus: status, message: 'The order stopped.' } } },
      'get_purchase_status'
    );
    expect(text(card, 'studio-sub')).toBe(`${stage} · Springfield, IL 62701`);
    expect(text(card, 'studio-summary')).toBe(`black and white · ${timing}`);
  });

  it('opens an expired dated preview on Style: it holds no date any more (#584 review round 2)', async () => {
    const card = mount();
    await card.show(output({ arrivalWindow: WINDOW, schedule: { arriveBy: '2026-10-20', mailOn: '2026-10-09' } }), ON);
    expect(card.selected()).toEqual(['delivery']);
    await card.answer({ result: { content: [], structuredContent: { draftId: 'draft_0001', status: 'expired' } } }, 'get_draft_status');
    expect(card.selected()).toEqual(['style']);
    expect(text(card, 'studio-summary')).toBe('black and white · the preview has expired');
  });

  it('brings the Style row back when Pay & Send cannot open a checkout', async () => {
    const card = mount();
    await card.show(
      output({
        stationery: { theme: 'botanical', source: 'asked' },
        canSendNow: false,
        sendEligibility: { packPays: false, payAndSend: { available: true, amountCents: 599, currency: 'usd' }, letterPack: { available: false } }
      }),
      ON
    );
    await card.click(card.byId('pay-send-button'));
    expect(card.byId('studio-style-quiet').style.display).toBe('');
    await card.answer({ result: { isError: true, content: [{ type: 'text', text: 'Pay & Send is not available right now.' }] } }, 'create_mail_checkout');
    expect(card.byId('style-row').style.display).toBe('');
    expect(card.byId('studio-style-quiet').style.display).toBe('none');
  });

  it('names a Pay & Send payment without a price plainly', async () => {
    const card = mount();
    await card.show(
      output({ canSendNow: false, sendEligibility: { packPays: false, payAndSend: { available: true }, letterPack: { available: false } } }),
      ON
    );
    await card.click(card.byId('pay-send-button'));
    await card.answer(
      { result: { content: [], structuredContent: { orderId: 'order-1', checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_1' } } },
      'create_mail_checkout'
    );
    await card.click(card.byId('check-status-button'));
    await card.answer({ result: { content: [], structuredContent: { orderId: 'order-1', purchaseStatus: 'processing' } } }, 'get_purchase_status');
    expect(text(card, 'studio-cost')).toBe('Paid with Pay & Send');
  });

  it('names the price of mail no pack pays for, and a gift letter as free', async () => {
    const paid = mount();
    await paid.show(
      output({
        canSendNow: false,
        sendEligibility: {
          packPays: false,
          payAndSend: { available: true, amountCents: 599, currency: 'usd' },
          letterPack: { available: false }
        }
      }),
      ON
    );
    // As the card's own Pay & Send button writes it.
    expect(text(paid, 'studio-cost')).toBe('Pay & Send USD 5.99');

    const gift = mount();
    await gift.show(output({ giftCard: { state: 'funded', description: 'A free letter goes with it.' } }), ON);
    expect(text(gift, 'studio-cost')).toBe('Free: a gift letter');

    const two = mount();
    await two.show(output({ lettersRequired: 2 }), ON);
    expect(text(two, 'studio-cost')).toBe('2 letters');

    const unpriced = mount();
    await unpriced.show(output({ canSendNow: false, sendEligibility: { packPays: false, payAndSend: { available: false } } }), ON);
    expect(text(unpriced, 'studio-cost')).toBe('Paid when you send it');
  });

  it('says what the page is printed in when there is no style to choose, and nothing when there is', async () => {
    const plain = mount();
    await plain.show(output(), ON);
    expect(plain.byId('style-row').style.display).toBe('none');
    expect(text(plain, 'studio-style-quiet')).toBe('Printed in black and white.');
    expect(plain.byId('studio-style-quiet').style.display).toBe('');

    const styled = mount();
    await styled.show(output({ stationery: { theme: 'classic', source: 'default' } }), ON);
    expect(styled.byId('style-row').style.display).toBe('');
    expect(styled.byId('studio-style-quiet').style.display).toBe('none');
    // Under the Style tab, the row is named for what it chooses.
    expect(text(styled, 'style-label')).toBe('Stationery');
  });

  it('changes the style with set_stationery from the Style tab, as the row always did, and names it in the summary', async () => {
    const card = mount();
    await card.show(output({ stationery: { theme: 'classic', source: 'default' } }), ON);
    expect(text(card, 'studio-summary')).toBe('Classic · black and white · mailed in 1-2 business days');
    await card.click(card.document.querySelector('#style-row [data-theme="botanical"]')!);
    expect(card.lastRequest('tools/call', 'set_stationery')!.params.arguments).toEqual({ draftId: 'draft_0001', stationery: 'botanical' });
    await card.answer(
      {
        result: {
          content: [{ type: 'text', text: 'Restyled.' }],
          structuredContent: { draftId: 'draft_0001', stationery: { theme: 'botanical', dateLine: 'October 1, 2026', source: 'asked' } },
          _meta: { previewHtml: PAGE }
        }
      },
      'set_stationery'
    );
    expect(text(card, 'studio-summary')).toBe('Botanical · black and white · mailed in 1-2 business days');
  });

  it('names the stationery once its row has gone with the send', async () => {
    const card = mount();
    await card.show(output({ stationery: { theme: 'botanical', source: 'asked' } }), ON);
    expect(card.byId('studio-style-quiet').style.display).toBe('none');
    await card.click(card.byId('send-button'));
    await card.answer({ result: { content: [{ type: 'text', text: 'Sent.' }], structuredContent: { orderId: 'order-1' } } }, 'send_letter');
    expect(card.byId('style-row').style.display).toBe('none');
    expect(card.byId('studio-style-quiet').style.display).toBe('');
    expect(text(card, 'studio-style-quiet')).toBe('Botanical stationery, printed in black and white.');
  });

  it('sends with send_letter from the footer, then says it was sent', async () => {
    const card = mount();
    await card.show(output(), ON);
    await card.click(card.byId('send-button'));
    expect(card.lastRequest('tools/call', 'send_letter')!.params.arguments).toEqual({ draftId: 'draft_0001', confirm: true });
    await card.answer({ result: { content: [{ type: 'text', text: 'Sent.' }], structuredContent: { orderId: 'order-1' } } }, 'send_letter');
    expect(text(card, 'studio-sub')).toBe('Sent · Springfield, IL 62701');
    expect(text(card, 'status-pill')).toBe('With the printer');
  });

  it('shows Delivery, where Cancel is, once a letter is sent with a date; a cancel says nothing will be mailed', async () => {
    const card = mount();
    await card.show(output({ arrivalWindow: WINDOW, schedule: { arriveBy: '2026-10-20', mailOn: '2026-10-09' } }), ON);
    await card.click(card.tab('style'));
    await card.click(card.byId('send-button'));
    await card.answer(
      {
        result: {
          content: [{ type: 'text', text: 'Scheduled.' }],
          structuredContent: { orderId: 'order-1', currentStatus: 'scheduled', schedule: { arriveBy: '2026-10-20', mailOn: '2026-10-09' }, cancellable: true }
        }
      },
      'send_letter'
    );
    expect(card.selected()).toEqual(['delivery']);
    expect(text(card, 'studio-sub')).toBe('Sent · Springfield, IL 62701');
    expect(text(card, 'studio-summary')).toMatch(/held until Fri, Oct 9/);
    expect(card.byId('cancel-scheduled-button').style.display).toBe('flex');

    // Cancel asks once more before it calls the tool.
    await card.click(card.byId('cancel-scheduled-button'));
    expect(text(card, 'cancel-scheduled-button-text')).toBe('Yes, cancel this letter');
    await card.click(card.byId('cancel-scheduled-button'));
    await card.answer({ result: { content: [{ type: 'text', text: 'Cancelled.' }], structuredContent: { orderId: 'order-1', status: 'cancelled' } } }, 'cancel_scheduled_mail');
    expect(text(card, 'status-pill')).toBe('Cancelled');
    expect(text(card, 'studio-sub')).toBe('Cancelled · Springfield, IL 62701');
    expect(text(card, 'studio-summary')).toBe('black and white · cancelled, nothing will be mailed');
  });

  it('shows a longer letter one page at a time, and the first page once sealed', async () => {
    const card = mount();
    await card.show(output(), { previewHtml: GIFT_PAGES, [STUDIO]: true, [REVEAL]: true });
    const pages = Array.from(card.document.querySelectorAll('.letter-page > svg.print-page'));
    expect(pages).toHaveLength(2);
    const shown = () => pages.map(page => page.classList.contains('shown'));
    expect(shown()).toEqual([true, false]);
    expect(card.document.querySelector('.page-count')!.textContent).toBe('Page 1 of 2');
    const step = card.document.querySelector('.page-tools .page-zoom:last-child') as HTMLElement;
    expect(step.textContent).toBe('Next page');

    await card.click(step);
    expect(shown()).toEqual([false, true]);
    expect(card.document.querySelector('.page-count')!.textContent).toBe('Page 2 of 2');
    expect(step.textContent).toBe('First page');
    // From the last page, back to the first.
    await card.click(step);
    expect(shown()).toEqual([true, false]);
    await card.click(step);
    expect(shown()).toEqual([false, true]);

    await card.click(card.byId('send-button'));
    await card.answer({ result: { content: [{ type: 'text', text: 'Sent.' }], structuredContent: { orderId: 'order-1' } } }, 'send_letter');
    expect(shown()).toEqual([true, false]);
    expect((card.document.querySelector('.page-count') as HTMLElement).hidden).toBe(true);
    expect(step.hidden).toBe(true);
  });

  it('keeps the page shown through a restyle (#584 review round 1)', async () => {
    const card = mount();
    await card.show(output({ stationery: { theme: 'classic', source: 'default' } }), { previewHtml: GIFT_PAGES, [STUDIO]: true });
    await card.click(card.document.querySelector('.page-tools .page-zoom:last-child')!);
    expect(card.document.querySelector('.page-count')!.textContent).toBe('Page 2 of 2');
    await card.click(card.document.querySelector('#style-row [data-theme="botanical"]')!);
    await card.answer(
      {
        result: {
          content: [{ type: 'text', text: 'Restyled.' }],
          structuredContent: { draftId: 'draft_0001', stationery: { theme: 'botanical', dateLine: 'October 1, 2026', source: 'asked' } },
          _meta: { previewHtml: document1('October 1, 2026\nDear Sam,\nPat', 'A letter for you') }
        }
      },
      'set_stationery'
    );
    const pages = Array.from(card.document.querySelectorAll('.letter-page > svg.print-page'));
    expect(pages[0].querySelector('title')!.textContent).toBe('October 1, 2026\nDear Sam,\nPat');
    expect(pages.map(page => page.classList.contains('shown'))).toEqual([false, true]);
    expect(card.document.querySelector('.page-count')!.textContent).toBe('Page 2 of 2');
  });

  it('starts another draft on its first page', async () => {
    const card = mount();
    await card.show(output(), { previewHtml: GIFT_PAGES, [STUDIO]: true });
    await card.click(card.document.querySelector('.page-tools .page-zoom:last-child')!);
    expect(card.document.querySelector('.page-count')!.textContent).toBe('Page 2 of 2');
    await card.show(output({ draftId: 'draft_0002' }), { previewHtml: GIFT_PAGES, [STUDIO]: true });
    expect(card.document.querySelector('.page-count')!.textContent).toBe('Page 1 of 2');
  });

  it('names its tabs by the letter, and spaces its note as the panels do (#584 review round 1)', async () => {
    const card = mount();
    await card.show(output(), ON);
    expect(card.document.querySelector('[role="tablist"]')!.getAttribute('aria-labelledby')).toBe('studio-title');
    const served = inlineHostBridge(fs.readFileSync(path.join(WIDGET_DIR, 'LetterPreviewCard.html'), 'utf-8'), WIDGET_DIR);
    expect(served).toContain('.studio-panel .note,.studio-side > .note{margin-top:0}');
  });

  it('grows the page across the card when it is enlarged', async () => {
    const card = mount();
    await card.show(output(), ON);
    await card.click(card.document.querySelector('.page-zoom')!);
    expect(card.byId('studio-body').classList.contains('zoomed')).toBe(true);
    await card.click(card.document.querySelector('.page-zoom')!);
    expect(card.byId('studio-body').classList.contains('zoomed')).toBe(false);
  });

  it('becomes a studio when a later result turns it on, and stays one', async () => {
    const card = mount();
    await card.show(output(), { previewHtml: GIFT_PAGES });
    expect(card.byId('card').classList.contains('studio')).toBe(false);
    expect(card.document.querySelector('.page-tools')).toBeNull();
    await card.show(output(), { previewHtml: GIFT_PAGES, [STUDIO]: true });
    expect(card.byId('card').classList.contains('studio')).toBe(true);
    // The page is drawn again for the studio, one page at a time.
    expect(card.document.querySelector('.page-tools')).not.toBeNull();
    await card.show(output(), { previewHtml: GIFT_PAGES });
    expect(card.byId('card').classList.contains('studio')).toBe(true);
    expect(card.document.querySelectorAll('.studio-hd')).toHaveLength(1);
  });
});
