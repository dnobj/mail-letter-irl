/**
 * Behaviour tests for PackCheckoutCard (issue #322).
 *
 * Two defects they cover:
 *
 * 1. Empty render. ChatGPT drops the first consequential tool call after
 *    "Allow once", renders this card's template with no tool result, and the
 *    skeleton sits there indefinitely while the model tells the customer to
 *    use "the checkout shown above" (production 2026-09-11, development
 *    2026-09-12; no request reached the API either time). The card waits,
 *    then offers to create the checkout itself through the bridge, the way
 *    the preview cards already buy packs. Proven in development by PAY-03.
 *
 * 2. Stale link. After payment the card still showed "Open secure checkout"
 *    for a session Stripe would refuse, and the model never sees a
 *    widget-initiated result, so nothing else could say the letters had
 *    landed. The card now polls get_purchase_status, in the preview cards'
 *    visibility-gated shape, and replaces the link with the outcome.
 *
 * Same honest limits as purchaseStatus.test.ts: jsdom runs the same source
 * but is not ChatGPT. Timer throttling in a hidden iframe does not reproduce
 * here; these tests guard the logic and the deployed development connector
 * guards the behaviour.
 */

import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';

const WIDGET_PATH = path.resolve(__dirname, '../../../widgets/PackCheckoutCard.html');

interface ScheduledTimer {
  fn: () => void;
  delay: number;
  cancelled: boolean;
}

interface MountOptions {
  toolOutput?: Record<string, unknown> | null;
  toolInput?: Record<string, unknown>;
  withoutCallTool?: boolean;
  packCheckoutFails?: boolean;
  packCheckoutOmitsUrl?: boolean;
  packListEmpty?: boolean;
}

interface Harness {
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  opened: string[];
  pendingTimers: () => ScheduledTimer[];
  runNextTimer: () => Promise<void>;
  deliver: (output: Record<string, unknown> | null) => void;
  setStatus: (status: Record<string, unknown>) => void;
  setHidden: (hidden: boolean) => void;
  fireVisibilityChange: () => void;
  click: (id: string) => Promise<void>;
  clickPackOption: (pack: string) => Promise<void>;
  packOptionLabels: () => string[];
  text: (id: string) => string;
  visible: (id: string) => boolean;
  href: (id: string) => string;
  disabled: (id: string) => boolean;
}

/** Let queued promise callbacks settle. */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

function pendingCheckout(overrides: Record<string, unknown> = {}) {
  return {
    orderId: 'ord_host_0001',
    checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_host',
    letters: 2,
    amountCents: 500,
    currency: 'usd',
    displayAmount: '5.00',
    productDescription: 'Starter Pack - 2 Letters',
    status: 'checkout_pending',
    reused: false,
    message: 'Checkout created, not opened: show the customer the checkoutUrl as a link to click.',
    ...overrides
  };
}

