/**
 * Behaviour tests for the preview cards' recovery from a preview call that
 * never reached the server (#411), and for what they keep for a reopened
 * conversation.
 *
 * On ChatGPT web a preview call approved with "Allow once" is lost inside the
 * host: no request reaches Letter IRL, the host still draws the card with no
 * result, and the model says the preview is ready. The card waits, then offers
 * Create my preview, which repeats the call with the host's own arguments
 * through window.openai.callTool, the path the pack card has used since #322.
 *
 * Same harness shape and the same two limits as purchaseStatus.test.ts: the
 * module script is run as a classic script, and jsdom is not ChatGPT. Only a
 * run on the deployed development connector shows that the host really
 * passes toolInput to such a card and really delivers the card's call.
 *
 * Every shared case runs against BOTH preview cards, which carry their own
 * copy of this logic.
 */

import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';
import { stampPreviewTool } from '../../../src/mcp/registerTools.js';

const WIDGET_DIR = path.resolve(__dirname, '../../../widgets');

type Json = Record<string, unknown>;

interface ScheduledTimer {
  fn: () => void;
  delay: number;
  cancelled: boolean;
}

interface CardSpec {
  file: 'LetterPreviewCard' | 'PostcardPreviewCard';
  tool: string;
  sendTool: string;
  waitMs: number;
  noun: string;
  args: () => Json;
  /** The arguments with the one field a repeat cannot do without removed. */
  incompleteArgs: () => Json;
  output: (draftId: string, overrides?: Json) => Json;
  meta: () => Json;
  /** Text the card shows only when it drew the preview from `meta()`. */
  drawnFromMeta: string;
}

const recipient = {
  name: 'Sam Rivera',
  addressLine1: '1 Main St',
  city: 'Springfield',
  state: 'IL',
  postalCode: '62701'
};

function eligibility(canSendNow: boolean): Json {
  return {
    canSendNow,
    reasonCannotSend: canSendNow ? undefined : 'Not enough letters in your balance.',
    sendEligibility: {
      payAndSend: { available: true, amountCents: 499, currency: 'usd', displayAmount: '4.99' },
      letterPack: { available: true, purchaseUrl: 'https://letterirl.com/packs' }
    }
  };
}

const LETTER: CardSpec = {
  file: 'LetterPreviewCard',
  tool: 'quote_and_preview_letter',
  sendTool: 'send_letter',
  waitMs: 25000,
  noun: 'letter',
  args: () => ({ recipient: { ...recipient }, bodyText: 'Hello Sam, see you soon.', signOff: 'Love, Dee' }),
  incompleteArgs: () => ({ recipient: { ...recipient }, bodyText: 'Hello Sam, see you soon.' }),
  output: (draftId, overrides = {}) => ({
    draftId,
    layoutType: 'text_only',
    lettersRequired: 1,
    deliveryClass: 'USPS First-Class Mail',
    deliveryEstimate: '1-2 weeks',
    ...eligibility(true),
    ...overrides
  }),
  meta: () => ({
    previewHtml:
      '<div class="letter-body">Drawn from the preview HTML</div><div class="sign-off">Signed in HTML</div>'
  }),
  drawnFromMeta: 'Drawn from the preview HTML'
};

const POSTCARD: CardSpec = {
  file: 'PostcardPreviewCard',
  tool: 'quote_and_preview_postcard',
  sendTool: 'send_postcard',
  waitMs: 45000,
  noun: 'postcard',
  args: () => ({
    recipient: { ...recipient },
    message: 'Wish you were here.',
    imageUrl: 'https://example.com/beach.jpg'
  }),
  incompleteArgs: () => ({ recipient: { ...recipient }, imageUrl: 'https://example.com/beach.jpg' }),
  output: (draftId, overrides = {}) => ({
    draftId,
    lettersRequired: 1,
    message: 'Wish you were here.',
    recipientName: 'Sam Rivera',
    recipientAddressLine1: '1 Main St',
    recipientCity: 'Springfield',
    recipientState: 'IL',
    recipientPostalCode: '62701',
    deliveryClass: 'USPS First-Class Mail',
    ...eligibility(true),
    ...overrides
  }),
  meta: () => ({
    previewFrontHtml: '<html><body><div class="postcard-front">FRONT FROM META</div></body></html>'
  }),
  drawnFromMeta: 'FRONT FROM META'
};

interface MountOptions {
  toolOutput?: Json | null;
  toolResponseMetadata?: Json;
  toolInput?: Json | null;
  /** The tool stamped into the page, or null for an unstamped page. */
  stamp?: string | null;
  widgetState?: unknown;
  noCallTool?: boolean;
  /** What the preview tool returns (or throws) when the card calls it. */
  previewResponse?: (name: string, args: Json) => unknown;
  /** get_purchase_status's answer from the start: a card may ask at mount. */
  purchaseStatus?: Json;
  /** How many send calls reject before one succeeds. */
  failSends?: number;
  /** How many create_mail_checkout calls reject before one succeeds. */
  failCheckouts?: number;
}

/** Let queued promise callbacks settle. */
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

