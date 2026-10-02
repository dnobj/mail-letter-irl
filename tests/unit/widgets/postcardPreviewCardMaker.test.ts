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
const inert = (card: ReturnType<typeof mount>, selector: string) =>
  [...card.document.querySelectorAll(selector)].map(button => button.getAttribute('aria-disabled') === 'true');
const frontViewBox = (card: ReturnType<typeof mount>) => card.byId('preview-front').querySelector('svg')!.getAttribute('viewBox');
/**
 * A selector's specificity as one number: ids, then classes, attributes and
 * pseudo-classes, then types. `:not()` counts only its argument.
 */
function specificity(selector: string): number {
  const bare = selector.replace(/:not\(/g, '(');
  const ids = bare.match(/#[\w-]+/g)?.length ?? 0;
  const classes = bare.match(/\.[\w-]+|\[[^\]]*\]|(?<!:):(?!:)[\w-]+/g)?.length ?? 0;
  const types = bare.replace(/\[[^\]]*\]|::?[\w-]+|[#.][\w-]+/g, ' ').match(/[a-z][\w-]*/gi)?.length ?? 0;
  return ids * 1e6 + classes * 1e3 + types;
}
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
    // Inert by aria-disabled, so the pressed choice keeps keyboard focus (#603 review round 1).
    expect(inert(card, '#studio-sizes [data-size]')).toEqual([true, true, true]);
    expect([...card.document.querySelectorAll<HTMLButtonElement>('#studio-sizes [data-size]')].some(button => button.disabled)).toBe(false);
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
    // The server's own sentence, announced (role=status).
    expect(card.byId('studio-style-note').textContent).toBe('The postcard is now a 4x6, with the photo across the front.');
    expect(card.byId('studio-style-note').classList.contains('studio-error')).toBe(false);
    expect(inert(card, '#studio-sizes [data-size]')).toEqual([false, false, false]);
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

describe('the maker after #603 review round 1', () => {
  const PER_SEND_4X6 = {
    draftId: 'draft_0001', size: '6x4', layout: 'full_bleed', canSendNow: false, sendEligibility: PER_SEND,
    message: 'The postcard is now a 4x6, with the photo across the front.'
  };

  it('hides what it hides: every rule that lays out a hidden element loses to a [hidden] rule for it', async () => {
    // JSDOM hides every [hidden] element whatever the author CSS says, so the
    // cascade is checked here: a rule that matches a hidden element and gives
    // it a display must lose to a [hidden] rule that matches it too, by
    // !important, by specificity, or by coming later.
    const card = mount();
    await card.show(output(), ON());
    const css = [...card.document.querySelectorAll('style')]
      .map(style => style.textContent ?? '')
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].flatMap(([, list, body], order) => {
      const display = /display\s*:\s*([^;!}]+?)\s*(!\s*important)?\s*(?:;|$)/.exec(body);
      return display ? list.split(',').map(selector => ({ selector: selector.trim(), value: display[1], important: Boolean(display[2]), order })) : [];
    });
    const matches = (element: Element, selector: string) => {
      try {
        return element.matches(selector);
      } catch {
        return false;
      }
    };
    // The unmounted templates too, each in a document of its own.
    const templates = new JSDOM(card.document.documentElement.outerHTML).window.document;
    for (const template of templates.querySelectorAll('template')) templates.body.append((template as HTMLTemplateElement).content.cloneNode(true));
    const hidden = [...card.document.querySelectorAll('[hidden]'), ...templates.querySelectorAll('[hidden]')];
    expect(hidden.map(element => element.id)).toEqual(expect.arrayContaining(['studio-sizes', 'studio-front', 'studio-line']));
    const checked = new Map<string, { laidOut: number; hidden: number }>();
    for (const element of hidden) {
      const applying = rules.filter(rule => matches(element, rule.selector));
      const hiding = applying.filter(rule => rule.value === 'none' && rule.selector.includes('[hidden]'));
      const layingOut = applying.filter(rule => rule.value !== 'none');
      for (const rule of layingOut) {
        const loses = hiding.some(hide =>
          hide.important ||
          (!rule.important && (specificity(hide.selector) > specificity(rule.selector) ||
            (specificity(hide.selector) === specificity(rule.selector) && hide.order > rule.order)))
        );
        expect(loses, `${rule.selector} {display: ${rule.value}} on #${element.id || element.className}`).toBe(true);
      }
      if (element.id) checked.set(element.id, { laidOut: layingOut.length, hidden: hiding.length });
    }
    // Not passed for want of anything to check (#603 review round 3): each of
    // the maker's containers was matched by the rule that lays it out and by
    // the [hidden] rule that hides it.
    for (const id of ['studio-sizes', 'studio-front', 'studio-line']) {
      expect(checked.get(id)?.laidOut, id).toBeGreaterThan(0);
      expect(checked.get(id)?.hidden, id).toBeGreaterThan(0);
    }
  });

  it('keeps its own change when an older status answer lands after it', async () => {
    const card = mount();
    await card.show(output({ size: '6x9', layout: 'full_bleed' }), ON());
    await card.click(card.document.querySelector('[data-size="6x4"]')!);
    await card.answer(restyled(PER_SEND_4X6, drawn('6x4')), 'set_postcard_style');
    // The status asked on the first draw answers now, with the style before the change.
    await card.answer(
      {
        result: {
          content: [{ type: 'text', text: 'Ready.' }],
          structuredContent: { draftId: 'draft_0001', status: 'ready', size: '6x9', layout: 'full_bleed', canSendNow: true, sendEligibility: PACK },
          _meta: { previewHtml: drawn() }
        }
      },
      'get_draft_status'
    );
    expect(pressed(card, '#studio-sizes [data-size]')).toEqual(['4 x 6 in']);
    expect(card.byId('studio-cost').textContent).toBe('Pay & Send USD 3.99');
    expect(frontViewBox(card)).toBe('0 0 450 306');
  });

  it('ignores a status answer that lands while a change is made', async () => {
    const card = mount();
    await card.show(output({ size: '6x9', layout: 'full_bleed' }), ON());
    await card.click(card.document.querySelector('[data-size="6x11"]')!);
    await card.answer(
      {
        result: {
          content: [{ type: 'text', text: 'Ready.' }],
          structuredContent: { draftId: 'draft_0001', status: 'ready', size: '6x4', layout: 'full_bleed', canSendNow: false, sendEligibility: PER_SEND },
          _meta: { previewHtml: drawn('6x4') }
        }
      },
      'get_draft_status'
    );
    await card.answer({ result: { isError: true, content: [{ type: 'text', text: 'The postcard changed while it was being drawn again.' }] } }, 'set_postcard_style');
    expect(pressed(card, '#studio-sizes [data-size]')).toEqual(['6 x 9 in']);
    expect(card.byId('studio-style-note').classList.contains('studio-error')).toBe(true);
  });

  it('holds Send and Pay & Send while a greeting waits for its place, and lets them go once it is set or left', async () => {
    const sending = mount();
    await sending.show(output({ layout: 'full_bleed' }), ON());
    await sending.click(sending.document.querySelector('[data-layout="greetings"]')!);
    await sending.type('Rye');
    expect((sending.byId('send-button') as HTMLButtonElement).disabled).toBe(true);
    await sending.click(sending.byId('send-button'));
    expect(sending.requests('send_postcard')).toEqual([]);
    // Back to the front it has: the greeting and its prompt go, and Send with them.
    await sending.click(sending.document.querySelector('[data-layout="full_bleed"]')!);
    expect(sending.byId('studio-style-note').textContent).toBe('');
    expect(sending.byId('studio-line').hidden).toBe(true);
    expect((sending.byId('send-button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('holds Pay & Send while a caption differs from the one the draft has, and not once it matches again', async () => {
    const card = mount();
    await card.show(
      output({ size: '6x4', layout: 'border', caption: 'Cape Cod', canSendNow: false, sendEligibility: PER_SEND }),
      ON(drawn('6x4', { layout: 'border', caption: 'Cape Cod' }))
    );
    await card.type('Nantucket');
    expect((card.byId('pay-send-button') as HTMLButtonElement).disabled).toBe(true);
    await card.click(card.byId('pay-send-button'));
    expect(card.requests('create_mail_checkout')).toEqual([]);
    await card.type('Cape Cod');
    expect((card.byId('pay-send-button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps a caption being written through a change of size', async () => {
    const card = mount();
    await card.show(output({ size: '6x9', layout: 'border', caption: 'Cape Cod' }), ON(drawn('6x9', { layout: 'border', caption: 'Cape Cod' })));
    await card.type('Nantucket');
    await card.click(card.document.querySelector('[data-size="6x11"]')!);
    await card.answer(
      restyled(
        { draftId: 'draft_0001', size: '6x11', layout: 'border', caption: 'Cape Cod', canSendNow: false, sendEligibility: PER_SEND, message: 'Resized.' },
        drawn('6x11', { layout: 'border', caption: 'Cape Cod' })
      ),
      'set_postcard_style'
    );
    expect((card.byId('studio-line-input') as HTMLInputElement).value).toBe('Nantucket');
  });

  it('keeps the place written so far when Greetings is pressed again', async () => {
    const card = mount();
    await card.show(output({ layout: 'full_bleed' }), ON());
    await card.click(card.document.querySelector('[data-layout="greetings"]')!);
    await card.type('Rye');
    await card.click(card.document.querySelector('[data-layout="greetings"]')!);
    expect((card.byId('studio-line-input') as HTMLInputElement).value).toBe('Rye');
  });

  it('keeps its change through a host redraw while the change is made', async () => {
    const card = mount();
    await card.show(output({ size: '6x9' }), ON());
    await card.click(card.document.querySelector('[data-size="6x4"]')!);
    // The host sends the preview's result again meanwhile.
    await card.show(output({ size: '6x9' }), ON());
    await card.answer(restyled(PER_SEND_4X6, drawn('6x4')), 'set_postcard_style');
    expect(pressed(card, '#studio-sizes [data-size]')).toEqual(['4 x 6 in']);
    expect(frontViewBox(card)).toBe('0 0 450 306');
  });

  it('names the new size, and says the page did not come back, when an answer has no page', async () => {
    const card = mount();
    await card.show(output({ size: '6x9' }), ON());
    await card.click(card.document.querySelector('[data-size="6x4"]')!);
    await card.answer(restyled(PER_SEND_4X6), 'set_postcard_style');
    expect(card.byId('studio-summary').textContent).toMatch(/^4 x 6 in · /);
    expect(card.byId('studio-style-note').textContent).toBe(
      'The postcard is changed, but its page did not come back here. Make the preview again to see it.'
    );
  });

  it('keeps keyboard focus on the choice pressed while the change is made', async () => {
    const card = mount();
    await card.show(output({ size: '6x9' }), ON());
    const button = card.document.querySelector<HTMLButtonElement>('[data-size="6x4"]')!;
    button.focus();
    await card.click(button);
    expect(button.disabled).toBe(false);
    expect(card.document.activeElement).toBe(button);
    // A press meanwhile asks nothing more.
    await card.click(card.document.querySelector('[data-size="6x11"]')!);
    expect(card.requests('set_postcard_style')).toHaveLength(1);
  });

  it('does not offer a gift postcard another size, as a gift letter pays for a 6x9 only', async () => {
    const card = mount();
    await card.show(output({ size: '6x9', layout: 'full_bleed', giftCard: { state: 'funded', description: 'A gift card.' } }), ON());
    expect(card.byId('studio-sizes').hidden).toBe(true);
    expect(card.byId('studio-size').hidden).toBe(false);
    expect(card.byId('studio-front').hidden).toBe(false);
  });

  it("names the line's limit to a screen reader", async () => {
    const card = mount();
    await card.show(output({ layout: 'border' }), ON(drawn('6x9', { layout: 'border' })));
    expect(card.byId('studio-line-input').getAttribute('aria-describedby')).toBe('studio-line-hint');
    expect(card.byId('studio-line-hint').textContent).toBe('Up to 60 characters, or none.');
  });
});

describe('the maker after #603 review round 2', () => {
  const sendDisabled = (card: ReturnType<typeof mount>) => (card.byId('send-button') as HTMLButtonElement).disabled;
  const BORDER = { layout: 'border', caption: 'Cape Cod' } as const;

  it("draws another draft's Send free of what was being written for the last", async () => {
    const greeting = mount();
    await greeting.show(output({ layout: 'full_bleed' }), ON());
    await greeting.click(greeting.document.querySelector('[data-layout="greetings"]')!);
    await greeting.type('Rye');
    expect(sendDisabled(greeting)).toBe(true);
    // The host's result for another draft replaces the card's, as on a retry (#411).
    await greeting.show(output({ draftId: 'draft_0002', layout: 'full_bleed' }), ON());
    expect(sendDisabled(greeting)).toBe(false);
    expect(pressed(greeting, '#studio-front [data-layout]')).toEqual(['Full']);
    expect(greeting.byId('studio-line').hidden).toBe(true);

    const caption = mount();
    await caption.show(output(BORDER), ON(drawn('6x9', BORDER)));
    await caption.type('Nantucket');
    expect(sendDisabled(caption)).toBe(true);
    await caption.show(output({ draftId: 'draft_0002', ...BORDER }), ON(drawn('6x9', BORDER)));
    expect(sendDisabled(caption)).toBe(false);
    expect((caption.byId('studio-line-input') as HTMLInputElement).value).toBe('Cape Cod');
  });

  it('says why Send waits while a caption differs, and puts the caption back', async () => {
    const card = mount();
    await card.show(output(BORDER), ON(drawn('6x9', BORDER)));
    expect(card.byId('studio-line-revert').hidden).toBe(true);
    await card.type('Nantucket');
    expect(card.byId('studio-line-hint').textContent).toBe('Up to 60 characters, or none. Sending waits until you Update or Put back.');
    expect(card.byId('studio-line-revert').hidden).toBe(false);

    card.byId('studio-line-revert').focus();
    await card.click(card.byId('studio-line-revert'));
    expect((card.byId('studio-line-input') as HTMLInputElement).value).toBe('Cape Cod');
    expect(sendDisabled(card)).toBe(false);
    expect(card.byId('studio-line-revert').hidden).toBe(true);
    expect(card.byId('studio-line-hint').textContent).toBe('Up to 60 characters, or none.');
    expect(card.document.activeElement).toBe(card.byId('studio-line-input'));
    expect(card.requests('set_postcard_style')).toEqual([]);
  });

  it('puts a greeting being written back to the front the postcard has, refusal and all', async () => {
    const card = mount();
    await card.show(output({ layout: 'full_bleed' }), ON());
    await card.click(card.document.querySelector('[data-layout="greetings"]')!);
    await card.type('Rye');
    await card.click(card.byId('studio-line-apply'));
    await card.answer({ result: { isError: true, content: [{ type: 'text', text: 'Too wide.' }] } }, 'set_postcard_style');
    expect(card.byId('studio-style-note').textContent).toBe('Too wide.');
    expect(sendDisabled(card)).toBe(true);

    await card.click(card.byId('studio-line-revert'));
    expect(pressed(card, '#studio-front [data-layout]')).toEqual(['Full']);
    expect(card.byId('studio-line').hidden).toBe(true);
    expect(card.byId('studio-style-note').textContent).toBe('');
    expect(card.byId('studio-style-note').classList.contains('studio-error')).toBe(false);
    expect(sendDisabled(card)).toBe(false);
    expect(card.document.activeElement).toBe(card.document.querySelector('[data-layout="full_bleed"]'));
  });

  it("keeps a size's refusal when a greeting being written is left or put back", async () => {
    const TOO_LONG = 'The message is too long for the back of a 4x6 postcard.';
    for (const leave of ['full', 'revert'] as const) {
      const card = mount();
      await card.show(output({ size: '6x9', layout: 'full_bleed' }), ON());
      await card.click(card.document.querySelector('[data-layout="greetings"]')!);
      await card.type('Rye');
      await card.click(card.document.querySelector('[data-size="6x4"]')!);
      await card.answer({ result: { isError: true, content: [{ type: 'text', text: TOO_LONG }] } }, 'set_postcard_style');
      expect(card.byId('studio-style-note').textContent, leave).toBe(TOO_LONG);
      await card.click(leave === 'full' ? card.document.querySelector('[data-layout="full_bleed"]')! : card.byId('studio-line-revert'));
      expect(pressed(card, '#studio-front [data-layout]'), leave).toEqual(['Full']);
      expect(card.byId('studio-style-note').textContent, leave).toBe(TOO_LONG);
    }
  });

  it('drops a refusal with the greeting it refused when the front the postcard has is pressed', async () => {
    const card = mount();
    await card.show(output({ layout: 'full_bleed' }), ON());
    await card.click(card.document.querySelector('[data-layout="greetings"]')!);
    await card.type('Rye');
    await card.click(card.byId('studio-line-apply'));
    await card.answer({ result: { isError: true, content: [{ type: 'text', text: 'Too wide.' }] } }, 'set_postcard_style');
    await card.click(card.document.querySelector('[data-layout="full_bleed"]')!);
    expect(card.byId('studio-style-note').textContent).toBe('');
    expect(sendDisabled(card)).toBe(false);
  });
});