function mount(options: MountOptions = {}): Harness {
  const html = fs.readFileSync(WIDGET_PATH, 'utf-8');
  const timers: ScheduledTimer[] = [];
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const opened: string[] = [];
  let toolOutput: Record<string, unknown> | null =
    options.toolOutput === undefined ? null : options.toolOutput;
  let purchaseStatus: Record<string, unknown> = { purchaseStatus: 'pending_payment' };
  let hidden = false;

  const bridge: Record<string, unknown> = {
    theme: 'light',
    get toolOutput() {
      return toolOutput;
    },
    toolResponseMetadata: null,
    toolInput: options.toolInput ?? {},
    openExternal: async ({ href }: { href: string }) => {
      opened.push(href);
    }
  };
  if (!options.withoutCallTool) {
    bridge.callTool = async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === 'list_letter_packs') {
        return {
          structuredContent: options.packListEmpty
            ? { packs: [], message: 'Letter packs are temporarily unavailable.' }
            : {
                packs: [
                  { pack: 'starter', letters: 2, amountCents: 500, currency: 'usd', displayAmount: '5.00' },
                  { pack: 'regular', letters: 5, amountCents: 1000, currency: 'usd', displayAmount: '10.00' },
                  { pack: 'power', letters: 50, amountCents: 9000, currency: 'usd', displayAmount: '90.00' }
                ],
                message: '3 letter packs are available to buy.'
              }
        };
      }
      if (name === 'create_pack_checkout') {
        if (options.packCheckoutFails) throw new Error('Purchasing is disabled on this account. Please contact support.');
        const letters = args.pack === 'regular' ? 5 : args.pack === 'power' ? 50 : 2;
        return {
          structuredContent: options.packCheckoutOmitsUrl
            ? {
                orderId: 'ord_retry_0001',
                letters,
                amountCents: 500,
                currency: 'usd',
                displayAmount: '5.00',
                productDescription: 'Starter Pack - 2 Letters',
                status: 'fulfilled',
                reused: true,
                message: 'This purchase is already paid or being fulfilled. Check its purchase status instead of opening another checkout.'
              }
            : pendingCheckout({
                orderId: 'ord_retry_0001',
                checkoutUrl: `https://checkout.stripe.com/c/pay/cs_retry_${String(args.pack)}`,
                letters,
                productDescription: `${String(args.pack)} pack`
              })
        };
      }
      if (name === 'get_purchase_status') {
        return { structuredContent: { orderId: args.orderId, ...purchaseStatus } };
      }
      return { structuredContent: {} };
    };
  }

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    beforeParse(window) {
      Object.defineProperty(window.document, 'hidden', { get: () => hidden });
      // Timers are captured rather than run, so the wait is observable and
      // nothing depends on wall-clock time.
      (window as unknown as Record<string, unknown>).setTimeout = (fn: () => void, delay: number) => {
        timers.push({ fn, delay, cancelled: false });
        return timers.length;
      };
      (window as unknown as Record<string, unknown>).clearTimeout = (id: number) => {
        const timer = timers[id - 1];
        if (timer) timer.cancelled = true;
      };
      (window as unknown as Record<string, unknown>).openai = bridge;
    }
  });

  const document = dom.window.document;
  const element = (id: string): HTMLElement => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`no element #${id}`);
    return el;
  };
  const isVisible = (el: HTMLElement): boolean => {
    for (let node: HTMLElement | null = el; node; node = node.parentElement) {
      if (node.classList.contains('hidden')) return false;
    }
    return true;
  };

  return {
    calls,
    opened,
    pendingTimers: () => timers.filter(timer => !timer.cancelled),
    runNextTimer: async () => {
      const timer = timers.find(candidate => !candidate.cancelled);
      if (!timer) throw new Error('no pending timer');
      timer.cancelled = true;
      timer.fn();
      await flush();
    },
    deliver: output => {
      toolOutput = output;
      dom.window.dispatchEvent(new dom.window.Event('openai:set_globals'));
    },
    setStatus: status => {
      purchaseStatus = status;
    },
    setHidden: value => {
      hidden = value;
    },
    fireVisibilityChange: () => {
      document.dispatchEvent(new dom.window.Event('visibilitychange'));
    },
    click: async id => {
      element(id).dispatchEvent(new dom.window.Event('click'));
      await flush();
    },
    clickPackOption: async pack => {
      const el = document.querySelector(`#pack-options button[data-pack="${pack}"]`);
      if (!el) throw new Error(`no pack option for ${pack}`);
      el.dispatchEvent(new dom.window.Event('click'));
      await flush();
    },
    packOptionLabels: () =>
      Array.from(document.querySelectorAll('#pack-options button')).map(el => el.textContent?.trim() ?? ''),
    text: id => element(id).textContent?.trim() ?? '',
    visible: id => isVisible(element(id)),
    href: id => element(id).getAttribute('href') ?? '',
    disabled: id => (element(id) as HTMLButtonElement).disabled
  };
}

const statusCalls = (card: Harness) => card.calls.filter(call => call.name === 'get_purchase_status');

