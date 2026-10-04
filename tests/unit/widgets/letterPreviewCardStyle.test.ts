/**
 * The letter card's Style row (#563): while a preview names its stationery,
 * the card offers the six styles and changes the draft's through
 * set_stationery, then draws the page the tool answers with in place of the
 * preview's. Framed by a fake MCP Apps host, as previewCardsOnBridge.test.ts
 * is: every call the card makes is a JSON-RPC request the test answers.
 */

import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';
import { inlineHostBridge } from '../../../src/mcp/widgetHost.js';
import { stampPreviewTool } from '../../../src/mcp/registerTools.js';

const WIDGET_DIR = path.resolve(__dirname, '../../../widgets');

type Json = Record<string, any>;

const recipient = { name: 'Sam Rivera', addressLine1: '1 Main St', city: 'Springfield', state: 'IL', postalCode: '62701' };
const ARGS = { recipient, bodyText: 'Dear Sam,', signOff: 'Pat' };

/** A preview document as our renderer writes it: one page, titled with what it says. */
const page = (title: string, extra = '') =>
  '<!DOCTYPE html><html><body data-renderer="pdf-1">' +
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 612 792" role="img"><title>${title}</title>` +
  `<rect width="612" height="792" fill="#fff"/>${extra}</svg>` +
  '<div hidden><div class="letter-body">Dear Sam,</div><div class="sign-off">Pat</div></div></body></html>';
const CLASSIC_PAGE = page('Dear Sam,\nPat');
const BOTANICAL_PAGE = page('October 1, 2026\nDear Sam,\nPat', '<path d="M1 1L2 2" fill="none" stroke="#222222" stroke-width="0.75"/>');

const canSend = {
  canSendNow: true,
  sendEligibility: {
    payAndSend: { available: false, unavailableReason: "Pay & Send isn't available in this app." },
    letterPack: { available: false, purchaseUrl: 'https://letterirl.com/packs' }
  }
};

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

