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
    // Only the handshake so far: nothing is saved to or asked of the host.
    expect(card.sent.map(message => message.method)).toEqual(['ui/initialize', 'ui/notifications/initialized']);
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
