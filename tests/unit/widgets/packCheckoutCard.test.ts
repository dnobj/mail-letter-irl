/**
 * Behaviour tests for PackCheckoutCard's empty-render recovery (issue #322).
 *
 * The defect they cover: ChatGPT drops the first consequential tool call after
 * "Allow once", renders this card's template with no tool result, and the
 * skeleton sits there indefinitely while the model tells the customer to use
 * "the checkout shown above" (observed in production on 2026-09-11 and in
 * development on 2026-09-12; no request reached the API either time). The
 * card now waits, then offers to create the checkout itself through the
 * bridge, the way the preview cards already buy packs.
 *
 * Same honest limits as purchaseStatus.test.ts: jsdom runs the same source
 * but is not ChatGPT. Whether the bridge is live inside a card the host drew
 * without a result, and whether a widget-initiated write call shows its own
 * consent prompt, can only be learned against deployed development.
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
      return { structuredContent: {} };
    };
  }

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    beforeParse(window) {
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

describe('PackCheckoutCard with a tool result', () => {
  it('renders the checkout straight away and never arms the empty-state wait', () => {
    const card = mount({ toolOutput: pendingCheckout() });

    expect(card.visible('state-ready')).toBe(true);
    expect(card.visible('state-loading')).toBe(false);
    expect(card.visible('state-empty')).toBe(false);
    expect(card.href('checkout-link')).toBe('https://checkout.stripe.com/c/pay/cs_host');
    expect(card.pendingTimers()).toEqual([]);
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
    expect(card.pendingTimers()).toEqual([]);
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

    expect(card.calls).toHaveLength(1);
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