/** The card as the server serves it, framed by a fake MCP Apps host. */
function mount(file = 'LetterPreviewCard', tool = 'quote_and_preview_letter') {
  const served = stampPreviewTool(inlineHostBridge(fs.readFileSync(path.join(WIDGET_DIR, `${file}.html`), 'utf-8'), WIDGET_DIR), tool);
  const runnable = served.replace('<script type="module">', '<script>');
  const sent: Json[] = [];
  const parent = { postMessage: (message: Json) => sent.push(JSON.parse(JSON.stringify(message))) };
  const dom = new JSDOM(runnable, {
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
  const lastRequest = (method: string, name?: string) =>
    [...sent].reverse().find(message => message.method === method && message.id !== undefined && (name === undefined || message.params?.name === name));
  const button = (theme: string) => document.querySelector(`#style-row [data-theme="${theme}"]`) as HTMLButtonElement;
  return {
    document,
    deliver,
    sent,
    lastRequest,
    button,
    pressed: () =>
      Array.from(document.querySelectorAll('#style-row [data-theme]'))
        .filter(element => element.getAttribute('aria-pressed') === 'true')
        .map(element => element.getAttribute('data-theme')),
    async show(output: Json, meta: Json = { previewHtml: CLASSIC_PAGE }, hostCapabilities: Json = {}) {
      await flush();
      await deliver({
        id: lastRequest('ui/initialize')!.id,
        result: { protocolVersion: '2026-01-26', hostInfo: { name: 'fake' }, hostCapabilities, hostContext: {} }
      });
      await deliver({ method: 'ui/notifications/tool-input', params: { arguments: ARGS } });
      await deliver({
        method: 'ui/notifications/tool-result',
        params: { content: [{ type: 'text', text: 'Preview ready.' }], structuredContent: output, _meta: meta }
      });
    },
    async choose(theme: string) {
      button(theme).dispatchEvent(new window.Event('click'));
      await flush();
    },
    async answer(reply: Json, name = 'set_stationery') {
      const request = lastRequest('tools/call', name);
      if (!request) throw new Error(`the card sent no ${name}`);
      await deliver({ id: request.id, ...reply });
    },
    async click(id: string) {
      document.getElementById(id)!.dispatchEvent(new window.Event('click'));
      await flush();
    },
    visible: (id: string) => {
      const element = document.getElementById(id) as HTMLElement | null;
      return !!element && element.style.display !== 'none';
    },
    text: (id: string) => document.getElementById(id)?.textContent?.trim() ?? '',
    drawn: () => document.getElementById('mockup-container')!.innerHTML
  };
}

const output = (stationery?: Json) => ({
  draftId: 'draft_0001',
  layoutType: 'text_only',
  lettersRequired: 1,
  ...canSend,
  ...(stationery ? { stationery } : {})
});

const restyled = (stationery: Json, previewHtml?: string) => ({
  result: {
    content: [{ type: 'text', text: 'The letter is now on the stationery.' }],
    structuredContent: { draftId: 'draft_0001', stationery, message: 'The letter is now on the stationery.' },
    ...(previewHtml ? { _meta: { previewHtml } } : {})
  }
});

describe('the Style row (#563)', () => {
  it('shares the explicit card draft selection only with the flag and a supported host', async () => {
    const card = mount();
    await card.show(output(), { previewHtml: CLASSIC_PAGE, modelContextEnabled: true }, { updateModelContext: { text: {} } });
    const selected = () => Array.from(card.document.querySelectorAll('button')).find(button => button.textContent === 'Select this draft in the conversation')!;
    expect(selected().hidden).toBe(false);
    expect(card.lastRequest('ui/update-model-context')).toBeUndefined();
    selected().click(); await flush();
    const request = card.lastRequest('ui/update-model-context')!;
    expect(JSON.parse(request.params.content[0].text)).toMatchObject({ draftId: 'draft_0001' });
    expect(request.params.content[0].text).not.toContain('Main St');
    await card.deliver({ id: request.id, result: {} });
    expect(card.document.body.textContent).toContain('Draft selection shared');
    await card.deliver({ method: 'ui/notifications/tool-result', params: { structuredContent: output(), _meta: { previewHtml: CLASSIC_PAGE } } });
    expect(selected().hidden).toBe(true);
  });
  it('offers the six styles while the preview names its stationery, the one it is in pressed', async () => {
    const card = mount();
    await card.show(output({ theme: 'classic', source: 'default' }));

    expect(card.visible('style-row')).toBe(true);
    expect(Array.from(card.document.querySelectorAll('#style-row [data-theme]')).map(element => element.textContent)).toEqual([
      'Classic', 'Monogram', 'Botanical', 'Celebration', 'Typewriter', 'Handwritten'
    ]);
    expect(Array.from(card.document.querySelectorAll('#style-row [data-theme]')).map(element => element.getAttribute('data-theme'))).toEqual([
      'classic', 'monogram', 'botanical', 'celebration', 'typewriter', 'handwritten'
    ]);
    expect(card.pressed()).toEqual(['classic']);
    expect(card.visible('style-note')).toBe(false);
  });

  it('restyles to a theme with its own typeface, and presses it (#563 PR 8b)', async () => {
    const card = mount();
    await card.show(output({ theme: 'handwritten', dateLine: 'October 1, 2026', source: 'asked' }));
    expect(card.pressed()).toEqual(['handwritten']);

    await card.choose('typewriter');
    expect(card.lastRequest('tools/call', 'set_stationery')!.params.arguments).toEqual({ draftId: 'draft_0001', stationery: 'typewriter' });
    await card.answer({
      result: {
        content: [],
        structuredContent: { draftId: 'draft_0001', stationery: { theme: 'typewriter', dateLine: 'October 1, 2026', source: 'asked' } },
        _meta: { previewHtml: BOTANICAL_PAGE }
      }
    });
    expect(card.pressed()).toEqual(['typewriter']);
  });

  it('is hidden while the preview names no stationery, as while stationery is not offered', async () => {
    const card = mount();
    await card.show(output());
    expect(card.visible('style-row')).toBe(false);
  });

  it('changes the style with set_stationery, holding Send meanwhile, and draws the page it answers with', async () => {
    const card = mount();
    await card.show(output({ theme: 'classic', source: 'default' }));
    expect(card.drawn()).toContain('<title>Dear Sam,\nPat</title>');

    await card.choose('botanical');
    expect(card.lastRequest('tools/call', 'set_stationery')!.params).toEqual({
      name: 'set_stationery',
      arguments: { draftId: 'draft_0001', stationery: 'botanical' }
    });
    // While the server answers: the choice shows, and nothing can be sent or chosen.
    expect(card.pressed()).toEqual(['botanical']);
    expect((card.document.getElementById('send-button') as HTMLButtonElement).disabled).toBe(true);
    // Waiting, every button says so, and none is disabled, so the pressed one keeps focus (#572 review round 1).
    expect(card.button('monogram').getAttribute('aria-disabled')).toBe('true');
    expect(card.button('botanical').getAttribute('aria-disabled')).toBe('true');
    expect(card.button('botanical').disabled).toBe(false);

    await card.answer(restyled({ theme: 'botanical', dateLine: 'October 1, 2026', source: 'asked' }, BOTANICAL_PAGE));

    expect(card.pressed()).toEqual(['botanical']);
    expect(card.drawn()).toContain('<title>October 1, 2026\nDear Sam,\nPat</title>');
    expect(card.drawn()).toContain('stroke="#222222"');
    expect((card.document.getElementById('send-button') as HTMLButtonElement).disabled).toBe(false);
    expect(card.visible('style-note')).toBe(false);
  });

  it('does nothing for the style the letter is in', async () => {
    const card = mount();
    await card.show(output({ theme: 'classic', source: 'default' }));
    await card.choose('classic');
    expect(card.lastRequest('tools/call', 'set_stationery')).toBeUndefined();
  });

  it('brings the headline and initials this card saw back with their style', async () => {
    const card = mount();
    await card.show(output({ theme: 'celebration', dateLine: 'October 1, 2026', headline: 'Happy Birthday!', source: 'asked' }));

    await card.choose('monogram');
    expect(card.lastRequest('tools/call', 'set_stationery')!.params.arguments).toEqual({ draftId: 'draft_0001', stationery: 'monogram' });
    await card.answer(restyled({ theme: 'monogram', dateLine: 'October 1, 2026', monogram: 'JMS', source: 'asked' }, BOTANICAL_PAGE));

    await card.choose('celebration');
    expect(card.lastRequest('tools/call', 'set_stationery')!.params.arguments).toEqual({
      draftId: 'draft_0001',
      stationery: 'celebration',
      headline: 'Happy Birthday!'
    });
    await card.answer(restyled({ theme: 'celebration', dateLine: 'October 1, 2026', headline: 'Happy Birthday!', source: 'asked' }, BOTANICAL_PAGE));

    await card.choose('monogram');
    expect(card.lastRequest('tools/call', 'set_stationery')!.params.arguments).toEqual({
      draftId: 'draft_0001',
      stationery: 'monogram',
      monogram: 'JMS'
    });
  });

  it('shows a refusal under the row and keeps the style and page as they were', async () => {
    const card = mount();
    await card.show(output({ theme: 'classic', source: 'default' }));

    await card.choose('celebration');
    await card.answer({
      result: { isError: true, content: [{ type: 'text', text: "This letter has already been sent, so its stationery can't change." }] }
    });

    expect(card.visible('style-note')).toBe(true);
    expect(card.text('style-note')).toContain("its stationery can't change");
    expect(card.document.getElementById('style-note')!.classList.contains('alert')).toBe(true);
    expect(card.pressed()).toEqual(['classic']);
    expect(card.drawn()).toContain('<title>Dear Sam,\nPat</title>');
  });

  it('says so, and keeps the last page, when the answer brings no page', async () => {
    const card = mount();
    await card.show(output({ theme: 'classic', source: 'default' }));

    await card.choose('botanical');
    await card.answer(restyled({ theme: 'botanical', dateLine: 'October 1, 2026', source: 'asked' }));

    expect(card.pressed()).toEqual(['botanical']);
    expect(card.text('style-note')).toBe('The style is changed, but its page did not come back here. Make the preview again to see it.');
    expect(card.drawn()).toContain('<title>Dear Sam,\nPat</title>');
  });

  it('goes once the letter is sent, and sets no style after', async () => {
    const card = mount();
    await card.show(output({ theme: 'classic', source: 'default' }));

    await card.click('send-button');
    await card.answer({ result: { content: [], structuredContent: { orderId: 'ord_0001' } } }, 'send_letter');

    expect(card.visible('style-row')).toBe(false);
    // A press that still reaches the hidden row (a host delivering it) does nothing.
    await card.choose('botanical');
    expect(card.lastRequest('tools/call', 'set_stationery')).toBeUndefined();
  });

  it('comes back after a send refused as a duplicate, even when the host redrew the card during it (#572 review round 3)', async () => {
    const said = 'Possible duplicate: you sent the same letter to Sam Rivera 5 minutes ago.';
    // The tool's refusal, and the same refusal as a host's error.
    for (const reply of [{ result: { isError: true, content: [{ type: 'text', text: said }] } }, { error: { code: -32000, message: said } }]) {
      const card = mount();
      await card.show(output({ theme: 'classic', source: 'default' }));

      await card.click('send-button');
      await card.show(output({ theme: 'classic', source: 'default' }));
      expect(card.visible('style-row')).toBe(false);
      await card.answer(reply, 'send_letter');
      expect(card.visible('style-row'), JSON.stringify(reply)).toBe(true);
      expect(card.text('error-message')).toContain('Send another copy only if you want two.');
    }
  });

  it('is not on the postcard card: a postcard takes no stationery', () => {
    const postcard = fs.readFileSync(path.join(WIDGET_DIR, 'PostcardPreviewCard.html'), 'utf-8');
    expect(postcard).not.toContain('style-row');
    expect(postcard).not.toContain('letter-irl:style');
  });
});

describe('the Style row while the card sends (#563)', () => {
  it('sets no style while the letter is being sent', async () => {
    const card = mount();
    await card.show(output({ theme: 'classic', source: 'default' }));

    await card.click('send-button');
    // The send is under way: the server has not answered.
    await card.choose('botanical');
    expect(card.lastRequest('tools/call', 'set_stationery')).toBeUndefined();
  });
});

describe('the Style row and the sends (#563)', () => {
  it('sends nothing while a style is being set', async () => {
    const card = mount();
    await card.show(output({ theme: 'classic', source: 'default' }));

    await card.choose('botanical');
    // Pressed anyway, as a host could deliver it: the card holds the send.
    await card.click('send-button');
    expect(card.lastRequest('tools/call', 'send_letter')).toBeUndefined();
  });

  it('goes when a checkout starts, and sets no style while it is under way', async () => {
    const card = mount();
    await card.show({
      draftId: 'draft_0001',
      layoutType: 'text_only',
      lettersRequired: 1,
      canSendNow: false,
      sendEligibility: {
        payAndSend: { available: true, amountCents: 499, currency: 'usd', displayAmount: '$4.99' },
        letterPack: { available: true, purchaseUrl: 'https://example.test/packs' }
      },
      stationery: { theme: 'classic', source: 'default' }
    });
    expect(card.visible('style-row')).toBe(true);

    await card.click('pay-send-button');
    expect(card.lastRequest('tools/call', 'create_mail_checkout')).toBeDefined();
    expect(card.visible('style-row')).toBe(false);
    await card.choose('botanical');
    expect(card.lastRequest('tools/call', 'set_stationery')).toBeUndefined();
  });

  it('waits through a send, and is usable again after one that fails (#572 review round 1)', async () => {
    const card = mount();
    await card.show(output({ theme: 'classic', source: 'default' }));

    await card.click('send-button');
    expect(card.button('botanical').getAttribute('aria-disabled')).toBe('true');
    await card.answer({ result: { isError: true, content: [{ type: 'text', text: 'The printer is busy.' }] } }, 'send_letter');

    expect(card.button('botanical').getAttribute('aria-disabled')).toBe('false');
    await card.choose('botanical');
    expect(card.lastRequest('tools/call', 'set_stationery')).toBeDefined();
  });

  it('comes back after a send that fails, even when the host redrew the card during it (#572 review round 2)', async () => {
    const card = mount();
    await card.show(output({ theme: 'classic', source: 'default' }));

    await card.click('send-button');
    // The host redraws while the send is out: the card hides its rows meanwhile.
    await card.show(output({ theme: 'classic', source: 'default' }));
    expect(card.visible('style-row')).toBe(false);

    await card.answer({ result: { isError: true, content: [{ type: 'text', text: 'The printer is busy.' }] } }, 'send_letter');
    expect(card.visible('style-row')).toBe(true);
    expect(card.text('send-button-text')).toBe('Retry Send');
  });

  it('comes back when a checkout is refused before it opens (#572 review round 1)', async () => {
    const card = mount();
    await card.show({
      draftId: 'draft_0001',
      layoutType: 'text_only',
      lettersRequired: 1,
      canSendNow: false,
      sendEligibility: {
        payAndSend: { available: true, amountCents: 499, currency: 'usd', displayAmount: '$4.99' },
        letterPack: { available: true, purchaseUrl: 'https://example.test/packs' }
      },
      stationery: { theme: 'classic', source: 'default' }
    });
    await card.click('pay-send-button');
    await card.answer({ result: { isError: true, content: [{ type: 'text', text: 'Checkout is not available.' }] } }, 'create_mail_checkout');
    expect(card.visible('style-row')).toBe(true);
  });
});

describe('the Style row against its answers (#572 review round 1)', () => {
  it('says the style may have changed for an answer without what it set, or for another letter', async () => {
    for (const result of [
      { content: [{ type: 'text', text: 'Done.' }] },
      { content: [], structuredContent: { draftId: 'draft_9999', stationery: { theme: 'botanical', source: 'asked' } }, _meta: { previewHtml: BOTANICAL_PAGE } }
    ]) {
      const card = mount();
      await card.show(output({ theme: 'classic', source: 'default' }));
      await card.choose('botanical');
      await card.answer({ result });
      expect(card.text('style-note')).toBe('The style may have changed. Make the preview again to see it.');
      expect(card.pressed()).toEqual(['classic']);
      expect(card.drawn()).toContain('<title>Dear Sam,\nPat</title>');
    }
  });

  it('keeps waiting through a host redraw, and draws the answer after it', async () => {
    const card = mount();
    await card.show(output({ theme: 'classic', source: 'default' }));
    await card.choose('botanical');

    // The host delivers the same result again while the call is out.
    await card.show(output({ theme: 'classic', source: 'default' }));
    expect(card.pressed()).toEqual(['botanical']);
    expect((card.document.getElementById('send-button') as HTMLButtonElement).disabled).toBe(true);

    await card.answer(restyled({ theme: 'botanical', dateLine: 'October 1, 2026', source: 'asked' }, BOTANICAL_PAGE));
    expect(card.drawn()).toContain('<title>October 1, 2026\nDear Sam,\nPat</title>');
  });

  it("holds Send until both a date and a style have been set", async () => {
    const card = mount();
    await card.show({ ...output({ theme: 'classic', source: 'default' }), arrivalWindow: { earliestArrival: '2026-10-14', latestArrival: '2026-11-30' } });
    const send = card.document.getElementById('send-button') as HTMLButtonElement;

    await card.choose('botanical');
    const date = card.document.getElementById('arrives-date') as HTMLInputElement;
    date.value = '2026-10-20';
    date.dispatchEvent(new (card.document.defaultView as any).Event('change'));
    await flush();
    expect(send.disabled).toBe(true);

    await card.answer(restyled({ theme: 'botanical', dateLine: 'October 1, 2026', source: 'asked' }, BOTANICAL_PAGE));
    // The date is still being set.
    expect(send.disabled).toBe(true);
    await card.answer(
      { result: { content: [], structuredContent: { draftId: 'draft_0001', schedule: { arriveBy: '2026-10-20', mailOn: '2026-10-09', releasesAt: '2026-10-09T13:00:00Z', earliestArrival: '2026-10-14', latestArrival: '2026-11-30' }, deliveryEstimate: 'Goes to the printer Fri, Oct 9.', message: 'Set.' } } },
      'set_arrival_date'
    );
    expect(send.disabled).toBe(false);
  });
});

describe('a restyle that changes the pages, and so the price (#586)', () => {
  const PAY_AND_SEND = { packPays: false, payAndSend: { available: true, amountCents: 599, currency: 'usd' }, letterPack: { available: false } };

  it('takes the restyle\'s price and pages: a face that runs the letter on to a second page', async () => {
    const card = mount();
    await card.show(output({ theme: 'classic', source: 'default' }));
    expect(card.text('cost')).toBe('1 Letter');
    expect(card.text('layout-type')).toBe('Text Only');
    expect(card.text('status-pill')).toBe('Ready to send');

    await card.choose('typewriter');
    await card.answer({
      result: {
        content: [],
        structuredContent: {
          draftId: 'draft_0001',
          stationery: { theme: 'typewriter', dateLine: 'October 1, 2026', source: 'asked' },
          pages: 2,
          canSendNow: false,
          reasonCannotSend: 'Letter packs and gift letters pay for one-page letters and 6x9 postcards; this one is paid with Pay & Send.',
          sendEligibility: PAY_AND_SEND,
          message: 'The letter is now on the typewriter stationery.'
        },
        _meta: { previewHtml: BOTANICAL_PAGE, pageFit: { pages: 2, sheets: 1, doubleSided: true } }
      }
    });

    expect(card.text('cost')).toBe('Pay & Send USD 5.99');
    expect(card.text('layout-type')).toBe('Text Only · 2 pages, both sides');
    expect(card.text('status-pill')).toBe('Letter packs and gift letters pay for one-page letters and 6x9 postcards; this one is paid with Pay & Send.');
  });

  it('takes it back to one page, which the balance pays for', async () => {
    const card = mount();
    await card.show({ ...output({ theme: 'typewriter', dateLine: 'October 1, 2026', source: 'asked' }), pages: 2, canSendNow: false, sendEligibility: PAY_AND_SEND });
    expect(card.text('cost')).toBe('Pay & Send USD 5.99');

    await card.choose('classic');
    await card.answer({
      result: {
        content: [],
        structuredContent: { draftId: 'draft_0001', stationery: { theme: 'classic', source: 'asked' }, ...canSend, message: 'The letter is now on a plain page.' },
        _meta: { previewHtml: CLASSIC_PAGE }
      }
    });

    expect(card.text('cost')).toBe('1 Letter');
    expect(card.text('layout-type')).toBe('Text Only');
  });

  it('keeps the preview\'s price when a restyle says nothing of it, as an older server would not', async () => {
    const card = mount();
    await card.show(output({ theme: 'classic', source: 'default' }));
    await card.choose('botanical');
    await card.answer(restyled({ theme: 'botanical', dateLine: 'October 1, 2026', source: 'asked' }, BOTANICAL_PAGE));
    expect(card.text('cost')).toBe('1 Letter');
    expect(card.text('status-pill')).toBe('Ready to send');
  });

  it('draws a new draft from its own price, shown once or again', async () => {
    const card = mount();
    await card.show(output({ theme: 'classic', source: 'default' }));
    await card.choose('typewriter');
    await card.answer({
      result: {
        content: [],
        structuredContent: {
          draftId: 'draft_0001',
          stationery: { theme: 'typewriter', dateLine: 'October 1, 2026', source: 'asked' },
          pages: 2,
          canSendNow: false,
          reasonCannotSend: 'Letter packs and gift letters pay for one-page letters and 6x9 postcards; this one is paid with Pay & Send.',
          sendEligibility: PAY_AND_SEND,
          message: 'The letter is now on the typewriter stationery.'
        },
        _meta: { previewHtml: BOTANICAL_PAGE }
      }
    });
    expect(card.text('cost')).toBe('Pay & Send USD 5.99');

    // A new preview in the same card, as the host may deliver it twice.
    const next = { ...output({ theme: 'classic', source: 'default' }), draftId: 'draft_0002' };
    for (const time of ['once', 'again']) {
      await card.show(next);
      expect(card.text('cost'), time).toBe('1 Letter');
      expect(card.text('layout-type'), time).toBe('Text Only');
      expect(card.text('status-pill'), time).toBe('Ready to send');
    }
  });

  it('takes a reopened card\'s price and pages from get_draft_status', async () => {
    const card = mount();
    await card.show(output({ theme: 'classic', source: 'default' }));
    await card.answer(
      {
        result: {
          content: [],
          structuredContent: {
            draftId: 'draft_0001',
            status: 'ready',
            deliveryEstimate: 'Mailed in 1-2 business days',
            stationery: { theme: 'typewriter', dateLine: 'October 1, 2026' },
            pages: 2,
            canSendNow: false,
            sendEligibility: PAY_AND_SEND
          },
          _meta: { previewHtml: BOTANICAL_PAGE }
        }
      },
      'get_draft_status'
    );
    expect(card.text('cost')).toBe('Pay & Send USD 5.99');
    expect(card.text('layout-type')).toBe('Text Only · 2 pages, both sides');

    // A restyle that then says nothing of it keeps that last word (#592 review round 1).
    await card.choose('botanical');
    await card.answer(restyled({ theme: 'botanical', dateLine: 'October 1, 2026', source: 'asked' }, BOTANICAL_PAGE));
    expect(card.text('cost')).toBe('Pay & Send USD 5.99');
  });
});

describe('a card shown its preview again (#572 review round 1)', () => {
  it("takes the draft's style and page now from get_draft_status", async () => {
    const card = mount();
    await card.show(output({ theme: 'classic', source: 'default' }));
    expect(card.lastRequest('tools/call', 'get_draft_status')).toBeDefined();

    await card.answer(
      {
        result: {
          content: [],
          structuredContent: {
            draftId: 'draft_0001',
            status: 'ready',
            deliveryEstimate: 'Mailed in 1-2 business days',
            stationery: { theme: 'botanical', dateLine: 'October 1, 2026' }
          },
          _meta: { previewHtml: BOTANICAL_PAGE }
        }
      },
      'get_draft_status'
    );

    expect(card.pressed()).toEqual(['botanical']);
    expect(card.drawn()).toContain('<title>October 1, 2026\nDear Sam,\nPat</title>');
  });

  it('keeps the preview as given when the answer names no style', async () => {
    const card = mount();
    await card.show(output({ theme: 'classic', source: 'default' }));
    await card.answer(
      { result: { content: [], structuredContent: { draftId: 'draft_0001', status: 'ready', deliveryEstimate: 'Mailed in 1-2 business days' } } },
      'get_draft_status'
    );
    expect(card.pressed()).toEqual(['classic']);
    expect(card.drawn()).toContain('<title>Dear Sam,\nPat</title>');
  });
});

describe('the Signature switch (#608 part 4b)', () => {
  const SIGNED_PAGE = page('Dear Sam,\nPat', '<image data-role="signature" href="data:image/png;base64,AA==" x="72" y="300" width="180" height="45"/>');
  const signed = (printed: boolean, source = 'remembered') => ({ ...output({ theme: 'classic', source: 'default' }), signature: { printed, source } });
  const switched = (printed: boolean, previewHtml?: string, extra: Json = {}) => ({
    result: {
      content: [{ type: 'text', text: 'The letter now prints no signature.' }],
      structuredContent: { draftId: 'draft_0001', signature: { printed, source: 'asked' }, ...canSend, message: 'Changed.', ...extra },
      ...(previewHtml ? { _meta: { previewHtml } } : {})
    }
  });
  // The card's cleaner drops the mark and keeps the picture: what it draws is the image.
  const SIGNATURE_IMAGE = 'data:image/png;base64,AA==';
  const PAY_AND_SEND = { packPays: false, payAndSend: { available: true, amountCents: 599, currency: 'usd' }, letterPack: { available: false } };
  const toggle = (card: ReturnType<typeof mount>) => card.document.getElementById('signature-switch') as HTMLButtonElement;
  const flip = async (card: ReturnType<typeof mount>) => card.click('signature-switch');

  it('is offered beside the styles while a signature is saved, on or off as the letter prints it', async () => {
    const card = mount();
    await card.show(signed(true));
    expect(card.visible('signature-row')).toBe(true);
    expect(toggle(card).getAttribute('role')).toBe('switch');
    expect(toggle(card).getAttribute('aria-checked')).toBe('true');
    expect(toggle(card).textContent).toBe('On');
    // Outside the style buttons: never taken for a theme.
    expect(card.pressed()).toEqual(['classic']);
    expect(card.document.querySelector('#style-row #signature-switch')).toBeNull();

    const off = mount();
    await off.show(signed(false));
    expect(toggle(off).getAttribute('aria-checked')).toBe('false');
    expect(toggle(off).textContent).toBe('Off');
  });

  it('is hidden with none saved, while signatures are not offered, or while the styles are', async () => {
    for (const shown of [signed(false, 'none_saved'), output({ theme: 'classic', source: 'default' }), { ...output(), signature: { printed: true, source: 'remembered' } }]) {
      const card = mount();
      await card.show(shown);
      expect(card.visible('signature-row')).toBe(false);
    }
  });

  it('signs or unsigns with set_letter_signature, holding Send meanwhile, and draws the page it answers with', async () => {
    const card = mount();
    await card.show(signed(false));

    await flip(card);
    expect(card.lastRequest('tools/call', 'set_letter_signature')!.params).toEqual({
      name: 'set_letter_signature',
      arguments: { draftId: 'draft_0001', signature: true }
    });
    // While the server answers: the choice shows, and nothing can be sent, switched or styled.
    expect(toggle(card).getAttribute('aria-checked')).toBe('true');
    expect(toggle(card).getAttribute('aria-disabled')).toBe('true');
    expect((card.document.getElementById('send-button') as HTMLButtonElement).disabled).toBe(true);
    await card.choose('botanical');
    expect(card.lastRequest('tools/call', 'set_stationery')).toBeUndefined();

    await card.answer(switched(true, SIGNED_PAGE), 'set_letter_signature');
    expect(toggle(card).getAttribute('aria-checked')).toBe('true');
    expect(toggle(card).getAttribute('aria-disabled')).toBe('false');
    expect(card.drawn()).toContain(SIGNATURE_IMAGE);
    expect((card.document.getElementById('send-button') as HTMLButtonElement).disabled).toBe(false);

    // And off again.
    await flip(card);
    expect(card.lastRequest('tools/call', 'set_letter_signature')!.params.arguments).toEqual({ draftId: 'draft_0001', signature: false });
    await card.answer(switched(false, CLASSIC_PAGE), 'set_letter_signature');
    expect(toggle(card).getAttribute('aria-checked')).toBe('false');
    expect(card.drawn()).not.toContain(SIGNATURE_IMAGE);
  });

  it('takes the price the answer gives when the signature runs the letter on to a page', async () => {
    const card = mount();
    await card.show(signed(false));
    await flip(card);
    await card.answer(switched(true, SIGNED_PAGE, { pages: 2, canSendNow: false, sendEligibility: PAY_AND_SEND }), 'set_letter_signature');
    expect(card.text('cost')).toBe('Pay & Send USD 5.99');
    expect(card.text('layout-type')).toBe('Text Only · 2 pages, both sides');
  });

  it('shows a refusal under the row and keeps the switch and page as they were', async () => {
    const card = mount();
    await card.show(signed(false));
    await flip(card);
    await card.answer(
      { result: { isError: true, content: [{ type: 'text', text: 'The signature takes 3 lines, and this letter has no room for them on one page.' }] } },
      'set_letter_signature'
    );
    expect(card.visible('style-note')).toBe(true);
    expect(card.text('style-note')).toContain('no room for them');
    expect(card.document.getElementById('style-note')!.classList.contains('alert')).toBe(true);
    expect(toggle(card).getAttribute('aria-checked')).toBe('false');
    expect(card.drawn()).toContain('<title>Dear Sam,\nPat</title>');
  });

  it('waits for a style being set, and a style waits for it', async () => {
    const card = mount();
    await card.show(signed(false));
    await card.choose('botanical');
    await flip(card);
    expect(card.lastRequest('tools/call', 'set_letter_signature')).toBeUndefined();
    await card.answer(restyled({ theme: 'botanical', dateLine: 'October 1, 2026', source: 'asked' }, BOTANICAL_PAGE));
    await flip(card);
    expect(card.lastRequest('tools/call', 'set_letter_signature')).toBeDefined();
  });

  it('goes once the letter is sent, and signs nothing after', async () => {
    const card = mount();
    await card.show(signed(false));
    expect(card.visible('signature-row')).toBe(true);
    await card.click('send-button');
    await card.answer({ result: { content: [], structuredContent: { orderId: 'ord_0001' } } }, 'send_letter');
    expect(card.visible('signature-row')).toBe(false);
    // A press that still reaches the hidden switch (a host delivering it) does nothing.
    await flip(card);
    expect(card.lastRequest('tools/call', 'set_letter_signature')).toBeUndefined();
  });

  it('takes whether a reopened card is signed now from get_draft_status', async () => {
    const card = mount();
    await card.show(signed(false));
    await card.answer(
      {
        result: {
          content: [],
          structuredContent: {
            draftId: 'draft_0001',
            status: 'ready',
            deliveryEstimate: 'Mailed in 1-2 business days',
            stationery: { theme: 'classic' },
            signature: true
          },
          _meta: { previewHtml: SIGNED_PAGE }
        }
      },
      'get_draft_status'
    );
    expect(toggle(card).getAttribute('aria-checked')).toBe('true');
    expect(card.drawn()).toContain(SIGNATURE_IMAGE);
  });
});

describe('the Signature switch against its answers (#615 review round 1)', () => {
  const SIGNED_PAGE = page('Dear Sam,\nPat', '<image data-role="signature" href="data:image/png;base64,AA==" x="72" y="300" width="180" height="45"/>');
  const SIGNATURE_IMAGE = 'data:image/png;base64,AA==';
  const signed = (printed: boolean, source = 'remembered', draftId = 'draft_0001') => ({
    ...output({ theme: 'classic', source: 'default' }),
    draftId,
    signature: { printed, source }
  });
  const toggle = (card: ReturnType<typeof mount>) => card.document.getElementById('signature-switch') as HTMLButtonElement;
  const send = (card: ReturnType<typeof mount>) => card.document.getElementById('send-button') as HTMLButtonElement;
  const status = (structured: Json, previewHtml = SIGNED_PAGE) => ({
    result: {
      content: [],
      structuredContent: { draftId: 'draft_0001', status: 'ready', deliveryEstimate: 'Mailed in 1-2 business days', stationery: { theme: 'classic' }, ...structured },
      _meta: { previewHtml }
    }
  });

  it('is offered for a preview asked to leave it off, which says a signature is saved', async () => {
    const card = mount();
    await card.show(signed(false, 'asked'));
    expect(card.visible('signature-row')).toBe(true);
    expect(toggle(card).getAttribute('aria-checked')).toBe('false');
  });

  it.each([
    ['refused', { result: { isError: true, content: [{ type: 'text', text: 'The signature takes 3 lines, and this letter has no room for them on one page.' }] } }],
    ['rejected by the host', { error: { code: -32000, message: 'The signature takes 3 lines, and this letter has no room for them on one page.' } }]
  ])('says a call %s, and lets the person go on: the switch, Send and the page as they were', async (_label, reply) => {
    const card = mount();
    await card.show(signed(false));
    await card.click('signature-switch');
    await card.answer(reply as Json, 'set_letter_signature');
    expect(card.text('style-note')).toContain('no room for them');
    expect(toggle(card).getAttribute('aria-checked')).toBe('false');
    expect(toggle(card).getAttribute('aria-disabled')).toBe('false');
    expect(send(card).disabled).toBe(false);
    expect(card.drawn()).not.toContain(SIGNATURE_IMAGE);
  });

  it("says a signature removed since the preview in the person's words, and puts the switch away", async () => {
    const card = mount();
    await card.show(signed(false));
    toggle(card).focus();
    await card.click('signature-switch');
    await card.answer(
      {
        result: {
          isError: true,
          content: [{ type: 'text', text: 'No signature is saved. Ask the person for a photo of their signature and save it with set_signature, then try again.' }]
        }
      },
      'set_letter_signature'
    );
    expect(card.text('style-note')).toBe("There's no saved signature to add now. Save one in the chat, or on your Letter IRL settings page.");
    expect(card.visible('signature-row')).toBe(false);
    expect(send(card).disabled).toBe(false);
    // Focus leaves with the switch, to the first style (#615 review round 2).
    expect(card.document.activeElement).toBe(card.button('classic'));
  });

  it('says the signature may have changed for an answer without what it set, or for another letter', async () => {
    for (const result of [
      { content: [{ type: 'text', text: 'Done.' }] },
      { content: [], structuredContent: { draftId: 'draft_9999', signature: { printed: true, source: 'asked' } }, _meta: { previewHtml: SIGNED_PAGE } }
    ]) {
      const card = mount();
      await card.show(signed(false));
      await card.click('signature-switch');
      await card.answer({ result }, 'set_letter_signature');
      expect(card.text('style-note')).toBe('The signature may have changed. Make the preview again to see it.');
      expect(toggle(card).getAttribute('aria-checked')).toBe('false');
      expect(card.drawn()).not.toContain(SIGNATURE_IMAGE);
    }
  });

  it('takes the new state from an answer without its page, and says the page did not come back', async () => {
    const card = mount();
    await card.show(signed(false));
    await card.click('signature-switch');
    await card.answer(
      { result: { content: [], structuredContent: { draftId: 'draft_0001', signature: { printed: true, source: 'asked' }, ...canSend } } },
      'set_letter_signature'
    );
    expect(toggle(card).getAttribute('aria-checked')).toBe('true');
    expect(card.text('style-note')).toBe('The signature is changed, but its page did not come back here. Make the preview again to see it.');
  });

  it('does not let a status answer arriving during a switch undo it', async () => {
    const card = mount();
    await card.show(signed(false));
    await card.click('signature-switch');
    // The card is waiting on the switch.
    await card.answer(status({ signature: false }, CLASSIC_PAGE), 'get_draft_status');
    expect(toggle(card).getAttribute('aria-checked')).toBe('true');
    await card.answer({ result: { content: [], structuredContent: { draftId: 'draft_0001', signature: { printed: true, source: 'asked' }, ...canSend }, _meta: { previewHtml: SIGNED_PAGE } } }, 'set_letter_signature');
    expect(toggle(card).getAttribute('aria-checked')).toBe('true');
    expect(card.drawn()).toContain(SIGNATURE_IMAGE);
  });

  it('does not let a status answer arriving after a switch undo it', async () => {
    const card = mount();
    await card.show(signed(false));
    await card.click('signature-switch');
    await card.answer({ result: { content: [], structuredContent: { draftId: 'draft_0001', signature: { printed: true, source: 'asked' }, ...canSend }, _meta: { previewHtml: SIGNED_PAGE } } }, 'set_letter_signature');
    expect(toggle(card).getAttribute('aria-checked')).toBe('true');
    // The card's one status request is answered only now: the card changed the draft
    // itself since asking, so the answer is older than that.
    await card.answer(status({ signature: false }, CLASSIC_PAGE), 'get_draft_status');
    expect(toggle(card).getAttribute('aria-checked')).toBe('true');
    expect(card.drawn()).toContain(SIGNATURE_IMAGE);
  });

  it("draws a new draft from its own preview, and an answer about the old one changes nothing", async () => {
    const card = mount();
    await card.show(signed(false));
    await card.click('signature-switch');
    // Another preview arrives while the call is out.
    await card.show(signed(false, 'remembered', 'draft_0002'), { previewHtml: CLASSIC_PAGE });
    expect(toggle(card).getAttribute('aria-checked')).toBe('false');
    await card.answer({ result: { content: [], structuredContent: { draftId: 'draft_0001', signature: { printed: true, source: 'asked' }, ...canSend }, _meta: { previewHtml: SIGNED_PAGE } } }, 'set_letter_signature');
    expect(toggle(card).getAttribute('aria-checked')).toBe('false');
    expect(card.drawn()).not.toContain(SIGNATURE_IMAGE);
  });

  it('goes when the send is offered as a link, and a press still delivered to it does nothing', async () => {
    const card = mount();
    await card.show(signed(false));
    await card.click('send-button');
    await card.answer(
      {
        result: {
          isError: true,
          content: [
            {
              type: 'text',
              text:
                'Not sent: Letter IRL sends mail only when the person sends it. ' +
                'Ask the person to open https://letterirl.com/confirm/draft_0001 to check the mail and send it themselves. Nothing is sent until they press Send there.'
            }
          ]
        }
      },
      'send_letter'
    );
    expect(card.visible('send-page-button')).toBe(true);
    expect(card.visible('signature-row')).toBe(false);
    // The page has the draft now: the card no longer changes it.
    await card.click('signature-switch');
    expect(card.lastRequest('tools/call', 'set_letter_signature')).toBeUndefined();
  });
});
