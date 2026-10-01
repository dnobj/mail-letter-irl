/**
 * The letter and postcard preview cards in an MCP Apps host (#474, phase 2a).
 *
 * The cards talk to their host only through the shared bridge
 * (widgets/shared/host.js). In ChatGPT that is window.openai, which the other
 * widget suites drive. Here the card is framed by a fake MCP Apps host, as in
 * Claude: it gets the tool's input and result as notifications, and every
 * call it makes is a JSON-RPC request the host answers. So this checks what
 * the card asks of such a host, message by message, and what it shows.
 */

import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';
import { inlineHostBridge } from '../../../src/mcp/widgetHost.js';
import { stampPreviewTool } from '../../../src/mcp/registerTools.js';

const WIDGET_DIR = path.resolve(__dirname, '../../../widgets');
const PACKS_URL = 'https://letterirl.com/packs';

type Json = Record<string, any>;

interface Spec {
  file: 'LetterPreviewCard' | 'PostcardPreviewCard';
  tool: string;
  sendTool: string;
  waitMs: number;
  args: Json;
  output: (draftId: string, eligibility: Json) => Json;
  meta: Json;
  pane: string;
  drawnFromMeta: string;
}

const recipient = { name: 'Sam Rivera', addressLine1: '1 Main St', city: 'Springfield', state: 'IL', postalCode: '62701' };

const LETTER: Spec = {
  file: 'LetterPreviewCard',
  tool: 'quote_and_preview_letter',
  sendTool: 'send_letter',
  waitMs: 25000,
  args: { recipient, bodyText: 'Hello Sam, see you soon.', signOff: 'Love, Dee' },
  output: (draftId, eligibility) => ({ draftId, layoutType: 'text_only', lettersRequired: 1, ...eligibility }),
  meta: { previewHtml: '<div class="letter-body">Drawn from the preview HTML</div><div class="sign-off">Signed</div>' },
  pane: 'mockup-container',
  drawnFromMeta: 'Drawn from the preview HTML'
};

const POSTCARD: Spec = {
  file: 'PostcardPreviewCard',
  tool: 'quote_and_preview_postcard',
  sendTool: 'send_postcard',
  waitMs: 45000,
  args: { recipient, message: 'Wish you were here.', imageUrl: 'https://example.com/beach.jpg' },
  output: (draftId, eligibility) => ({ draftId, lettersRequired: 1, message: 'Wish you were here.', ...eligibility }),
  meta: { previewFrontHtml: '<html><body><div class="postcard-front">FRONT FROM META</div></body></html>' },
  pane: 'preview-front',
  drawnFromMeta: 'FRONT FROM META'
};

const canSend = {
  canSendNow: true,
  sendEligibility: {
    payAndSend: { available: false, unavailableReason: "Pay & Send isn't available in this app." },
    letterPack: { available: false, purchaseUrl: PACKS_URL }
  }
};

/** What the server sends where the app takes no purchases (#475). */
const noLetters = { ...canSend, canSendNow: false, reasonCannotSend: 'Not enough letters in your balance.' };

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

/** The card as the server serves it, framed by a fake MCP Apps host. */
function mountInMcpHost(spec: Spec) {
  const page = stampPreviewTool(
    inlineHostBridge(fs.readFileSync(path.join(WIDGET_DIR, `${spec.file}.html`), 'utf-8'), WIDGET_DIR),
    spec.tool
  );
  // jsdom does not run module scripts; see purchaseStatus.test.ts.
  const runnable = page.replace('<script type="module">', '<script>');

  const sent: Json[] = [];
  const parent = { postMessage: (message: Json) => sent.push(JSON.parse(JSON.stringify(message))) };
  const timers: Array<{ fn: () => void; delay: number; cancelled: boolean }> = [];
  const dom = new JSDOM(runnable, {
    runScripts: 'dangerously',
    beforeParse(window) {
      Object.defineProperty(window, 'parent', { value: parent, configurable: true });
      Object.defineProperty(window.document, 'hidden', { get: () => false });
      (window as any).setTimeout = (fn: () => void, delay: number) => {
        timers.push({ fn, delay, cancelled: false });
        return timers.length;
      };
      (window as any).clearTimeout = (id: number) => {
        const timer = timers[id - 1];
        if (timer) timer.cancelled = true;
      };
    }
  });
  const window = dom.window as any;
  const document = window.document as Document;

  const deliver = async (message: Json) => {
    window.dispatchEvent(new window.MessageEvent('message', { data: { jsonrpc: '2.0', ...message }, source: parent }));
    await flush();
  };
  const requests = (method: string) => sent.filter(message => message.method === method && message.id !== undefined);
  const lastRequest = (method: string, name?: string) =>
    [...requests(method)].reverse().find(message => name === undefined || message.params?.name === name);

  return {
    window,
    document,
    sent,
    requests,
    lastRequest,
    initialize: (hostContext: Json = {}) =>
      deliver({
        id: lastRequest('ui/initialize')!.id,
        result: { protocolVersion: '2026-01-26', hostInfo: { name: 'fake' }, hostCapabilities: {}, hostContext }
      }),
    toolInput: (args: Json) => deliver({ method: 'ui/notifications/tool-input', params: { arguments: args } }),
    toolResult: (result: Json) => deliver({ method: 'ui/notifications/tool-result', params: result }),
    /** Answer the card's last request of this kind. */
    answer: (method: string, reply: Json, name?: string) => {
      const request = lastRequest(method, name);
      if (!request) throw new Error(`the card sent no ${method} ${name ?? ''}`);
      return deliver({ id: request.id, ...reply });
    },
    runTimer: async (delay: number) => {
      const pending = timers.filter(timer => !timer.cancelled && timer.delay === delay);
      expect(pending, `exactly one pending ${delay} ms timer`).toHaveLength(1);
      pending[0].cancelled = true;
      pending[0].fn();
      await flush();
    },
    click: async (id: string) => {
      document.getElementById(id)!.dispatchEvent(new window.Event('click'));
      await flush();
    },
    text: (id: string) => document.getElementById(id)?.textContent?.trim() ?? '',
    html: (id: string) => document.getElementById(id)?.innerHTML ?? '',
    visible: (id: string) => {
      const el = document.getElementById(id) as HTMLElement | null;
      return !!el && el.style.display !== 'none';
    }
  };
}

