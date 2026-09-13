/**
 * The letter card draws the address window from the raw `originalAddress`
 * objects in the tool result, which are the customer's own input echoed back
 * (src/tools/letterHelpers.ts). The 2026-09-13 audit found `formatAddress`
 * joining those strings into `innerHTML` unescaped, while the body and the
 * sign-off a few lines away were escaped. A recipient name carrying markup,
 * pasted from a document the customer asked ChatGPT to mail to, would have
 * run inside the card with the customer's bridge: `send_letter` on the
 * visible draft, checkouts, follow-up messages.
 *
 * This mounts the real card in jsdom (the purchaseStatus harness pattern)
 * and feeds it a hostile address on every field the window shows.
 */

import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';

const WIDGET_DIR = path.resolve(__dirname, '../../../widgets');

const HOSTILE = '<img src=x onerror="window.__pwned = 1">';

function hostileAddress(label: string) {
  return {
    name: `${label} ${HOSTILE}`,
    addressLine1: `1 Main St ${HOSTILE}`,
    addressLine2: `Unit <b>2</b>`,
    city: `Springfield ${HOSTILE}`,
    state: 'CA<script>window.__pwned = 1</script>',
    postalCode: '90000"><svg onload="window.__pwned = 1">',
    country: 'US'
  };
}

function mount() {
  const html = fs.readFileSync(path.join(WIDGET_DIR, 'LetterPreviewCard.html'), 'utf-8');
  // jsdom does not execute module scripts; the card's script parses as a
  // classic script (see tests/unit/widgets/purchaseStatus.test.ts, limit 1).
  const runnable = html.replace('<script type="module">', '<script>');

  const dom = new JSDOM(runnable, {
    runScripts: 'dangerously',
    beforeParse(window) {
      (window as unknown as Record<string, unknown>).openai = {
        theme: 'light',
        toolOutput: {
          draftId: 'draft_test_0002',
          layoutType: 'text_only',
          lettersRequired: 1,
          canSendNow: true,
          deliveryClass: 'USPS First-Class Mail',
          deliveryEstimate: '1-2 weeks',
          senderAddressValidation: { status: 'verified', originalAddress: hostileAddress('Sender') },
          recipientAddressValidation: { status: 'verified', originalAddress: hostileAddress('Recipient') }
        },
        toolResponseMetadata: {
          previewHtml:
            '<div class="letter-body">Hello</div><div class="sign-off">Bye</div>'
        },
        callTool: async () => ({})
      };
    }
  });
  dom.window.dispatchEvent(new dom.window.Event('openai:set_globals'));
  return dom;
}

describe('LetterPreviewCard address window', () => {
  it('renders every address field as text, never as markup', () => {
    const dom = mount();
    const container = dom.window.document.getElementById('mockup-container');
    expect(container).not.toBeNull();

    // The window is drawn: both names are visible as text.
    expect(container!.textContent).toContain('Recipient <img src=x');
    expect(container!.textContent).toContain('Sender <img src=x');
    expect(container!.textContent).toContain('CA<script>');

    // And nothing in it became an element.
    expect(container!.querySelector('img, svg, script, b')).toBeNull();
    expect((dom.window as unknown as Record<string, unknown>).__pwned).toBeUndefined();

    // The line breaks the card adds between lines survive the escaping.
    expect(container!.querySelectorAll('.address-window br, .recipient-address br, .sender-address br').length)
      .toBeGreaterThan(0);
  });

  it('keeps the escape on the sign-off and body as well', () => {
    const dom = mount();
    const container = dom.window.document.getElementById('mockup-container');
    expect(container!.querySelector('.body-text')?.textContent).toContain('Hello');
    expect(container!.querySelector('.sign-off')?.textContent).toContain('Bye');
  });
});
