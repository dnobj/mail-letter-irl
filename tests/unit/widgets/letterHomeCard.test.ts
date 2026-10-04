import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

const html = readFileSync(new URL('../../../widgets/LetterHomeCard.html', import.meta.url), 'utf8');
function open(output: unknown = { drafts: [], orders: [], recipients: [], limit: 20 }) {
  const host = { theme: () => 'light', toolOutput: () => output, onChange: vi.fn(), callTool: vi.fn() };
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
    expect(doc.querySelector('a')).toBeNull();
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
    expect(doc.querySelectorAll('a')).toHaveLength(2);
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
