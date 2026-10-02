/**
 * The postcard maker's size and front (#594): while the preview names its
 * size or its front (each named only while it is offered), the maker offers
 * the choices and sets them on the draft with set_postcard_style, the tool a
 * model would call. It shows the postcard the answer draws again, and what it
 * costs now; Send waits meanwhile, and a refusal is said in place. A card
 * shown its preview again takes the style get_draft_status says the draft
 * has. Framed by a fake MCP Apps host, with postcards drawn by the real
 * renderer.
 */

import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';
import { inlineHostBridge } from '../../../src/mcp/widgetHost.js';
import { stampPreviewTool } from '../../../src/mcp/registerTools.js';
import { layoutPostcard, POSTCARD_GEOMETRY, renderPreviewSvg, type PostcardFront } from '../../../src/render/index.js';
import { renderPostcardPreviewDocument } from '../../../src/services/previewService.js';
import type { PostcardSize } from '../../../src/services/types.js';

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

/** The postcard as our renderer draws it, at a size and with a front. */
function drawn(size: PostcardSize = '6x9', front: PostcardFront | Record<string, never> = {}): string {
  return renderPostcardPreviewDocument(renderPreviewSvg(
    layoutPostcard({ message: MESSAGE, image: { bytes: pngBytes(540, 360), mime: 'image/png', width: 540, height: 360 }, size, ...front }),
    {
      addresses: { from: ['RETURN TO:', 'PAT EXAMPLE', '1 MAIN ST', 'SPRINGFIELD, IL 62701'], to: ['SAM RIVERA', '350 FIFTH AVE', 'NEW YORK, NY 10118'] },
      stamp: { page: 1, geometry: POSTCARD_GEOMETRY[size].stamp }
    }
  ));
}

const recipient = { name: 'Sam Rivera', addressLine1: '350 Fifth Ave', city: 'New York', state: 'NY', postalCode: '10118' };
const ARGS = { recipient, message: MESSAGE, imageUrl: 'https://example.com/beach.jpg' };
const PACK = {
  packPays: true,
  payAndSend: { available: false, unavailableReason: "Pay & Send isn't available in this app." },
  letterPack: { available: false, purchaseUrl: 'https://letterirl.example/packs' }
};
const PER_SEND = {
  packPays: false,
  payAndSend: { available: true, amountCents: 399, currency: 'usd' },
  letterPack: { available: false, purchaseUrl: 'https://letterirl.example/packs' }
};

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
  sendEligibility: PACK,
  ...extra
});

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise(resolve => setImmediate(resolve));
}

/** The card as served, in a fake MCP Apps host. */
function mount() {
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
    }
  });
  const window = dom.window as any;
  const document = window.document as Document;
  const deliver = async (message: Json) => {
    window.dispatchEvent(new window.MessageEvent('message', { data: { jsonrpc: '2.0', ...message }, source: parent }));
    await flush();
  };
  const requests = (name: string) => sent.filter(message => message.method === 'tools/call' && message.params?.name === name);
  const lastRequest = (method: string, name?: string) =>
    [...sent].reverse().find(message => message.method === method && message.id !== undefined && (name === undefined || message.params?.name === name));
  let initialized = false;
  const byId = (id: string) => document.getElementById(id) as HTMLElement;
  return {
    window,
    document,
    requests,
    byId,
    async show(result: Json, meta: Json) {
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
        params: { content: [{ type: 'text', text: 'Preview ready.' }], structuredContent: result, _meta: meta }
      });
    },
    async answer(reply: Json, name: string) {
      const request = lastRequest('tools/call', name);
      if (!request) throw new Error(`the card sent no ${name}`);
      await deliver({ id: request.id, ...reply });
    },
    async click(element: Element) {
      element.dispatchEvent(new window.Event('click', { bubbles: true }));
      await flush();
    },
    async type(text: string) {
      const input = byId('studio-line-input') as HTMLInputElement;
      input.value = text;
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      await flush();
    }
  };
}

const ON = (page = drawn()) => ({ previewHtml: page, [STUDIO]: true });
const pressed = (card: ReturnType<typeof mount>, selector: string) =>
  [...card.document.querySelectorAll(selector)].filter(button => button.getAttribute('aria-pressed') === 'true').map(button => button.textContent);
const frontViewBox = (card: ReturnType<typeof mount>) => card.byId('preview-front').querySelector('svg')!.getAttribute('viewBox');
const restyled = (structuredContent: Json, page?: string) => ({
  result: {
    content: [{ type: 'text', text: structuredContent.message ?? 'Changed.' }],
    structuredContent,
    ...(page ? { _meta: { previewHtml: page } } : {})
  }
});

