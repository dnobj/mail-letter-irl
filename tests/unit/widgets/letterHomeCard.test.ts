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
      recipients: [], limit: 20, websiteOrigin: 'https://dev.example.test'
    });
    expect(doc.body.textContent).toContain('Aims to arrive by Oct 20, 2026');
    expect(doc.body.textContent).toContain('Gift letter');
    expect(doc.querySelectorAll('a[href]')).toHaveLength(2);
    expect(doc.body.textContent).toContain('Goes as USPS Certified Mail.');
    expect(doc.querySelector('a')?.rel).toBe('noopener noreferrer');
    dom.window.close();
  });

  it('opens a confirmation link only on the website the server names, and a USPS link only with the label the API builds (#651)', () => {
    const draft = (confirmationUrl: string) => ({ recipient: { name: 'Ruth', city: '', state: '' }, confirmationUrl, expiresAt: '2026-10-05', draftId: 'draft-1' });
    const usps = (carrierTrackingUrl: string) => order('in_transit', { carrierTrackingUrl, orderId: carrierTrackingUrl });
    const { dom, doc } = open({
      drafts: [
        draft('https://dev.example.test/confirm/draft-1'),
        draft('https://Dev.Example.TEST:443/confirm/draft-2'),
        draft('https://evil.example/confirm/draft-1'),
        draft('https://dev.example.test' + String.fromCharCode(92) + '@evil.example/confirm/draft-1'),
        draft('https://dev.example.test@evil.example/confirm/draft-1'),
        draft('https://dev.example.test:8443/confirm/draft-1'),
        draft('http://dev.example.test/confirm/draft-1'),
        draft('https://dev.example.test/confirm/draft-1?next=https://evil.example'),
        draft('https://dev.example.test/confirm/draft-1#x'),
        draft('https://dev.example.test/other/draft-1')
      ],
      orders: [
        usps('https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223856928499'),
        usps('https://tools.usps.com/go/TrackConfirmAction?tLabels=EJ123456789US'),
        usps('https://Tools.USPS.com:443/go/TrackConfirmAction?tLabels=9400111899223856928400'),
        usps('https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223856928499&redirect=https://evil.example'),
        usps('https://tools.usps.com/go/TrackConfirmAction?tLabels=9400%2611189922'),
        usps('https://tools.usps.com/go/TrackConfirmAction?tLabels=1234567'),
        usps('https://tools.usps.com/go/TrackConfirmAction?tLabels=' + '9'.repeat(41)),
        usps('https://tools.usps.com/go/TrackConfirmAction?tLabels=9400-1118'),
        usps('https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223856928499#x'),
        usps('https://tools.usps.com/go/TrackConfirmAction'),
        usps('https://tools.usps.com/go/Other?tLabels=9400111899223856928499'),
        usps('https://tools.usps.com:8443/go/TrackConfirmAction?tLabels=9400111899223856928499')
      ],
      recipients: [], limit: 20, websiteOrigin: 'https://dev.example.test'
    });
    const hrefs = [...doc.querySelectorAll('a[href]')].map(a => a.getAttribute('href'));
    expect(hrefs).toEqual([
      'https://dev.example.test/confirm/draft-1',
      'https://dev.example.test/confirm/draft-2',
      'https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223856928499',
      'https://tools.usps.com/go/TrackConfirmAction?tLabels=EJ123456789US',
      'https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223856928400'
    ]);
    dom.window.close();
  });

  it('opens no confirmation link when the server names no website (an older server)', () => {
    const { dom, doc } = open({
      drafts: [{ recipient: { name: 'Ruth', city: '', state: '' }, confirmationUrl: 'https://dev.example.test/confirm/draft-1', expiresAt: '2026-10-05', draftId: 'draft-1' }],
      orders: [], recipients: [], limit: 20
    });
    expect(doc.querySelector('a[href]')).toBeNull();
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
    // A refresh that worked says so, in the live status line (HOME-01).
    expect(doc.getElementById('notice')?.textContent).toBe('Mail list refreshed.');
    dom.window.close();
  });

  it('says the refresh last, when the host also redraws the card with the new result', async () => {
    const fresh = { drafts: [], orders: [order('in_transit')], recipients: [], limit: 20 };
    let current: unknown = { drafts: [], orders: [], recipients: [], limit: 20 };
    const callTool = vi.fn(async () => { current = fresh; return { structuredContent: fresh }; });
    const { dom, doc } = open(undefined, { toolOutput: () => current, callTool });
    (doc.getElementById('refresh') as HTMLButtonElement).click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(doc.getElementById('orders')?.textContent).toContain('In the mail');
    expect(doc.getElementById('notice')?.textContent).toBe('Mail list refreshed.');
    dom.window.close();
  });

  it('never says it refreshed when the refresh failed, even when the host redraws the card (HOME-01 review round 2)', async () => {
    const fresh = { drafts: [], orders: [order('in_transit')], recipients: [], limit: 20 };
    let current: unknown = { drafts: [], orders: [], recipients: [], limit: 20 };
    const callTool = vi.fn(async () => { current = fresh; return { isError: true }; });
    const { dom, doc } = open(undefined, { toolOutput: () => current, callTool });
    (doc.getElementById('refresh') as HTMLButtonElement).click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(doc.getElementById('orders')?.textContent).toContain('In the mail');
    expect(doc.getElementById('notice')?.textContent).not.toBe('Mail list refreshed.');
    dom.window.close();
  });

  it('says nothing of a refresh when the card first draws', () => {
    const { dom, doc } = open();
    expect(doc.getElementById('notice')?.textContent).toBe('');
    dom.window.close();
  });
});