describe('PackCheckoutCard with a tool result', () => {
  it('renders the checkout straight away and never arms the empty-state wait', () => {
    const card = mount({ toolOutput: pendingCheckout() });

    expect(card.visible('state-ready')).toBe(true);
    expect(card.visible('state-loading')).toBe(false);
    expect(card.visible('state-empty')).toBe(false);
    expect(card.href('checkout-link')).toBe('https://checkout.stripe.com/c/pay/cs_host');
    expect(card.text('order-line')).toBe('Order ord_host_0001');
    // The only timer is the status poll; no 5 s empty-state wait exists.
    expect(card.pendingTimers().map(timer => timer.delay)).toEqual([3000]);
  });

  it('swaps the skeleton for the checkout when the result arrives in time, so the retry never appears', () => {
    // The normal path: toolOutput is null at load and openai:set_globals
    // delivers it a moment later. The customer must see exactly what the
    // card showed before this change.
    const card = mount();

    expect(card.visible('state-loading')).toBe(true);
    expect(card.pendingTimers().map(timer => timer.delay)).toEqual([5000]);

    card.deliver(pendingCheckout());

    expect(card.visible('state-ready')).toBe(true);
    expect(card.visible('state-empty')).toBe(false);
    expect(card.href('checkout-link')).toBe('https://checkout.stripe.com/c/pay/cs_host');
    expect(card.pendingTimers().map(timer => timer.delay)).toEqual([3000]);
  });
});

