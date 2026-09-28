/**
 * The card host bridge (widgets/shared/host.js, #474), and the getting-started
 * card on it.
 *
 * In ChatGPT the bridge wraps window.openai exactly as the cards always used
 * it. Anywhere else it speaks MCP Apps with the frame's parent: ui/initialize
 * first, ui/notifications/initialized after the reply, then the tool's input
 * and result, tool calls, links and chat messages, as JSON-RPC 2.0 over
 * postMessage. Here the parent is a fake host that records what the card sends
 * and answers it, so the protocol is checked message by message.
 */

import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';
import { inlineHostBridge } from '../../../src/mcp/widgetHost.js';

const WIDGET_DIR = path.resolve(__dirname, '../../../widgets');
const BRIDGE = fs.readFileSync(path.join(WIDGET_DIR, 'shared', 'host.js'), 'utf-8');

type Message = Record<string, any>;

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

/** A page framed by a fake MCP Apps host. */
function mountInMcpHost(html: string) {
  const sent: Message[] = [];
  const parent = { postMessage: (message: Message) => sent.push(JSON.parse(JSON.stringify(message))) };
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    beforeParse(window) {
      Object.defineProperty(window, 'parent', { value: parent, configurable: true });
    }
  });
  const window = dom.window as any;
  const deliver = (message: Message, source: unknown = parent) =>
    window.dispatchEvent(new window.MessageEvent('message', { data: { jsonrpc: '2.0', ...message }, source }));
  const lastRequest = (method: string) => [...sent].reverse().find(message => message.method === method);
  return { window, sent, deliver, lastRequest, host: () => window.letterIrlHost };
}

/** Answers the card's ui/initialize, as a host does. */
function initialize(mounted: ReturnType<typeof mountInMcpHost>, hostContext: Record<string, unknown> = {}) {
  const init = mounted.lastRequest('ui/initialize');
  mounted.deliver({ id: init!.id, result: { protocolVersion: '2026-01-26', hostInfo: { name: 'fake' }, hostCapabilities: {}, hostContext } });
}

const bridgePage = (body = '') => `<!doctype html><html><body>${body}<script>${BRIDGE}</script></body></html>`;