describe('home extension interactions', () => {
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const click = (doc: Document, label: string) => (Array.from(doc.querySelectorAll('button')).find(node => node.textContent === label) as HTMLButtonElement).click();
  const data = (extra = {}) => ({ drafts: [{ draftId: 'draft-1', recipient: { name: 'Ruth', city: 'Chicago', state: 'IL' }, expiresAt: '2026-10-20' }], orders: [order('scheduled', { cancellable: true, isGiftSend: true, arriveBy: '2026-10-20' })], recipients: [], limit: 20, ...extra });

  it('shares only selected summaries, serializes changes, and replaces context on clear', async () => {
    const update = vi.fn().mockResolvedValue({});
    // A draft carrying a status a label exists for, so only the draft rule keeps statusLabel out of its selection.
    const { dom, doc } = open(data({ drafts: [{ ...data().drafts[0], status: 'delivered' }] }), { updateModelContext: update });
    click(doc, 'Select draft'); click(doc, 'Select order'); click(doc, 'Clear selection');
    await tick();
    expect(update).toHaveBeenCalledTimes(3);
    // A sentence a person can read, since ChatGPT shows the shared context to them (#668).
    expect(update.mock.calls[0][0].content[0].text).toBe('Selected in the Letter IRL home: draft draft-1, a letter to Ruth (Chicago, IL). It can be revised; check get_draft_status first.');
    expect(update.mock.calls[1][0].content[0].text).toBe('Selected in the Letter IRL home: order order-1, a letter to Ruth (Chicago, IL), status: Scheduled; it aims to arrive by 2026-10-20. It is mail already ordered, not a draft to edit.');
    expect(update.mock.calls[0][0].content[0].text).not.toContain('status:');
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
    expect(updateModelContext.mock.calls.at(-1)![0].content[0].text).toContain('order order-1, a letter to Ruth (Chicago, IL), status: Cancelled; not mailed');
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
  it("shares a delivered order's status in the card's words, as estimated (HOME-01 review)", async () => {
    const update = vi.fn().mockResolvedValue({});
    const { dom, doc } = open({ drafts: [], orders: [order('delivered')], recipients: [], limit: 20 }, { updateModelContext: update });
    click(doc, 'Select order'); await tick();
    expect(update.mock.calls[0][0].content[0].text).toContain('status: Delivery estimated');
    dom.window.close();
  });
  it('keeps a deep link still unavailable after a Refresh that works, rather than saying it refreshed (HOME-01)', async () => {
    const { dom, host, doc } = open({ drafts: [], orders: [], recipients: [], limit: 20 }, { hostContext: () => ({ 'openai/deepLink': { url: '/order/order-9' } }) });
    expect(doc.getElementById('notice')?.textContent).toBe('That selection is unavailable in your current mail list. Refresh to check again.');
    host.callTool.mockResolvedValue({ structuredContent: data });
    click(doc, 'Refresh'); await tick();
    expect(host.callTool).toHaveBeenCalledExactlyOnceWith('open_letter_home', {});
    expect(doc.getElementById('orders')?.textContent).toContain('order-1');
    expect(doc.getElementById('notice')?.textContent).toBe('That selection is unavailable in your current mail list. Refresh to check again.');
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
  it('gives up on a share the host never answers after the usual wait, so later selections still go (#665)', async () => {
    vi.useFakeTimers();
    try {
      const updateModelContext = vi.fn().mockReturnValueOnce(new Promise(() => {})).mockResolvedValue({});
      const { dom, doc } = open(structuredClone(data), { updateModelContext });
      click(doc, 'Select order');
      await vi.advanceTimersByTimeAsync(14999);
      click(doc, 'Clear selection');
      await vi.advanceTimersByTimeAsync(0);
      expect(updateModelContext).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      // The unanswered share gave up; the clear went on to the host.
      expect(updateModelContext).toHaveBeenCalledTimes(2);
      expect(updateModelContext.mock.calls[1][0]).toEqual({ content: [] });
      dom.window.close();
    } finally {
      vi.useRealTimers();
    }
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
  expect(updateModelContext.mock.calls.at(-1)![0].content[0].text).toContain('order order-2,');
  dom.window.close();
});

it('lets explicit selection supersede an initially unresolved route even when Refresh later resolves it', async () => {
  const updateModelContext = vi.fn().mockResolvedValue({});
  const first = { drafts: [], orders: [order('accepted', { orderId: 'order-2' })], recipients: [], limit: 20 };
  const { dom, host, doc } = open(first, { updateModelContext, hostContext: () => ({ 'openai/deepLink': { url: '/order/order-1' } }) });
  expect(doc.getElementById('selection')?.hidden).toBe(true);
  (Array.from(doc.querySelectorAll('#orders button')).find(node => node.textContent === 'Select order') as HTMLButtonElement).click();
  host.callTool.mockResolvedValue({ structuredContent: { ...first, orders: [order('scheduled'), ...first.orders] } });
  (doc.getElementById('refresh') as HTMLButtonElement).click(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(doc.getElementById('selected-detail')?.textContent).toContain('order-2');
  expect(updateModelContext.mock.calls.at(-1)![0].content[0].text).toContain('order order-2,');
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

describe('the compact home (#662)', () => {
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const draft = (n: number) => ({ draftId: `draft-${n}`, recipient: { name: `Draft person ${n}`, city: 'Chicago', state: 'IL' }, mailType: 'letter', expiresAt: '2026-10-20T00:00:00Z' });
  const delivered = Array.from({ length: 16 }, (_, n) => order('delivered', { orderId: `done-${n}` }));
  const big = () => ({
    drafts: [1, 2, 3, 4, 5].map(draft),
    orders: [
      order('scheduled', { orderId: 'sched-1', cancellable: true, arriveBy: '2026-10-30', mailOn: '2026-10-21' }),
      order('failed', { orderId: 'fail-1' }), order('in_transit', { orderId: 'move-1' }),
      order('accepted', { orderId: 'move-2' }), order('printing', { orderId: 'move-3' }),
      ...delivered, order('cancelled', { orderId: 'gone-1' })
    ],
    recipients: [{ name: 'Ruth', city: 'Chicago', state: 'IL' }], limit: 20
  });
  const shown = (doc: Document, selector: string) => Array.from(doc.querySelectorAll(selector)).filter(node => !(node as HTMLElement).hidden && !(node as HTMLElement).closest('[hidden]'));
  const button = (doc: Document, label: string) => Array.from(doc.querySelectorAll('button')).find(node => node.textContent === label) as HTMLButtonElement | undefined;
  const group = (doc: Document) => doc.querySelector('#orders > button.group') as HTMLButtonElement;

  it('inline, shows a few rows of what needs the person, folds settled mail away, and keeps recipients for the whole view', () => {
    const { dom, doc } = open(big());
    expect(shown(doc, '#drafts > article')).toHaveLength(3);
    expect(button(doc, 'Show 2 more')).toBeDefined();
    // Problems first, then scheduled, then the rest, newest first within each.
    expect(shown(doc, '#orders > article').map(node => node.getAttribute('data-key'))).toEqual(['order/fail-1', 'order/sched-1', 'order/move-1', 'order/move-2']);
    expect(button(doc, 'Show 1 more')).toBeDefined();
    expect(group(doc).textContent).toBe('Delivery estimated (16) · Cancelled (1)');
    expect(group(doc).getAttribute('aria-expanded')).toBe('false');
    expect(group(doc).getAttribute('aria-controls')).toBe('settled-orders');
    expect(group(doc).getAttribute('aria-label')).toBe('Delivery estimated (16) · Cancelled (1), settled mail');
    expect((doc.getElementById('settled-orders') as HTMLElement).hidden).toBe(true);
    expect(doc.querySelectorAll('#settled-orders > article')).toHaveLength(17);
    expect((doc.getElementById('people') as HTMLElement).hidden).toBe(true);
    const seeAll = doc.getElementById('see-all') as HTMLButtonElement;
    expect(seeAll.hidden).toBe(false);
    expect(seeAll.textContent).toBe('See all');
    expect(seeAll.getAttribute('aria-expanded')).toBe('false');
    dom.window.close();
  });

  it('draws each item as one line whose details and actions open under it', () => {
    const { dom, doc } = open(big());
    const article = doc.querySelector('[data-key="order/sched-1"]') as HTMLElement;
    const main = article.querySelector('.row-main') as HTMLButtonElement;
    const details = article.querySelector('.row-details') as HTMLElement;
    expect(Array.from(main.children).map(node => node.textContent)).toEqual(['Letter', 'Ruth', 'Chicago, IL', 'Scheduled, arrives by Oct 30']);
    expect(main.getAttribute('aria-controls')).toBe(details.id);
    expect(details.hidden).toBe(true);
    expect(main.getAttribute('aria-expanded')).toBe('false');
    main.click();
    expect(details.hidden).toBe(false);
    expect(main.getAttribute('aria-expanded')).toBe('true');
    expect(Array.from(details.querySelectorAll('button')).map(node => node.textContent)).toEqual(['Select order', 'Cancel scheduled mail']);
    main.click();
    expect(details.hidden).toBe(true);
    const draftRow = doc.querySelector('[data-key="draft/draft-1"] .row-main') as HTMLElement;
    expect(Array.from(draftRow.children).map(node => node.textContent)).toEqual(['Letter draft', 'Draft person 1', 'Chicago, IL', expect.stringMatching(/^Expires /)]);
    dom.window.close();
  });

  it('opens more rows and the settled mail in place, and keeps them and an open row open across a refresh', async () => {
    const { dom, doc, host } = open(big());
    button(doc, 'Show 2 more')!.click();
    expect(shown(doc, '#drafts > article')).toHaveLength(5);
    expect(button(doc, 'Show 2 more')).toBeUndefined();
    group(doc).click();
    expect((doc.getElementById('settled-orders') as HTMLElement).hidden).toBe(false);
    expect(group(doc).getAttribute('aria-expanded')).toBe('true');
    (doc.querySelector('[data-key="order/done-3"] .row-main') as HTMLButtonElement).click();
    host.callTool.mockResolvedValue({ structuredContent: big() });
    (doc.getElementById('refresh') as HTMLButtonElement).click();
    await tick();
    expect(shown(doc, '#drafts > article')).toHaveLength(5);
    expect((doc.getElementById('settled-orders') as HTMLElement).hidden).toBe(false);
    expect((doc.querySelector('[data-key="order/done-3"] .row-details') as HTMLElement).hidden).toBe(false);
    group(doc).click();
    expect((doc.getElementById('settled-orders') as HTMLElement).hidden).toBe(true);
    expect(group(doc).getAttribute('aria-expanded')).toBe('false');
    dom.window.close();
  });

  it('See all asks the host for fullscreen and draws everything, and the home is compact again when the host returns inline', async () => {
    let mode = 'inline';
    const requestDisplayMode = vi.fn(async () => ({ mode: 'fullscreen' }));
    const { dom, doc, host } = open(big(), { requestDisplayMode, displayMode: () => mode });
    (doc.getElementById('see-all') as HTMLButtonElement).click();
    await tick();
    expect(requestDisplayMode).toHaveBeenCalledExactlyOnceWith('fullscreen');
    expect(shown(doc, '#drafts > article')).toHaveLength(5);
    expect(shown(doc, '#orders article')).toHaveLength(22);
    expect((doc.getElementById('people') as HTMLElement).hidden).toBe(false);
    expect(button(doc, 'Show 2 more')).toBeUndefined();
    mode = 'fullscreen';
    host.onChange.mock.calls[0][0]();
    expect((doc.getElementById('see-all') as HTMLButtonElement).hidden).toBe(true);
    expect(shown(doc, '#orders article')).toHaveLength(22);
    mode = 'inline';
    host.onChange.mock.calls[0][0]();
    expect((doc.getElementById('see-all') as HTMLButtonElement).hidden).toBe(false);
    expect((doc.getElementById('see-all') as HTMLButtonElement).textContent).toBe('See all');
    expect(shown(doc, '#drafts > article')).toHaveLength(3);
    expect((doc.getElementById('people') as HTMLElement).hidden).toBe(true);
    dom.window.close();
  });

  it('See all opens everything in place where the host has no fullscreen, refuses it or gives another mode, and Show less folds it back', async () => {
    const hosts = [{}, { requestDisplayMode: vi.fn(async () => { throw new Error('no'); }) }, { requestDisplayMode: vi.fn(async () => ({ mode: 'inline' })) }];
    for (const extras of hosts) {
      const { dom, doc } = open(big(), extras);
      const seeAll = doc.getElementById('see-all') as HTMLButtonElement;
      seeAll.click();
      await tick();
      expect(shown(doc, '#orders article')).toHaveLength(22);
      expect((doc.getElementById('people') as HTMLElement).hidden).toBe(false);
      expect(seeAll.textContent).toBe('Show less');
      expect(seeAll.getAttribute('aria-expanded')).toBe('true');
      seeAll.click();
      await tick();
      expect(shown(doc, '#drafts > article')).toHaveLength(3);
      expect(seeAll.textContent).toBe('See all');
      expect(seeAll.getAttribute('aria-expanded')).toBe('false');
      dom.window.close();
    }
  });

  it('puts what needs the person first: the draft expiring soonest, and older problems before newer mail on the way', () => {
    const data = big();
    data.drafts = [
      { ...draft(1), expiresAt: '2026-10-20T00:00:00Z' }, { ...draft(2), expiresAt: '2026-10-19T00:00:00Z' },
      { ...draft(3), expiresAt: '2026-10-21T00:00:00Z' }, { ...draft(4), expiresAt: '2026-10-09T00:00:00Z' }
    ];
    data.orders = [
      order('in_transit', { orderId: 'new-1' }), order('accepted', { orderId: 'new-2' }), order('printing', { orderId: 'new-3' }),
      order('pending', { orderId: 'held-1' }), order('in_transit', { orderId: 'new-4' }), order('scheduled', { orderId: 'sched-9' }),
      order('returned', { orderId: 'back-1' }), order('delivered', { orderId: 'done-9' })
    ];
    const { dom, doc } = open(data);
    expect(shown(doc, '#drafts > article').map(node => node.getAttribute('data-key'))).toEqual(['draft/draft-4', 'draft/draft-2', 'draft/draft-1']);
    expect(shown(doc, '#orders > article').map(node => node.getAttribute('data-key'))).toEqual(['order/back-1', 'order/sched-9', 'order/held-1', 'order/new-1']);
    dom.window.close();
  });

  it('says nothing is on the way when all mail is settled, and nothing when there is no mail', () => {
    const settledOnly = { drafts: [], orders: [order('delivered', { orderId: 'done-1' })], recipients: [], limit: 20 };
    const first = open(settledOnly);
    expect(first.doc.getElementById('orders')?.firstElementChild?.textContent).toBe('Nothing on the way.');
    first.dom.window.close();
    const none = open({ drafts: [], orders: [], recipients: [], limit: 20 });
    expect(none.doc.getElementById('orders')?.textContent).toBe('No recent mail to show.');
    none.dom.window.close();
  });

  it('keeps an order cancelled here in view, open and focused, rather than folding it away', async () => {
    const callTool = vi.fn(async () => ({ structuredContent: { orderId: 'sched-1', status: 'cancelled', message: 'Cancelled. The gift letter is back.' } }));
    const { dom, doc } = open(big(), { callTool });
    (doc.querySelector('[data-key="order/sched-1"] .row-main') as HTMLButtonElement).click();
    button(doc, 'Cancel scheduled mail')!.click();
    const confirm = button(doc, 'Confirm cancellation')!;
    doc.hasFocus = () => true;
    confirm.focus();
    confirm.click();
    // As a browser does when the focused Confirm button is disabled: focus drops to the page.
    confirm.disabled = false; confirm.blur(); confirm.disabled = true;
    await tick(); await tick();
    expect(callTool).toHaveBeenCalledExactlyOnceWith('cancel_scheduled_mail', { orderId: 'sched-1', confirm: true });
    const article = doc.querySelector('[data-key="order/sched-1"]') as HTMLElement;
    expect(shown(doc, '[data-key="order/sched-1"]')).toHaveLength(1);
    expect(article.closest('#settled-orders')).toBeNull();
    expect(article.querySelector('.row-main .state')?.textContent).toBe('Cancelled; not mailed');
    expect((article.querySelector('.row-details') as HTMLElement).hidden).toBe(false);
    expect(doc.activeElement === article.querySelector('.row-main')).toBe(true);
    expect(doc.getElementById('notice')?.textContent).toBe('Cancelled. The gift letter is back.');

    // A Refresh that fails keeps it in view.
    callTool.mockResolvedValue({ structuredContent: { wrong: true } } as any);
    (doc.getElementById('refresh') as HTMLButtonElement).click();
    await tick();
    expect(doc.getElementById('notice')?.textContent).toContain('may be out of date');
    // Drawn again (See all, then Show less): the card still keeps it.
    const seeAll = doc.getElementById('see-all') as HTMLButtonElement;
    seeAll.click(); await tick(); seeAll.click(); await tick();
    expect(seeAll.textContent).toBe('See all');
    expect(shown(doc, '[data-key="order/sched-1"]').length).toBe(1);
    // A Refresh brings the server's word: from then on it folds with settled mail.
    const after = big(); after.orders[0] = { ...after.orders[0], status: 'cancelled', cancellable: false };
    callTool.mockResolvedValue({ structuredContent: after } as any);
    (doc.getElementById('refresh') as HTMLButtonElement).click();
    await tick();
    expect(callTool).toHaveBeenLastCalledWith('open_letter_home', {});
    expect(doc.getElementById('notice')?.textContent).toBe('Mail list refreshed.');
    expect(Boolean(doc.querySelector('#settled-orders [data-key="order/sched-1"]'))).toBe(true);
    expect(shown(doc, '[data-key="order/sched-1"]').length).toBe(0);
    dom.window.close();
  });

  it('gives Refresh its focus back after it runs, as a keyboard press leaves it', async () => {
    const { dom, doc, host } = open(big());
    doc.hasFocus = () => true;
    const refreshButton = doc.getElementById('refresh') as HTMLButtonElement;
    refreshButton.focus();
    host.callTool.mockImplementation(async () => {
      // As a browser does when the focused Refresh is disabled: focus drops to the page.
      refreshButton.disabled = false; refreshButton.blur(); refreshButton.disabled = true;
      return { structuredContent: big() };
    });
    refreshButton.click();
    await tick();
    expect(doc.getElementById('notice')?.textContent).toBe('Mail list refreshed.');
    expect(doc.activeElement === refreshButton).toBe(true);
    dom.window.close();
  });

  it('leaves focus where the person put it during a Refresh: on the host page, or on a row in the card', async () => {
    // The person goes to the host's page while Refresh runs.
    const away = open(big());
    let focused = true;
    away.doc.hasFocus = () => focused;
    const awayRefresh = away.doc.getElementById('refresh') as HTMLButtonElement;
    awayRefresh.focus();
    away.host.callTool.mockImplementation(async () => {
      awayRefresh.disabled = false; awayRefresh.blur(); awayRefresh.disabled = true;
      focused = false;
      return { structuredContent: big() };
    });
    awayRefresh.click();
    await tick();
    expect(away.doc.getElementById('notice')?.textContent).toBe('Mail list refreshed.');
    expect(away.doc.activeElement === awayRefresh).toBe(false);
    away.dom.window.close();

    // The card's page never had focus when Refresh was pressed: nothing is taken.
    const unfocused = open(big());
    unfocused.doc.hasFocus = () => false;
    const unfocusedRefresh = unfocused.doc.getElementById('refresh') as HTMLButtonElement;
    unfocusedRefresh.focus();
    unfocused.host.callTool.mockImplementation(async () => {
      unfocusedRefresh.disabled = false; unfocusedRefresh.blur(); unfocusedRefresh.disabled = true;
      unfocused.doc.hasFocus = () => true;
      return { structuredContent: big() };
    });
    unfocusedRefresh.click();
    await tick();
    expect(unfocused.doc.activeElement === unfocusedRefresh).toBe(false);
    unfocused.dom.window.close();

    // The person tabs to a row while Refresh runs: focus stays on that row.
    const tabbed = open(big());
    tabbed.doc.hasFocus = () => true;
    const tabbedRefresh = tabbed.doc.getElementById('refresh') as HTMLButtonElement;
    tabbedRefresh.focus();
    tabbed.host.callTool.mockImplementation(async () => {
      tabbedRefresh.disabled = false; tabbedRefresh.blur(); tabbedRefresh.disabled = true;
      (tabbed.doc.querySelector('[data-key="order/move-1"] .row-main') as HTMLButtonElement).focus();
      return { structuredContent: big() };
    });
    tabbedRefresh.click();
    await tick();
    expect(tabbed.doc.activeElement === tabbed.doc.querySelector('[data-key="order/move-1"] .row-main')).toBe(true);
    tabbed.dom.window.close();
  });

  it('keeps focus on the same row when a Refresh redraws the home', async () => {
    const { dom, doc, host } = open(big());
    (doc.querySelector('[data-key="order/move-1"] .row-main') as HTMLButtonElement).focus();
    host.callTool.mockResolvedValue({ structuredContent: big() });
    (doc.getElementById('refresh') as HTMLButtonElement).click();
    await tick();
    expect(doc.getElementById('notice')?.textContent).toBe('Mail list refreshed.');
    expect(doc.activeElement === doc.querySelector('[data-key="order/move-1"] .row-main')).toBe(true);
    dom.window.close();
  });

  it('takes no focus after a cancellation when the card does not have it', async () => {
    const callTool = vi.fn(async () => ({ structuredContent: { orderId: 'sched-1', status: 'cancelled', message: 'Cancelled.' } }));
    const { dom, doc } = open(big(), { callTool });
    // The host's page has focus, as a browser reports it.
    doc.hasFocus = () => false;
    (doc.querySelector('[data-key="order/sched-1"] .row-main') as HTMLButtonElement).click();
    button(doc, 'Cancel scheduled mail')!.click();
    button(doc, 'Confirm cancellation')!.click();
    await tick(); await tick();
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(doc.activeElement).toBe(doc.body);
    dom.window.close();
  });

  it('keeps focus on the same row through a redraw, and takes none when the host changes things while the card is not focused', () => {
    let mode = 'fullscreen';
    const { dom, doc, host } = open(big(), { displayMode: () => mode });
    const moving = () => doc.querySelector('[data-key="order/move-1"] .row-main') as HTMLButtonElement;
    const first = moving();
    first.focus();
    mode = 'inline';
    host.onChange.mock.calls[0][0]();
    expect(moving()).not.toBe(first);
    expect(doc.activeElement).toBe(moving());
    // A settled row folds away: focus goes to See all.
    mode = 'fullscreen'; host.onChange.mock.calls[0][0]();
    (doc.querySelector('[data-key="order/done-2"] .row-main') as HTMLButtonElement).focus();
    mode = 'inline'; host.onChange.mock.calls[0][0]();
    expect(doc.activeElement).toBe(doc.getElementById('see-all'));
    // The host's page has focus: a change it makes leaves focus where it is.
    mode = 'fullscreen'; host.onChange.mock.calls[0][0]();
    (doc.querySelector('[data-key="order/done-2"] .row-main') as HTMLButtonElement).focus();
    doc.hasFocus = () => false;
    mode = 'inline'; host.onChange.mock.calls[0][0]();
    expect(doc.activeElement).not.toBe(doc.getElementById('see-all'));
    expect(doc.activeElement).not.toBe(doc.getElementById('refresh'));
    dom.window.close();
  });

  it('gives See all its focus back after the wait, and leaves the home compact when the host went fullscreen and back meanwhile', async () => {
    const held: { seeAll?: HTMLButtonElement; away?: boolean } = {};
    // As a browser does when the focused button is disabled: focus drops to the page, the card's document keeps it.
    // (JSDOM will not blur a disabled button, so the drop is done by hand.)
    const drop = () => { const button = held.seeAll!; button.disabled = false; button.blur(); button.disabled = true; };
    const blurring = vi.fn(async () => { drop(); return { mode: 'inline' }; });
    const first = open(big(), { requestDisplayMode: blurring });
    first.doc.hasFocus = () => !held.away;
    const seeAll = first.doc.getElementById('see-all') as HTMLButtonElement;
    held.seeAll = seeAll;
    seeAll.focus();
    seeAll.click(); await tick();
    expect(first.doc.activeElement === seeAll).toBe(true);
    expect(seeAll.textContent).toBe('Show less');
    // The person goes to the host's page during the wait: focus stays there.
    seeAll.click(); await tick();
    seeAll.focus();
    blurring.mockImplementation(async () => { drop(); held.away = true; return { mode: 'inline' }; });
    seeAll.click(); await tick();
    expect(seeAll.textContent).toBe('Show less');
    expect(first.doc.activeElement === seeAll).toBe(false);
    first.dom.window.close();

    let mode = 'inline';
    let answer!: (value: unknown) => void;
    const waiting = vi.fn(() => new Promise(resolve => { answer = resolve; }));
    const second = open(big(), { requestDisplayMode: waiting, displayMode: () => mode });
    (second.doc.getElementById('see-all') as HTMLButtonElement).click();
    mode = 'fullscreen'; second.host.onChange.mock.calls[0][0]();
    mode = 'inline'; second.host.onChange.mock.calls[0][0]();
    answer({ mode: 'fullscreen' }); await tick();
    expect(shown(second.doc, '#drafts > article')).toHaveLength(3);
    expect((second.doc.getElementById('see-all') as HTMLButtonElement).textContent).toBe('See all');
    second.dom.window.close();
  });

  it('puts drafts with an unreadable date last, ranks an unknown status with the rest, and says nothing is on the way beside a kept settled order', () => {
    const data = big();
    data.drafts = [{ ...draft(1), expiresAt: '2026-10-20T00:00:00Z' }, { ...draft(2), expiresAt: 'soon' }, { ...draft(3), expiresAt: '2026-10-10T00:00:00Z' }];
    data.orders = [order('constructor', { orderId: 'odd-1' }), order('failed', { orderId: 'fail-9' })];
    const first = open(data);
    expect(first.doc.querySelector('[data-key="order/odd-1"] .state')?.textContent).toBe('Status unavailable');
    expect(shown(first.doc, '#drafts > article').map(node => node.getAttribute('data-key'))).toEqual(['draft/draft-3', 'draft/draft-1', 'draft/draft-2']);
    expect(shown(first.doc, '#orders > article').map(node => node.getAttribute('data-key'))).toEqual(['order/fail-9', 'order/odd-1']);
    first.dom.window.close();

    const settledOnly = { drafts: [], orders: [order('delivered', { orderId: 'done-1' }), order('delivered', { orderId: 'done-2' })], recipients: [], limit: 20 };
    const second = open(settledOnly, { hostContext: () => ({ 'openai/deepLink': { url: '/order/done-1' } }) });
    expect(second.doc.getElementById('orders')?.firstElementChild?.textContent).toBe('Nothing on the way.');
    expect(shown(second.doc, '#orders > article').map(node => node.getAttribute('data-key'))).toEqual(['order/done-1']);
    second.dom.window.close();
  });

  it('keeps keyboard focus on the card: Show N more moves it to the first row it showed, Show less to See all', async () => {
    const { dom, doc } = open(big());
    const more = button(doc, 'Show 2 more')!;
    more.focus();
    more.click();
    expect(doc.activeElement).toBe(doc.querySelector('[data-key="draft/draft-4"] .row-main'));
    const seeAll = doc.getElementById('see-all') as HTMLButtonElement;
    seeAll.focus();
    seeAll.click(); await tick();
    expect(doc.activeElement).toBe(seeAll);
    seeAll.click(); await tick();
    expect(doc.activeElement).toBe(seeAll);
    dom.window.close();
  });

  it('moves focus to Refresh when the host goes fullscreen and hides the focused See all', async () => {
    let mode = 'inline';
    const { dom, doc, host } = open(big(), { displayMode: () => mode });
    const seeAll = doc.getElementById('see-all') as HTMLButtonElement;
    seeAll.focus();
    mode = 'fullscreen';
    host.onChange.mock.calls[0][0]();
    expect(seeAll.hidden).toBe(true);
    expect(doc.activeElement).toBe(doc.getElementById('refresh'));
    dom.window.close();
  });

  it('waits for the host at most 5 seconds, disabled meanwhile, then opens everything in place', async () => {
    vi.useFakeTimers();
    try {
      const requestDisplayMode = vi.fn(() => new Promise(() => {}));
      const { dom, doc } = open(big(), { requestDisplayMode });
      const seeAll = doc.getElementById('see-all') as HTMLButtonElement;
      seeAll.click();
      expect(seeAll.disabled).toBe(true);
      seeAll.click();
      expect(requestDisplayMode).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(4999);
      expect(shown(doc, '#drafts > article')).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(seeAll.disabled).toBe(false);
      expect(shown(doc, '#drafts > article')).toHaveLength(5);
      expect(seeAll.textContent).toBe('Show less');
      dom.window.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps clear of the host's chrome in fullscreen and honours its safe-area insets (#668)", () => {
    let mode = 'inline';
    let insets: unknown = { top: 24, right: 0, bottom: 34, left: 'x' };
    const { dom, doc, host } = open(big(), { displayMode: () => mode, safeArea: () => insets });
    const root = doc.documentElement;
    expect(root.classList.contains('fullscreen')).toBe(false);
    expect(root.style.getPropertyValue('--inset-top')).toBe('24px');
    expect(root.style.getPropertyValue('--inset-bottom')).toBe('34px');
    // A value that is not a number is no inset.
    expect(root.style.getPropertyValue('--inset-left')).toBe('0px');
    mode = 'fullscreen';
    insets = null;
    host.onChange.mock.calls[0][0]();
    expect(root.classList.contains('fullscreen')).toBe(true);
    expect(root.style.getPropertyValue('--inset-top')).toBe('0px');
    mode = 'inline';
    host.onChange.mock.calls[0][0]();
    expect(root.classList.contains('fullscreen')).toBe(false);
    dom.window.close();
  });

  it('draws everything, with no See all, in a host that shows it in fullscreen', () => {
    const { dom, doc } = open(big(), { displayMode: () => 'fullscreen' });
    expect((doc.getElementById('see-all') as HTMLButtonElement).hidden).toBe(true);
    expect(shown(doc, '#drafts > article')).toHaveLength(5);
    expect(shown(doc, '#orders article')).toHaveLength(22);
    expect((doc.getElementById('people') as HTMLElement).hidden).toBe(false);
    dom.window.close();
  });

  it('shows the row of a deep link into folded mail or past the first rows, then keeps the rest folded', () => {
    let route = '/order/done-5';
    const { dom, doc, host } = open(big(), { hostContext: () => ({ 'openai/deepLink': { url: route } }) });
    // The selected delivered order joins the list in view; the rest of settled mail stays folded.
    expect((doc.getElementById('settled-orders') as HTMLElement).hidden).toBe(true);
    expect(shown(doc, '[data-key="order/done-5"]')).toHaveLength(1);
    expect(doc.querySelector('#settled-orders [data-key="order/done-5"]')).toBeNull();
    expect(doc.getElementById('selected-detail')?.textContent).toContain('done-5');
    route = '/draft/draft-5';
    host.onChange.mock.calls[0][0]();
    expect(shown(doc, '[data-key="draft/draft-5"]')).toHaveLength(1);
    expect(shown(doc, '#drafts > article').map(node => node.getAttribute('data-key'))).toEqual(['draft/draft-1', 'draft/draft-2', 'draft/draft-3', 'draft/draft-5']);
    expect((doc.getElementById('settled-orders') as HTMLElement).hidden).toBe(true);
    dom.window.close();
  });
});
