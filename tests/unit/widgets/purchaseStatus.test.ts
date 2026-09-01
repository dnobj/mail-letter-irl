/**
 * Behaviour tests for the preview cards' purchase-status handling.
 *
 * These are the first tests in this repository that RENDER a widget rather
 * than string-match its source (issue #206, tier 2). They exist because the
 * defect they cover could not be caught any other way: on 2026-08-30 a paid
 * order's card reset itself to "Not enough letters in your balance" and the
 * draft id, because render() wrote over rows that a completed checkout owned.
 * Every existing widget test would have stayed green.
 *
 * TWO HONEST LIMITS, so a green run is not over-read:
 *
 * 1. jsdom does not execute `<script type="module">`, so the harness rewrites
 *    the tag to a classic script. Both preview cards' script bodies parse
 *    cleanly as classic scripts - no import/export, no top-level await - so
 *    this runs the same source, but not through the loader ChatGPT uses.
 *
 * 2. jsdom is not ChatGPT. The root causes here - timer throttling and iframe
 *    suspension in a background tab - do not reproduce in jsdom and cannot be
 *    tested here. These tests guard the logic; only a run against deployed
 *    development guards the behaviour.
 *
 * Every case runs against BOTH preview cards. The two files carry an
 * identical copy of this logic, and fixing one and not the other is a failure
 * this repository has produced repeatedly (#278 rounds 12-13, the duplicated
 * friendlyDraftError, and twice while writing this very change).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';

const WIDGET_DIR = path.resolve(__dirname, '../../../widgets');
const CARDS = ['LetterPreviewCard', 'PostcardPreviewCard'] as const;

interface ScheduledTimer {
  fn: () => void;
  delay: number;
  cancelled: boolean;
}

interface Harness {
  document: Document;
  timers: ScheduledTimer[];
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  setStatus: (status: Record<string, unknown>) => void;
  setBalance: (balance: Record<string, unknown>) => void;
  failPackCheckout: () => void;
  packCheckoutWithoutUrl: () => void;
  setHidden: (hidden: boolean) => void;
  /** Hold tool calls open so in-flight UI state can be observed. */
  holdCalls: () => void;
  releaseCalls: () => Promise<void>;
  fireGlobals: () => void;
  fireVisibilityChange: () => void;
  pendingTimers: () => ScheduledTimer[];
  runNextTimer: () => Promise<void>;
  click: (id: string) => Promise<void>;
  text: (id: string) => string;
  visible: (id: string) => boolean;
}

/** Let queued promise callbacks settle. */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

function toolOutputFixture() {
  return {
    draftId: 'draft_test_0001',
    layoutType: 'text_only',
    lettersRequired: 1,
    canSendNow: false,
    reasonCannotSend: 'Not enough letters in your balance.',
    deliveryClass: 'USPS First-Class Mail',
    deliveryEstimate: '1-2 weeks',
    sendEligibility: {
      // No prepaid block: the server stopped serving one (#308), and a fixture
      // richer than the real payload can hide a widget that depends on it.
      payAndSend: {
        available: true,
        amountCents: 499,
        currency: 'usd',
        displayAmount: '4.99'
      },
      letterPack: { available: true, purchaseUrl: 'https://letterirl.com/packs' }
    }
  };
}