function mount(spec: CardSpec, options: MountOptions = {}) {
  const raw = fs.readFileSync(path.join(WIDGET_DIR, `${spec.file}.html`), 'utf-8');
  const stamp = options.stamp === undefined ? spec.tool : options.stamp;
  const stamped = stamp === null ? raw : stampPreviewTool(raw, stamp);
  if (stamp !== null) expect(stamped).not.toBe(raw);
  // jsdom does not run module scripts; see purchaseStatus.test.ts.
  const runnable = stamped.replace('<script type="module">', '<script>');

  const timers: ScheduledTimer[] = [];
  const calls: Array<{ name: string; args: Json }> = [];
  const savedStates: unknown[] = [];
  let purchaseStatus: Json = options.purchaseStatus ?? { purchaseStatus: 'pending_payment' };
  let sendFailures = options.failSends ?? 0;
  let checkoutFailures = options.failCheckouts ?? 0;
  let gate: Promise<void> | null = null;
  let openGate: (() => void) | null = null;

  const openai: Json = {
    theme: 'light',
    toolOutput: options.toolOutput === undefined ? null : options.toolOutput,
    toolResponseMetadata: options.toolResponseMetadata ?? null,
    toolInput: options.toolInput === undefined ? spec.args() : options.toolInput,
    widgetState: options.widgetState ?? null,
    setWidgetState: async (state: unknown) => {
      savedStates.push(JSON.parse(JSON.stringify(state)));
    },
    openExternal: async () => {}
  };
  if (!options.noCallTool) {
    openai.callTool = async (name: string, args: Json) => {
      calls.push({ name, args: JSON.parse(JSON.stringify(args)) });
      if (gate) await gate;
      if (name.startsWith('quote_and_preview_')) {
        if (options.previewResponse) return options.previewResponse(name, args);
        return { structuredContent: spec.output('draft_retry_0001'), _meta: spec.meta() };
      }
      if (name === spec.sendTool) {
        if (sendFailures > 0) {
          sendFailures -= 1;
          throw new Error('host timed out');
        }
        return { structuredContent: { orderId: 'ord_sent_0001' } };
      }
      if (name === 'create_mail_checkout') {
        if (checkoutFailures > 0) {
          checkoutFailures -= 1;
          throw new Error('host timed out');
        }
        return {
          structuredContent: {
            orderId: 'ord_checkout_0001',
            checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test'
          }
        };
      }
      if (name === 'get_purchase_status') return { structuredContent: purchaseStatus };
      if (name === 'get_account_balance') return { structuredContent: { lettersRemaining: 0 } };
      return { structuredContent: {} };
    };
  }

  const dom = new JSDOM(runnable, {
    runScripts: 'dangerously',
    beforeParse(window) {
      Object.defineProperty(window.document, 'hidden', { get: () => false });
      (window as unknown as Json).setTimeout = (fn: () => void, delay: number) => {
        timers.push({ fn, delay, cancelled: false });
        return timers.length;
      };
      (window as unknown as Json).clearTimeout = (id: number) => {
        const timer = timers[id - 1];
        if (timer) timer.cancelled = true;
      };
      (window as unknown as Json).openai = openai;
    }
  });
  const document = dom.window.document;

  const harness = {
    document,
    openai,
    calls,
    savedStates,
    callsTo: (name: string) => calls.filter(call => call.name === name),
    pendingTimers: () => timers.filter(timer => !timer.cancelled),
    /** Fire the recovery wait (the only timer a card arms before a result). */
    /** Fire the one pending timer armed with this delay. */
    runTimer: async (delay: number) => {
      const pending = timers.filter(timer => !timer.cancelled && timer.delay === delay);
      expect(pending, `exactly one pending ${delay} ms timer`).toHaveLength(1);
      pending[0].cancelled = true;
      pending[0].fn();
      await flush();
    },
    runWait: async () => {
      const pending = timers.filter(timer => !timer.cancelled);
      expect(pending, 'exactly one pending timer').toHaveLength(1);
      pending[0].cancelled = true;
      pending[0].fn();
      await flush();
    },
    deliverHostResult: async (output: Json, meta: Json = spec.meta()) => {
      openai.toolOutput = output;
      openai.toolResponseMetadata = meta;
      dom.window.dispatchEvent(new dom.window.Event('openai:set_globals'));
      await flush();
    },
    fireGlobals: async () => {
      dom.window.dispatchEvent(new dom.window.Event('openai:set_globals'));
      await flush();
    },
    setStatus: (status: Json) => {
      purchaseStatus = status;
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
    click: async (id: string) => {
      const el = document.getElementById(id);
      if (!el) throw new Error(`no element #${id}`);
      el.dispatchEvent(new dom.window.Event('click'));
      await flush();
    },
    text: (id: string) => document.getElementById(id)?.textContent?.trim() ?? '',
    html: (id: string) => document.getElementById(id)?.innerHTML ?? '',
    visible: (id: string) => {
      const el = document.getElementById(id) as HTMLElement | null;
      return !!el && el.style.display !== 'none';
    },
    disabled: (id: string) => (document.getElementById(id) as HTMLButtonElement | null)?.disabled ?? false
  };
  return harness;
}

type Harness = ReturnType<typeof mount>;

/** The pane a card draws its preview into. */
function previewPane(spec: CardSpec): string {
  return spec.file === 'LetterPreviewCard' ? 'mockup-container' : 'preview-front';
}

/** A tool that draws the card and takes an attached image. */
function imageTool(spec: CardSpec): string {
  return spec.file === 'LetterPreviewCard' ? 'quote_and_preview_letter_with_image' : spec.tool;
}

/** A lost call: no result, then the wait runs out. */
async function lostCall(spec: CardSpec, options: MountOptions = {}): Promise<Harness> {
  const harness = mount(spec, options);
  await flush();
  await harness.runWait();
  return harness;
}

describe.each([LETTER, POSTCARD])('$file recovery from a lost preview call (#411)', spec => {
  it('waits for the host, then offers to create the preview', async () => {
    const harness = mount(spec);
    await flush();

    expect(harness.visible('empty-state')).toBe(false);
    expect(harness.text('status-pill')).toBe('Loading...');
    expect(harness.pendingTimers().map(timer => timer.delay)).toEqual([spec.waitMs]);

    await harness.runWait();

    expect(harness.visible('empty-state')).toBe(true);
    expect(harness.visible('retry-button')).toBe(true);
    expect(harness.text('retry-button')).toBe('Create my preview');
    expect(harness.text('empty-message')).toBe(
      `No preview is showing on this card. If this ${spec.noun} was already sent, there is nothing more to do here. Otherwise, create the preview again.`
    );
    expect(harness.text('status-pill')).toBe('No preview');
    expect(harness.visible('send-button')).toBe(false);
    // The card never repeats a call by itself.
    expect(harness.calls).toEqual([]);
  });

  it('repeats the preview with exactly the host arguments and draws the result', async () => {
    const harness = await lostCall(spec);

    await harness.click('retry-button');

    expect(harness.calls).toEqual([{ name: spec.tool, args: spec.args() }]);
    expect(harness.visible('empty-state')).toBe(false);
    expect(harness.text('id-label')).toBe('Draft');
    expect(harness.text('id-value')).toBe('draft_retry_0001');
    expect(harness.text('status-pill')).toBe('Ready to send');
    expect(harness.visible('send-button')).toBe(true);
    expect(harness.html(previewPane(spec))).toContain(spec.drawnFromMeta);
  });

  it('sends the draft it created', async () => {
    const harness = await lostCall(spec);
    await harness.click('retry-button');

    await harness.click('send-button');

    expect(harness.callsTo(spec.sendTool)).toEqual([
      { name: spec.sendTool, args: { draftId: 'draft_retry_0001', confirm: true } }
    ]);
  });

  it('opens a checkout for the draft it created', async () => {
    const harness = await lostCall(spec, {
      previewResponse: () => ({
        structuredContent: spec.output('draft_retry_0001', eligibility(false)),
        _meta: spec.meta()
      })
    });
    await harness.click('retry-button');

    await harness.click('pay-send-button');

    expect(harness.callsTo('create_mail_checkout')).toEqual([
      { name: 'create_mail_checkout', args: { draftId: 'draft_retry_0001' } }
    ]);
  });

  it('draws a host result that arrives before the wait ends, and cancels the wait', async () => {
    const harness = mount(spec);
    await flush();

    await harness.deliverHostResult(spec.output('draft_host_0001'));

    expect(harness.pendingTimers()).toEqual([]);
    expect(harness.visible('empty-state')).toBe(false);
    expect(harness.text('id-value')).toBe('draft_host_0001');
    expect(harness.calls).toEqual([]);
  });

  it('draws a host result that arrives after the wait', async () => {
    const harness = await lostCall(spec);

    await harness.deliverHostResult(spec.output('draft_host_0001'));

    expect(harness.visible('empty-state')).toBe(false);
    expect(harness.visible('send-button')).toBe(true);
    expect(harness.text('id-value')).toBe('draft_host_0001');
  });

  it('switches to a late host draft while nothing has been done with its own', async () => {
    // Both drafts hold the same mail. The host's is the one the model knows,
    // so a send from the card and a send from the chat land on one draft.
    const harness = await lostCall(spec);
    await harness.click('retry-button');
    expect(harness.text('id-value')).toBe('draft_retry_0001');

    await harness.deliverHostResult(spec.output('draft_host_0001'));
    expect(harness.text('id-value')).toBe('draft_host_0001');

    await harness.click('send-button');
    expect(harness.callsTo(spec.sendTool).map(call => call.args.draftId)).toEqual(['draft_host_0001']);
  });

  it('keeps its own draft once it has sent it', async () => {
    const harness = await lostCall(spec);
    await harness.click('retry-button');
    await harness.click('send-button');

    await harness.deliverHostResult(spec.output('draft_host_0001'));

    expect(harness.text('id-label')).toBe('Order');
    expect(harness.text('id-value')).toBe('ord_sent_0001');
    expect(harness.text('status-pill')).toBe('With the printer');
    expect(harness.disabled('send-button')).toBe(true);
    // What a reopened card will read names the draft that was sent.
    expect(harness.savedStates.at(-1)).toEqual({
      v: 1,
      draftId: 'draft_retry_0001',
      sent: true,
      orderId: 'ord_sent_0001'
    });
    await harness.click('send-button');
    expect(harness.callsTo(spec.sendTool)).toHaveLength(1);
  });

  it('keeps its own draft while a checkout is being created, and after', async () => {
    const harness = await lostCall(spec, {
      previewResponse: () => ({
        structuredContent: spec.output('draft_retry_0001', eligibility(false)),
        _meta: spec.meta()
      })
    });
    await harness.click('retry-button');
    harness.holdCalls();
    await harness.click('pay-send-button');

    // The host result lands while create_mail_checkout is still running.
    await harness.deliverHostResult(spec.output('draft_host_0001', eligibility(false)));
    expect(harness.text('id-value')).toBe('draft_retry_0001');
    await harness.releaseCalls();
    await harness.deliverHostResult(spec.output('draft_host_0001', eligibility(false)));

    expect(harness.callsTo('create_mail_checkout').map(call => call.args.draftId)).toEqual([
      'draft_retry_0001'
    ]);
    expect(harness.text('id-label')).toBe('Purchase');
    expect(harness.text('id-value')).toBe('ord_checkout_0001');
    // The card never moved to the host draft, so it keeps the one it paid for.
    expect(harness.savedStates.at(-1)).toEqual({
      v: 1,
      draftId: 'draft_retry_0001',
      checkout: true,
      orderId: 'ord_checkout_0001',
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test'
    });
  });

  it('stays on its own draft after a send that failed', async () => {
    // A send that failed on the card's side may still have gone out, and the
    // server recognises a repeated send only when it names the same draft.
    const harness = await lostCall(spec, { failSends: 1 });
    await harness.click('retry-button');
    await harness.click('send-button');
    expect(harness.text('error-message')).toBe('Failed to send: host timed out');

    await harness.deliverHostResult(spec.output('draft_host_0001'));
    expect(harness.text('id-value')).toBe('draft_retry_0001');

    await harness.click('send-button');
    expect(harness.callsTo(spec.sendTool).map(call => call.args.draftId)).toEqual([
      'draft_retry_0001',
      'draft_retry_0001'
    ]);
  });

  it('stays on its own draft after a checkout that failed to open', async () => {
    const harness = await lostCall(spec, {
      failCheckouts: 1,
      previewResponse: () => ({
        structuredContent: spec.output('draft_retry_0001', eligibility(false)),
        _meta: spec.meta()
      })
    });
    await harness.click('retry-button');
    await harness.click('pay-send-button');
    expect(harness.text('error-message')).toBe('Unable to open checkout: host timed out');

    await harness.deliverHostResult(spec.output('draft_host_0001', eligibility(false)));
    expect(harness.text('id-value')).toBe('draft_retry_0001');

    await harness.click('pay-send-button');
    expect(harness.callsTo('create_mail_checkout').map(call => call.args.draftId)).toEqual([
      'draft_retry_0001',
      'draft_retry_0001'
    ]);
  });

  it('stops waiting on its own call after a minute, and still draws a late result', async () => {
    const harness = await lostCall(spec);
    harness.holdCalls();
    await harness.click('retry-button');

    await harness.runTimer(60000);

    expect(harness.text('error-message')).toBe(
      'No preview yet. It will appear here if it arrives. You can also try again, or ask for the preview in the chat.'
    );
    expect(harness.disabled('retry-button')).toBe(false);
    expect(harness.text('retry-button')).toBe('Create my preview');

    await harness.releaseCalls();

    expect(harness.text('id-value')).toBe('draft_retry_0001');
    expect(harness.visible('error-message')).toBe(false);
    expect(harness.visible('empty-state')).toBe(false);
  });

  it('clears its call timeout once the call answers', async () => {
    const harness = await lostCall(spec);

    await harness.click('retry-button');

    expect(harness.pendingTimers()).toEqual([]);
  });

  it('draws only the first preview when two of its own calls answer', async () => {
    let attempt = 0;
    const harness = await lostCall(spec, {
      previewResponse: () => {
        attempt += 1;
        return { structuredContent: spec.output(`draft_retry_000${attempt}`), _meta: spec.meta() };
      }
    });
    harness.holdCalls();
    await harness.click('retry-button');
    await harness.runTimer(60000);
    await harness.click('retry-button');
    expect(harness.callsTo(spec.tool)).toHaveLength(2);

    await harness.releaseCalls();

    expect(harness.text('id-value')).toBe('draft_retry_0001');
    await harness.click('send-button');
    expect(harness.callsTo(spec.sendTool).map(call => call.args.draftId)).toEqual(['draft_retry_0001']);
  });

  it.each<[string, unknown]>([
    ['a bare file reference', 'file_000000abc'],
    ['a file object without a download address', { file_id: 'file_1' }],
    ['a file object with an empty download address', { download_url: '', file_id: 'file_1' }],
    ['a file object without a file id', { download_url: 'https://files.example/x' }],
    ['null', null]
  ])('will not repeat a preview whose image argument is %s', async (_label, image) => {
    // The server reads anything else as no image and falls back to the most
    // recent upload, which may be a different picture.
    const harness = await lostCall(spec, {
      stamp: imageTool(spec),
      toolInput: { ...spec.args(), image }
    });

    expect(harness.visible('retry-button')).toBe(false);
    expect(harness.text('empty-message')).toMatch(/ask for the preview again in the chat\.$/);
  });

  it.each<[string, unknown]>([
    ['the attached file object', { download_url: 'https://files.example/photo', file_id: 'file_1', mime_type: 'image/jpeg' }],
    ['the empty string some clients send for no file', '']
  ])('repeats a preview whose image argument is %s, unchanged', async (_label, image) => {
    const args = { ...spec.args(), image };
    const harness = await lostCall(spec, { stamp: imageTool(spec), toolInput: args });

    await harness.click('retry-button');

    expect(harness.calls).toEqual([{ name: imageTool(spec), args }]);
  });

  it('keeps the host result if it arrives while its own call runs', async () => {
    const harness = await lostCall(spec);
    harness.holdCalls();
    await harness.click('retry-button');

    await harness.deliverHostResult(spec.output('draft_host_0001'));
    await harness.releaseCalls();

    expect(harness.text('id-value')).toBe('draft_host_0001');
    expect(harness.text('retry-button')).toBe('Create my preview');
    expect(harness.visible('empty-state')).toBe(false);
  });

  it('ignores a second click while its call runs', async () => {
    const harness = await lostCall(spec);
    harness.holdCalls();

    await harness.click('retry-button');
    expect(harness.disabled('retry-button')).toBe(true);
    expect(harness.text('retry-button')).toBe('Creating preview...');
    await harness.click('retry-button');
    await harness.releaseCalls();

    expect(harness.callsTo(spec.tool)).toHaveLength(1);
  });

  it('shows the tool error and stays retryable', async () => {
    let attempts = 0;
    const harness = await lostCall(spec, {
      previewResponse: () => {
        attempts += 1;
        if (attempts === 1) {
          return {
            isError: true,
            content: [{ type: 'text', text: 'The recipient address could not be verified.' }]
          };
        }
        return { structuredContent: spec.output('draft_retry_0002'), _meta: spec.meta() };
      }
    });

    await harness.click('retry-button');

    expect(harness.visible('error-message')).toBe(true);
    expect(harness.text('error-message')).toBe(
      'Unable to create the preview: The recipient address could not be verified.'
    );
    expect(harness.visible('retry-button')).toBe(true);
    expect(harness.disabled('retry-button')).toBe(false);
    expect(harness.text('retry-button')).toBe('Create my preview');
    expect(harness.visible('send-button')).toBe(false);

    await harness.click('retry-button');

    expect(harness.visible('error-message')).toBe(false);
    expect(harness.text('id-value')).toBe('draft_retry_0002');
  });

  it("clears a failed retry's error when the host result arrives", async () => {
    const harness = await lostCall(spec, {
      previewResponse: () => {
        throw new Error('host refused the call');
      }
    });
    await harness.click('retry-button');
    expect(harness.visible('error-message')).toBe(true);

    await harness.deliverHostResult(spec.output('draft_host_0001'));

    expect(harness.visible('error-message')).toBe(false);
    expect(harness.text('id-value')).toBe('draft_host_0001');
  });

  it('keeps a send error through a later re-render', async () => {
    // The error clearing above must stay limited to the card's first
    // preview, or a failed send would lose its message on the next render.
    const harness = mount(spec, { toolOutput: spec.output('draft_host_0001') });
    (harness.openai as Json).callTool = async () => {
      throw new Error('send refused');
    };
    await flush();
    await harness.click('send-button');
    expect(harness.text('error-message')).toBe('Failed to send: send refused');

    await harness.fireGlobals();

    expect(harness.visible('error-message')).toBe(true);
  });

  it('shows a thrown error', async () => {
    const harness = await lostCall(spec, {
      previewResponse: () => {
        throw new Error('host refused the call');
      }
    });

    await harness.click('retry-button');

    expect(harness.text('error-message')).toBe('Unable to create the preview: host refused the call');
    expect(harness.visible('retry-button')).toBe(true);
  });

  it('does not draw an error result, even one that carries a draft', async () => {
    const harness = await lostCall(spec, {
      previewResponse: () => ({
        isError: true,
        structuredContent: spec.output('draft_error_0001'),
        content: [{ type: 'text', text: 'Letter IRL could not finish the preview.' }]
      })
    });

    await harness.click('retry-button');

    expect(harness.text('error-message')).toBe(
      'Unable to create the preview: Letter IRL could not finish the preview.'
    );
    expect(harness.text('id-value')).not.toBe('draft_error_0001');
    expect(harness.visible('send-button')).toBe(false);
  });

  it('treats a result without a draft as a failure, not a preview', async () => {
    const harness = await lostCall(spec, {
      previewResponse: () => ({ structuredContent: { message: 'Something happened.' } })
    });

    await harness.click('retry-button');

    expect(harness.text('error-message')).toBe(
      'Unable to create the preview: The preview was not returned.'
    );
    expect(harness.visible('send-button')).toBe(false);
    expect(harness.visible('empty-state')).toBe(true);
  });

  it.each<[string, MountOptions]>([
    ['the page carries no tool stamp', { stamp: null }],
    ['the stamp names a tool this card does not draw', { stamp: 'send_letter' }],
    ['the host passed no arguments', { toolInput: null }],
    ['the arguments are not an object', { toolInput: ['recipient'] as unknown as Json }],
    ['the recipient is missing', { toolInput: { bodyText: 'x', signOff: 'y', message: 'z' } }],
    ['the host cannot run tools', { noCallTool: true }]
  ])('asks for the preview in the chat instead when %s', async (_label, options) => {
    const harness = await lostCall(spec, options);

    expect(harness.visible('empty-state')).toBe(true);
    expect(harness.visible('retry-button')).toBe(false);
    expect(harness.text('empty-message')).toMatch(/Otherwise, ask for the preview again in the chat\.$/);

    await harness.click('retry-button');
    expect(harness.calls).toEqual([]);
  });

  it('offers no retry when the arguments are incomplete', async () => {
    const harness = await lostCall(spec, { toolInput: spec.incompleteArgs() });

    expect(harness.visible('retry-button')).toBe(false);
  });
});

describe('LetterPreviewCard picks the right preview to repeat (#411)', () => {
  const imageArgs = (): Json => ({
    ...LETTER.args(),
    imageUrl: 'https://example.com/photo.jpg'
  });

  it.each([
    ['quote_and_preview_letter_with_header_image', 45000],
    ['quote_and_preview_letter_with_image', 45000],
    ['quote_and_preview_letter', 25000]
  ])('repeats %s, the tool its page was stamped with, after %i ms', async (tool, waitMs) => {
    const args = tool === 'quote_and_preview_letter' ? LETTER.args() : imageArgs();
    const harness = mount(LETTER, { stamp: tool, toolInput: args });
    await flush();
    expect(harness.pendingTimers().map(timer => timer.delay)).toEqual([waitMs]);
    await harness.runWait();

    await harness.click('retry-button');

    expect(harness.calls).toEqual([{ name: tool, args }]);
  });

  it.each([
    ['an imageUrl', { imageUrl: 'https://example.com/photo.jpg' }],
    ['an attached image', { image: { download_url: 'https://files.example/x', file_id: 'file_1' } }],
    ['an empty image field', { image: '' }]
  ])('will not repeat a text-only preview whose input carries %s', async (_label, extra) => {
    // A client on a pre-#411 tool list draws image letters from the text-only
    // template. Repeating that call would drop the image.
    const harness = await lostCall(LETTER, {
      stamp: 'quote_and_preview_letter',
      toolInput: { ...LETTER.args(), ...extra }
    });

    expect(harness.visible('retry-button')).toBe(false);
    expect(harness.text('empty-message')).toMatch(/ask for the preview again in the chat\.$/);
  });

  it('draws the letter text from its arguments when the result carries no preview HTML', async () => {
    // Whether the host hands _meta back to a card's own call is not
    // documented, so the card must not depend on it.
    const harness = await lostCall(LETTER, {
      previewResponse: () => ({ structuredContent: LETTER.output('draft_retry_0001') })
    });

    await harness.click('retry-button');

    const mockup = harness.document.getElementById('mockup-container');
    expect(mockup?.querySelector('.body-text')?.textContent).toBe('Hello Sam, see you soon.');
    expect(mockup?.querySelector('.sign-off')?.textContent).toBe('Love, Dee');
  });

  it('escapes argument text it draws', async () => {
    const hostile = { ...LETTER.args(), bodyText: '<img src=x onerror="window.pwned=1">', signOff: '<b>x</b>' };
    const harness = await lostCall(LETTER, {
      toolInput: hostile,
      previewResponse: () => ({ structuredContent: LETTER.output('draft_retry_0001') })
    });

    await harness.click('retry-button');

    const mockup = harness.document.getElementById('mockup-container');
    expect(mockup?.querySelector('img')).toBeNull();
    expect(mockup?.querySelector('.body-text b, .sign-off b')).toBeNull();
    expect(mockup?.querySelector('.body-text')?.textContent).toBe(hostile.bodyText);
  });

  it('draws the image preview from the result metadata of its own call', async () => {
    const harness = await lostCall(LETTER, {
      stamp: 'quote_and_preview_letter_with_header_image',
      toolInput: imageArgs(),
      previewResponse: () => ({
        structuredContent: LETTER.output('draft_retry_0001', { layoutType: 'header_image' }),
        _meta: { ...LETTER.meta(), headerImagePreview: 'data:image/jpeg;base64,AAAA' }
      })
    });

    await harness.click('retry-button');

    const image = harness.document.querySelector('#mockup-container .header-image-wrapper img');
    expect(image?.getAttribute('src')).toBe('data:image/jpeg;base64,AAAA');
    expect(harness.document.querySelector('#mockup-container .image-not-shown')).toBeNull();
  });

  it.each([
    ['header_image', 'quote_and_preview_letter_with_header_image', '.header-image-wrapper'],
    ['inline_image', 'quote_and_preview_letter_with_image', '.inline-image-wrapper']
  ])('says so when it cannot show the image of a %s letter', async (layoutType, tool, wrapper) => {
    // Whether the host returns _meta to a card's own call is not documented.
    // An image letter drawn without its image must not pass for a finished
    // preview.
    const harness = await lostCall(LETTER, {
      stamp: tool,
      toolInput: imageArgs(),
      previewResponse: () => ({ structuredContent: LETTER.output('draft_retry_0001', { layoutType }) })
    });

    await harness.click('retry-button');

    const mockup = harness.document.getElementById('mockup-container');
    expect(mockup?.querySelector(`${wrapper} .image-not-shown`)?.textContent).toBe(
      'Image not shown on this card'
    );
    expect(mockup?.querySelector('img')).toBeNull();
  });

  it('shows no image placeholder on a text-only letter', async () => {
    const harness = await lostCall(LETTER, {
      previewResponse: () => ({ structuredContent: LETTER.output('draft_retry_0001') })
    });

    await harness.click('retry-button');

    expect(harness.document.querySelector('#mockup-container .image-not-shown')).toBeNull();
  });
});

describe.each([LETTER, POSTCARD])('$file keeps what it did for a reopened conversation', spec => {
  it('remembers the draft it shows, once', async () => {
    const harness = mount(spec, { toolOutput: spec.output('draft_host_0001') });
    await flush();
    await harness.fireGlobals();

    expect(harness.savedStates).toEqual([{ v: 1, draftId: 'draft_host_0001' }]);
  });

  it('remembers a send', async () => {
    const harness = mount(spec, { toolOutput: spec.output('draft_host_0001') });
    await flush();

    await harness.click('send-button');

    expect(harness.savedStates.at(-1)).toEqual({
      v: 1,
      draftId: 'draft_host_0001',
      sent: true,
      orderId: 'ord_sent_0001'
    });
  });

  it('does not remember a send that failed', async () => {
    const harness = mount(spec, { toolOutput: spec.output('draft_host_0001') });
    (harness.openai as Json).callTool = async () => {
      throw new Error('send refused');
    };
    await flush();

    await harness.click('send-button');

    expect(harness.savedStates).toEqual([{ v: 1, draftId: 'draft_host_0001' }]);
  });

  it('remembers a checkout', async () => {
    const harness = mount(spec, {
      toolOutput: spec.output('draft_host_0001', eligibility(false))
    });
    await flush();

    await harness.click('pay-send-button');

    expect(harness.savedStates.at(-1)).toEqual({
      v: 1,
      draftId: 'draft_host_0001',
      checkout: true,
      orderId: 'ord_checkout_0001',
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test'
    });
  });

  it('offers the kept checkout link while a reopened order is unpaid', async () => {
    const harness = mount(spec, {
      widgetState: {
        v: 1,
        draftId: 'draft_host_0001',
        checkout: true,
        orderId: 'ord_kept_0001',
        checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_kept'
      }
    });
    await flush();

    expect(harness.text('status-pill')).toBe('Checkout open - waiting for payment');
    expect(harness.visible('checkout-link')).toBe(true);
    expect(harness.document.getElementById('checkout-link')?.getAttribute('href')).toBe(
      'https://checkout.stripe.com/c/pay/cs_kept'
    );
    expect(harness.text('checkout-link')).toBe('Open checkout');
    expect(harness.visible('pay-send-button')).toBe(false);
  });

  it('does not offer the kept checkout link once the order is paid', async () => {
    const harness = mount(spec, {
      widgetState: {
        v: 1,
        draftId: 'draft_host_0001',
        checkout: true,
        orderId: 'ord_kept_0001',
        checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_kept'
      },
      purchaseStatus: { purchaseStatus: 'processing' }
    });
    await flush();

    expect(harness.text('status-pill')).toBe('Paid - preparing mail');
    expect(harness.visible('checkout-link')).toBe(false);
  });

  it('ignores a kept checkout link that is not https', async () => {
    const harness = mount(spec, {
      widgetState: {
        v: 1,
        draftId: 'draft_host_0001',
        checkout: true,
        orderId: 'ord_kept_0001',
        checkoutUrl: 'javascript:alert(1)'
      }
    });
    await flush();

    expect(harness.visible('checkout-link')).toBe(false);
    expect(harness.document.getElementById('checkout-link')?.getAttribute('href')).toBe('#');
  });

  it('keeps no checkout link that is not https', async () => {
    const harness = mount(spec, {
      toolOutput: spec.output('draft_host_0001', eligibility(false))
    });
    (harness.openai as Json).callTool = async (name: string) =>
      name === 'create_mail_checkout'
        ? { structuredContent: { orderId: 'ord_checkout_0001', checkoutUrl: 'http://checkout.example/pay' } }
        : { structuredContent: { purchaseStatus: 'pending_payment' } };
    await flush();

    await harness.click('pay-send-button');

    expect(harness.savedStates.at(-1)).toEqual({
      v: 1,
      draftId: 'draft_host_0001',
      checkout: true,
      orderId: 'ord_checkout_0001'
    });
  });

  it('switches to the kept order when the saved state arrives after the first render', async () => {
    const harness = mount(spec);
    await flush();
    expect(harness.pendingTimers().map(timer => timer.delay)).toEqual([spec.waitMs]);

    harness.openai.widgetState = {
      v: 1,
      draftId: 'draft_host_0001',
      sent: true,
      orderId: 'ord_sent_0001'
    };
    await harness.fireGlobals();

    expect(harness.pendingTimers()).toEqual([]);
    expect(harness.text('status-pill')).toBe('With the printer');
    expect(harness.visible('retry-button')).toBe(false);
  });

  it('is not mistaken for a reopened card once the host applies its own saved state', async () => {
    const harness = mount(spec, {
      toolOutput: spec.output('draft_host_0001'),
      toolResponseMetadata: spec.meta()
    });
    await flush();
    await harness.click('send-button');

    harness.openai.widgetState = harness.savedStates.at(-1);
    await harness.fireGlobals();

    expect(harness.visible('empty-state')).toBe(false);
    expect(harness.text('id-value')).toBe('ord_sent_0001');
    expect(harness.html(previewPane(spec))).toContain(spec.drawnFromMeta);
    expect(harness.html(previewPane(spec))).not.toContain('reopened conversation');
  });

  it('shows a reopened card that sent its mail as sent, and offers nothing', async () => {
    const harness = mount(spec, {
      widgetState: { v: 1, draftId: 'draft_host_0001', sent: true, orderId: 'ord_sent_0001' }
    });
    await flush();

    expect(harness.pendingTimers()).toEqual([]);
    expect(harness.visible('empty-state')).toBe(true);
    expect(harness.text('empty-message')).toBe(
      `This ${spec.noun} was sent to the printer from this card. Ask for its status in the chat.`
    );
    expect(harness.text('status-pill')).toBe('With the printer');
    expect(harness.text('id-label')).toBe('Order');
    expect(harness.text('id-value')).toBe('ord_sent_0001');
    expect(harness.visible('retry-button')).toBe(false);
    expect(harness.visible('send-button')).toBe(false);
    expect(harness.visible('purchase-actions')).toBe(false);

    // A host that does replay the result changes nothing.
    await harness.deliverHostResult(spec.output('draft_host_0001'));

    expect(harness.visible('send-button')).toBe(false);
    expect(harness.visible('retry-button')).toBe(false);
    expect(harness.text('status-pill')).toBe('With the printer');
    expect(harness.calls).toEqual([]);
  });

  it('follows the order of a reopened card that opened a checkout', async () => {
    const harness = mount(spec, {
      widgetState: { v: 1, draftId: 'draft_host_0001', checkout: true, orderId: 'ord_kept_0001' },
      purchaseStatus: { purchaseStatus: 'submitted' }
    });
    await flush();

    expect(harness.callsTo('get_purchase_status')).toEqual([
      { name: 'get_purchase_status', args: { orderId: 'ord_kept_0001' } }
    ]);
    expect(harness.text('status-pill')).toBe('With the printer');
    expect(harness.text('id-label')).toBe('Purchase');
    expect(harness.text('id-value')).toBe('ord_kept_0001');
    expect(harness.visible('check-status-button')).toBe(true);
    expect(harness.visible('pay-send-button')).toBe(false);
    expect(harness.visible('buy-pack-button')).toBe(false);
    expect(harness.visible('send-button')).toBe(false);
    expect(harness.visible('retry-button')).toBe(false);
    expect(harness.visible('checkout-link')).toBe(false);

    await harness.deliverHostResult(spec.output('draft_host_0001', eligibility(false)));

    expect(harness.visible('pay-send-button')).toBe(false);
    expect(harness.text('status-pill')).toBe('With the printer');
    expect(harness.callsTo('create_mail_checkout')).toEqual([]);
  });

  it('keeps polling a reopened checkout that is still unpaid', async () => {
    const harness = mount(spec, {
      widgetState: { v: 1, draftId: 'draft_host_0001', checkout: true, orderId: 'ord_kept_0001' }
    });
    await flush();

    expect(harness.text('status-pill')).toBe('Checkout open - waiting for payment');
    expect(harness.pendingTimers()).toHaveLength(1);

    await harness.fireGlobals();
    expect(harness.pendingTimers()).toHaveLength(1);
    expect(harness.callsTo('get_purchase_status')).toHaveLength(1);
  });

  it('says a checkout was started when it cannot look the order up', async () => {
    const harness = mount(spec, {
      widgetState: { v: 1, draftId: 'draft_host_0001', checkout: true },
      noCallTool: true
    });
    await flush();

    expect(harness.text('status-pill')).toBe('Checkout started');
    expect(harness.text('id-value')).toBe(spec.file === 'LetterPreviewCard' ? '—' : '-');
    expect(harness.visible('retry-button')).toBe(false);
    expect(harness.visible('check-status-button')).toBe(false);
  });

  it('offers a reopened card that only showed a preview the preview again, at once', async () => {
    const harness = mount(spec, { widgetState: { v: 1, draftId: 'draft_host_0001' } });
    await flush();

    expect(harness.pendingTimers()).toEqual([]);
    expect(harness.visible('empty-state')).toBe(true);
    expect(harness.visible('retry-button')).toBe(true);

    await harness.click('retry-button');
    expect(harness.text('id-value')).toBe('draft_retry_0001');
    expect(harness.savedStates.at(-1)).toEqual({ v: 1, draftId: 'draft_retry_0001' });

    // Sending from here is remembered on top of the resumed state.
    await harness.click('send-button');
    expect(harness.savedStates.at(-1)).toEqual({
      v: 1,
      draftId: 'draft_retry_0001',
      sent: true,
      orderId: 'ord_sent_0001'
    });
    expect(harness.visible('empty-state')).toBe(false);
  });

  it.each<[string, unknown]>([
    ['another version', { v: 2, draftId: 'draft_host_0001', sent: true }],
    ['no draft', { v: 1, sent: true, orderId: 'ord_sent_0001' }],
    ['a draft that is not a string', { v: 1, draftId: 42, sent: true }],
    ['not an object', 'sent']
  ])('treats kept state with %s as a fresh card', async (_label, widgetState) => {
    const harness = mount(spec, { widgetState });
    await flush();

    expect(harness.visible('empty-state')).toBe(false);
    expect(harness.text('status-pill')).toBe('Loading...');
    expect(harness.pendingTimers().map(timer => timer.delay)).toEqual([spec.waitMs]);
  });

  it('does not treat a sent flag that is not true as a send', async () => {
    const harness = mount(spec, { widgetState: { v: 1, draftId: 'draft_host_0001', sent: 'yes' } });
    await flush();

    expect(harness.visible('retry-button')).toBe(true);
    expect(harness.text('status-pill')).toBe('No preview');
  });
});