describe('the bridge in ChatGPT', () => {
  function mountInChatGpt(overrides: Record<string, unknown> = {}) {
    const calls: unknown[][] = [];
    const openai: Record<string, unknown> = {
      theme: 'dark',
      toolInput: { a: 1 },
      toolOutput: { b: 2 },
      toolResponseMetadata: { c: 3 },
      widgetState: { v: 1 },
      callTool: async (...args: unknown[]) => { calls.push(['callTool', ...args]); return { structuredContent: { ok: true } }; },
      openExternal: async (...args: unknown[]) => { calls.push(['openExternal', ...args]); },
      setWidgetState: async (...args: unknown[]) => { calls.push(['setWidgetState', ...args]); },
      sendFollowUpMessage: async (...args: unknown[]) => { calls.push(['sendFollowUpMessage', ...args]); },
      ...overrides
    };
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete openai[key];
    }
    const sent: unknown[] = [];
    const dom = new JSDOM(bridgePage(), {
      runScripts: 'dangerously',
      beforeParse(window) {
        (window as any).openai = openai;
        Object.defineProperty(window, 'parent', { value: { postMessage: (m: unknown) => sent.push(m) }, configurable: true });
      }
    });
    return { window: dom.window as any, openai, calls, sent };
  }

  it('reads everything straight from window.openai', () => {
    const { window } = mountInChatGpt();
    const host = window.letterIrlHost;
    expect(host.kind).toBe('chatgpt');
    expect(host.theme()).toBe('dark');
    expect(host.toolInput()).toEqual({ a: 1 });
    expect(host.toolOutput()).toEqual({ b: 2 });
    expect(host.toolMeta()).toEqual({ c: 3 });
    expect(host.widgetState()).toEqual({ v: 1 });
  });

  it('calls window.openai for tools, links, state and messages, and posts nothing', async () => {
    const { window, calls, sent } = mountInChatGpt();
    const host = window.letterIrlHost;
    await expect(host.callTool('get_account_balance', { x: 1 })).resolves.toEqual({ structuredContent: { ok: true } });
    await host.openLink('https://example.com/a');
    await host.setWidgetState({ v: 2 });
    await host.sendMessage('hello');
    expect(calls).toEqual([
      ['callTool', 'get_account_balance', { x: 1 }],
      ['openExternal', { href: 'https://example.com/a' }],
      ['setWidgetState', { v: 2 }],
      ['sendFollowUpMessage', { prompt: 'hello' }]
    ]);
    expect(sent).toEqual([]);
  });

  it("passes ChatGPT's empty values through, so a card can tell no result from an empty one", () => {
    const { window } = mountInChatGpt({ toolInput: undefined, toolOutput: null, toolResponseMetadata: undefined, widgetState: undefined });
    const host = window.letterIrlHost;
    expect(host.toolInput()).toBeUndefined();
    expect(host.toolOutput()).toBeNull();
    expect(host.toolMeta()).toBeUndefined();
    expect(host.widgetState()).toBeUndefined();
  });

  it('offers a capability only where window.openai has it', () => {
    const { window } = mountInChatGpt({ openExternal: undefined, setWidgetState: undefined, sendFollowUpMessage: undefined });
    const host = window.letterIrlHost;
    expect(typeof host.callTool).toBe('function');
    for (const name of ['openLink', 'setWidgetState', 'sendMessage', 'uploadFile', 'selectFiles', 'getFileDownloadUrl']) {
      expect(host[name], name).toBeUndefined();
    }
  });

  it("hands ChatGPT's file store calls straight through", async () => {
    const calls: unknown[][] = [];
    const { window } = mountInChatGpt({
      uploadFile: async (...args: unknown[]) => { calls.push(['uploadFile', ...args]); return { fileId: 'file_1' }; },
      selectFiles: async (...args: unknown[]) => { calls.push(['selectFiles', ...args]); return [{ fileId: 'file_2' }]; },
      getFileDownloadUrl: async (...args: unknown[]) => { calls.push(['getFileDownloadUrl', ...args]); return { downloadUrl: 'https://files.example/2' }; }
    });
    const host = window.letterIrlHost;
    const file = { name: 'photo.jpg' };
    await expect(host.uploadFile(file)).resolves.toEqual({ fileId: 'file_1' });
    await expect(host.selectFiles()).resolves.toEqual([{ fileId: 'file_2' }]);
    await expect(host.getFileDownloadUrl({ fileId: 'file_2' })).resolves.toEqual({ downloadUrl: 'https://files.example/2' });
    expect(calls).toEqual([['uploadFile', file], ['selectFiles'], ['getFileDownloadUrl', { fileId: 'file_2' }]]);
  });

  it('asks window.openai afresh each time, so what ChatGPT adds or sets after the page loads is there', async () => {
    const { window, openai } = mountInChatGpt();
    const host = window.letterIrlHost;
    expect(host.selectFiles).toBeUndefined();
    openai.selectFiles = async () => [{ fileId: 'file_3' }];
    await expect(host.selectFiles()).resolves.toEqual([{ fileId: 'file_3' }]);
    openai.toolOutput = { b: 3 };
    expect(host.toolOutput()).toEqual({ b: 3 });
    // Even a window.openai replaced whole.
    window.openai = { ...openai, theme: 'light', toolOutput: { b: 4 } };
    expect(host.theme()).toBe('light');
    expect(host.toolOutput()).toEqual({ b: 4 });
  });

  it('tells the card when ChatGPT sets new globals', () => {
    const { window } = mountInChatGpt();
    let changes = 0;
    window.letterIrlHost.onChange(() => { changes += 1; });
    window.dispatchEvent(new window.Event('openai:set_globals'));
    expect(changes).toBe(1);
  });
});

