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

describe('model context bridge', () => {
  it('gates updates on host advertisement, sends the standard request, and merges deep-link context changes', async () => {
    const mounted = mountInMcpHost(bridgePage());
    expect(mounted.host().updateModelContext).toBeUndefined();
    mounted.deliver({ id: mounted.lastRequest('ui/initialize')!.id, result: { hostCapabilities: { updateModelContext: { text: {} } }, hostContext: { theme: 'dark', 'openai/deepLink': { url: '/draft/d1' } } } });
    await flush();
    const update = mounted.host().updateModelContext({ content: [{ type: 'text', text: 'draft d1' }] });
    const request = mounted.lastRequest('ui/update-model-context')!;
    expect(request.params).toEqual({ content: [{ type: 'text', text: 'draft d1' }] });
    mounted.deliver({ id: request.id, result: {} });
    await expect(update).resolves.toEqual({});
    mounted.deliver({ method: 'ui/notifications/host-context-changed', params: { 'openai/deepLink': { url: '/order/o1' } } });
    expect(mounted.host().hostContext()).toMatchObject({ theme: 'dark', 'openai/deepLink': { url: '/order/o1' } });
    mounted.deliver({ method: 'ui/notifications/host-context-changed', params: { 'openai/deepLink': null } });
    expect(mounted.host().hostContext()['openai/deepLink']).toBeNull();
    mounted.window.close();
  });
  it('leaves context unsupported when no text capability is advertised', async () => {
    const mounted = mountInMcpHost(bridgePage()); initialize(mounted); await flush();
    expect(mounted.host().updateModelContext).toBeUndefined(); mounted.window.close();
  });
});

describe('display modes (#662)', () => {
  const modesPage = `<!doctype html><html data-display-modes="inline fullscreen bogus"><body><script>${BRIDGE}</script></body></html>`;
  function inChatGpt(page: string, openai: Record<string, unknown>) {
    const dom = new JSDOM(page, { runScripts: 'dangerously', beforeParse(window) { (window as any).openai = openai; } });
    return dom.window as any;
  }

  it('in ChatGPT, reads displayMode afresh and asks with { mode } only for a mode the card lists', async () => {
    const asked: unknown[] = [];
    const openai: Record<string, unknown> = { displayMode: 'inline', requestDisplayMode: async (arg: unknown) => { asked.push(arg); return { mode: 'fullscreen' }; } };
    const window = inChatGpt(modesPage, openai);
    const host = window.letterIrlHost;
    expect(host.displayMode()).toBe('inline');
    openai.displayMode = 'fullscreen';
    expect(host.displayMode()).toBe('fullscreen');
    await expect(host.requestDisplayMode('fullscreen')).resolves.toEqual({ mode: 'fullscreen' });
    expect(asked).toEqual([{ mode: 'fullscreen' }]);
    await expect(host.requestDisplayMode('pip')).rejects.toThrow();
    expect(asked).toHaveLength(1);
    window.close();
  });

  it('in ChatGPT, offers no mode change to a card that lists none, or where ChatGPT has none', () => {
    const plain = inChatGpt(bridgePage(), { requestDisplayMode: async () => ({ mode: 'fullscreen' }) });
    expect(plain.letterIrlHost.requestDisplayMode).toBeUndefined();
    plain.close();
    const none = inChatGpt(modesPage, {});
    expect(none.letterIrlHost.requestDisplayMode).toBeUndefined();
    none.close();
  });

  it('in an MCP Apps host, declares the listed modes and asks with ui/request-display-mode only for one the host offers', async () => {
    const mounted = mountInMcpHost(modesPage);
    expect(mounted.lastRequest('ui/initialize')!.params.appCapabilities).toEqual({ availableDisplayModes: ['inline', 'fullscreen'] });
    expect(mounted.host().requestDisplayMode).toBeUndefined();
    initialize(mounted, { displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] });
    await flush();
    expect(mounted.host().displayMode()).toBe('inline');
    const asked = mounted.host().requestDisplayMode('fullscreen');
    const request = mounted.lastRequest('ui/request-display-mode')!;
    expect(request.params).toEqual({ mode: 'fullscreen' });
    mounted.deliver({ id: request.id, result: { mode: 'fullscreen' } });
    await expect(asked).resolves.toEqual({ mode: 'fullscreen' });
    mounted.deliver({ method: 'ui/notifications/host-context-changed', params: { displayMode: 'fullscreen' } });
    expect(mounted.host().displayMode()).toBe('fullscreen');
    await expect(mounted.host().requestDisplayMode('pip')).rejects.toThrow();
    expect(mounted.sent.filter(message => message.method === 'ui/request-display-mode')).toHaveLength(1);
    mounted.window.close();
  });

  it('in an MCP Apps host, offers nothing where the host has only inline, and declares nothing for a card that lists none', async () => {
    const inlineOnly = mountInMcpHost(modesPage);
    initialize(inlineOnly, { availableDisplayModes: ['inline'] });
    await flush();
    expect(inlineOnly.host().requestDisplayMode).toBeUndefined();
    inlineOnly.window.close();
    const plain = mountInMcpHost(bridgePage());
    expect(plain.lastRequest('ui/initialize')!.params.appCapabilities).toEqual({});
    initialize(plain, { availableDisplayModes: ['inline', 'fullscreen'] });
    await flush();
    expect(plain.host().requestDisplayMode).toBeUndefined();
    plain.window.close();
  });
});