function mount(
  card: string,
  options: { openExternalRejects?: boolean } = {}
): Harness {
  const html = fs.readFileSync(path.join(WIDGET_DIR, `${card}.html`), 'utf-8');
  // See limit (1) at the top of this file.
  const runnable = html.replace('<script type="module">', '<script>');

  const timers: ScheduledTimer[] = [];
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let purchaseStatus: Record<string, unknown> = { purchaseStatus: 'pending_payment' };
  // The fixture's draft needs 1 letter, so 0 is "the pack has not landed yet".
  let accountBalance: Record<string, unknown> = { lettersRemaining: 0 };
  let hidden = false;
  let packCheckoutFails = false;
  let packCheckoutOmitsUrl = false;
  let gate: Promise<void> | null = null;
  let openGate: (() => void) | null = null;

  const dom = new JSDOM(runnable, {
    runScripts: 'dangerously',
    beforeParse(window) {
      Object.defineProperty(window.document, 'hidden', { get: () => hidden });

      // Timers are captured rather than run, so scheduling is observable and
      // nothing depends on wall-clock time.
      (window as unknown as Record<string, unknown>).setTimeout = (
        fn: () => void,
        delay: number
      ) => {
        timers.push({ fn, delay, cancelled: false });
        return timers.length;
      };
      (window as unknown as Record<string, unknown>).clearTimeout = (id: number) => {
        const timer = timers[id - 1];
        if (timer) timer.cancelled = true;
      };

      (window as unknown as Record<string, unknown>).openai = {
        theme: 'light',
        toolOutput: toolOutputFixture(),
        callTool: async (name: string, args: Record<string, unknown>) => {
          calls.push({ name, args });
          if (gate) await gate;
          if (name === 'create_mail_checkout') {
            return {
              structuredContent: {
                orderId: 'ord_test_0001',
                checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test'
              }
            };
          }
          if (name === 'get_purchase_status') {
            return { structuredContent: purchaseStatus };
          }
          if (name === 'get_account_balance') {
            return { structuredContent: accountBalance };
          }
          if (name === 'create_pack_checkout') {
            if (packCheckoutFails) throw new Error('pack checkout unavailable');
            return {
              structuredContent: {
                orderId: 'ord_pack_0001',
                ...(packCheckoutOmitsUrl
                  ? { message: 'This purchase is already paid or being fulfilled.' }
                  : { checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_pack' }),
                letters: 2,
                amountCents: 500,
                currency: 'usd'
              }
            };
          }
          return { structuredContent: {} };
        },
        openExternal: async () => {
          if (options.openExternalRejects) throw new Error('host refused');
        }
      };
    }
  });

  const document = dom.window.document;

  return {
    document,
    timers,
    calls,
    setStatus: status => {
      purchaseStatus = status;
    },
    setBalance: balance => {
      accountBalance = balance;
    },
    failPackCheckout: () => {
      packCheckoutFails = true;
    },
    packCheckoutWithoutUrl: () => {
      packCheckoutOmitsUrl = true;
    },
    setHidden: value => {
      hidden = value;
    },
    holdCalls: () => {
      gate = new Promise<void>(resolve => {
        openGate = resolve;
      });
    },
    releaseCalls: async () => {
      openGate?.();
      gate = null;
      openGate = null;
      await flush();
    },
    fireGlobals: () => {
      dom.window.dispatchEvent(new dom.window.Event('openai:set_globals'));
    },
    fireVisibilityChange: () => {
      document.dispatchEvent(new dom.window.Event('visibilitychange'));
    },
    pendingTimers: () => timers.filter(timer => !timer.cancelled),
    runNextTimer: async () => {
      const next = timers.filter(timer => !timer.cancelled).pop();
      if (!next) throw new Error('no timer armed');
      next.cancelled = true;
      next.fn();
      await flush();
    },
    click: async (id: string) => {
      const el = document.getElementById(id);
      if (!el) throw new Error(`no element #${id}`);
      el.dispatchEvent(new dom.window.Event('click'));
      await flush();
    },
    text: (id: string) => document.getElementById(id)?.textContent?.trim() ?? '',
    visible: (id: string) => {
      const el = document.getElementById(id) as HTMLElement | null;
      return !!el && el.style.display !== 'none';
    }
  };
}

/** Drive a card through a successful checkout. */
async function checkout(harness: Harness): Promise<void> {
  await harness.click('pay-send-button');
}

describe.each(CARDS)('%s purchase status', card => {
  let harness: Harness;

  beforeEach(() => {
    harness = mount(card);
  });

  it('does not let a re-render wipe the checkout state', async () => {
    // THE DEFECT. Before the fix, this set_globals reset the pill to
    // reasonCannotSend and the ID row to the draft id - so a customer who had
    // just paid was told they had no letters.
    await checkout(harness);
    expect(harness.text('id-label')).toBe('Purchase');
    expect(harness.text('id-value')).toBe('ord_test_0001');

    harness.fireGlobals();
    await flush();

    expect(harness.text('id-label')).toBe('Purchase');
    expect(harness.text('id-value')).toBe('ord_test_0001');
    // Specifically NOT the pre-checkout text: that is what a customer who
    // had just paid was shown.
    expect(harness.text('status-pill')).toBe('Checkout open - waiting for payment');
  });

  it('still lets a re-render update the card before any checkout', async () => {
    // The guard must not freeze a card that is still describing a draft.
    harness.fireGlobals();
    await flush();

    expect(harness.text('id-label')).toBe('Draft');
    expect(harness.text('id-value')).toBe('draft_test_0001');
    expect(harness.text('status-pill')).toBe('Not enough letters in your balance.');
  });

  it('reveals Check status only once an order exists, and reads that order', async () => {
    expect(harness.visible('check-status-button')).toBe(false);

    await checkout(harness);
    expect(harness.visible('check-status-button')).toBe(true);

    const before = harness.calls.length;
    await harness.click('check-status-button');

    const statusCalls = harness.calls
      .slice(before)
      .filter(call => call.name === 'get_purchase_status');
    expect(statusCalls.length).toBeGreaterThan(0);
    expect(statusCalls[0].args).toEqual({ orderId: 'ord_test_0001' });
  });

  it('keeps polling while the payment is still pending', async () => {
    await checkout(harness);
    expect(harness.pendingTimers().length).toBe(1);

    harness.setStatus({ purchaseStatus: 'pending_payment' });
    await harness.runNextTimer();

    expect(harness.pendingTimers().length).toBe(1);
  });

  it('stops the timer once the payment is confirmed', async () => {
    // "processing" is paid|fulfillment_pending, and the hop to "sent" is set
    // when the provider accepts - which runs only in the HOURLY maintenance
    // job. Polling a 10-minute budget for it made ~40 calls for a transition
    // that could not arrive. Observed against dev on 2026-08-31.
    await checkout(harness);
    harness.setStatus({ purchaseStatus: 'processing' });

    await harness.runNextTimer();

    expect(harness.pendingTimers().length).toBe(0);
    // Stopping the timer must not stop the display.
    expect(harness.text('status-pill')).toBe('Paid - preparing mail');
  });

  it('still refreshes on return after the timer has stopped', async () => {
    // This is what makes stopping the timer safe: the customer who comes back
    // an hour later still sees the outcome, without the card having polled
    // throughout.
    await checkout(harness);
    harness.setStatus({ purchaseStatus: 'processing' });
    await harness.runNextTimer();
    expect(harness.pendingTimers().length).toBe(0);

    // Renamed from 'sent': it fires when the print provider ACCEPTS the
    // job, not when the item is in the mail (#310).
    harness.setStatus({ purchaseStatus: 'submitted' });
    harness.fireVisibilityChange();
    await flush();

    expect(harness.text('status-pill')).toBe('With the printer');
    expect(harness.pendingTimers().length).toBe(0);
  });

  it('stops on a terminal status', async () => {
    await checkout(harness);
    harness.setStatus({ purchaseStatus: 'payment_failed', message: 'Payment was not completed.' });

    await harness.runNextTimer();

    expect(harness.text('status-pill')).toBe('Payment was not completed.');
    expect(harness.pendingTimers().length).toBe(0);
  });

  it('does not flicker the button on an automatic refresh', async () => {
    // The reported symptom: the card appeared to cycle between "Checking..."
    // and "Check status". A label announcing the user's click has no business
    // firing on a timer.
    await checkout(harness);
    harness.holdCalls();

    await harness.runNextTimer();

    expect(harness.text('check-status-button')).toBe('Check status');
    expect(
      (harness.document.getElementById('check-status-button') as HTMLButtonElement).disabled
    ).toBe(false);
    await harness.releaseCalls();
  });

  it('does show progress on a refresh the user asked for', async () => {
    // The other half: suppressing the label everywhere would leave a click
    // with no feedback at all.
    await checkout(harness);
    harness.holdCalls();

    await harness.click('check-status-button');
    expect(harness.text('check-status-button')).toBe('Checking...');

    await harness.releaseCalls();
    expect(harness.text('check-status-button')).toBe('Check status');
  });

  it('refreshes immediately when the tab becomes visible again', async () => {
    // The whole point: returning from the checkout tab is when the answer is
    // wanted, and the first moment a hidden iframe is allowed to run.
    await checkout(harness);
    harness.setStatus({ purchaseStatus: 'processing' });

    const before = harness.calls.filter(c => c.name === 'get_purchase_status').length;
    harness.fireVisibilityChange();
    await flush();

    const after = harness.calls.filter(c => c.name === 'get_purchase_status').length;
    expect(after).toBeGreaterThan(before);
    expect(harness.text('status-pill')).toBe('Paid - preparing mail');
  });

  it('stops the timer while the tab is hidden', async () => {
    await checkout(harness);
    expect(harness.pendingTimers().length).toBe(1);

    harness.setHidden(true);
    harness.fireVisibilityChange();
    await flush();

    expect(harness.pendingTimers().length).toBe(0);
  });

  it('does not re-arm if the tab hid while a poll was in flight', async () => {
    // The narrow race the document.hidden check inside scheduleStatusPoll
    // exists for, and which the visibilitychange test above does NOT cover:
    // that handler returns early when hidden and never reaches the scheduler.
    // Here a timer fires while visible, the tab hides during the await, and
    // the completion must not arm another timer behind the user's back.
    //
    // Added because mutating that check away left every other test green.
    await checkout(harness);
    expect(harness.pendingTimers().length).toBe(1);

    harness.setStatus({ purchaseStatus: 'processing' });
    harness.setHidden(true);
    await harness.runNextTimer();

    expect(harness.text('status-pill')).toBe('Paid - preparing mail');
    expect(harness.pendingTimers().length).toBe(0);
  });

  it('still shows the checkout link and polls when the host will not open a tab', async () => {
    // Protects what shipped in #304: openExternal resolving without opening
    // anything left customers with no way to pay.
    const rejecting = mount(card, { openExternalRejects: true });
    await checkout(rejecting);

    expect(rejecting.visible('checkout-link')).toBe(true);
    expect(rejecting.document.getElementById('checkout-link')?.getAttribute('href')).toBe(
      'https://checkout.stripe.com/c/pay/cs_test'
    );
    expect(rejecting.text('pay-send-button-text')).toBe('Use the checkout link below');
    expect(rejecting.pendingTimers().length).toBe(1);
  });
});

/**
 * A Letter Pack grants credits and nothing else: the customer must come back
 * and press Send. Before this, buying a pack left the card frozen on
 * "Not enough letters in your balance", so a paid-for letter could sit unsent
 * indefinitely with no way to learn otherwise except asking ChatGPT (#306).
 *
 * The pack is bought on the website, so there is no order id and
 * get_purchase_status is unusable - the balance is the only observable.
 */
describe.each(CARDS)('%s letter pack refresh', card => {
  let harness: Harness;

  beforeEach(() => {
    harness = mount(card);
  });

  async function buyPack(): Promise<void> {
    await harness.click('buy-pack-button');
  }

  it('starts watching for the letters after a pack checkout', async () => {
    expect(harness.visible('check-status-button')).toBe(false);
    expect(harness.pendingTimers().length).toBe(0);

    await buyPack();

    expect(harness.visible('check-status-button')).toBe(true);
    expect(harness.pendingTimers().length).toBe(1);
    expect(harness.text('status-pill')).toBe('Waiting for your Letter Pack');
  });

  it('makes the card sendable once the letters arrive', async () => {
    await buyPack();
    harness.setBalance({ lettersRemaining: 3 });

    await harness.runNextTimer();

    expect(harness.text('status-pill')).toBe('Ready to send');
    expect(harness.visible('send-button')).toBe(true);
    // Offering to charge again for a letter the customer now owns is the one
    // outcome worth ruling out.
    expect(harness.visible('pay-send-button')).toBe(false);
    expect(harness.pendingTimers().length).toBe(0);
  });

  it('survives a re-render that still reports the old balance', async () => {
    // The tool output is never re-fetched, so it still says canSendNow: false.
    // render() has to prefer the refreshed balance or the card snaps back.
    await buyPack();
    harness.setBalance({ lettersRemaining: 3 });
    await harness.runNextTimer();

    harness.fireGlobals();
    await flush();

    expect(harness.text('status-pill')).toBe('Ready to send');
    expect(harness.visible('send-button')).toBe(true);
  });

  it('keeps waiting when the letters have not arrived', async () => {
    // The expected outcome when a pack is bought while signed out of the
    // website: the letters never reach this account. It must stay checkable
    // rather than declare failure.
    await buyPack();
    harness.setBalance({ lettersRemaining: 0 });

    await harness.runNextTimer();

    expect(harness.visible('send-button')).toBe(false);
    expect(harness.visible('check-status-button')).toBe(true);
    expect(harness.pendingTimers().length).toBe(1);
  });

  it('asks about the balance, never about an order it does not have', async () => {
    await buyPack();
    await harness.runNextTimer();

    const names = harness.calls.map(call => call.name);
    expect(names).toContain('get_account_balance');
    expect(names).not.toContain('get_purchase_status');
  });

  it('prefers order status when a checkout is also being tracked', async () => {
    // Order state is the more specific answer, and the pack path has no order
    // id to ask about.
    await harness.click('pay-send-button');
    await buyPack();
    const before = harness.calls.length;

    await harness.click('check-status-button');

    const asked = harness.calls.slice(before).map(call => call.name);
    expect(asked).toContain('get_purchase_status');
    expect(asked).not.toContain('get_account_balance');
  });

  it('creates a checkout session instead of opening a website URL', async () => {
    // Previously this opened letterPack.purchaseUrl, a static address carrying
    // no identity - so a customer not signed in on the website bought letters
    // that never reached this account.
    await buyPack();

    const packCalls = harness.calls.filter(call => call.name === 'create_pack_checkout');
    expect(packCalls).toHaveLength(1);
    expect(packCalls[0].args).toEqual({ pack: 'starter' });
    expect(harness.document.getElementById('checkout-link')?.getAttribute('href')).toBe(
      'https://checkout.stripe.com/c/pay/cs_pack'
    );
  });

  it('says what the pack costs and how many letters it adds', async () => {
    await buyPack();

    expect(harness.text('checkout-link')).toBe('Open checkout - 2 letters (USD 5.00)');
    expect(harness.text('checkout-link')).not.toMatch(/credit/i);
  });

  it('does not track the pack order, or the balance refresh would starve', async () => {
    // THE correctness guard for this change. A pack now has a real order id,
    // and the refresher prefers order status whenever one is tracked - but
    // order status cannot say how many letters are on the balance, which is
    // the only thing that makes this card sendable. Tracking it would break
    // the flow it was meant to improve.
    await buyPack();
    harness.setBalance({ lettersRemaining: 3 });

    await harness.runNextTimer();

    const names = harness.calls.map(call => call.name);
    expect(names).toContain('get_account_balance');
    expect(names).not.toContain('get_purchase_status');
    expect(harness.text('status-pill')).toBe('Ready to send');
  });

  it('reports a failed pack checkout without pretending one is pending', async () => {
    harness.failPackCheckout();

    await buyPack();

    expect(harness.visible('error-message')).toBe(true);
    expect(harness.text('error-message')).toMatch(/unable to start the letter pack checkout/i);
    // No session exists, so nothing should be waited on.
    expect(harness.pendingTimers().length).toBe(0);
    expect(harness.visible('check-status-button')).toBe(false);
  });

  it('does not wait on a session it never received', async () => {
    // A result with no checkoutUrl means no session exists to pay. Arming the
    // scheduler anyway would leave the card watching for letters that nothing
    // is going to deliver, and the customer with no way to pay.
    //
    // Added because mutating the guard away left every other case green: the
    // failure test above makes callTool THROW, which never reaches this branch.
    harness.packCheckoutWithoutUrl();

    await buyPack();

    expect(harness.pendingTimers().length).toBe(0);
    expect(harness.visible('check-status-button')).toBe(false);
    expect(harness.visible('error-message')).toBe(true);
  });

  it('ignores a second click while a pack checkout is already pending', async () => {
    // A second order would charge for letters already being bought.
    await buyPack();
    await buyPack();

    expect(harness.calls.filter(call => call.name === 'create_pack_checkout')).toHaveLength(1);
  });
});