describe('the bridge in an MCP Apps host', () => {
  it('opens with ui/initialize and sends nothing else until the host answers', async () => {
    const mounted = mountInMcpHost(bridgePage());
    await flush();
    expect(mounted.sent).toHaveLength(1);
    expect(mounted.sent[0]).toMatchObject({
      jsonrpc: '2.0',
      method: 'ui/initialize',
      params: { appInfo: { name: 'letter-irl-card' }, protocolVersion: '2026-01-26', appCapabilities: {} }
    });
    expect(typeof mounted.sent[0].id).toBe('number');
    expect(mounted.host().kind).toBe('mcp-apps');
  });

  it('confirms with ui/notifications/initialized after the reply, and takes the theme from the host context', async () => {
    const mounted = mountInMcpHost(bridgePage());
    let changes = 0;
    mounted.host().onChange(() => { changes += 1; });
    initialize(mounted, { theme: 'dark' });
    await flush();
    expect(mounted.sent[1]).toEqual({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} });
    expect(mounted.host().theme()).toBe('dark');
    expect(changes).toBeGreaterThan(0);
  });

  it('takes the tool input, the result and context changes from notifications', async () => {
    const mounted = mountInMcpHost(bridgePage());
    initialize(mounted);
    await flush();
    let changes = 0;
    mounted.host().onChange(() => { changes += 1; });

    mounted.deliver({ method: 'ui/notifications/tool-input', params: { arguments: { draftId: 'd1' } } });
    mounted.deliver({
      method: 'ui/notifications/tool-result',
      params: { content: [], structuredContent: { overview: 'o' }, _meta: { previewHtml: '<p>' } }
    });
    mounted.deliver({ method: 'ui/notifications/host-context-changed', params: { theme: 'dark' } });

    expect(mounted.host().toolInput()).toEqual({ draftId: 'd1' });
    expect(mounted.host().toolOutput()).toEqual({ overview: 'o' });
    expect(mounted.host().toolMeta()).toEqual({ previewHtml: '<p>' });
    expect(mounted.host().theme()).toBe('dark');
    expect(changes).toBe(3);
  });

  it('calls a tool with tools/call and returns the host\'s answer, or its error', async () => {
    const mounted = mountInMcpHost(bridgePage());
    initialize(mounted);
    await flush();

    const call = mounted.host().callTool('get_account_balance', { a: 1 });
    const request = mounted.lastRequest('tools/call');
    expect(request).toMatchObject({ method: 'tools/call', params: { name: 'get_account_balance', arguments: { a: 1 } } });
    mounted.deliver({ id: request!.id, result: { structuredContent: { lettersRemaining: 2 } } });
    await expect(call).resolves.toEqual({ structuredContent: { lettersRemaining: 2 } });

    const refused = mounted.host().callTool('send_letter', {});
    mounted.deliver({ id: mounted.lastRequest('tools/call')!.id, error: { code: -32000, message: 'not allowed' } });
    await expect(refused).rejects.toThrow('not allowed');
  });

  it('opens links with ui/open-link and sends chat messages as a content array', async () => {
    const mounted = mountInMcpHost(bridgePage());
    initialize(mounted);
    await flush();

    void mounted.host().openLink('https://letterirl.com/dashboard/letter-packs');
    void mounted.host().sendMessage('Preview it');
    expect(mounted.lastRequest('ui/open-link')!.params).toEqual({ url: 'https://letterirl.com/dashboard/letter-packs' });
    expect(mounted.lastRequest('ui/message')!.params).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'Preview it' }]
    });
  });

  it('answers ping and ui/resource-teardown, and refuses a request it does not serve', async () => {
    const mounted = mountInMcpHost(bridgePage());
    initialize(mounted);
    await flush();

    mounted.deliver({ id: 'p1', method: 'ping' });
    mounted.deliver({ id: 't1', method: 'ui/resource-teardown', params: {} });
    mounted.deliver({ id: 'x1', method: 'ui/something-new', params: {} });
    mounted.deliver({ method: 'ui/notifications/tool-cancelled', params: {} });

    expect(mounted.sent).toContainEqual({ jsonrpc: '2.0', id: 'p1', result: {} });
    expect(mounted.sent).toContainEqual({ jsonrpc: '2.0', id: 't1', result: {} });
    expect(mounted.sent).toContainEqual({ jsonrpc: '2.0', id: 'x1', error: { code: -32601, message: 'Method not found' } });
    // A notification gets no answer.
    expect(mounted.sent.filter(message => message.id === undefined && message.method === undefined)).toEqual([]);
  });

  it('ignores messages that do not come from its host, or are not JSON-RPC', async () => {
    const mounted = mountInMcpHost(bridgePage());
    initialize(mounted);
    await flush();

    mounted.deliver({ method: 'ui/notifications/tool-result', params: { structuredContent: { evil: true } } }, { postMessage() {} });
    mounted.window.dispatchEvent(
      new mounted.window.MessageEvent('message', { data: { method: 'ui/notifications/tool-result', params: { structuredContent: { evil: true } } }, source: mounted.window.parent })
    );
    expect(mounted.host().toolOutput()).toBeNull();
  });

  it('starts empty, and has no widget state writer and no file store', () => {
    const host = mountInMcpHost(bridgePage()).host();
    expect(host.toolInput()).toBeNull();
    expect(host.toolOutput()).toBeNull();
    expect(host.toolMeta()).toBeNull();
    expect(host.widgetState()).toBeNull();
    // A card checks for these before using them (the preview cards' photo
    // picker and saved-state paths), so they must be absent, not stubs.
    for (const name of ['setWidgetState', 'uploadFile', 'selectFiles', 'getFileDownloadUrl']) {
      expect(host[name], name).toBeUndefined();
    }
    for (const name of ['callTool', 'openLink', 'sendMessage']) {
      expect(typeof host[name], name).toBe('function');
    }
  });

  it('reports its height only after the handshake, and only when it changes', async () => {
    let observed: (() => void) | undefined;
    const sent: Message[] = [];
    const parent = { postMessage: (message: Message) => sent.push(JSON.parse(JSON.stringify(message))) };
    const dom = new JSDOM(bridgePage('<div style="height:120px"></div>'), {
      runScripts: 'dangerously',
      beforeParse(window) {
        Object.defineProperty(window, 'parent', { value: parent, configurable: true });
        (window as any).ResizeObserver = class {
          constructor(callback: () => void) { observed = callback; }
          observe() {}
        };
        // jsdom does no layout, so every element measures 120px tall here.
        (window as any).Element.prototype.getBoundingClientRect = () => ({ height: 120 }) as DOMRect;
      }
    });
    const window = dom.window as any;
    const sizes = () => sent.filter(message => message.method === 'ui/notifications/size-changed');

    observed!();
    expect(sizes()).toEqual([]);

    const init = sent.find(message => message.method === 'ui/initialize')!;
    window.dispatchEvent(new window.MessageEvent('message', {
      data: { jsonrpc: '2.0', id: init.id, result: { hostContext: {} } },
      source: parent
    }));
    await flush();
    expect(sizes()).toEqual([{ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 120 } }]);

    observed!();
    expect(sizes()).toHaveLength(1);
  });

  it('stays quiet when the page is not framed, rather than answering itself', async () => {
    const sent: unknown[] = [];
    const dom = new JSDOM(bridgePage(), { runScripts: 'dangerously' });
    const window = dom.window as any;
    window.addEventListener('message', (event: any) => sent.push(event.data));
    await flush();
    expect(window.letterIrlHost.kind).toBe('mcp-apps');
    expect(sent).toEqual([]);
    await expect(window.letterIrlHost.callTool('get_started', {})).rejects.toThrow('no host');
  });
});