describe('Plugin Extensions in ChatGPT (#665)', () => {
  const extensionsPage = `<!doctype html><html data-display-modes="inline fullscreen" data-plugin-extensions><body><script>${BRIDGE}</script></body></html>`;
  function mountInChatGptFrame(page: string, openai: Record<string, unknown> = {}) {
    const sent: Message[] = [];
    const parent = { postMessage: (message: Message) => sent.push(JSON.parse(JSON.stringify(message))) };
    const dom = new JSDOM(page, {
      runScripts: 'dangerously',
      beforeParse(window) {
        (window as any).openai = { toolOutput: { from: 'openai' }, hostContext: { locale: 'en' }, ...openai };
        Object.defineProperty(window, 'parent', { value: parent, configurable: true });
      }
    });
    const window = dom.window as any;
    const deliver = (message: Message, source: unknown = parent) =>
      window.dispatchEvent(new window.MessageEvent('message', { data: { jsonrpc: '2.0', ...message }, source }));
    const lastRequest = (method: string) => [...sent].reverse().find(message => message.method === method);
    return { window, sent, deliver, lastRequest, host: () => window.letterIrlHost };
  }

  it('opens the MCP Apps handshake beside window.openai for a card that asks, and shares model context once the host offers it', async () => {
    const mounted = mountInChatGptFrame(extensionsPage, { hostContext: { locale: 'en', 'openai/deepLink': { url: '/stale' } } });
    const host = mounted.host();
    expect(host.kind).toBe('chatgpt');
    const init = mounted.lastRequest('ui/initialize')!;
    // Ids of its own: a reply meant for window.openai's runtime (a plain number) is not taken.
    expect(String(init.id)).toMatch(/^lirl-ext-/);
    mounted.deliver({ id: 1, result: { hostCapabilities: { experimental: { 'openai/modelContext': {} } } } });
    await flush();
    expect(host.updateModelContext).toBeUndefined();
    expect(init.params.appCapabilities).toEqual({ availableDisplayModes: ['inline', 'fullscreen'] });
    expect(host.updateModelContext).toBeUndefined();
    let told = 0;
    host.onChange(() => { told += 1; });
    mounted.deliver({ id: init.id, result: { hostCapabilities: { experimental: { 'openai/modelContext': {} } }, hostContext: { 'openai/deepLink': { url: '/order/o-1' } } } });
    await flush();
    expect(told).toBe(1);
    expect(mounted.sent.some(message => message.method === 'ui/notifications/initialized')).toBe(true);
    // The deep link over window.openai's own host context; the result stays window.openai's.
    expect(host.hostContext()).toEqual({ locale: 'en', 'openai/deepLink': { url: '/order/o-1' } });
    expect(host.toolOutput()).toEqual({ from: 'openai' });
    const shared = host.updateModelContext({ content: [{ type: 'text', text: 'order o-1' }] });
    const request = mounted.lastRequest('ui/update-model-context')!;
    expect(request.params).toEqual({ content: [{ type: 'text', text: 'order o-1' }] });
    mounted.deliver({ id: request.id, result: { _meta: { 'openai/modelContext': { updateId: 'u-1' } } } });
    await expect(shared).resolves.toEqual({ _meta: { 'openai/modelContext': { updateId: 'u-1' } } });
    // A new route arrives as a host context change.
    mounted.deliver({ method: 'ui/notifications/host-context-changed', params: { 'openai/deepLink': { url: '/draft/d-2' } } });
    expect(host.hostContext()['openai/deepLink']).toEqual({ url: '/draft/d-2' });
    expect(told).toBe(2);
    // A refused share rejects, so the card can say it was not shared.
    const refused = host.updateModelContext({ content: [] });
    mounted.deliver({ id: mounted.lastRequest('ui/update-model-context')!.id, error: { code: -32000, message: 'no' } });
    await expect(refused).rejects.toThrow('no');
    mounted.window.close();
  });

  it('keeps a context change that arrives before the handshake reply over the reply', async () => {
    const mounted = mountInChatGptFrame(extensionsPage);
    mounted.deliver({ method: 'ui/notifications/host-context-changed', params: { 'openai/deepLink': { url: '/order/new' } } });
    mounted.deliver({ id: mounted.lastRequest('ui/initialize')!.id, result: { hostCapabilities: {}, hostContext: { 'openai/deepLink': { url: '/order/old' }, theme: 'dark' } } });
    await flush();
    expect(mounted.host().hostContext()).toMatchObject({ 'openai/deepLink': { url: '/order/new' }, theme: 'dark' });
    mounted.window.close();
  });

  it('takes the updateModelContext capability as the MCP Apps spec states it, and offers nothing when the host offers neither', async () => {
    const text = mountInChatGptFrame(extensionsPage);
    text.deliver({ id: text.lastRequest('ui/initialize')!.id, result: { hostCapabilities: { updateModelContext: { text: {} } } } });
    await flush();
    expect(typeof text.host().updateModelContext).toBe('function');
    text.window.close();
    const neither = mountInChatGptFrame(extensionsPage);
    neither.deliver({ id: neither.lastRequest('ui/initialize')!.id, result: { hostCapabilities: { updateModelContext: {} } } });
    await flush();
    expect(neither.host().updateModelContext).toBeUndefined();
    neither.window.close();
  });

  it("uses ChatGPT's own updateModelContext when window.openai has one, sending nothing over postMessage", async () => {
    const calls: unknown[] = [];
    const mounted = mountInChatGptFrame(extensionsPage, { updateModelContext: async (value: unknown) => { calls.push(value); return { ok: true }; } });
    await expect(mounted.host().updateModelContext({ content: [] })).resolves.toEqual({ ok: true });
    expect(calls).toEqual([{ content: [] }]);
    expect(mounted.sent.filter(message => message.method === 'ui/update-model-context')).toHaveLength(0);
    mounted.window.close();
  });

  it('changes nothing when the host never answers, or the card does not ask', async () => {
    const silent = mountInChatGptFrame(extensionsPage);
    await flush();
    expect(silent.host().updateModelContext).toBeUndefined();
    expect(silent.host().hostContext()).toEqual({ locale: 'en' });
    silent.window.close();
    const plain = mountInChatGptFrame(bridgePage());
    await flush();
    expect(plain.sent).toHaveLength(0);
    expect(plain.host().updateModelContext).toBeUndefined();
    expect(plain.host().hostContext()).toEqual({ locale: 'en' });
    plain.window.close();
  });

  it("answers ping and teardown, takes nothing else from the host, and ignores messages from anyone else", async () => {
    const mounted = mountInChatGptFrame(extensionsPage);
    const init = mounted.lastRequest('ui/initialize')!;
    // A reply from a stranger is not the host's.
    mounted.deliver({ id: init.id, result: { hostCapabilities: { experimental: { 'openai/modelContext': {} } } } }, {});
    await flush();
    expect(mounted.host().updateModelContext).toBeUndefined();
    let told = 0;
    mounted.host().onChange(() => { told += 1; });
    mounted.deliver({ method: 'ui/notifications/tool-input', params: { arguments: { from: 'mcp' } } });
    mounted.deliver({ method: 'ui/notifications/tool-result', params: { structuredContent: { from: 'mcp' } } });
    expect(told).toBe(0);
    // Before the host has taken us as an MCP App, ping and teardown are window.openai's runtime's to answer.
    mounted.deliver({ id: 75, method: 'ping' });
    expect(mounted.sent.some(message => message.id === 75)).toBe(false);
    mounted.deliver({ id: mounted.lastRequest('ui/initialize')!.id, result: { hostCapabilities: {} } });
    await flush();
    // A request it does not serve goes unanswered.
    mounted.deliver({ id: 76, method: 'ui/unknown' });
    expect(mounted.sent.some(message => message.id === 76)).toBe(false);
    mounted.deliver({ method: 'ui/notifications/host-context-changed', params: { 'openai/deepLink': { url: '/x' } } }, {});
    expect(mounted.host().hostContext()).toEqual({ locale: 'en' });
    mounted.deliver({ id: 77, method: 'ping' });
    mounted.deliver({ id: 78, method: 'ui/resource-teardown' });
    expect(mounted.sent.filter(message => message.id === 77 || message.id === 78).map(message => message.result)).toEqual([{}, {}]);
    mounted.window.close();
    // A refused handshake leaves window.openai alone, as before.
    const refused = mountInChatGptFrame(extensionsPage);
    refused.deliver({ id: refused.lastRequest('ui/initialize')!.id, error: { code: -32601, message: 'no' } });
    await flush();
    expect(refused.host().updateModelContext).toBeUndefined();
    expect(refused.sent.some(message => message.method === 'ui/notifications/initialized')).toBe(false);
    refused.window.close();
  });
});