describe("the postcard maker's choices (#594)", () => {
  it('offers none while the preview names neither its size nor its front', async () => {
    const card = mount();
    await card.show(output(), ON());
    expect(card.byId('studio-sizes').hidden).toBe(true);
    expect(card.byId('studio-front').hidden).toBe(true);
    expect(card.byId('studio-size').hidden).toBe(false);
    expect(card.byId('studio-size').textContent).toBe('6 x 9 in');
  });

  it('offers the sizes while the preview names its size, and the front while it names its front', async () => {
    const card = mount();
    await card.show(output({ size: '6x9' }), ON());
    expect(card.byId('studio-sizes').hidden).toBe(false);
    expect(card.byId('studio-size').hidden).toBe(true);
    expect(pressed(card, '#studio-sizes [data-size]')).toEqual(['6 x 9 in']);
    expect(card.byId('studio-front').hidden).toBe(true);

    const both = mount();
    await both.show(output({ size: '6x9', layout: 'border', caption: 'Cape Cod' }), ON(drawn('6x9', { layout: 'border', caption: 'Cape Cod' })));
    expect(pressed(both, '#studio-front [data-layout]')).toEqual(['Border']);
    expect(both.byId('studio-line').hidden).toBe(false);
    expect(both.byId('studio-line-label').textContent).toBe('Caption');
    expect((both.byId('studio-line-input') as HTMLInputElement).value).toBe('Cape Cod');
    expect((both.byId('studio-line-input') as HTMLInputElement).maxLength).toBe(60);
  });
});

describe('a size set on the maker (#594)', () => {
  it('is set with set_postcard_style, holding Send meanwhile, and shows the postcard and price it answers with', async () => {
    const card = mount();
    await card.show(output({ size: '6x9' }), ON());
    await card.click(card.document.querySelector('[data-size="6x4"]')!);

    const [request] = card.requests('set_postcard_style');
    expect(request.params.arguments).toEqual({ draftId: 'draft_0001', size: '6x4' });
    // Meanwhile: the choices and Send wait, and the maker says why.
    expect([...card.document.querySelectorAll<HTMLButtonElement>('#studio-sizes [data-size]')].every(button => button.disabled)).toBe(true);
    expect((card.byId('send-button') as HTMLButtonElement).disabled).toBe(true);
    expect(card.byId('studio-style-note').textContent).toBe('Drawing the postcard again.');

    await card.answer(
      restyled(
        {
          draftId: 'draft_0001', size: '6x4', layout: 'full_bleed', canSendNow: false, sendEligibility: PER_SEND,
          reasonCannotSend: 'Letter packs and gift letters pay for one-page letters and 6x9 postcards; this one is paid with Pay & Send.',
          message: 'The postcard is now a 4x6, with the photo across the front.'
        },
        drawn('6x4')
      ),
      'set_postcard_style'
    );
    expect(pressed(card, '#studio-sizes [data-size]')).toEqual(['4 x 6 in']);
    expect(frontViewBox(card)).toBe('0 0 450 306');
    expect(card.byId('studio-summary').textContent).toMatch(/^4 x 6 in · /);
    expect(card.byId('studio-cost').textContent).toBe('Pay & Send USD 3.99');
    expect(card.byId('studio-style-note').textContent).toBe('');
    expect([...card.document.querySelectorAll<HTMLButtonElement>('#studio-sizes [data-size]')].some(button => button.disabled)).toBe(false);
  });

  it('says a refusal in place and keeps the postcard as it was', async () => {
    const card = mount();
    await card.show(output({ size: '6x9' }), ON());
    await card.click(card.document.querySelector('[data-size="6x4"]')!);
    const refusal = 'The message is too long for the back of a 4x6 postcard: it takes 13 lines and the back holds 11.';
    await card.answer({ result: { isError: true, content: [{ type: 'text', text: refusal }] } }, 'set_postcard_style');
    expect(card.byId('studio-style-note').textContent).toContain('too long for the back of a 4x6 postcard');
    expect(pressed(card, '#studio-sizes [data-size]')).toEqual(['6 x 9 in']);
    expect(frontViewBox(card)).toBe('0 0 666 450');
  });

  it('neither sends nor pays while a change is being made, however the button is pressed', async () => {
    // Pressed by script, past the disabled state a person would see.
    const sending = mount();
    await sending.show(output({ size: '6x9' }), ON());
    await sending.click(sending.document.querySelector('[data-size="6x11"]')!);
    await sending.click(sending.byId('send-button'));
    expect(sending.requests('send_postcard')).toEqual([]);

    const paying = mount();
    await paying.show(output({ size: '6x9', canSendNow: false, sendEligibility: PER_SEND }), ON());
    await paying.click(paying.document.querySelector('[data-size="6x4"]')!);
    await paying.click(paying.byId('pay-send-button'));
    expect(paying.requests('create_mail_checkout')).toEqual([]);
  });

  it('asks nothing for the size it already has', async () => {
    const card = mount();
    await card.show(output({ size: '6x9' }), ON());
    await card.click(card.document.querySelector('[data-size="6x9"]')!);
    expect(card.requests('set_postcard_style')).toEqual([]);
  });
});

