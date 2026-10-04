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
