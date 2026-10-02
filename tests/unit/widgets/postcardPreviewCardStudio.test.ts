/**
 * The postcard card as Demo 3's postcard maker (#580): while the preview's
 * _meta carries letterirl/studioCard, the card lays itself out with a header
 * naming the postcard, the postcard as it prints with a flip to its back,
 * its size, its message read-only with what it uses of the back, its
 * delivery, and a footer with the cost and Send. The rows and buttons are the
 * card's own, moved, so each still calls its tool (Principle 2). Without the
 * switch nothing moves. Framed by a fake MCP Apps host, with a postcard drawn
 * by the real renderer.
 */

import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';
import { inlineHostBridge } from '../../../src/mcp/widgetHost.js';
import { stampPreviewTool } from '../../../src/mcp/registerTools.js';
import { layoutPostcard, POSTCARD_STAMP, renderPreviewSvg } from '../../../src/render/index.js';
import { renderPostcardPreviewDocument } from '../../../src/services/previewService.js';

const WIDGET_DIR = path.resolve(__dirname, '../../../widgets');
const STUDIO = 'letterirl/studioCard';

type Json = Record<string, any>;

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

const MESSAGE = 'Dear Sam,\nWish you were here.\nPat';
const RENDERED = renderPostcardPreviewDocument(renderPreviewSvg(
  layoutPostcard({ message: MESSAGE, image: { bytes: pngBytes(540, 360), mime: 'image/png', width: 540, height: 360 } }),
  {
    addresses: { from: ['RETURN TO:', 'PAT EXAMPLE', '1 MAIN ST', 'SPRINGFIELD, IL 62701'], to: ['SAM RIVERA', '350 FIFTH AVE', 'NEW YORK, NY 10118'] },
    stamp: { page: 1, geometry: POSTCARD_STAMP }
  }
));

const recipient = { name: 'Sam Rivera', addressLine1: '350 Fifth Ave', city: 'New York', state: 'NY', postalCode: '10118' };
const ARGS = { recipient, message: MESSAGE, imageUrl: 'https://example.com/beach.jpg' };
const WINDOW = { earliestArrival: '2026-10-14', latestArrival: '2026-11-30' };

const output = (extra: Json = {}) => ({
  draftId: 'draft_0001',
  lettersRequired: 1,
  canSendNow: true,
  message: MESSAGE,
  recipientName: 'Sam Rivera',
  recipientAddressLine1: '350 Fifth Ave',
  recipientCity: 'New York',
  recipientState: 'NY',
  recipientPostalCode: '10118',
  deliveryClass: 'First Class',
  deliveryEstimate: 'Mailed in 1-2 business days',
  sendEligibility: {
    payAndSend: { available: false, unavailableReason: "Pay & Send isn't available in this app." },
    letterPack: { available: false, purchaseUrl: 'https://letterirl.example/packs' }
  },
  ...extra
});

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise(resolve => setImmediate(resolve));
}