describe('a front set on the maker (#594)', () => {
  it('sets a border at once, and its caption with Update', async () => {
    const card = mount();
    await card.show(output({ layout: 'full_bleed' }), ON());
    expect(card.byId('studio-line').hidden).toBe(true);
    await card.click(card.document.querySelector('[data-layout="border"]')!);
    expect(card.requests('set_postcard_style').map(request => request.params.arguments)).toEqual([{ draftId: 'draft_0001', layout: 'border' }]);
    await card.answer(
      restyled({ draftId: 'draft_0001', size: '6x9', layout: 'border', canSendNow: true, sendEligibility: PACK, message: 'Bordered.' }, drawn('6x9', { layout: 'border' })),
      'set_postcard_style'
    );
    expect(pressed(card, '#studio-front [data-layout]')).toEqual(['Border']);
    expect(card.byId('studio-line').hidden).toBe(false);

    await card.type('Cape Cod');
    await card.click(card.byId('studio-line-apply'));
    expect(card.requests('set_postcard_style')[1].params.arguments).toEqual({ draftId: 'draft_0001', layout: 'border', caption: 'Cape Cod' });
    await card.answer(
      restyled(
        { draftId: 'draft_0001', size: '6x9', layout: 'border', caption: 'Cape Cod', canSendNow: true, sendEligibility: PACK, message: 'Captioned.' },
        drawn('6x9', { layout: 'border', caption: 'Cape Cod' })
      ),
      'set_postcard_style'
    );
    expect(card.byId('preview-front').querySelector('title')!.textContent).toBe('Cape Cod');
    expect((card.byId('studio-line-input') as HTMLInputElement).value).toBe('Cape Cod');
  });

  it('asks a greeting for its place before setting it, and takes it with Enter', async () => {
    const card = mount();
    await card.show(output({ layout: 'full_bleed' }), ON());
    await card.click(card.document.querySelector('[data-layout="greetings"]')!);
    expect(card.requests('set_postcard_style')).toEqual([]);
    expect(pressed(card, '#studio-front [data-layout]')).toEqual(['Greetings']);
    expect(card.byId('studio-line-label').textContent).toBe('Place');
    expect((card.byId('studio-line-input') as HTMLInputElement).maxLength).toBe(30);
    expect(card.byId('studio-style-note').textContent).toBe('Write the place it greets from, then Update.');
    // Nothing to send without a place.
    await card.click(card.byId('studio-line-apply'));
    expect(card.requests('set_postcard_style')).toEqual([]);

    await card.type('Rye');
    card.byId('studio-line-input').dispatchEvent(new card.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(card.requests('set_postcard_style').map(request => request.params.arguments)).toEqual([
      { draftId: 'draft_0001', layout: 'greetings', place: 'Rye' }
    ]);
  });

  it('takes the front back to the photo alone', async () => {
    const card = mount();
    await card.show(output({ layout: 'border', caption: 'Cape Cod' }), ON(drawn('6x9', { layout: 'border', caption: 'Cape Cod' })));
    await card.click(card.document.querySelector('[data-layout="full_bleed"]')!);
    expect(card.requests('set_postcard_style').map(request => request.params.arguments)).toEqual([{ draftId: 'draft_0001', layout: 'full_bleed' }]);
  });
});

describe('a maker shown its preview again (#594)', () => {
  it('takes the size, front, page and price get_draft_status says the draft has', async () => {
    const card = mount();
    await card.show(output({ size: '6x9', layout: 'full_bleed' }), ON());
    await card.answer(
      {
        result: {
          content: [{ type: 'text', text: 'Ready.' }],
          structuredContent: {
            draftId: 'draft_0001', status: 'ready', deliveryEstimate: 'Mailed in 1-2 business days',
            size: '6x11', layout: 'border', caption: 'Rye', canSendNow: false, sendEligibility: PER_SEND
          },
          _meta: { previewHtml: drawn('6x11', { layout: 'border', caption: 'Rye' }) }
        }
      },
      'get_draft_status'
    );
    expect(pressed(card, '#studio-sizes [data-size]')).toEqual(['6 x 11 in']);
    expect(pressed(card, '#studio-front [data-layout]')).toEqual(['Border']);
    expect((card.byId('studio-line-input') as HTMLInputElement).value).toBe('Rye');
    expect(frontViewBox(card)).toBe('0 0 810 450');
    expect(card.byId('studio-cost').textContent).toBe('Pay & Send USD 3.99');
  });
});
