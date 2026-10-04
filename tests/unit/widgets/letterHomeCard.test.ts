import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

const html = readFileSync(new URL('../../../widgets/LetterHomeCard.html', import.meta.url), 'utf8');
function open(output: unknown = { drafts: [], orders: [], recipients: [], limit: 20 }, extras = {}) {
  const host = { theme: () => 'light', toolOutput: () => output, onChange: vi.fn(), callTool: vi.fn(), ...extras };
  const dom = new JSDOM(html, { runScripts: 'dangerously', beforeParse(window) { (window as any).letterIrlHost = host; } });
  return { dom, host, doc: dom.window.document };
}
const order = (status: string, extra = {}) => ({ recipient: { name: 'Ruth', city: 'Chicago', state: 'IL' }, mailType: 'letter', status, orderId: 'order-1', ...extra });

describe('LetterHomeCard', () => {
  it('uses the initial result without another call and handles empty state', () => {
    const { dom, host, doc } = open();
    expect(host.callTool).not.toHaveBeenCalled();
    expect(doc.getElementById('home')?.hidden).toBe(false);
    expect(doc.getElementById('drafts')?.textContent).toContain('No active drafts');
    expect(doc.getElementById('orders')?.textContent).toContain('No recent mail');
    dom.window.close();
  });

  it('renders recipient strings literally and rejects executable and non-USPS tracking links', () => {
    const { dom, doc } = open({
      drafts: [{ recipient: { name: '<img src=x onerror=alert(1)>', city: '', state: '' }, confirmationUrl: 'javascript:alert(1)', expiresAt: 'tomorrow' }],
      orders: [order('delivered', { carrierTrackingUrl: 'https://evil.example/go/TrackConfirmAction', certifiedNote: '<script>bad</script>' })],
      recipients: [], limit: 20
    });
    expect(doc.getElementById('drafts')?.textContent).toContain('<img');
    expect(doc.querySelector('img')).toBeNull();
    expect(doc.querySelector('a[href]')).toBeNull();
    expect(doc.getElementById('orders')?.textContent).toContain('Delivery estimated');
    dom.window.close();
  });

  it('shows scheduled dates, a gift, a review link, and the existing certified note', () => {
    const { dom, doc } = open({
      drafts: [{ recipient: { name: 'Ruth', city: '', state: '' }, confirmationUrl: 'https://dev.example.test/confirm/draft-1', expiresAt: '2026-10-05', isGiftSend: true }],
      orders: [order('scheduled', { arriveBy: '2026-10-20', mailOn: '2026-10-09', carrierTrackingUrl: 'https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223856928499', certifiedNote: 'Goes as USPS Certified Mail.' })],
      recipients: [], limit: 20
    });
    expect(doc.body.textContent).toContain('Aims to arrive by Oct 20, 2026');
    expect(doc.body.textContent).toContain('Gift letter');
    expect(doc.querySelectorAll('a[href]')).toHaveLength(2);
    expect(doc.body.textContent).toContain('Goes as USPS Certified Mail.');
    expect(doc.querySelector('a')?.rel).toBe('noopener noreferrer');
    dom.window.close();
  });

  it('refreshes with {}, prevents duplicate calls, and retains a stale warning on failure', async () => {
    const { dom, host, doc } = open();
    let reject!: (error: Error) => void;
    host.callTool.mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
    const button = doc.getElementById('refresh') as HTMLButtonElement;
    button.click(); button.click();
    expect(host.callTool).toHaveBeenCalledExactlyOnceWith('open_letter_home', {});
    expect(button.disabled).toBe(true);
    reject(new Error('secret failure'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(doc.getElementById('notice')?.textContent).toContain('may be out of date');
    expect(doc.getElementById('notice')?.textContent).not.toContain('secret');
    expect(button.disabled).toBe(false);
    dom.window.close();
  });

  it('handles a refused refresh, then recovers on a successful one', async () => {
    const { dom, host, doc } = open(null);
    const button = doc.getElementById('refresh') as HTMLButtonElement;
    host.callTool.mockResolvedValueOnce({ isError: true }).mockResolvedValueOnce({ structuredContent: { drafts: [], orders: [order('cancelled')], recipients: [], limit: 20 } });
    button.click(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(doc.getElementById('notice')?.textContent).toContain('Unable to load');
    button.click(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(doc.getElementById('orders')?.textContent).toContain('Cancelled; not mailed');
    dom.window.close();
  });
});

describe('home extension interactions', () => {
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const click = (doc: Document, label: string) => (Array.from(doc.querySelectorAll('button')).find(node => node.textContent === label) as HTMLButtonElement).click();
  const data = (extra = {}) => ({ drafts: [{ draftId: 'draft-1', recipient: { name: 'Ruth', city: 'Chicago', state: 'IL' }, expiresAt: '2026-10-20' }], orders: [order('scheduled', { cancellable: true, isGiftSend: true, arriveBy: '2026-10-20' })], recipients: [], limit: 20, ...extra });

  it('shares only selected summaries, serializes changes, and replaces context on clear', async () => {
    const update = vi.fn().mockResolvedValue({});
    const { dom, doc } = open(data(), { updateModelContext: update });
    click(doc, 'Select draft'); click(doc, 'Select order'); click(doc, 'Clear selection');
    await tick();
    expect(update).toHaveBeenCalledTimes(3);
    expect(JSON.parse(update.mock.calls[0][0].content[0].text)).toMatchObject({ kind: 'draft', id: 'draft-1', editable: true });
    expect(JSON.parse(update.mock.calls[1][0].content[0].text)).toMatchObject({ kind: 'order', id: 'order-1', status: 'scheduled', editable: false });
    expect(update.mock.calls[2][0]).toEqual({ content: [] });
    expect(JSON.stringify(update.mock.calls)).not.toMatch(/addressLine|bodyText|confirmationUrl/);
    dom.window.close();
  });

  it('reports unsupported and refused context without claiming success', async () => {
    for (const extra of [{}, { updateModelContext: vi.fn().mockResolvedValue({ isError: true }) }]) {
      const { dom, doc } = open(data(), extra);
      click(doc, 'Select draft'); await tick();
      expect(doc.getElementById('notice')?.textContent).toMatch(/cannot share|could not be shared/);
      expect(doc.getElementById('selection')?.hidden).toBe(false);
      dom.window.close();
    }
  });

  it('honors owner-visible deep links and produces a properly encoded share URL', async () => {
    const { dom, doc } = open(data({ appUrl: 'https://chatgpt.com/plugins/letter-irl-dev/app/open_letter_home' }), { hostContext: () => ({ 'openai/deepLink': { url: '/draft/draft-1' } }) });
    await tick();
    expect(doc.getElementById('selected-detail')?.textContent).toContain('draft-1');
    const link = doc.getElementById('selection-link') as HTMLAnchorElement;
    expect(link.hidden).toBe(false);
    expect(new URL(link.href).searchParams.get('path')).toBe('/draft/draft-1');
    expect(link.href).toContain('path=%2Fdraft%2Fdraft-1');
    dom.window.close();
  });

  it.each(['/draft/another-account', '//evil.example', '/draft/draft-1#fragment', '/draft/draft-1?query=1', '/draft/%2e%2e'])('refuses unavailable or malformed route %s without fetching it', async route => {
    const { dom, host, doc } = open(data(), { hostContext: () => ({ 'openai/deepLink': { url: route } }) });
    await tick();
    expect(doc.getElementById('selection')?.hidden).toBe(true);
    expect(doc.getElementById('notice')?.textContent).toContain('unavailable');
    expect(host.callTool).not.toHaveBeenCalled();
    dom.window.close();
  });

  it('asks before cancelling, blocks double presses, and displays the actual returned balance message', async () => {
    const { dom, doc, host } = open(data());
    let resolve!: (value: unknown) => void;
    host.callTool.mockReturnValue(new Promise(done => { resolve = done; }));
    click(doc, 'Cancel scheduled mail');
    expect(host.callTool).not.toHaveBeenCalled();
    click(doc, 'Keep scheduled');
    expect(doc.querySelector('.cancel-confirm')).toBeNull();
    click(doc, 'Cancel scheduled mail'); click(doc, 'Confirm cancellation'); click(doc, 'Confirm cancellation');
    expect(host.callTool).toHaveBeenCalledExactlyOnceWith('cancel_scheduled_mail', { orderId: 'order-1', confirm: true });
    resolve({ structuredContent: { orderId: 'order-1', status: 'cancelled', message: 'Cancelled. Nothing returned because it expired.' } });
    await tick();
    expect(doc.getElementById('orders')?.textContent).toContain('Cancelled; not mailed');
    expect(doc.getElementById('notice')?.textContent).toContain('Nothing returned because it expired');
    expect(doc.querySelector('.cancel-confirm')).toBeNull();
    dom.window.close();
  });

  it('preserves scheduled state on an ambiguous/refused cancellation, and offers no cancel for ineligible mail', async () => {
    const { dom, doc, host } = open(data());
    host.callTool.mockResolvedValue({ isError: true });
    click(doc, 'Cancel scheduled mail'); click(doc, 'Confirm cancellation'); await tick();
    expect(doc.getElementById('orders')?.textContent).toContain('Scheduled');
    expect(doc.getElementById('notice')?.textContent).toContain('not confirmed');
    dom.window.close();
    for (const item of [order('printing', { cancellable: true }), order('scheduled', { cancellable: false })]) {
      const mounted = open(data({ orders: [item] }));
      expect(mounted.doc.getElementById('orders')?.textContent).not.toContain('Cancel scheduled mail');
      mounted.dom.window.close();
    }
  });
});

describe('home extension recovery regressions', () => {
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const click = (doc: Document, label: string) => (Array.from(doc.querySelectorAll('button')).find(node => node.textContent === label) as HTMLButtonElement).click();
  const data = { drafts: [], orders: [order('scheduled', { cancellable: true })], recipients: [], limit: 20 };
  it('keeps the actual cancellation balance outcome when the selected order is republished', async () => {
    const updateModelContext = vi.fn().mockResolvedValue({});
    const { dom, host, doc } = open(structuredClone(data), { updateModelContext });
    click(doc, 'Select order'); await tick();
    host.callTool.mockResolvedValue({ structuredContent: { orderId: 'order-1', status: 'cancelled', message: 'Cancelled. Funding expired; nothing returned.' } });
    click(doc, 'Cancel scheduled mail'); click(doc, 'Confirm cancellation'); await tick(); await tick();
    expect(doc.getElementById('notice')?.textContent).toBe('Cancelled. Funding expired; nothing returned.');
    expect(JSON.parse(updateModelContext.mock.calls.at(-1)![0].content[0].text)).toMatchObject({ status: 'cancelled', id: 'order-1' });
    dom.window.close();
  });
  it('retries an unavailable deep link when Refresh brings its owner-visible order into the list', async () => {
    const { dom, host, doc } = open({ drafts: [], orders: [], recipients: [], limit: 20 }, { hostContext: () => ({ 'openai/deepLink': { url: '/order/order-1' } }) });
    expect(doc.getElementById('selection')?.hidden).toBe(true);
    host.callTool.mockResolvedValue({ structuredContent: data });
    click(doc, 'Refresh'); await tick();
    expect(doc.getElementById('selection')?.hidden).toBe(false);
    expect(doc.getElementById('selected-detail')?.textContent).toContain('order-1');
    dom.window.close();
  });
  it('rejects an error result even when it contains cancellation-shaped structured content', async () => {
    const { dom, host, doc } = open(structuredClone(data));
    host.callTool.mockResolvedValue({ isError: true, structuredContent: { orderId: 'order-1', status: 'cancelled', message: 'Wrong success' } });
    click(doc, 'Cancel scheduled mail'); click(doc, 'Confirm cancellation'); await tick();
    expect(doc.getElementById('orders')?.textContent).not.toContain('Cancelled; not mailed');
    expect(doc.getElementById('notice')?.textContent).toContain('not confirmed');
    dom.window.close();
  });
  it('waits for an earlier context acknowledgment before sending the newer selection', async () => {
    let resolve!: (value: unknown) => void;
    const updateModelContext = vi.fn().mockReturnValueOnce(new Promise(done => { resolve = done; })).mockResolvedValue({});
    const { dom, doc } = open(structuredClone(data), { updateModelContext });
    click(doc, 'Select order'); click(doc, 'Clear selection'); await tick();
    expect(updateModelContext).toHaveBeenCalledTimes(1);
    resolve({}); await tick();
    expect(updateModelContext).toHaveBeenCalledTimes(2);
    expect(updateModelContext.mock.calls[1][0]).toEqual({ content: [] });
    dom.window.close();
  });
});

it('recovers from a lost cancellation reply, ignores late success and requires Refresh before another cancellation', async () => {
  const output = { drafts: [], orders: [order('scheduled', { cancellable: true }), order('scheduled', { cancellable: true, orderId: 'order-2' })], recipients: [], limit: 20 };
  const { dom, host, doc } = open(output);
  const expire: (() => void)[] = [];
  dom.window.setTimeout = ((callback: () => void, ms: number) => { expect(ms).toBe(15000); expire.push(callback); return expire.length; }) as any;
  dom.window.clearTimeout = vi.fn();
  const click = (label: string) => (Array.from(doc.querySelectorAll('button')).find(button => button.textContent === label) as HTMLButtonElement).click();
  let lateReply!: (value: unknown) => void;
  host.callTool.mockReturnValueOnce(new Promise(resolve => { lateReply = resolve; }));
  Array.from(doc.querySelectorAll('#orders button')).filter(button => button.textContent === 'Cancel scheduled mail').forEach(button => (button as HTMLButtonElement).click());
  click('Confirm cancellation');
  expect((doc.getElementById('refresh') as HTMLButtonElement).disabled).toBe(true);
  expect(expire).toHaveLength(1);
  expire[0](); await new Promise(resolve => setTimeout(resolve, 0));
  expect(doc.getElementById('notice')?.textContent).toContain('not confirmed');
  expect((doc.getElementById('refresh') as HTMLButtonElement).disabled).toBe(false);
  click('Confirm cancellation');
  (Array.from(doc.querySelectorAll('#orders button')).filter(button => button.textContent === 'Confirm cancellation')[1] as HTMLButtonElement).click();
  expect(host.callTool).toHaveBeenCalledTimes(1);
  lateReply({ structuredContent: { orderId: 'order-1', status: 'cancelled', message: 'Late refund success' } });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(doc.getElementById('notice')?.textContent).not.toContain('Late refund');
  expect(doc.getElementById('orders')?.textContent).not.toContain('Cancelled; not mailed');
  host.callTool.mockResolvedValueOnce({ structuredContent: { drafts: [], orders: [order('cancelled')], recipients: [], limit: 20 } });
  click('Refresh'); await new Promise(resolve => setTimeout(resolve, 0));
  expect(doc.getElementById('orders')?.textContent).toContain('Cancelled; not mailed');
  expect(doc.getElementById('orders')?.textContent).not.toContain('Cancel scheduled mail');
  dom.window.close();
});

it('does not undo an explicit clear or newer selection when the original successful deep link is unchanged', async () => {
  const updateModelContext = vi.fn().mockResolvedValue({});
  const output = { drafts: [], orders: [order('scheduled'), order('accepted', { orderId: 'order-2' })], recipients: [], limit: 20 };
  const { dom, host, doc } = open(output, { updateModelContext, hostContext: () => ({ 'openai/deepLink': { url: '/order/order-1' } }) });
  (doc.getElementById('clear-selection') as HTMLButtonElement).click();
  host.callTool.mockResolvedValue({ structuredContent: structuredClone(output) });
  (doc.getElementById('refresh') as HTMLButtonElement).click(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(doc.getElementById('selection')?.hidden).toBe(true);
  expect(updateModelContext.mock.calls.at(-1)![0]).toEqual({ content: [] });
  (Array.from(doc.querySelectorAll('#orders button')).filter(button => button.textContent === 'Select order')[1] as HTMLButtonElement).click();
  (doc.getElementById('refresh') as HTMLButtonElement).click(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(doc.getElementById('selected-detail')?.textContent).toContain('order-2');
  expect(JSON.parse(updateModelContext.mock.calls.at(-1)![0].content[0].text)).toMatchObject({ id: 'order-2' });
  dom.window.close();
});

it('lets explicit selection supersede an initially unresolved route even when Refresh later resolves it', async () => {
  const updateModelContext = vi.fn().mockResolvedValue({});
  const first = { drafts: [], orders: [order('accepted', { orderId: 'order-2' })], recipients: [], limit: 20 };
  const { dom, host, doc } = open(first, { updateModelContext, hostContext: () => ({ 'openai/deepLink': { url: '/order/order-1' } }) });
  expect(doc.getElementById('selection')?.hidden).toBe(true);
  (doc.querySelector('#orders button') as HTMLButtonElement).click();
  host.callTool.mockResolvedValue({ structuredContent: { ...first, orders: [order('scheduled'), ...first.orders] } });
  (doc.getElementById('refresh') as HTMLButtonElement).click(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(doc.getElementById('selected-detail')?.textContent).toContain('order-2');
  expect(JSON.parse(updateModelContext.mock.calls.at(-1)![0].content[0].text)).toMatchObject({ id: 'order-2' });
  dom.window.close();
});

it('handles a changed host route and root navigation without changing mail', async () => {
  let route = '/order/order-1';
  const updateModelContext = vi.fn().mockResolvedValue({});
  const { dom, host, doc } = open({ drafts: [], orders: [order('accepted'), order('failed', { orderId: 'order-2' })], recipients: [], limit: 20 }, { updateModelContext, hostContext: () => ({ 'openai/deepLink': { url: route } }) });
  route = '/order/order-2'; host.onChange.mock.calls[0][0]();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(doc.getElementById('selected-detail')?.textContent).toContain('order-2');
  route = '/'; host.onChange.mock.calls[0][0]();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(doc.getElementById('selection')?.hidden).toBe(true);
  expect(updateModelContext.mock.calls.at(-1)![0]).toEqual({ content: [] });
  expect(host.callTool).not.toHaveBeenCalled();
  dom.window.close();
});

it.each(['unsupported', 'refused'])('reports %s context sharing for initial and newly resolved deep links', async failure => {
  const extra = failure === 'refused' ? { updateModelContext: vi.fn().mockResolvedValue({ isError: true }) } : {};
  for (const initiallyAvailable of [true, false]) {
    const filled = { drafts: [], orders: [order('accepted')], recipients: [], limit: 20 };
    const { dom, host, doc } = open(initiallyAvailable ? filled : { ...filled, orders: [] }, { ...extra, hostContext: () => ({ 'openai/deepLink': { url: '/order/order-1' } }) });
    if (!initiallyAvailable) {
      host.callTool.mockResolvedValue({ structuredContent: filled });
      (doc.getElementById('refresh') as HTMLButtonElement).click();
    }
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(doc.getElementById('selection')?.hidden).toBe(false);
    expect(doc.getElementById('notice')?.textContent).toMatch(/cannot share|could not be shared/);
    dom.window.close();
  }
});

it.each(['https://evil.example/plugins/dev/app/open_letter_home', 'https://user:pass@chatgpt.com/plugins/dev/app/open_letter_home', 'https://chatgpt.com/plugins/dev/app/other', 'javascript:alert(1)'])('does not offer an unsafe share base %s', async appUrl => {
  const { dom, doc } = open({ drafts: [], orders: [order('accepted')], recipients: [], limit: 20, appUrl });
  (doc.querySelector('#orders button') as HTMLButtonElement).click(); await new Promise(resolve => setTimeout(resolve, 0));
  const link = doc.getElementById('selection-link') as HTMLAnchorElement;
  expect(link.hidden).toBe(true); expect(link.getAttribute('href')).toBeNull();
  dom.window.close();
});