describe('the getting-started card on the bridge', () => {
  const CARD = inlineHostBridge(fs.readFileSync(path.join(WIDGET_DIR, 'GetStartedCard.html'), 'utf-8'), WIDGET_DIR);
  const COPY = {
    title: 'Get Started with Letter IRL',
    overview: 'Letter IRL can draft, preview, and mail real physical letters.',
    purchaseStep: 'Letters are prepaid: buy a letter pack on your Letter IRL dashboard.',
    examplePrompts: ['Draft a letter to my grandmother', 'Check my letter balance']
  };
  const text = (window: any, id: string) => window.document.getElementById(id).textContent;
  const hidden = (window: any, id: string) => window.document.getElementById(id).classList.contains('hidden');

  it('is served with the bridge inlined and no marker left', () => {
    expect(CARD).not.toContain('<!-- letter-irl:host -->');
    expect(CARD).toContain('window.letterIrlHost = {');
  });

  it("renders ChatGPT's copy from the result's _meta", () => {
    const dom = new JSDOM(CARD, {
      runScripts: 'dangerously',
      beforeParse(window) {
        (window as any).openai = { theme: 'light', toolOutput: {}, toolResponseMetadata: COPY };
      }
    });
    const window = dom.window as any;
    expect(hidden(window, 'state-ready')).toBe(false);
    expect(text(window, 'overview')).toBe(COPY.overview);
    expect(text(window, 'purchase-step')).toBe(COPY.purchaseStep);
    expect(window.document.querySelectorAll('#example-prompts li')).toHaveLength(2);
  });

  it('renders in an MCP Apps host from structuredContent, in the host\'s theme', async () => {
    const mounted = mountInMcpHost(CARD);
    expect(hidden(mounted.window, 'state-ready')).toBe(true);
    initialize(mounted, { theme: 'dark' });
    await flush();
    mounted.deliver({ method: 'ui/notifications/tool-result', params: { content: [], structuredContent: COPY } });

    expect(hidden(mounted.window, 'state-loading')).toBe(true);
    expect(hidden(mounted.window, 'state-ready')).toBe(false);
    expect(text(mounted.window, 'title')).toBe(COPY.title);
    expect(text(mounted.window, 'purchase-step')).toBe(COPY.purchaseStep);
    expect(mounted.window.document.documentElement.classList.contains('dark')).toBe(true);
  });
});