/** The card as served, in ChatGPT: window.openai carries the result and its _meta. */
function mountInChatGpt(meta: Json) {
  const served = stampPreviewTool(
    inlineHostBridge(fs.readFileSync(path.join(WIDGET_DIR, 'PostcardPreviewCard.html'), 'utf-8'), WIDGET_DIR),
    'quote_and_preview_postcard'
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

/** The card as served, in a fake MCP Apps host; `still` turns on reduced motion. */
function mount(options: { still?: boolean } = {}) {
  const served = stampPreviewTool(
    inlineHostBridge(fs.readFileSync(path.join(WIDGET_DIR, 'PostcardPreviewCard.html'), 'utf-8'), WIDGET_DIR),
    'quote_and_preview_postcard'
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
      if (options.still) {
        (window as any).matchMedia = (query: string) => ({ matches: query.includes('reduce'), addEventListener() {}, removeEventListener() {} });
      }
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
    side: () => (byId('preview-front').classList.contains('hidden') ? 'back' : 'front')
  };
}

const ON = { previewHtml: RENDERED, [STUDIO]: true };
const text = (card: ReturnType<typeof mount>, id: string) => card.byId(id).textContent;

describe('the postcard card without the studio switch (#580)', () => {
  it('is laid out as it always was', async () => {
    const card = mount();
    await card.show(output({ arrivalWindow: WINDOW }), { previewHtml: RENDERED });
    expect(card.byId('card').classList.contains('studio')).toBe(false);
    expect(card.byId('studio-body')).toBeNull();
    expect(card.byId('preview-container').parentElement!.id).toBe('card');
    expect(card.byId('arrives-row').parentElement!.className).toBe('rows');
    expect(card.byId('send-button').parentElement!.className).toBe('meta');
    expect(card.byId('status-pill').parentElement!.id).toBe('status-row');
    expect(card.byId('message-box').style.display).toBe('block');
  });
});

describe('the postcard card as a postcard maker (#580)', () => {
  it('names the postcard in its header, with the status beside it', async () => {
    const card = mount();
    await card.show(output(), ON);
    expect(card.byId('card').classList.contains('studio')).toBe(true);
    expect(text(card, 'studio-title')).toBe('Postcard to Sam Rivera');
    expect(text(card, 'studio-sub')).toBe('Draft · New York, NY 10118');
    expect(card.byId('status-pill').parentElement!.className).toBe('studio-hd');
  });

  it('says "Your postcard" when the recipient has no name', async () => {
    const card = mount();
    await card.show(output({ recipientName: ' ' }), ON);
    expect(text(card, 'studio-title')).toBe('Your postcard');
  });

  it("moves the card's own postcard, rows and buttons into the maker", async () => {
    const card = mount();
    await card.show(output({ arrivalWindow: WINDOW }), ON);
    expect(card.byId('preview-container').parentElement!.id).toBe('studio-postcard');
    for (const id of ['arrives-row', 'arrives-note', 'scheduled', 'delivery-row', 'id-row']) {
      expect(card.byId(id).parentElement!.className, id).toBe('studio-section');
    }
    for (const id of ['send-button', 'purchase-actions', 'send-page-button', 'send-page-note', 'error-message']) {
      expect(card.byId(id).parentElement!.className, id).toBe('studio-ft');
    }
    expect(card.byId('note').parentElement!.className).toBe('studio-side');
    expect(card.document.querySelectorAll('[data-slot]')).toHaveLength(0);
    // The message is in the maker; the card's own box is hidden by the maker's styles.
    expect(card.window.getComputedStyle(card.byId('message-box')).display).toBe('none');
    expect(card.window.getComputedStyle(card.document.querySelector('.preview-tabs')!).display).toBe('none');
    // The note beside the postcard is spaced as the sections' notes are.
    expect(card.window.getComputedStyle(card.byId('note')).marginTop).toBe('0px');
  });

  it('flips the postcard to its back and to its front again, saying which side shows', async () => {
    const card = mount();
    await card.show(output(), ON);
    const flip = card.byId('studio-flip');
    expect(card.side()).toBe('front');
    expect(flip.textContent).toBe('Flip to the back');
    expect(text(card, 'studio-scale')).toBe('Drawn to scale: 6 x 9 in.');
    expect(card.byId('preview-front').querySelector('svg[role="img"]')).not.toBeNull();

    await card.click(flip);
    expect(card.side()).toBe('back');
    expect(flip.textContent).toBe('Show the front');
    expect(text(card, 'studio-scale')).toBe('The right half is for the address and postage.');
    expect(card.byId('studio-postcard').classList.contains('flipping')).toBe(true);
    card.byId('studio-postcard').dispatchEvent(new card.window.Event('animationend'));
    expect(card.byId('studio-postcard').classList.contains('flipping')).toBe(false);

    await card.click(flip);
    expect(card.side()).toBe('front');
    expect(flip.textContent).toBe('Flip to the back');
  });

  it('keeps the side shown through a redraw, and turns once a press after it', async () => {
    const card = mount();
    await card.show(output(), ON);
    await card.click(card.byId('studio-flip'));
    await card.show(output(), ON);
    expect(card.side()).toBe('back');
    expect(card.byId('studio-flip').textContent).toBe('Show the front');
    await card.click(card.byId('studio-flip'));
    expect(card.side()).toBe('front');
  });

  it('leaves the announced line alone when a redraw changes nothing (#580 maker review round 1)', async () => {
    const card = mount();
    await card.show(output(), ON);
    const said = card.byId('studio-scale').firstChild;
    await card.show(output(), ON);
    expect(card.byId('studio-scale').firstChild).toBe(said);
    await card.click(card.byId('studio-flip'));
    expect(card.byId('studio-scale').firstChild).not.toBe(said);
  });

  it('turns the postcard without motion when motion is reduced, and ends a cut-short motion (#580 maker review round 1)', async () => {
    const still = mount({ still: true });
    await still.show(output(), ON);
    await still.click(still.byId('studio-flip'));
    expect(still.side()).toBe('back');
    expect(still.byId('studio-postcard').classList.contains('flipping')).toBe(false);

    const cut = mount();
    await cut.show(output(), ON);
    await cut.click(cut.byId('studio-flip'));
    expect(cut.byId('studio-postcard').classList.contains('flipping')).toBe(true);
    cut.byId('studio-postcard').dispatchEvent(new cut.window.Event('animationcancel'));
    expect(cut.byId('studio-postcard').classList.contains('flipping')).toBe(false);
  });

  it("flips a preview our renderer did not draw: the card's own front and its mockup of the back (#580 maker review round 1)", async () => {
    const card = mount();
    await card.show(output(), {
      previewFrontHtml: '<html><body><div class="postcard-front">FRONT FROM META</div></body></html>',
      [STUDIO]: true
    });
    expect(card.byId('preview-front').textContent).toContain('FRONT FROM META');
    await card.click(card.byId('studio-flip'));
    expect(card.side()).toBe('back');
    expect(card.byId('preview-back').querySelector('.postcard-back-mockup')).not.toBeNull();
    expect(card.byId('preview-back').textContent).toContain('Wish you were here.');
  });

  it('becomes a postcard maker in ChatGPT, from the switch in toolResponseMetadata (#580 maker review round 1)', async () => {
    const document = mountInChatGpt(ON);
    await flush();
    expect(document.getElementById('card')!.classList.contains('studio')).toBe(true);
    expect(document.getElementById('studio-title')!.textContent).toBe('Postcard to Sam Rivera');

    const off = mountInChatGpt({ previewHtml: RENDERED });
    await flush();
    expect(off.getElementById('card')!.classList.contains('studio')).toBe(false);
  });

  it('shows the message read-only, beside what the back holds, which is lines, not characters', async () => {
    const card = mount();
    await card.show(output(), ON);
    expect(text(card, 'studio-message')).toBe(MESSAGE);
    expect(text(card, 'studio-count')).toBe(`${[...MESSAGE].length} characters · the back holds 16 lines, about 500 characters of prose`);

    const gift = mount();
    await gift.show(output({ giftCard: { state: 'funded', description: 'A free letter goes with it.' } }), ON);
    expect(text(gift, 'studio-count')).toBe(`${[...MESSAGE].length} characters · beside the gift card, the back holds 11 lines`);

    const none = mount();
    await none.show(output({ message: undefined }), ON, { recipient });
    expect(text(none, 'studio-message')).toBe('The message is on the back.');
    expect(text(none, 'studio-count')).toBe('');
  });

  it('sums the postcard up in the footer: its cost, size and when it mails', async () => {
    const card = mount();
    await card.show(output(), ON);
    expect(text(card, 'studio-cost')).toBe('1 letter');
    expect(text(card, 'studio-summary')).toBe('6 x 9 in · mailed in 1-2 business days');

    const dated = mount();
    await dated.show(output({ arrivalWindow: WINDOW, schedule: { arriveBy: '2026-10-20', mailOn: '2026-10-09' } }), ON);
    expect(text(dated, 'studio-summary')).toMatch(/^6 x 9 in · held until Fri, Oct 9(, 2026)?$/);
  });

  it('names the price of mail no pack pays for, and a gift as free', async () => {
    const paid = mount();
    await paid.show(
      output({ canSendNow: false, sendEligibility: { packPays: false, payAndSend: { available: true, amountCents: 399, currency: 'usd' }, letterPack: { available: false } } }),
      ON
    );
    expect(text(paid, 'studio-cost')).toBe('Pay & Send USD 3.99');

    const unpriced = mount();
    await unpriced.show(output({ canSendNow: false, sendEligibility: { packPays: false, payAndSend: { available: false } } }), ON);
    expect(text(unpriced, 'studio-cost')).toBe('Paid when you send it');

    const gift = mount();
    await gift.show(output({ giftCard: { state: 'funded' } }), ON);
    expect(text(gift, 'studio-cost')).toBe('Free: a gift letter');

    const two = mount();
    await two.show(output({ lettersRequired: 2 }), ON);
    expect(text(two, 'studio-cost')).toBe('2 letters');
  });

  it('sends with send_postcard from the footer, then says it was sent', async () => {
    const card = mount();
    await card.show(output(), ON);
    await card.click(card.byId('send-button'));
    expect(card.lastRequest('tools/call', 'send_postcard')!.params.arguments).toEqual({ draftId: 'draft_0001', confirm: true });
    await card.answer({ result: { content: [{ type: 'text', text: 'Sent.' }], structuredContent: { orderId: 'order-1' } } }, 'send_postcard');
    expect(text(card, 'studio-sub')).toBe('Sent · New York, NY 10118');
  });

  it('says a postcard sent with a date and cancelled will not be mailed', async () => {
    const card = mount();
    await card.show(output({ arrivalWindow: WINDOW, schedule: { arriveBy: '2026-10-20', mailOn: '2026-10-09' } }), ON);
    await card.click(card.byId('send-button'));
    await card.answer(
      {
        result: {
          content: [{ type: 'text', text: 'Scheduled.' }],
          structuredContent: { orderId: 'order-1', currentStatus: 'scheduled', schedule: { arriveBy: '2026-10-20', mailOn: '2026-10-09' }, cancellable: true }
        }
      },
      'send_postcard'
    );
    expect(text(card, 'studio-sub')).toBe('Sent · New York, NY 10118');
    expect(text(card, 'studio-summary')).toMatch(/held until Fri, Oct 9/);
    await card.click(card.byId('cancel-scheduled-button'));
    await card.click(card.byId('cancel-scheduled-button'));
    await card.answer({ result: { content: [{ type: 'text', text: 'Cancelled.' }], structuredContent: { orderId: 'order-1', status: 'cancelled' } } }, 'cancel_scheduled_mail');
    expect(text(card, 'studio-sub')).toBe('Cancelled · New York, NY 10118');
    expect(text(card, 'studio-summary')).toBe('6 x 9 in · cancelled, nothing will be mailed');
  });

  it('holds a postcard the server says is waiting for its mail date, and says when one was cancelled', async () => {
    const card = mount();
    await card.show(output(), ON);
    await card.answer(
      {
        result: {
          content: [],
          structuredContent: { draftId: 'draft_0001', status: 'sent', orderId: 'order-1', orderStatus: 'scheduled', schedule: { arriveBy: '2026-10-20', mailOn: '2026-10-09' }, cancellable: true }
        }
      },
      'get_draft_status'
    );
    expect(text(card, 'studio-sub')).toBe('Sent · New York, NY 10118');
    expect(text(card, 'studio-summary')).toMatch(/^6 x 9 in · held until Fri, Oct 9(, 2026)?$/);

    const gone = mount();
    await gone.show(output(), ON);
    await gone.answer(
      { result: { content: [], structuredContent: { draftId: 'draft_0001', status: 'sent', orderId: 'order-1', orderStatus: 'cancelled' } } },
      'get_draft_status'
    );
    expect(text(gone, 'studio-sub')).toBe('Cancelled · New York, NY 10118');
  });

  it('says a postcard the server or its own send put with the printer is there, whatever date its preview had', async () => {
    const dated = { arrivalWindow: WINDOW, schedule: { arriveBy: '2026-10-20', mailOn: '2026-10-09' }, deliveryEstimate: 'Goes to the printer Fri, Oct 9.' };
    const card = mount();
    await card.show(output(dated), ON);
    await card.answer(
      { result: { content: [], structuredContent: { draftId: 'draft_0001', status: 'sent', orderId: 'order-1', orderStatus: 'sent', schedule: null } } },
      'get_draft_status'
    );
    expect(text(card, 'studio-sub')).toBe('Sent · New York, NY 10118');
    expect(text(card, 'studio-summary')).toBe('6 x 9 in · with the printer');

    const own = mount();
    await own.show(output(dated), ON);
    await own.click(own.byId('send-button'));
    await own.answer({ result: { content: [{ type: 'text', text: 'Sent.' }], structuredContent: { orderId: 'order-1', currentStatus: 'sent' } } }, 'send_postcard');
    expect(text(own, 'studio-summary')).toBe('6 x 9 in · with the printer');
  });

  it('says an expired preview has expired', async () => {
    const card = mount();
    await card.show(output(), ON);
    await card.answer({ result: { content: [], structuredContent: { draftId: 'draft_0001', status: 'expired' } } }, 'get_draft_status');
    expect(text(card, 'studio-sub')).toBe('Expired · New York, NY 10118');
    expect(text(card, 'studio-summary')).toBe('6 x 9 in · the preview has expired');
  });

  it('follows a Pay & Send order: paid, then with the printer', async () => {
    const card = mount();
    await card.show(
      output({ canSendNow: false, sendEligibility: { packPays: false, payAndSend: { available: true, amountCents: 399, currency: 'usd' }, letterPack: { available: false } } }),
      ON
    );
    await card.click(card.byId('pay-send-button'));
    await card.answer(
      { result: { content: [], structuredContent: { orderId: 'order-1', checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_1' } } },
      'create_mail_checkout'
    );
    expect(text(card, 'studio-sub')).toBe('Draft · New York, NY 10118');
    await card.click(card.byId('check-status-button'));
    await card.answer({ result: { content: [], structuredContent: { orderId: 'order-1', purchaseStatus: 'processing' } } }, 'get_purchase_status');
    expect(text(card, 'studio-sub')).toBe('Paid · New York, NY 10118');
    expect(text(card, 'studio-cost')).toBe('Paid USD 3.99');
    expect(text(card, 'studio-summary')).toBe('6 x 9 in · paid, going to the printer');
    await card.click(card.byId('check-status-button'));
    await card.answer({ result: { content: [], structuredContent: { orderId: 'order-1', purchaseStatus: 'submitted' } } }, 'get_purchase_status');
    expect(text(card, 'studio-sub')).toBe('Sent · New York, NY 10118');
    expect(text(card, 'studio-summary')).toBe('6 x 9 in · with the printer');

    const unpriced = mount();
    await unpriced.show(
      output({ canSendNow: false, sendEligibility: { packPays: false, payAndSend: { available: true }, letterPack: { available: false } } }),
      ON
    );
    await unpriced.click(unpriced.byId('pay-send-button'));
    await unpriced.answer(
      { result: { content: [], structuredContent: { orderId: 'order-2', checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_2' } } },
      'create_mail_checkout'
    );
    await unpriced.click(unpriced.byId('check-status-button'));
    await unpriced.answer({ result: { content: [], structuredContent: { orderId: 'order-2', purchaseStatus: 'processing' } } }, 'get_purchase_status');
    expect(text(unpriced, 'studio-cost')).toBe('Paid with Pay & Send');
  });

  it('holds a dated Pay & Send order while it waits, then says it is with the printer', async () => {
    const card = mount();
    await card.show(
      output({
        arrivalWindow: WINDOW,
        schedule: { arriveBy: '2026-10-20', mailOn: '2026-10-09' },
        canSendNow: false,
        sendEligibility: { packPays: false, payAndSend: { available: true, amountCents: 399, currency: 'usd' }, letterPack: { available: false } }
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
    expect(text(card, 'studio-summary')).toMatch(/^6 x 9 in · held until Fri, Oct 9(, 2026)?$/);
    await card.click(card.byId('check-status-button'));
    await card.answer({ result: { content: [], structuredContent: { orderId: 'order-1', purchaseStatus: 'submitted' } } }, 'get_purchase_status');
    expect(text(card, 'studio-summary')).toBe('6 x 9 in · with the printer');
  });

  it.each([
    ['payment_failed', 'Draft', 'the payment did not go through'],
    ['refund_pending', 'Refunded', 'being refunded, nothing will be mailed'],
    ['refunded', 'Refunded', 'refunded, nothing will be mailed'],
    ['on_hold', 'On hold', 'on hold'],
    ['cancelled', 'Cancelled', 'cancelled, nothing will be mailed']
  ])('never promises mail for a Pay & Send order %s', async (status, stage, timing) => {
    const card = mount();
    await card.show(
      output({ canSendNow: false, sendEligibility: { packPays: false, payAndSend: { available: true, amountCents: 399, currency: 'usd' }, letterPack: { available: false } } }),
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
    expect(text(card, 'studio-sub')).toBe(`${stage} · New York, NY 10118`);
    expect(text(card, 'studio-summary')).toBe(`6 x 9 in · ${timing}`);
  });

  it("takes the estimate a cleared date brings, not the dated preview's", async () => {
    const card = mount();
    await card.show(
      output({ arrivalWindow: WINDOW, schedule: { arriveBy: '2026-10-20', mailOn: '2026-10-09' }, deliveryEstimate: 'Goes to the printer Fri, Oct 9.' }),
      ON
    );
    await card.click(card.byId('arrives-asap'));
    await card.answer(
      { result: { content: [], structuredContent: { draftId: 'draft_0001', schedule: null, deliveryEstimate: 'Mailed in 1-2 business days', message: 'Cleared.' } } },
      'set_arrival_date'
    );
    expect(text(card, 'studio-summary')).toBe('6 x 9 in · mailed in 1-2 business days');
  });
});