describe('the home card in ChatGPT on the bridge (#665)', () => {
  const HOME = inlineHostBridge(fs.readFileSync(path.join(WIDGET_DIR, 'LetterHomeCard.html'), 'utf-8'), WIDGET_DIR);
  const output = {
    drafts: [], recipients: [], limit: 20, websiteOrigin: 'https://dev.example.test',
    orders: [{ orderId: 'o-1', recipient: { name: 'Ruth', city: 'Chicago', state: 'IL' }, mailType: 'letter', status: 'delivered', createdAt: '2026-10-01T00:00:00Z', isGiftSend: false }]
  };

  it('selects the order a deep link names and shares the selection, both through the handshake', async () => {
    const sent: Message[] = [];
    const parent = { postMessage: (message: Message) => sent.push(JSON.parse(JSON.stringify(message))) };
    const dom = new JSDOM(HOME, {
      runScripts: 'dangerously',
      beforeParse(window) {
        (window as any).openai = { toolOutput: output, theme: 'dark', callTool: async () => ({}) };
        Object.defineProperty(window, 'parent', { value: parent, configurable: true });
      }
    });
    const window = dom.window as any;
    const doc = window.document as Document;
    const deliver = (message: Message) => window.dispatchEvent(new window.MessageEvent('message', { data: { jsonrpc: '2.0', ...message }, source: parent }));
    expect(doc.getElementById('selection')?.hidden).toBe(true);
    const init = sent.find(message => message.method === 'ui/initialize')!;
    deliver({ id: init.id, result: { hostCapabilities: { experimental: { 'openai/modelContext': {} } }, hostContext: { 'openai/deepLink': { url: '/order/o-1' } } } });
    await flush();
    expect(doc.getElementById('selection')?.hidden).toBe(false);
    expect(doc.getElementById('selected-detail')?.textContent).toContain('o-1');
    // Selecting by hand shares it with the model through ui/update-model-context.
    (Array.from(doc.querySelectorAll('button')).find(node => node.textContent === 'Select order') as HTMLButtonElement).click();
    await flush();
    // Shares go one at a time: the deep link's first, then the press's.
    const shares = () => sent.filter(message => message.method === 'ui/update-model-context');
    expect(shares()).toHaveLength(1);
    deliver({ id: shares()[0].id, result: {} });
    await flush();
    expect(shares()).toHaveLength(2);
    const share = shares()[1];
    expect(JSON.parse(share.params.content[0].text)).toMatchObject({ kind: 'order', id: 'o-1', statusLabel: 'Delivery estimated' });
    deliver({ id: share.id, result: {} });
    await flush();
    expect(doc.getElementById('notice')?.textContent).toBe('Selection shared with the conversation.');
    window.close();
  });
});