/** A card showing the host's draft, after the handshake. */
async function showing(spec: Spec, eligibility: Json, hostContext: Json = {}) {
  const card = mountInMcpHost(spec);
  await flush();
  await card.initialize(hostContext);
  await card.toolInput(spec.args);
  await card.toolResult({ content: [{ type: 'text', text: 'Preview ready.' }], structuredContent: spec.output('draft_0001', eligibility), _meta: spec.meta });
  return card;
}

describe.each([LETTER, POSTCARD])('$file in an MCP Apps host (#474)', spec => {
  it("draws the preview from the host's tool result, in the host's theme", async () => {
    const card = await showing(spec, canSend, { theme: 'dark' });

    expect(card.html(spec.pane)).toContain(spec.drawnFromMeta);
    expect(card.text('id-value')).toBe('draft_0001');
    expect(card.text('status-pill')).toBe('Ready to send');
    expect(card.visible('send-button')).toBe(true);
    expect(card.document.documentElement.classList.contains('dark')).toBe(true);
    // The handshake, then one question about the draft (#474): nothing is
    // saved to the host, which keeps nothing for the card.
    expect(card.sent.map(message => message.method)).toEqual(['ui/initialize', 'ui/notifications/initialized', 'tools/call']);
    expect(card.lastRequest('tools/call')!.params.name).toBe('get_draft_status');
  });

  it('sends with tools/call and shows the order', async () => {
    const card = await showing(spec, canSend);

    await card.click('send-button');
    expect(card.lastRequest('tools/call', spec.sendTool)!.params).toEqual({
      name: spec.sendTool,
      arguments: { draftId: 'draft_0001', confirm: true }
    });
    await card.answer('tools/call', { result: { content: [], structuredContent: { orderId: 'ord_0001' } } }, spec.sendTool);

    expect(card.text('status-pill')).toBe('With the printer');
    expect(card.text('id-value')).toBe('ord_0001');
  });

  it('shows a refused send as not sent, with the reason', async () => {
    const card = await showing(spec, canSend);

    await card.click('send-button');
    await card.answer(
      'tools/call',
      {
        result: {
          isError: true,
          content: [{ type: 'text', text: 'Not sent: Letter IRL sends mail only when the person sends it.' }]
        }
      },
      spec.sendTool
    );

    expect(card.visible('error-message')).toBe(true);
    expect(card.text('error-message')).toContain('Letter IRL sends mail only when the person sends it.');
    expect(card.text('status-pill')).not.toBe('With the printer');
  });

  it('offers the confirmation page when the server answers Send with it (#470), and opens it with ui/open-link', async () => {
    const card = await showing(spec, canSend);
    const page = 'https://letterirl.com/confirm/draft_0001';

    await card.click('send-button');
    await card.answer(
      'tools/call',
      {
        result: {
          isError: true,
          content: [
            {
              type: 'text',
              text:
                'Not sent: Letter IRL sends mail only when the person sends it. ' +
                `Ask the person to open ${page} to check the mail and send it themselves. Nothing is sent until they press Send there.`
            }
          ]
        }
      },
      spec.sendTool
    );

    expect(card.visible('send-button')).toBe(false);
    expect(card.visible('send-page-button')).toBe(true);
    expect(card.visible('error-message')).toBe(false);
    expect(card.text('status-pill')).toBe('Send it on the confirmation page');

    await card.click('send-page-button');
    expect(card.lastRequest('ui/open-link')!.params).toEqual({ url: page });
    await card.answer('ui/open-link', { result: {} });
    expect(card.visible('error-message')).toBe(false);
  });

  it('opens the letter packs page with ui/open-link, then checks the balance with tools/call', async () => {
    const card = await showing(spec, noLetters);
    expect(card.visible('website-packs-button')).toBe(true);

    await card.click('website-packs-button');
    expect(card.lastRequest('ui/open-link')!.params).toEqual({ url: PACKS_URL });
    await card.answer('ui/open-link', { result: {} });

    expect(card.visible('error-message')).toBe(false);
    expect(card.visible('check-status-button')).toBe(true);

    await card.runTimer(3000);
    expect(card.lastRequest('tools/call', 'get_account_balance')!.params).toEqual({ name: 'get_account_balance', arguments: {} });
    await card.answer('tools/call', { result: { content: [], structuredContent: { lettersRemaining: 1 } } }, 'get_account_balance');

    expect(card.visible('send-button')).toBe(true);
    expect(card.visible('purchase-actions')).toBe(false);
  });

  it('shows the address when the host declines to open the page', async () => {
    for (const reply of [{ result: { isError: true } }, { error: { code: -32000, message: 'The person cancelled' } }]) {
      const card = await showing(spec, noLetters);
      await card.click('website-packs-button');
      await card.answer('ui/open-link', reply);

      expect(card.visible('error-message'), JSON.stringify(reply)).toBe(true);
      expect(card.text('error-message')).toBe(`The website did not open. Letter packs are at ${PACKS_URL}`);
    }
  });

  it("offers the preview again when none arrives, without ChatGPT's tip", async () => {
    const card = mountInMcpHost(spec);
    await flush();
    await card.initialize();
    await card.toolInput(spec.args);

    await card.runTimer(spec.waitMs);

    expect(card.visible('empty-state')).toBe(true);
    expect(card.visible('retry-button')).toBe(true);
    expect(card.visible('empty-hint')).toBe(false);
    // No file store in this host, so no picker either.
    expect(card.visible('choose-image-button')).toBe(false);
    expect(card.visible('upload-image-button')).toBe(false);

    await card.click('retry-button');
    expect(card.lastRequest('tools/call', spec.tool)!.params).toEqual({ name: spec.tool, arguments: spec.args });
  });
});

