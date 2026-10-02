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
    sent,
    lastRequest,
    button,
    pressed: () =>
      Array.from(document.querySelectorAll('#style-row [data-theme]'))
        .filter(element => element.getAttribute('aria-pressed') === 'true')
        .map(element => element.getAttribute('data-theme')),
    async show(output: Json, meta: Json = { previewHtml: CLASSIC_PAGE }) {
      await flush();
      await deliver({
        id: lastRequest('ui/initialize')!.id,
        result: { protocolVersion: '2026-01-26', hostInfo: { name: 'fake' }, hostCapabilities: {}, hostContext: {} }
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