describe('PackCheckoutCard rendered without a tool result', () => {
  it('keeps the skeleton until the wait elapses, then says nothing was created', async () => {
    const card = mount({ toolInput: { pack: 'starter' } });

    expect(card.visible('state-empty')).toBe(false);
    await card.runNextTimer();

    expect(card.visible('state-loading')).toBe(false);
    expect(card.visible('state-empty')).toBe(true);
    expect(card.text('empty-message')).toMatch(/no checkout was created yet/i);
    expect(card.text('empty-message')).toMatch(/nothing has been charged/i);
    expect(card.visible('retry-button')).toBe(true);
    expect(card.text('retry-button')).toBe('Create my checkout');
    expect(card.calls).toEqual([]);
  });

  it('creates the requested pack itself and draws the link from the result', async () => {
    const card = mount({ toolInput: { pack: 'starter' } });
    await card.runNextTimer();

    await card.click('retry-button');

    expect(card.calls).toEqual([{ name: 'create_pack_checkout', args: { pack: 'starter' } }]);
    expect(card.visible('state-ready')).toBe(true);
    expect(card.visible('state-empty')).toBe(false);
    expect(card.visible('state-loading')).toBe(false);
    expect(card.visible('checkout-link')).toBe(true);
    expect(card.href('checkout-link')).toBe('https://checkout.stripe.com/c/pay/cs_retry_starter');
    expect(card.text('letters')).toBe('2');
    expect(card.text('price')).toBe('5.00');
    expect(card.text('message')).toBe('Pay USD 5.00 to add 2 letters to your account.');
    expect(card.text('order-line')).toBe('Order ord_retry_0001');
    // The one convenience open, with the retry's own URL.
    expect(card.opened).toEqual(['https://checkout.stripe.com/c/pay/cs_retry_starter']);
  });

  it('offers the pack sizes when the request carried no pack, and buys the one chosen', async () => {
    const card = mount();
    await card.runNextTimer();

    expect(card.text('retry-button')).toBe('Choose a pack');
    await card.click('retry-button');

    expect(card.calls).toEqual([{ name: 'list_letter_packs', args: {} }]);
    expect(card.visible('retry-button')).toBe(false);
    expect(card.packOptionLabels()).toEqual([
      '2 letters · USD 5.00',
      '5 letters · USD 10.00',
      '50 letters · USD 90.00'
    ]);

    await card.clickPackOption('regular');

    expect(card.calls[1]).toEqual({ name: 'create_pack_checkout', args: { pack: 'regular' } });
    expect(card.visible('state-ready')).toBe(true);
    expect(card.href('checkout-link')).toBe('https://checkout.stripe.com/c/pay/cs_retry_regular');
    expect(card.text('letters')).toBe('5');
  });

  it('treats a pack it does not recognise as no pack at all', async () => {
    // The enum is copied from the tool's input schema; a value outside it
    // must not be forwarded to the tool, which would refuse it.
    const card = mount({ toolInput: { pack: 'enormous' } });
    await card.runNextTimer();

    expect(card.text('retry-button')).toBe('Choose a pack');
  });

  it('shows an empty catalogue as an error and leaves the button to try again', async () => {
    const card = mount({ packListEmpty: true });
    await card.runNextTimer();

    await card.click('retry-button');

    expect(card.visible('retry-error')).toBe(true);
    expect(card.text('retry-error')).toMatch(/temporarily unavailable/);
    expect(card.visible('retry-button')).toBe(true);
    expect(card.disabled('retry-button')).toBe(false);
    expect(card.text('retry-button')).toBe('Choose a pack');
  });

  it('keeps the button when the checkout call fails, showing the message the tool wrote', async () => {
    const card = mount({ toolInput: { pack: 'starter' }, packCheckoutFails: true });
    await card.runNextTimer();

    await card.click('retry-button');

    expect(card.visible('state-empty')).toBe(true);
    expect(card.visible('retry-error')).toBe(true);
    expect(card.text('retry-error')).toMatch(/Purchasing is disabled on this account/);
    expect(card.disabled('retry-button')).toBe(false);
    expect(card.text('retry-button')).toBe('Create my checkout');

    await card.click('retry-button');
    expect(card.calls).toHaveLength(2);
  });

  it('renders an already-paid result as done, without a link', async () => {
    const card = mount({ toolInput: { pack: 'starter' }, packCheckoutOmitsUrl: true });
    await card.runNextTimer();

    await card.click('retry-button');

    expect(card.visible('state-ready')).toBe(true);
    expect(card.visible('checkout-link')).toBe(false);
    expect(card.visible('done')).toBe(true);
    expect(card.text('done')).toMatch(/already paid or being fulfilled/);
  });

  it('keeps the checkout it created when the host later delivers nothing', async () => {
    // A late openai:set_globals with an empty toolOutput is exactly the
    // state that produced the skeleton in the first place. It must not put
    // the skeleton back over a link the customer may be paying on.
    const card = mount({ toolInput: { pack: 'starter' } });
    await card.runNextTimer();
    await card.click('retry-button');

    card.deliver(null);

    expect(card.visible('state-ready')).toBe(true);
    expect(card.href('checkout-link')).toBe('https://checkout.stripe.com/c/pay/cs_retry_starter');
    expect(card.visible('state-loading')).toBe(false);
    expect(card.visible('state-empty')).toBe(false);
  });

  it('prefers the checkout it created over a host result that arrives afterwards', async () => {
    // Same reason: the customer acted on the retry's link. Swapping it for a
    // different order under them would be worse than the original defect.
    const card = mount({ toolInput: { pack: 'starter' } });
    await card.runNextTimer();
    await card.click('retry-button');

    card.deliver(pendingCheckout({ checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_late' }));

    expect(card.href('checkout-link')).toBe('https://checkout.stripe.com/c/pay/cs_retry_starter');
  });

  it('gives way to a host result that arrives after the empty state but before any click', async () => {
    const card = mount({ toolInput: { pack: 'starter' } });
    await card.runNextTimer();
    expect(card.visible('state-empty')).toBe(true);

    card.deliver(pendingCheckout());

    expect(card.visible('state-ready')).toBe(true);
    expect(card.visible('state-empty')).toBe(false);
    expect(card.href('checkout-link')).toBe('https://checkout.stripe.com/c/pay/cs_host');
    expect(card.calls).toEqual([]);
  });

  it('ignores a second click while a call is in flight', async () => {
    const card = mount({ toolInput: { pack: 'starter' } });
    await card.runNextTimer();

    // Two clicks in the same tick: the first sets the in-flight guard before
    // the second handler runs.
    const first = card.click('retry-button');
    const second = card.click('retry-button');
    await Promise.all([first, second]);

    expect(card.calls.filter(call => call.name === 'create_pack_checkout')).toHaveLength(1);
  });

  it('explains how to recover when the bridge cannot call tools', async () => {
    // A host that drew the template but exposes no callTool: the card can
    // still say what happened, which beats placeholder bars.
    const card = mount({ withoutCallTool: true, toolInput: { pack: 'starter' } });
    await card.runNextTimer();

    expect(card.visible('state-empty')).toBe(true);
    expect(card.text('empty-message')).toMatch(/ask for the checkout again/i);
    expect(card.visible('retry-button')).toBe(false);
  });
});

describe('PackCheckoutCard purchase status', () => {
  it('polls the purchase status while the checkout is open and keeps the link while payment is pending', async () => {
    const card = mount({ toolOutput: pendingCheckout() });

    expect(card.visible('check-status-button')).toBe(true);
    await card.runNextTimer();

    expect(statusCalls(card)).toEqual([{ name: 'get_purchase_status', args: { orderId: 'ord_host_0001' } }]);
    expect(card.visible('checkout-link')).toBe(true);
    expect(card.pendingTimers().map(timer => timer.delay)).toEqual([3000]);
  });

  it('shows the paid state and stops polling once the letters are on the account', async () => {
    const card = mount({ toolOutput: pendingCheckout() });
    card.setStatus({ purchaseStatus: 'submitted', letters: 2, lettersRemaining: 2 });

    await card.runNextTimer();

    expect(card.text('message')).toBe('Paid. 2 letters added to your account.');
    expect(card.text('done')).toMatch(/2 of 2 from this pack are still unused/);
    expect(card.visible('checkout-link')).toBe(false);
    expect(card.visible('note')).toBe(false);
    // On demand only after payment (#368): visible, but no timer behind it.
    expect(card.visible('check-status-button')).toBe(true);
    expect(card.text('order-line')).toBe('Order ord_host_0001');
    expect(card.pendingTimers()).toEqual([]);
  });

  it('shows a refund issued after payment when the customer returns to the tab', async () => {
    // Polling ends at "paid", by design. On 2026-09-13 a Dashboard refund
    // then left the card claiming two unused letters against a balance of
    // zero (#368). One read per return to the tab, no timers, closes that.
    const card = mount({ toolOutput: pendingCheckout() });
    card.setStatus({ purchaseStatus: 'submitted', letters: 2, lettersRemaining: 2 });
    await card.runNextTimer();
    expect(card.pendingTimers()).toEqual([]);

    card.setStatus({
      purchaseStatus: 'refunded',
      letters: 2,
      lettersRemaining: 0,
      message: 'This purchase was refunded. Refunds take 5-10 business days to appear on the card.'
    });
    card.setHidden(true);
    card.fireVisibilityChange();
    card.setHidden(false);
    card.fireVisibilityChange();
    await flush();

    expect(statusCalls(card)).toHaveLength(2);
    expect(card.text('message')).toMatch(/refunded/i);
    expect(card.visible('done')).toBe(false);
    expect(card.visible('check-status-button')).toBe(false);
    expect(card.pendingTimers()).toEqual([]);
  });

  it('lets the customer check again after payment without restarting the timers', async () => {
    const card = mount({ toolOutput: pendingCheckout() });
    card.setStatus({ purchaseStatus: 'submitted', letters: 2, lettersRemaining: 2 });
    await card.runNextTimer();

    await card.click('check-status-button');

    expect(statusCalls(card)).toHaveLength(2);
    expect(card.text('message')).toBe('Paid. 2 letters added to your account.');
    expect(card.text('check-status-button')).toBe('Check status');
    expect(card.pendingTimers()).toEqual([]);
  });

  it('reports a confirmed payment that is still being credited, and keeps polling', async () => {
    const card = mount({ toolOutput: pendingCheckout() });
    card.setStatus({ purchaseStatus: 'processing', letters: 2 });

    await card.runNextTimer();

    expect(card.text('message')).toBe('Payment confirmed. Adding 2 letters to your account...');
    expect(card.visible('checkout-link')).toBe(false);
    expect(card.visible('check-status-button')).toBe(true);
    expect(card.pendingTimers().map(timer => timer.delay)).toEqual([3000]);
  });

  it('keeps the paid state when the host re-delivers the pending checkout', async () => {
    // openai:set_globals only ever knows the checkout. Re-rendering from it
    // put the payment link back over a paid purchase in the preview cards
    // on 2026-08-30; the same guard applies here.
    const card = mount({ toolOutput: pendingCheckout() });
    card.setStatus({ purchaseStatus: 'submitted', letters: 2, lettersRemaining: 2 });
    await card.runNextTimer();

    card.deliver(pendingCheckout());

    expect(card.text('message')).toBe('Paid. 2 letters added to your account.');
    expect(card.visible('checkout-link')).toBe(false);
    expect(card.pendingTimers()).toEqual([]);
  });

  it('offers a new checkout when the session expired, and polls the replacement', async () => {
    const card = mount({ toolOutput: pendingCheckout(), toolInput: { pack: 'starter' } });
    card.setStatus({ purchaseStatus: 'cancelled' });
    await card.runNextTimer();

    expect(card.text('message')).toBe('This checkout expired before it was paid. Nothing was charged.');
    expect(card.visible('checkout-link')).toBe(false);
    expect(card.visible('new-checkout-button')).toBe(true);
    expect(card.pendingTimers()).toEqual([]);

    card.setStatus({ purchaseStatus: 'pending_payment' });
    await card.click('new-checkout-button');

    expect(card.calls.at(-1)).toEqual({ name: 'create_pack_checkout', args: { pack: 'starter' } });
    expect(card.visible('checkout-link')).toBe(true);
    expect(card.href('checkout-link')).toBe('https://checkout.stripe.com/c/pay/cs_retry_starter');
    expect(card.visible('new-checkout-button')).toBe(false);
    expect(card.text('order-line')).toBe('Order ord_retry_0001');

    await card.runNextTimer();
    expect(statusCalls(card).at(-1)).toEqual({ name: 'get_purchase_status', args: { orderId: 'ord_retry_0001' } });
  });

  it('says how to recover from a failed payment when no pack is known', async () => {
    const card = mount({ toolOutput: pendingCheckout() });
    card.setStatus({ purchaseStatus: 'payment_failed' });

    await card.runNextTimer();

    expect(card.text('message')).toBe('The payment did not go through. Nothing was charged.');
    expect(card.visible('new-checkout-button')).toBe(false);
    expect(card.visible('err')).toBe(true);
    expect(card.text('err')).toMatch(/ask for a new checkout/i);
  });

  it('shows the server message for refund and hold states', async () => {
    const card = mount({ toolOutput: pendingCheckout() });
    card.setStatus({
      purchaseStatus: 'refunded',
      message: 'This purchase was refunded. Refunds take 5-10 business days to appear on the card.'
    });

    await card.runNextTimer();

    expect(card.text('message')).toMatch(/refunded/i);
    expect(card.visible('checkout-link')).toBe(false);
    expect(card.visible('done')).toBe(false);
    expect(card.pendingTimers()).toEqual([]);
  });

  it('stops polling while the tab is hidden and refreshes the moment it returns', async () => {
    const card = mount({ toolOutput: pendingCheckout() });
    expect(card.pendingTimers()).toHaveLength(1);

    card.setHidden(true);
    card.fireVisibilityChange();
    expect(card.pendingTimers()).toEqual([]);
    expect(statusCalls(card)).toEqual([]);

    card.setHidden(false);
    card.fireVisibilityChange();
    await flush();

    expect(statusCalls(card)).toHaveLength(1);
    expect(card.pendingTimers().map(timer => timer.delay)).toEqual([3000]);
  });

  it('lets the customer check on demand', async () => {
    const card = mount({ toolOutput: pendingCheckout() });

    await card.click('check-status-button');

    expect(statusCalls(card)).toHaveLength(1);
    expect(card.text('check-status-button')).toBe('Check status');
    expect(card.disabled('check-status-button')).toBe(false);
  });

  it('starts polling the checkout it created itself', async () => {
    const card = mount({ toolInput: { pack: 'starter' } });
    await card.runNextTimer();
    await card.click('retry-button');

    expect(card.pendingTimers().map(timer => timer.delay)).toEqual([3000]);
    await card.runNextTimer();

    expect(statusCalls(card)).toEqual([{ name: 'get_purchase_status', args: { orderId: 'ord_retry_0001' } }]);
  });

  it('does not poll without a bridge to call through', () => {
    const card = mount({ toolOutput: pendingCheckout(), withoutCallTool: true });

    expect(card.visible('checkout-link')).toBe(true);
    expect(card.visible('check-status-button')).toBe(false);
    expect(card.pendingTimers()).toEqual([]);
  });
});