describe.each([LETTER, POSTCARD])('$file asks the server what became of its draft (#474)', spec => {
  const noun = spec.file === 'LetterPreviewCard' ? 'letter' : 'postcard';
  const status = (card: Awaited<ReturnType<typeof showing>>, answer: Json) =>
    card.answer('tools/call', { result: { content: [], structuredContent: answer } }, 'get_draft_status');

  it('asks once, for the draft the host showed', async () => {
    const card = await showing(spec, canSend);

    expect(card.requests('tools/call').filter(message => message.params?.name === 'get_draft_status')).toHaveLength(1);
    expect(card.lastRequest('tools/call', 'get_draft_status')!.params).toEqual({
      name: 'get_draft_status',
      arguments: { draftId: 'draft_0001' }
    });

    // The host handing the same result over again asks nothing new.
    await card.toolResult({ content: [], structuredContent: spec.output('draft_0001', canSend), _meta: spec.meta });
    expect(card.requests('tools/call').filter(message => message.params?.name === 'get_draft_status')).toHaveLength(1);
  });

  it('shows a draft that was sent as sent, with its order, and offers nothing to press', async () => {
    const card = await showing(spec, canSend);

    await status(card, { draftId: 'draft_0001', status: 'sent', orderId: 'ord_0001' });

    expect(card.text('status-pill')).toBe('With the printer');
    expect(card.text('id-label')).toBe('Order');
    expect(card.text('id-value')).toBe('ord_0001');
    expect(card.visible('send-button')).toBe(false);
    expect(card.visible('purchase-actions')).toBe(false);
    expect(card.text('note')).toContain(`This ${noun} has already been sent. Ask for its status in the chat.`);
    // The preview itself stays.
    expect(card.html(spec.pane)).toContain(spec.drawnFromMeta);
  });

  it('shows an expired preview as expired, with nothing to buy or send', async () => {
    const card = await showing(spec, noLetters);
    expect(card.visible('website-packs-button')).toBe(true);

    await status(card, { draftId: 'draft_0001', status: 'expired' });

    expect(card.text('status-pill')).toBe('Preview expired');
    expect(card.visible('send-button')).toBe(false);
    expect(card.visible('purchase-actions')).toBe(false);
    expect(card.text('note')).toContain('This preview has expired. Ask for a new one in the chat.');
  });

  it('leaves a ready draft as the host gave it', async () => {
    const card = await showing(spec, canSend);

    await status(card, { draftId: 'draft_0001', status: 'ready' });

    expect(card.text('status-pill')).toBe('Ready to send');
    expect(card.visible('send-button')).toBe(true);
    expect(card.text('id-label')).toBe('Draft');
  });

  it('ignores an answer about another draft', async () => {
    const card = await showing(spec, canSend);
    await status(card, { draftId: 'draft_other', status: 'sent', orderId: 'ord_other' });
    expect(card.text('status-pill')).toBe('Ready to send');
    expect(card.visible('send-button')).toBe(true);
  });

  it("keeps the card's own send on screen while an answer arrives", async () => {
    const card = await showing(spec, canSend);
    await card.click('send-button');

    await status(card, { draftId: 'draft_0001', status: 'sent', orderId: 'ord_0001' });
    // The send is still under way, and it owns the pill.
    expect(card.text('status-pill')).toBe('Ready to send');

    await card.answer('tools/call', { result: { content: [], structuredContent: { orderId: 'ord_0001' } } }, spec.sendTool);
    expect(card.text('status-pill')).toBe('With the printer');
    expect(card.text('id-value')).toBe('ord_0001');
  });

  it('shows a draft as sent when the answer comes after its own send failed', async () => {
    const card = await showing(spec, canSend);
    await card.click('send-button');
    await card.answer('tools/call', { error: { code: -32603, message: 'The host timed out' } }, spec.sendTool);
    expect(card.text('status-pill')).toBe('Send failed');

    await status(card, { draftId: 'draft_0001', status: 'sent', orderId: 'ord_0001' });

    expect(card.text('status-pill')).toBe('With the printer');
    expect(card.text('id-value')).toBe('ord_0001');
    expect(card.visible('send-button')).toBe(false);
    expect(card.visible('error-message')).toBe(false);
  });

  it('shows the preview as the host gave it when the question goes unanswered', async () => {
    const card = await showing(spec, canSend);

    await card.answer('tools/call', { error: { code: -32603, message: 'no such tool' } }, 'get_draft_status');

    expect(card.text('status-pill')).toBe('Ready to send');
    expect(card.visible('send-button')).toBe(true);
  });

  it('drops the answer when the host shows another draft, and asks about that one', async () => {
    const card = await showing(spec, canSend);
    await status(card, { draftId: 'draft_0001', status: 'sent', orderId: 'ord_0001' });
    expect(card.text('status-pill')).toBe('With the printer');

    await card.toolResult({ content: [], structuredContent: spec.output('draft_0002', canSend), _meta: spec.meta });

    expect(card.text('status-pill')).toBe('Ready to send');
    expect(card.text('id-value')).toBe('draft_0002');
    expect(card.visible('send-button')).toBe(true);
    expect(card.lastRequest('tools/call', 'get_draft_status')!.params.arguments).toEqual({ draftId: 'draft_0002' });
  });

  it('does not ask about a draft it made itself', async () => {
    const card = mountInMcpHost(spec);
    await flush();
    await card.initialize();
    await card.toolInput(spec.args);
    await card.runTimer(spec.waitMs);
    await card.click('retry-button');

    await card.answer(
      'tools/call',
      { result: { content: [], structuredContent: spec.output('draft_retry', canSend), _meta: spec.meta } },
      spec.tool
    );

    expect(card.text('id-value')).toBe('draft_retry');
    expect(card.requests('tools/call').filter(message => message.params?.name === 'get_draft_status')).toEqual([]);
  });
});

describe.each([LETTER, POSTCARD])('$file: the arrival date (#535)', spec => {
  const Noun = spec.file === 'LetterPreviewCard' ? 'Letter' : 'Postcard';
  const noun = Noun.toLowerCase();
  const WINDOW = { earliestArrival: '2026-10-13', latestArrival: '2026-11-30' };
  const HELD = {
    arriveBy: '2026-10-16',
    mailOn: '2026-10-06',
    releasesAt: '2026-10-06T13:00:00.000Z',
    earliestArrival: '2026-10-13',
    latestArrival: '2026-11-30'
  };
  // The card names the year only when it is not this year in New York.
  const MAILS_OCT_6 = /^Mails Tue, Oct 6(, 2026)? · cancel free until then$/;
  // What a send answers for mail that waits for its mail date.
  const SCHEDULED_SEND = {
    orderId: 'ord_0001',
    currentStatus: 'scheduled',
    schedule: { arriveBy: '2026-10-16', mailOn: '2026-10-06' },
    cancellable: true
  };

  /** A card showing a preview that offers dates, after the handshake. */
  async function offering(extra: Json = {}) {
    const card = mountInMcpHost(spec);
    await flush();
    await card.initialize();
    await card.toolInput(spec.args);
    await card.toolResult({
      content: [{ type: 'text', text: 'Preview ready.' }],
      structuredContent: { ...spec.output('draft_0001', canSend), arrivalWindow: WINDOW, ...extra },
      _meta: spec.meta
    });
    return card;
  }
  const dateInput = (card: Awaited<ReturnType<typeof offering>>) =>
    card.document.getElementById('arrives-date') as HTMLInputElement;
  async function choose(card: Awaited<ReturnType<typeof offering>>, value: string) {
    const input = dateInput(card);
    input.value = value;
    input.dispatchEvent(new card.window.Event('change'));
    await flush();
  }
  const answerTool = (card: Awaited<ReturnType<typeof offering>>, name: string, result: Json) =>
    card.answer('tools/call', { result }, name);

  it('offers the dates the preview names, starting from as soon as possible', async () => {
    const card = await offering();

    expect(card.visible('arrives-row')).toBe(true);
    expect(dateInput(card).min).toBe('2026-10-13');
    expect(dateInput(card).max).toBe('2026-11-30');
    expect(dateInput(card).value).toBe('');
    expect(card.document.getElementById('arrives-asap')!.getAttribute('aria-pressed')).toBe('true');
    expect(card.visible('arrives-note')).toBe(false);
    expect(card.text('send-button-text')).toBe(`Send ${Noun}`);
  });

  it('offers nothing while the preview names no dates', async () => {
    const card = await showing(spec, canSend);
    expect(card.visible('arrives-row')).toBe(false);
    expect(card.text('send-button-text')).toBe(`Send ${Noun}`);
  });

  it('sets a chosen date on the draft, holding Send meanwhile, then offers to schedule', async () => {
    const card = await offering();

    await choose(card, '2026-10-16');
    expect(card.lastRequest('tools/call', 'set_arrival_date')!.params.arguments).toEqual({
      draftId: 'draft_0001',
      arriveBy: '2026-10-16'
    });
    expect((card.document.getElementById('send-button') as HTMLButtonElement).disabled).toBe(true);
    expect(dateInput(card).disabled).toBe(true);
    expect(dateInput(card).value).toBe('2026-10-16');

    await answerTool(card, 'set_arrival_date', {
      content: [{ type: 'text', text: 'The arrival date is set.' }],
      structuredContent: {
        draftId: 'draft_0001',
        schedule: HELD,
        deliveryEstimate: 'Goes to the printer Tue, Oct 6, and aims to arrive by Fri, Oct 16.',
        message: 'Nothing has been sent.'
      }
    });

    expect(dateInput(card).value).toBe('2026-10-16');
    expect(dateInput(card).disabled).toBe(false);
    expect(card.text('arrives-note')).toMatch(MAILS_OCT_6);
    expect(card.text('delivery')).toContain('Goes to the printer Tue, Oct 6, and aims to arrive by Fri, Oct 16.');
    expect(card.text('send-button-text')).toBe(`Schedule ${Noun}`);
    expect((card.document.getElementById('send-button') as HTMLButtonElement).disabled).toBe(false);
    expect(card.document.getElementById('arrives-asap')!.getAttribute('aria-pressed')).toBe('false');
  });

  it('clears the date with As soon as possible', async () => {
    const card = await offering({ schedule: HELD });
    expect(dateInput(card).value).toBe('2026-10-16');
    expect(card.text('send-button-text')).toBe(`Schedule ${Noun}`);

    await card.click('arrives-asap');
    expect(card.lastRequest('tools/call', 'set_arrival_date')!.params.arguments).toEqual({ draftId: 'draft_0001' });
    expect(dateInput(card).value).toBe('');
    await answerTool(card, 'set_arrival_date', {
      content: [],
      structuredContent: {
        draftId: 'draft_0001',
        deliveryEstimate: 'Mailed in 1-2 business days; usually arrives in 1-2 weeks',
        message: 'Nothing has been sent.'
      }
    });

    expect(dateInput(card).value).toBe('');
    expect(card.visible('arrives-note')).toBe(false);
    expect(card.text('delivery')).toContain('Mailed in 1-2 business days');
    expect(card.text('send-button-text')).toBe(`Send ${Noun}`);
  });

  it('keeps the dates it had when a date is refused, and moves to the earliest the refusal names', async () => {
    const card = await offering();

    await choose(card, '2026-10-13');
    await answerTool(card, 'set_arrival_date', {
      isError: true,
      content: [
        {
          type: 'text',
          text: 'The earliest this can arrive is Wed, Oct 14 (2026-10-14). Choose that date or later, or leave arriveBy out to mail as soon as possible.'
        }
      ]
    });

    expect(dateInput(card).value).toBe('');
    expect(dateInput(card).min).toBe('2026-10-14');
    expect(card.text('arrives-note')).toMatch(/^That date can't be met any more\. The earliest on offer is now Wed, Oct 14(, 2026)?\.$/);
    expect(card.document.getElementById('arrives-note')!.classList.contains('alert')).toBe(true);
    expect(card.text('send-button-text')).toBe(`Send ${Noun}`);
    expect((card.document.getElementById('send-button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('sent with a date, waits as scheduled, and is cancelled only after asking', async () => {
    const card = await offering({ schedule: HELD });

    await card.click('send-button');
    await answerTool(card, spec.sendTool, { content: [], structuredContent: SCHEDULED_SEND });

    expect(card.text('status-pill')).toBe('Scheduled');
    expect(card.text('id-value')).toBe('ord_0001');
    expect(card.text('send-button-text')).toBe(`${Noun} Scheduled`);
    expect(card.visible('arrives-row')).toBe(false);
    expect(card.visible('scheduled')).toBe(true);
    expect(card.text('scheduled-note')).toMatch(MAILS_OCT_6);
    expect(card.text('cancel-scheduled-button-text')).toBe(`Cancel this ${noun}`);

    await card.click('cancel-scheduled-button');
    expect(card.lastRequest('tools/call', 'cancel_scheduled_mail')).toBeUndefined();
    expect(card.text('cancel-scheduled-button-text')).toBe(`Yes, cancel this ${noun}`);
    expect(card.text('scheduled-note')).toBe('Cancel it? Nothing is mailed, and what paid for it comes back.');

    await card.click('cancel-scheduled-button');
    expect(card.lastRequest('tools/call', 'cancel_scheduled_mail')!.params.arguments).toEqual({ orderId: 'ord_0001', confirm: true });
    await answerTool(card, 'cancel_scheduled_mail', {
      content: [],
      structuredContent: {
        status: 'cancelled',
        alreadyCancelled: false,
        returned: { kind: 'letters', count: 1 },
        message: 'Cancelled. The letter it cost is back in the balance.'
      }
    });

    expect(card.text('status-pill')).toBe('Cancelled');
    expect(card.text('scheduled-note')).toBe('Cancelled. The letter it cost is back in the balance.');
    expect(card.visible('cancel-scheduled-button')).toBe(false);
  });

  it('stops offering Cancel once the mail has gone to the printer', async () => {
    const card = await offering({ schedule: HELD });
    await card.click('send-button');
    await answerTool(card, spec.sendTool, { content: [], structuredContent: SCHEDULED_SEND });
    await card.click('cancel-scheduled-button');
    await card.click('cancel-scheduled-button');

    await answerTool(card, 'cancel_scheduled_mail', {
      isError: true,
      content: [
        {
          type: 'text',
          text: "This order has gone to the printer, or did not go out, so it can't be cancelled. get_order_status shows where it is."
        }
      ]
    });

    expect(card.text('scheduled-note')).toBe('It has gone to the printer, so it can no longer be cancelled.');
    expect(card.visible('cancel-scheduled-button')).toBe(false);
    expect(card.text('status-pill')).toBe('Scheduled');
  });

  it('keeps Cancel after a refusal worth trying again, and closes it when nothing is left to cancel', async () => {
    const card = await offering({ schedule: HELD });
    await card.click('send-button');
    await answerTool(card, spec.sendTool, { content: [], structuredContent: SCHEDULED_SEND });
    await card.click('cancel-scheduled-button');
    await card.click('cancel-scheduled-button');

    await answerTool(card, 'cancel_scheduled_mail', {
      isError: true,
      content: [{ type: 'text', text: "That order wasn't found. list_orders shows the orders on this account." }]
    });
    expect(card.text('scheduled-note')).toBe("That order wasn't found. list_orders shows the orders on this account.");
    expect(card.visible('cancel-scheduled-button')).toBe(true);
    expect(card.text('cancel-scheduled-button-text')).toBe(`Cancel this ${noun}`);

    await card.click('cancel-scheduled-button');
    await card.click('cancel-scheduled-button');
    await answerTool(card, 'cancel_scheduled_mail', {
      isError: true,
      content: [
        {
          type: 'text',
          text: "This order is going to the printer right now, so it can't be cancelled. get_order_status shows where it is."
        }
      ]
    });
    expect(card.text('scheduled-note')).toBe('It is going to the printer right now, so it can no longer be cancelled.');
    expect(card.visible('cancel-scheduled-button')).toBe(false);
  });

  it("keeps a draft it made itself once a date is set on it, when the host's result comes late", async () => {
    const card = mountInMcpHost(spec);
    await flush();
    await card.initialize();
    await card.toolInput(spec.args);
    await card.runTimer(spec.waitMs);
    await card.click('retry-button');
    await card.answer(
      'tools/call',
      {
        result: {
          content: [],
          structuredContent: { ...spec.output('draft_retry', canSend), arrivalWindow: WINDOW },
          _meta: spec.meta
        }
      },
      spec.tool
    );
    await choose(card, '2026-10-16');
    await answerTool(card, 'set_arrival_date', { content: [], structuredContent: { draftId: 'draft_retry', schedule: HELD } });

    await card.toolResult({
      content: [],
      structuredContent: { ...spec.output('draft_0001', canSend), arrivalWindow: WINDOW },
      _meta: spec.meta
    });

    expect(card.text('id-value')).toBe('draft_retry');
    expect(dateInput(card).value).toBe('2026-10-16');
    expect(card.text('send-button-text')).toBe(`Schedule ${Noun}`);
  });

  it('draws the dates the draft has now, which a card shown its first preview again cannot know', async () => {
    const card = await offering();

    await answerTool(card, 'get_draft_status', {
      content: [],
      structuredContent: {
        draftId: 'draft_0001',
        status: 'ready',
        schedule: { arriveBy: '2026-10-16', mailOn: '2026-10-06' },
        deliveryEstimate: 'Goes to the printer Tue, Oct 6, and aims to arrive by Fri, Oct 16.'
      }
    });

    expect(dateInput(card).value).toBe('2026-10-16');
    expect(card.text('arrives-note')).toMatch(MAILS_OCT_6);
    expect(card.text('delivery')).toContain('Goes to the printer Tue, Oct 6, and aims to arrive by Fri, Oct 16.');
    expect(card.text('send-button-text')).toBe(`Schedule ${Noun}`);
  });

  it('draws a date cleared since its preview, with the estimate that goes with none', async () => {
    const card = await offering({
      schedule: HELD,
      deliveryEstimate: 'Goes to the printer Tue, Oct 6, and aims to arrive by Fri, Oct 16.'
    });
    expect(card.text('delivery')).toContain('Goes to the printer Tue, Oct 6');

    await answerTool(card, 'get_draft_status', {
      content: [],
      structuredContent: { draftId: 'draft_0001', status: 'ready', deliveryEstimate: 'Mailed in 1-2 business days; usually arrives in 1-2 weeks' }
    });

    expect(dateInput(card).value).toBe('');
    expect(card.visible('arrives-note')).toBe(false);
    expect(card.text('delivery')).toContain('Mailed in 1-2 business days');
    expect(card.text('delivery')).not.toContain('Goes to the printer');
    expect(card.text('send-button-text')).toBe(`Send ${Noun}`);
  });

  it('says what the send answers, not what it thought: a date set from the chat is scheduled', async () => {
    const card = await offering();
    expect(card.text('send-button-text')).toBe(`Send ${Noun}`);

    await card.click('send-button');
    await answerTool(card, spec.sendTool, { content: [], structuredContent: SCHEDULED_SEND });

    expect(card.text('status-pill')).toBe('Scheduled');
    expect(card.text('scheduled-note')).toMatch(MAILS_OCT_6);
    expect(card.visible('cancel-scheduled-button')).toBe(true);
  });

  it('says what the send answers, not what it thought: a date cleared from the chat goes at once', async () => {
    const card = await offering({ schedule: HELD });
    expect(card.text('send-button-text')).toBe(`Schedule ${Noun}`);

    await card.click('send-button');
    await answerTool(card, spec.sendTool, { content: [], structuredContent: { orderId: 'ord_0001', currentStatus: 'accepted' } });

    expect(card.text('status-pill')).toBe('With the printer');
    expect(card.text('send-button-text')).toBe(`${Noun} Sent!`);
    expect(card.visible('scheduled')).toBe(false);
  });

  it('shows a dated send the outbox took at once as sent, with no Cancel', async () => {
    const card = await offering({ schedule: HELD });

    await card.click('send-button');
    await answerTool(card, spec.sendTool, {
      content: [],
      structuredContent: { ...SCHEDULED_SEND, currentStatus: 'accepted', cancellable: false }
    });

    expect(card.text('status-pill')).toBe('With the printer');
    expect(card.visible('scheduled')).toBe(false);
  });

  it('shows a draft sent with a date as scheduled, with Cancel', async () => {
    const card = await offering();

    await answerTool(card, 'get_draft_status', {
      content: [],
      structuredContent: {
        draftId: 'draft_0001',
        status: 'sent',
        orderId: 'ord_0002',
        schedule: { arriveBy: '2026-10-16', mailOn: '2026-10-06' },
        orderStatus: 'scheduled',
        cancellable: true
      }
    });

    expect(card.text('status-pill')).toBe('Scheduled');
    expect(card.text('id-value')).toBe('ord_0002');
    expect(card.visible('send-button')).toBe(false);
    expect(card.visible('arrives-row')).toBe(false);
    expect(card.visible('scheduled')).toBe(true);
    expect(card.text('cancel-scheduled-button-text')).toBe(`Cancel this ${noun}`);

    // Cancelled from here, it stays cancelled, in its own words, when redrawn.
    await card.click('cancel-scheduled-button');
    await card.click('cancel-scheduled-button');
    await answerTool(card, 'cancel_scheduled_mail', {
      content: [],
      structuredContent: { status: 'cancelled', message: 'Cancelled. The letter it cost is back in the balance.' }
    });
    await card.toolResult({
      content: [],
      structuredContent: { ...spec.output('draft_0001', canSend), arrivalWindow: WINDOW },
      _meta: spec.meta
    });
    expect(card.text('status-pill')).toBe('Cancelled');
    expect(card.text('scheduled-note')).toBe('Cancelled. The letter it cost is back in the balance.');
    expect(card.visible('cancel-scheduled-button')).toBe(false);
    expect(card.text('note')).toContain(`This ${noun} was sent with a date, then cancelled. Nothing will be mailed.`);
  });

  const sentAnswer = (extra: Json) => ({
    content: [],
    structuredContent: {
      draftId: 'draft_0001',
      status: 'sent',
      orderId: 'ord_0002',
      schedule: { arriveBy: '2026-10-16', mailOn: '2026-10-06' },
      ...extra
    }
  });

  it('shows a Pay & Send order waiting for its date as scheduled, without Cancel', async () => {
    const card = await offering();
    await answerTool(card, 'get_draft_status', sentAnswer({ orderStatus: 'scheduled', cancellable: false }));

    expect(card.text('status-pill')).toBe('Scheduled');
    expect(card.visible('scheduled')).toBe(true);
    expect(card.visible('cancel-scheduled-button')).toBe(false);
    expect(card.text('scheduled-note')).toMatch(/^Mails Tue, Oct 6(, 2026)? · to cancel, email support@letterirl\.com$/);
  });

  it('shows an order cancelled since, from the chat or the website, as cancelled', async () => {
    const card = await offering();
    await answerTool(card, 'get_draft_status', sentAnswer({ orderStatus: 'cancelled', cancellable: false }));

    expect(card.text('status-pill')).toBe('Cancelled');
    expect(card.text('scheduled-note')).toBe('Cancelled. Nothing will be mailed.');
    expect(card.visible('cancel-scheduled-button')).toBe(false);
    expect(card.visible('send-button')).toBe(false);
    expect(card.text('note')).toContain(`This ${noun} was sent with a date, then cancelled. Nothing will be mailed.`);
  });

  it('shows an order the outbox has taken as with the printer, whatever its dates', async () => {
    const card = await offering();
    await answerTool(card, 'get_draft_status', sentAnswer({ orderStatus: 'sent', cancellable: false }));

    expect(card.text('status-pill')).toBe('With the printer');
    expect(card.visible('scheduled')).toBe(false);
    expect(card.text('note')).toContain(`This ${noun} has already been sent. Ask for its status in the chat.`);
  });

  const anotherSent = {
    content: [],
    structuredContent: {
      draftId: 'draft_0002',
      status: 'sent',
      orderId: 'ord_0003',
      schedule: { arriveBy: '2026-10-16', mailOn: '2026-10-06' },
      orderStatus: 'scheduled',
      cancellable: true
    }
  };
  const showAnother = (card: Awaited<ReturnType<typeof offering>>) =>
    card.toolResult({
      content: [],
      structuredContent: { ...spec.output('draft_0002', canSend), arrivalWindow: WINDOW },
      _meta: spec.meta
    });

  it("starts afresh for another order: one cancelled is not the next one's", async () => {
    const card = await offering();
    await answerTool(card, 'get_draft_status', sentAnswer({ orderStatus: 'scheduled', cancellable: true }));
    await card.click('cancel-scheduled-button');
    await card.click('cancel-scheduled-button');
    await answerTool(card, 'cancel_scheduled_mail', {
      content: [],
      structuredContent: { status: 'cancelled', message: 'Cancelled. The letter it cost is back in the balance.' }
    });
    expect(card.text('status-pill')).toBe('Cancelled');

    await showAnother(card);
    await answerTool(card, 'get_draft_status', anotherSent);

    expect(card.text('id-value')).toBe('ord_0003');
    expect(card.text('status-pill')).toBe('Scheduled');
    expect(card.text('scheduled-note')).toMatch(MAILS_OCT_6);
    expect(card.text('cancel-scheduled-button-text')).toBe(`Cancel this ${noun}`);
  });

  it("does not count a cancel's late answer for the order shown since", async () => {
    const card = await offering();
    await answerTool(card, 'get_draft_status', sentAnswer({ orderStatus: 'scheduled', cancellable: true }));
    await card.click('cancel-scheduled-button');
    await card.click('cancel-scheduled-button');
    expect(card.lastRequest('tools/call', 'cancel_scheduled_mail')!.params.arguments).toEqual({ orderId: 'ord_0002', confirm: true });

    // Before it answers, the host shows another draft, sent with a date too.
    await showAnother(card);
    await answerTool(card, 'get_draft_status', anotherSent);
    await answerTool(card, 'cancel_scheduled_mail', {
      content: [],
      structuredContent: { status: 'cancelled', message: 'Cancelled. The letter it cost is back in the balance.' }
    });

    expect(card.text('status-pill')).toBe('Scheduled');
    expect(card.text('scheduled-note')).toMatch(MAILS_OCT_6);
    expect(card.visible('cancel-scheduled-button')).toBe(true);
    expect((card.document.getElementById('cancel-scheduled-button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('drops the Scheduled block when the host shows another draft', async () => {
    const card = await offering();
    await answerTool(card, 'get_draft_status', {
      content: [],
      structuredContent: {
        draftId: 'draft_0001',
        status: 'sent',
        orderId: 'ord_0002',
        schedule: { arriveBy: '2026-10-16', mailOn: '2026-10-06' },
        orderStatus: 'scheduled',
        cancellable: true
      }
    });
    expect(card.visible('scheduled')).toBe(true);

    await card.toolResult({
      content: [],
      structuredContent: { ...spec.output('draft_0002', canSend), arrivalWindow: WINDOW },
      _meta: spec.meta
    });

    expect(card.text('id-value')).toBe('draft_0002');
    expect(card.visible('scheduled')).toBe(false);
    expect(card.visible('arrives-row')).toBe(true);
    expect(card.visible('send-button')).toBe(true);
  });
});
