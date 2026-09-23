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
  /** What the send tool answers, instead of the usual order (#412). */
  sendResponse?: (args: Json) => unknown;
  /** What create_mail_checkout answers, instead of the usual checkout (#412). */
  checkoutResponse?: (args: Json) => unknown;
  /** The host's file bridge. Only the functions given are exposed. */
  fileApis?: {
    selectFiles?: () => unknown;
    uploadFile?: (file: unknown) => unknown;
    getFileDownloadUrl?: (arg: unknown) => unknown;
  };
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
        if (options.sendResponse) return options.sendResponse(args);
        if (sendFailures > 0) {
          sendFailures -= 1;
          throw new Error('host timed out');
        }
        return { structuredContent: { orderId: 'ord_sent_0001' } };
      }
      if (name === 'create_mail_checkout') {
        if (options.checkoutResponse) return options.checkoutResponse(args);
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

  const fileCalls: Array<{ name: string; arg: unknown }> = [];
  for (const [name, fn] of Object.entries(options.fileApis ?? {})) {
    openai[name] = async (arg: unknown) => {
      fileCalls.push({ name, arg });
      return (fn as (value: unknown) => unknown)(arg);
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
    fileCalls,
    /** Hand the upload input a file, as the device picker would. */
    pickDeviceFile: async (file: { name: string; type: string; size?: number }) => {
      const input = document.getElementById('image-file-input') as HTMLInputElement;
      const picked = new dom.window.File(['x'], file.name, { type: file.type });
      if (file.size !== undefined) Object.defineProperty(picked, 'size', { value: file.size });
      Object.defineProperty(input, 'files', { value: [picked], configurable: true });
      input.dispatchEvent(new dom.window.Event('change'));
      await flush();
      return picked;
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

  it('suggests a higher thinking effort once the wait runs out', async () => {
    const harness = mount(spec);
    await flush();
    expect(harness.visible('empty-hint')).toBe(false);

    await harness.runWait();

    expect(harness.visible('empty-hint')).toBe(true);
    expect(harness.text('empty-hint')).toBe(
      "Tip: with Instant selected, ChatGPT sometimes doesn't run an action you approved. A higher thinking effort can help."
    );
  });

  it('keeps the tip when it cannot repeat the call', async () => {
    const harness = await lostCall(spec, { noCallTool: true });

    expect(harness.visible('retry-button')).toBe(false);
    expect(harness.visible('empty-hint')).toBe(true);
  });

  it('repeats the preview with exactly the host arguments and draws the result', async () => {
    const harness = await lostCall(spec);

    await harness.click('retry-button');

    expect(harness.calls).toEqual([{ name: spec.tool, args: spec.args() }]);
    expect(harness.visible('empty-state')).toBe(false);
    expect(harness.visible('empty-hint')).toBe(false);
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
    expect(harness.visible('empty-hint')).toBe(false);
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

  it('shows no timeout message over a preview that arrived meanwhile', async () => {
    const harness = await lostCall(spec);
    harness.holdCalls();
    await harness.click('retry-button');
    await harness.deliverHostResult(spec.output('draft_host_0001'));

    await harness.runTimer(60000);

    expect(harness.visible('error-message')).toBe(false);
    expect(harness.text('id-value')).toBe('draft_host_0001');

    await harness.releaseCalls();

    expect(harness.visible('error-message')).toBe(false);
    expect(harness.text('id-value')).toBe('draft_host_0001');
  });

  it('shows no retry error over a preview that arrived meanwhile', async () => {
    const harness = await lostCall(spec, {
      previewResponse: () => {
        throw new Error('host refused the call');
      }
    });
    harness.holdCalls();
    await harness.click('retry-button');
    await harness.deliverHostResult(spec.output('draft_host_0001'));

    await harness.releaseCalls();

    expect(harness.callsTo(spec.tool)).toHaveLength(1);
    expect(harness.visible('error-message')).toBe(false);
    expect(harness.text('id-value')).toBe('draft_host_0001');
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

describe.each([LETTER, POSTCARD])('$file previews a chat image picked again (#414)', spec => {
  // ChatGPT web passes an image attached or generated in the chat to the card
  // as a sandbox path, which the server cannot open.
  const CHAT_IMAGE = '/mnt/data/beach.png';
  const LINK = 'https://files.example/download/file_pick';
  const chatImageArgs = (): Json => ({ ...spec.args(), image: CHAT_IMAGE });
  /** What the card sends: the host's arguments with the image replaced by the link. */
  const linkedArgs = (): Json => {
    const { image, imageUrl, ...rest } = chatImageArgs();
    return { ...rest, imageUrl: LINK };
  };
  const allFileApis = (overrides: MountOptions['fileApis'] = {}): MountOptions['fileApis'] => ({
    selectFiles: () => [{ fileId: 'file_pick', fileName: 'beach.png', mimeType: 'image/png' }],
    uploadFile: () => ({ fileId: 'file_pick' }),
    getFileDownloadUrl: () => ({ downloadUrl: LINK }),
    ...overrides
  });
  const lostChatImage = (options: MountOptions = {}) =>
    lostCall(spec, { stamp: imageTool(spec), toolInput: chatImageArgs(), fileApis: allFileApis(), ...options });

  it('offers to choose or upload the image instead of repeating the call', async () => {
    const harness = await lostChatImage();

    expect(harness.visible('retry-button')).toBe(false);
    expect(harness.visible('choose-image-button')).toBe(true);
    expect(harness.visible('upload-image-button')).toBe(true);
    expect(harness.text('choose-image-button')).toBe('Choose from library');
    expect(harness.text('upload-image-button')).toBe('Upload the image');
    expect(harness.text('empty-message')).toBe(
      `No preview is showing on this card. If this ${spec.noun} was already sent, there is nothing more to do here. ` +
        'Otherwise, choose the image from your ChatGPT library or upload it again, and this card creates the preview.'
    );
    expect(harness.visible('empty-hint')).toBe(true);
    expect(harness.calls).toEqual([]);
    expect(harness.fileCalls).toEqual([]);
  });

  it('previews an image chosen from the library by link', async () => {
    const harness = await lostChatImage();

    await harness.click('choose-image-button');

    expect(harness.fileCalls).toEqual([
      { name: 'selectFiles', arg: undefined },
      { name: 'getFileDownloadUrl', arg: { fileId: 'file_pick' } }
    ]);
    expect(harness.calls).toEqual([{ name: imageTool(spec), args: linkedArgs() }]);
    expect(harness.visible('empty-state')).toBe(false);
    expect(harness.text('id-value')).toBe('draft_retry_0001');
    expect(harness.html(previewPane(spec))).toContain(spec.drawnFromMeta);
    expect(harness.savedStates.at(-1)).toEqual({ v: 1, draftId: 'draft_retry_0001' });

    await harness.click('send-button');
    expect(harness.callsTo(spec.sendTool).map(call => call.args.draftId)).toEqual(['draft_retry_0001']);
  });

  it('previews an uploaded image by link', async () => {
    const harness = await lostChatImage();

    await harness.click('upload-image-button');
    const file = await harness.pickDeviceFile({ name: 'beach.jpg', type: 'image/jpeg' });

    expect(harness.fileCalls).toEqual([
      { name: 'uploadFile', arg: file },
      { name: 'getFileDownloadUrl', arg: { fileId: 'file_pick' } }
    ]);
    expect(harness.calls).toEqual([{ name: imageTool(spec), args: linkedArgs() }]);
    expect(harness.text('id-value')).toBe('draft_retry_0001');
  });

  it('reads the file id and link under either spelling', async () => {
    const harness = await lostChatImage({
      fileApis: allFileApis({
        selectFiles: () => [{ file_id: 'file_pick', mime_type: 'image/webp' }],
        getFileDownloadUrl: () => ({ download_url: LINK })
      })
    });

    await harness.click('choose-image-button');

    expect(harness.calls).toEqual([{ name: imageTool(spec), args: linkedArgs() }]);
  });

  it.each<[string, MountOptions['fileApis'], string, boolean, boolean]>([
    ['no library picker', { uploadFile: () => ({ fileId: 'f' }), getFileDownloadUrl: () => ({ downloadUrl: LINK }) },
      'Otherwise, upload the image again, and this card creates the preview.', false, true],
    ['no uploads', { selectFiles: () => [], getFileDownloadUrl: () => ({ downloadUrl: LINK }) },
      'Otherwise, choose the image from your ChatGPT library, and this card creates the preview.', true, false],
    ['no file links', { selectFiles: () => [], uploadFile: () => ({ fileId: 'f' }) },
      'Otherwise, ask for the preview again in the chat.', false, false]
  ])('with %s, offers only what the host can do', async (_label, fileApis, next, choose, upload) => {
    const harness = await lostChatImage({ fileApis });

    expect(harness.visible('choose-image-button')).toBe(choose);
    expect(harness.visible('upload-image-button')).toBe(upload);
    expect(harness.text('empty-message').endsWith(next)).toBe(true);
  });

  it('offers nothing new when the host cannot run tools', async () => {
    const harness = await lostChatImage({ noCallTool: true });

    expect(harness.visible('choose-image-button')).toBe(false);
    expect(harness.visible('upload-image-button')).toBe(false);
    expect(harness.text('empty-message')).toMatch(/ask for the preview again in the chat\.$/);
  });

  it('keeps the retry for an image it can pass back', async () => {
    const harness = await lostCall(spec, {
      stamp: imageTool(spec),
      toolInput: { ...spec.args(), image: { download_url: 'https://files.example/x', file_id: 'file_1' } },
      fileApis: allFileApis()
    });

    expect(harness.visible('retry-button')).toBe(true);
    expect(harness.visible('choose-image-button')).toBe(false);
    expect(harness.visible('upload-image-button')).toBe(false);
  });

  it.each<[string, unknown]>([
    ['nothing', []],
    ['a list without a file id', [{ fileName: 'x.png' }]],
    ['something that is not a list', { fileId: 'file_pick' }]
  ])('says so when the library returns %s', async (_label, answer) => {
    const harness = await lostChatImage({ fileApis: allFileApis({ selectFiles: () => answer }) });

    await harness.click('choose-image-button');

    expect(harness.text('error-message')).toBe('No image was chosen.');
    expect(harness.visible('error-message')).toBe(true);
    expect(harness.calls).toEqual([]);
    expect(harness.disabled('choose-image-button')).toBe(false);
    expect(harness.text('choose-image-button')).toBe('Choose from library');
  });

  it('says so when the library picker fails or is closed', async () => {
    const harness = await lostChatImage({
      fileApis: allFileApis({
        selectFiles: () => {
          throw new Error('cancelled');
        }
      })
    });

    await harness.click('choose-image-button');

    expect(harness.text('error-message')).toBe('No image was chosen.');
    expect(harness.calls).toEqual([]);
  });

  it('clears an earlier error as soon as a new pick starts', async () => {
    let calls = 0;
    const harness = await lostChatImage({
      fileApis: allFileApis({ selectFiles: () => (calls++ === 0 ? [] : new Promise(() => {})) })
    });
    await harness.click('choose-image-button');
    expect(harness.visible('error-message')).toBe(true);

    await harness.click('choose-image-button');

    expect(harness.visible('error-message')).toBe(false);
    expect(harness.text('choose-image-button')).toBe('Opening your library...');
  });

  it('clears an earlier error as soon as a new upload starts', async () => {
    let calls = 0;
    const harness = await lostChatImage({
      fileApis: allFileApis({
        uploadFile: () => {
          if (calls++ === 0) throw new Error('network down');
          return new Promise(() => {});
        }
      })
    });
    await harness.pickDeviceFile({ name: 'beach.jpg', type: 'image/jpeg' });
    expect(harness.visible('error-message')).toBe(true);

    await harness.pickDeviceFile({ name: 'beach.jpg', type: 'image/jpeg' });

    expect(harness.visible('error-message')).toBe(false);
    expect(harness.text('upload-image-button')).toBe('Uploading...');
  });

  it('refuses a library file that is not a supported image', async () => {
    const harness = await lostChatImage({
      fileApis: allFileApis({ selectFiles: () => [{ fileId: 'file_pick', mimeType: 'application/pdf' }] })
    });

    await harness.click('choose-image-button');

    expect(harness.text('error-message')).toBe('That file is not a JPEG, PNG or WebP image.');
    expect(harness.fileCalls.map(call => call.name)).toEqual(['selectFiles']);
    expect(harness.calls).toEqual([]);
  });

  it.each<[string, { name: string; type: string; size?: number }, string]>([
    ['a file that is not a supported image', { name: 'notes.pdf', type: 'application/pdf' }, 'That file is not a JPEG, PNG or WebP image.'],
    ['an image over 10 MB', { name: 'big.jpg', type: 'image/jpeg', size: 10 * 1024 * 1024 + 1 }, 'That image is larger than 10 MB.']
  ])('refuses to upload %s', async (_label, file, message) => {
    const harness = await lostChatImage();

    await harness.pickDeviceFile(file);

    expect(harness.text('error-message')).toBe(message);
    expect(harness.fileCalls).toEqual([]);
    expect(harness.calls).toEqual([]);
  });

  it('uploads an image of exactly 10 MB', async () => {
    const harness = await lostChatImage();

    await harness.pickDeviceFile({ name: 'big.jpg', type: 'image/jpeg', size: 10 * 1024 * 1024 });

    expect(harness.calls).toEqual([{ name: imageTool(spec), args: linkedArgs() }]);
  });

  it('shows a failed upload and stays usable', async () => {
    let failures = 1;
    const harness = await lostChatImage({
      fileApis: allFileApis({
        uploadFile: () => {
          if (failures-- > 0) throw new Error('network down');
          return { fileId: 'file_pick' };
        }
      })
    });

    await harness.pickDeviceFile({ name: 'beach.jpg', type: 'image/jpeg' });

    expect(harness.text('error-message')).toBe('Unable to upload the image: network down');
    expect(harness.calls).toEqual([]);
    expect(harness.disabled('upload-image-button')).toBe(false);
    expect(harness.text('upload-image-button')).toBe('Upload the image');

    await harness.pickDeviceFile({ name: 'beach.jpg', type: 'image/jpeg' });

    expect(harness.visible('error-message')).toBe(false);
    expect(harness.calls).toEqual([{ name: imageTool(spec), args: linkedArgs() }]);
  });

  it('says so when an upload returns no file', async () => {
    const harness = await lostChatImage({ fileApis: allFileApis({ uploadFile: () => ({}) }) });

    await harness.pickDeviceFile({ name: 'beach.jpg', type: 'image/jpeg' });

    expect(harness.text('error-message')).toBe('The upload did not return a file.');
    expect(harness.calls).toEqual([]);
  });

  it.each<[string, () => unknown]>([
    ['no link', () => ({})],
    ['a link that is not https', () => ({ downloadUrl: 'http://files.example/x' })],
    ['an error', () => {
      throw new Error('expired');
    }]
  ])('says so when the host answers the link request with %s', async (_label, getFileDownloadUrl) => {
    const harness = await lostChatImage({ fileApis: allFileApis({ getFileDownloadUrl }) });

    await harness.click('choose-image-button');

    expect(harness.text('error-message')).toBe('Unable to get a link to that image. Please try again.');
    expect(harness.calls).toEqual([]);
    expect(harness.disabled('choose-image-button')).toBe(false);
  });

  it('shows the preview error for the picked image and stays usable', async () => {
    const harness = await lostChatImage({
      previewResponse: () => ({ isError: true, content: [{ type: 'text', text: 'Image is too small for print quality.' }] })
    });

    await harness.click('choose-image-button');

    expect(harness.text('error-message')).toBe('Unable to create the preview: Image is too small for print quality.');
    expect(harness.visible('empty-state')).toBe(true);
    expect(harness.disabled('choose-image-button')).toBe(false);
    expect(harness.text('choose-image-button')).toBe('Choose from library');
  });

  it('ignores clicks while a pick is running', async () => {
    let answer: (files: unknown) => void = () => {};
    const harness = await lostChatImage({
      fileApis: allFileApis({ selectFiles: () => new Promise(resolve => { answer = resolve; }) })
    });

    await harness.click('choose-image-button');
    expect(harness.disabled('choose-image-button')).toBe(true);
    expect(harness.disabled('upload-image-button')).toBe(true);
    await harness.click('choose-image-button');
    await harness.click('upload-image-button');
    await harness.pickDeviceFile({ name: 'beach.jpg', type: 'image/jpeg' });
    expect(harness.fileCalls.map(call => call.name)).toEqual(['selectFiles']);

    answer([{ fileId: 'file_pick', mimeType: 'image/png' }]);
    await flush();

    expect(harness.calls).toEqual([{ name: imageTool(spec), args: linkedArgs() }]);
  });

  it('gives the buttons back when the library has not answered, and still uses a later pick', async () => {
    let answer: (files: unknown) => void = () => {};
    const harness = await lostChatImage({
      fileApis: allFileApis({ selectFiles: () => new Promise(resolve => { answer = resolve; }) })
    });
    await harness.click('choose-image-button');

    await harness.runTimer(120000);

    expect(harness.disabled('choose-image-button')).toBe(false);
    expect(harness.disabled('upload-image-button')).toBe(false);
    expect(harness.text('choose-image-button')).toBe('Choose from library');
    expect(harness.text('error-message')).toBe('Still waiting for the image. If nothing happened, please try again.');

    // Someone browsing the library for a while still gets their pick.
    harness.holdCalls();
    answer([{ fileId: 'file_pick', mimeType: 'image/png' }]);
    await flush();
    expect(harness.disabled('choose-image-button')).toBe(true);
    expect(harness.disabled('upload-image-button')).toBe(true);
    expect(harness.visible('error-message')).toBe(false);
    expect(harness.calls).toEqual([{ name: imageTool(spec), args: linkedArgs() }]);

    await harness.releaseCalls();
    expect(harness.text('id-value')).toBe('draft_retry_0001');
  });

  it('drops a waiting pick once the person starts again', async () => {
    let answer: (files: unknown) => void = () => {};
    const harness = await lostChatImage({
      fileApis: allFileApis({
        selectFiles: () => new Promise(resolve => { answer = resolve; }),
        uploadFile: () => new Promise(() => {})
      })
    });
    await harness.click('choose-image-button');
    await harness.runTimer(120000);

    await harness.pickDeviceFile({ name: 'beach.jpg', type: 'image/jpeg' });
    expect(harness.text('upload-image-button')).toBe('Uploading...');
    answer([{ fileId: 'file_pick', mimeType: 'image/png' }]);
    await flush();

    expect(harness.fileCalls.map(call => call.name)).toEqual(['selectFiles', 'uploadFile']);
    expect(harness.calls).toEqual([]);
    // The upload still owns the buttons.
    expect(harness.disabled('choose-image-button')).toBe(true);
    expect(harness.text('upload-image-button')).toBe('Uploading...');
  });

  it('gives the buttons back when an upload has not answered, and still uses a later one', async () => {
    let answer: (value: unknown) => void = () => {};
    const harness = await lostChatImage({
      fileApis: allFileApis({ uploadFile: () => new Promise(resolve => { answer = resolve; }) })
    });
    await harness.pickDeviceFile({ name: 'beach.jpg', type: 'image/jpeg' });

    await harness.runTimer(120000);

    expect(harness.disabled('upload-image-button')).toBe(false);
    expect(harness.text('upload-image-button')).toBe('Upload the image');
    expect(harness.text('error-message')).toBe('Still waiting for the image. If nothing happened, please try again.');

    answer({ fileId: 'file_pick' });
    await flush();
    expect(harness.calls).toEqual([{ name: imageTool(spec), args: linkedArgs() }]);
  });

  it('gives the buttons back when the image link has not answered', async () => {
    let answer: (value: unknown) => void = () => {};
    const harness = await lostChatImage({
      fileApis: allFileApis({ getFileDownloadUrl: () => new Promise(resolve => { answer = resolve; }) })
    });
    await harness.click('choose-image-button');
    expect(harness.fileCalls.map(call => call.name)).toEqual(['selectFiles', 'getFileDownloadUrl']);

    await harness.runTimer(120000);

    expect(harness.disabled('choose-image-button')).toBe(false);
    expect(harness.text('error-message')).toBe('Still waiting for the image. If nothing happened, please try again.');

    harness.holdCalls();
    answer({ downloadUrl: LINK });
    await flush();
    expect(harness.calls).toEqual([{ name: imageTool(spec), args: linkedArgs() }]);
    // The late link took the buttons again for the preview call.
    expect(harness.disabled('upload-image-button')).toBe(true);
    await harness.releaseCalls();
    expect(harness.text('id-value')).toBe('draft_retry_0001');
  });

  it('ignores an image link that answers after a preview arrived', async () => {
    let answer: (value: unknown) => void = () => {};
    const harness = await lostChatImage({
      fileApis: allFileApis({ getFileDownloadUrl: () => new Promise(resolve => { answer = resolve; }) })
    });
    await harness.click('choose-image-button');

    await harness.deliverHostResult(spec.output('draft_host_0001'));
    answer({ downloadUrl: LINK });
    await flush();

    expect(harness.calls).toEqual([]);
    expect(harness.text('id-value')).toBe('draft_host_0001');
  });

  it('ignores an image link that answers after the person started again', async () => {
    let answer: (value: unknown) => void = () => {};
    let links = 0;
    const harness = await lostChatImage({
      fileApis: allFileApis({
        getFileDownloadUrl: () => (links++ === 0 ? new Promise(resolve => { answer = resolve; }) : new Promise(() => {}))
      })
    });
    await harness.click('choose-image-button');
    await harness.runTimer(120000);
    await harness.pickDeviceFile({ name: 'beach.jpg', type: 'image/jpeg' });

    answer({ downloadUrl: LINK });
    await flush();

    expect(harness.calls).toEqual([]);
    expect(harness.text('upload-image-button')).toBe('Uploading...');
  });

  it('gives the buttons back again when the image link hangs after a late pick', async () => {
    let answer: (files: unknown) => void = () => {};
    const harness = await lostChatImage({
      fileApis: allFileApis({
        selectFiles: () => new Promise(resolve => { answer = resolve; }),
        getFileDownloadUrl: () => new Promise(() => {})
      })
    });
    await harness.click('choose-image-button');
    await harness.runTimer(120000);
    answer([{ fileId: 'file_pick', mimeType: 'image/png' }]);
    await flush();
    // The pick took the buttons again and cleared the wait message.
    expect(harness.disabled('choose-image-button')).toBe(true);
    expect(harness.disabled('upload-image-button')).toBe(true);
    expect(harness.visible('error-message')).toBe(false);
    expect(harness.pendingTimers().map(timer => timer.delay)).toEqual([120000]);

    await harness.runTimer(120000);

    expect(harness.disabled('choose-image-button')).toBe(false);
    expect(harness.disabled('upload-image-button')).toBe(false);
    expect(harness.text('choose-image-button')).toBe('Choose from library');
    expect(harness.text('error-message')).toBe('Still waiting for the image. If nothing happened, please try again.');
  });

  it('shows no wait message over a preview that arrived meanwhile', async () => {
    const harness = await lostChatImage({
      fileApis: allFileApis({ selectFiles: () => new Promise(() => {}) })
    });
    await harness.click('choose-image-button');
    await harness.deliverHostResult(spec.output('draft_host_0001'));

    await harness.runTimer(120000);

    expect(harness.visible('error-message')).toBe(false);
    expect(harness.text('id-value')).toBe('draft_host_0001');
  });

  it('shows no wait message over a kept order that arrived meanwhile', async () => {
    const harness = await lostChatImage({
      fileApis: allFileApis({ selectFiles: () => new Promise(() => {}) })
    });
    await harness.click('choose-image-button');
    harness.openai.widgetState = { v: 1, draftId: 'draft_host_0001', sent: true, orderId: 'ord_sent_0001' };
    await harness.fireGlobals();

    await harness.runTimer(120000);

    expect(harness.visible('error-message')).toBe(false);
    expect(harness.text('status-pill')).toBe('With the printer');
  });

  it('clears a wait message when a kept order arrives afterwards', async () => {
    const harness = await lostChatImage({
      fileApis: allFileApis({ selectFiles: () => new Promise(() => {}) })
    });
    await harness.click('choose-image-button');
    await harness.runTimer(120000);
    expect(harness.visible('error-message')).toBe(true);

    harness.openai.widgetState = { v: 1, draftId: 'draft_host_0001', sent: true, orderId: 'ord_sent_0001' };
    await harness.fireGlobals();

    expect(harness.text('status-pill')).toBe('With the printer');
    expect(harness.visible('error-message')).toBe(false);
  });

  it('says so when a file is chosen while an earlier image is still on its way', async () => {
    let answer: (files: unknown) => void = () => {};
    const harness = await lostChatImage({
      fileApis: allFileApis({
        selectFiles: () => new Promise(resolve => { answer = resolve; }),
        getFileDownloadUrl: () => new Promise(() => {})
      })
    });
    await harness.click('choose-image-button');
    await harness.runTimer(120000);
    answer([{ fileId: 'file_pick', mimeType: 'image/png' }]);
    await flush();

    await harness.pickDeviceFile({ name: 'beach.jpg', type: 'image/jpeg' });

    expect(harness.text('error-message')).toBe(
      'An image you chose earlier is still on its way. Try again once it has arrived.'
    );
    expect(harness.fileCalls.map(call => call.name)).toEqual(['selectFiles', 'getFileDownloadUrl']);
  });

  it('ends the image wait when the preview call starts, which has its own timeout', async () => {
    const harness = await lostChatImage();
    harness.holdCalls();

    await harness.click('choose-image-button');

    expect(harness.calls).toHaveLength(1);
    expect(harness.pendingTimers().map(timer => timer.delay)).toEqual([60000]);
    await harness.runTimer(60000);
    expect(harness.text('error-message')).toBe(
      'No preview yet. It will appear here if it arrives. You can also try again, or ask for the preview in the chat.'
    );
    expect(harness.disabled('choose-image-button')).toBe(false);
    expect(harness.text('choose-image-button')).toBe('Choose from library');

    await harness.releaseCalls();
    expect(harness.text('id-value')).toBe('draft_retry_0001');
  });

  it('ends the image wait when the pick ends', async () => {
    const harness = await lostChatImage({ fileApis: allFileApis({ selectFiles: () => [] }) });

    await harness.click('choose-image-button');

    expect(harness.pendingTimers()).toEqual([]);
  });

  it('ignores a pick that answers after a kept order arrived', async () => {
    let answer: (files: unknown) => void = () => {};
    const harness = await lostChatImage({
      fileApis: allFileApis({ selectFiles: () => new Promise(resolve => { answer = resolve; }) })
    });
    await harness.click('choose-image-button');

    harness.openai.widgetState = { v: 1, draftId: 'draft_host_0001', sent: true, orderId: 'ord_sent_0001' };
    await harness.fireGlobals();
    answer([{ fileId: 'file_pick', mimeType: 'image/png' }]);
    await flush();

    expect(harness.fileCalls.map(call => call.name)).toEqual(['selectFiles']);
    expect(harness.calls).toEqual([]);
    expect(harness.text('status-pill')).toBe('With the printer');
  });

  it('keeps an open pick through a re-render', async () => {
    const harness = await lostChatImage({
      fileApis: allFileApis({ selectFiles: () => new Promise(() => {}) })
    });
    await harness.click('choose-image-button');

    harness.openai.theme = 'dark';
    await harness.fireGlobals();

    expect(harness.text('choose-image-button')).toBe('Opening your library...');
    expect(harness.disabled('choose-image-button')).toBe(true);
    expect(harness.disabled('upload-image-button')).toBe(true);
  });

  it('switches to a late host draft after a picked preview until it acts on it', async () => {
    const harness = await lostChatImage();
    await harness.click('choose-image-button');
    expect(harness.text('id-value')).toBe('draft_retry_0001');

    await harness.deliverHostResult(spec.output('draft_host_0001'));
    expect(harness.text('id-value')).toBe('draft_host_0001');

    await harness.click('send-button');
    expect(harness.callsTo(spec.sendTool).map(call => call.args.draftId)).toEqual(['draft_host_0001']);
  });

  it.each<[string, Json]>([
    ['a sandbox path', { imageUrl: '/mnt/data/beach.png' }],
    ['an http address', { imageUrl: 'http://example.com/beach.jpg' }],
    ['a link that is not text', { imageUrl: 42 }]
  ])('offers the pick for %s given as imageUrl', async (_label, extra) => {
    const { image, imageUrl, ...rest } = chatImageArgs();
    const harness = await lostCall(spec, {
      stamp: imageTool(spec),
      toolInput: { ...rest, ...extra },
      fileApis: allFileApis()
    });

    expect(harness.visible('retry-button')).toBe(false);
    expect(harness.visible('choose-image-button')).toBe(true);

    await harness.click('choose-image-button');
    expect(harness.calls).toEqual([{ name: imageTool(spec), args: { ...rest, imageUrl: LINK } }]);
  });

  it.each<[string, Json]>([
    ['an https imageUrl', { imageUrl: 'https://example.com/beach.jpg' }],
    ['an empty imageUrl', { imageUrl: '' }],
    ['a usable file object beside a sandbox imageUrl', {
      imageUrl: '/mnt/data/beach.png',
      image: { download_url: 'https://files.example/x', file_id: 'file_1' }
    }]
  ])('repeats the call for %s', async (_label, extra) => {
    const { image, imageUrl, ...rest } = chatImageArgs();
    const args = { ...rest, ...extra };
    const harness = await lostCall(spec, { stamp: imageTool(spec), toolInput: args, fileApis: allFileApis() });

    expect(harness.visible('choose-image-button')).toBe(false);
    await harness.click('retry-button');
    expect(harness.calls).toEqual([{ name: imageTool(spec), args }]);
  });

  it('keeps a host result that arrives while the image is being picked', async () => {
    let answer: (files: unknown) => void = () => {};
    const harness = await lostChatImage({
      fileApis: allFileApis({ selectFiles: () => new Promise(resolve => { answer = resolve; }) })
    });
    await harness.click('choose-image-button');

    await harness.deliverHostResult(spec.output('draft_host_0001'));
    answer([{ fileId: 'file_pick', mimeType: 'image/png' }]);
    await flush();

    expect(harness.text('id-value')).toBe('draft_host_0001');
    expect(harness.calls).toEqual([]);
    expect(harness.fileCalls.map(call => call.name)).toEqual(['selectFiles']);
  });

  it('keeps a host result that arrives while the image uploads', async () => {
    let answer: (value: unknown) => void = () => {};
    const harness = await lostChatImage({
      fileApis: allFileApis({ uploadFile: () => new Promise(resolve => { answer = resolve; }) })
    });
    await harness.pickDeviceFile({ name: 'beach.jpg', type: 'image/jpeg' });

    await harness.deliverHostResult(spec.output('draft_host_0001'));
    answer({ fileId: 'file_pick' });
    await flush();

    expect(harness.text('id-value')).toBe('draft_host_0001');
    expect(harness.calls).toEqual([]);
    expect(harness.fileCalls.map(call => call.name)).toEqual(['uploadFile']);
  });

  it('offers the pick at once on a reopened card that only showed a preview', async () => {
    const harness = mount(spec, {
      stamp: imageTool(spec),
      toolInput: chatImageArgs(),
      fileApis: allFileApis(),
      widgetState: { v: 1, draftId: 'draft_host_0001' }
    });
    await flush();

    expect(harness.pendingTimers()).toEqual([]);
    expect(harness.visible('choose-image-button')).toBe(true);
    expect(harness.visible('empty-hint')).toBe(false);
  });

  it('offers no pick on a reopened card that sent its mail', async () => {
    const harness = mount(spec, {
      stamp: imageTool(spec),
      toolInput: chatImageArgs(),
      fileApis: allFileApis(),
      widgetState: { v: 1, draftId: 'draft_host_0001', sent: true, orderId: 'ord_sent_0001' }
    });
    await flush();

    expect(harness.visible('choose-image-button')).toBe(false);
    expect(harness.visible('upload-image-button')).toBe(false);
  });

  it('hides the pick when a kept order arrives after the wait', async () => {
    const harness = await lostChatImage();
    expect(harness.visible('choose-image-button')).toBe(true);

    harness.openai.widgetState = { v: 1, draftId: 'draft_host_0001', sent: true, orderId: 'ord_sent_0001' };
    await harness.fireGlobals();

    expect(harness.visible('choose-image-button')).toBe(false);
    expect(harness.visible('upload-image-button')).toBe(false);
  });

  it('does nothing when a hidden button is clicked', async () => {
    const harness = await lostCall(spec, { fileApis: allFileApis() });

    await harness.click('choose-image-button');
    await harness.click('upload-image-button');
    await harness.pickDeviceFile({ name: 'beach.jpg', type: 'image/jpeg' });

    expect(harness.fileCalls).toEqual([]);
  });
});

describe('LetterPreviewCard picks an image only for an image letter (#414)', () => {
  it('gives advice for a text-only stamp whose input names a chat image', async () => {
    const harness = await lostCall(LETTER, {
      stamp: 'quote_and_preview_letter',
      toolInput: { ...LETTER.args(), image: '/mnt/data/beach.png' },
      fileApis: {
        selectFiles: () => [],
        uploadFile: () => ({ fileId: 'f' }),
        getFileDownloadUrl: () => ({ downloadUrl: 'https://files.example/x' })
      }
    });

    expect(harness.visible('choose-image-button')).toBe(false);
    expect(harness.visible('upload-image-button')).toBe(false);
    expect(harness.text('empty-message')).toMatch(/ask for the preview again in the chat\.$/);
  });

  it('keeps the other letter arguments and drops only the image', async () => {
    const args = { ...LETTER.args(), sender: { ...recipient, name: 'Dee' }, image: '/mnt/data/beach.png' };
    const harness = await lostCall(LETTER, {
      stamp: 'quote_and_preview_letter_with_header_image',
      toolInput: args,
      fileApis: {
        selectFiles: () => [{ fileId: 'file_pick' }],
        getFileDownloadUrl: () => ({ downloadUrl: 'https://files.example/x' })
      }
    });

    await harness.click('choose-image-button');

    const { image, ...rest } = args;
    expect(harness.calls).toEqual([
      { name: 'quote_and_preview_letter_with_header_image', args: { ...rest, imageUrl: 'https://files.example/x' } }
    ]);
  });
});

describe.each([LETTER, POSTCARD])('$file and the same mail twice (#412)', spec => {
  const label = spec.file === 'LetterPreviewCard' ? 'Send Letter' : 'Send Postcard';
  const sentLabel = spec.file === 'LetterPreviewCard' ? 'Letter Sent!' : 'Postcard Sent!';
  const refusal = (details?: Json, text = 'Possible duplicate: This same mail was already sent.') => ({
    isError: true,
    content: [{ type: 'text', text }],
    ...(details ? { _meta: { 'letterirl/duplicateMail': details } } : {})
  });
  const sentDetails = { kind: 'sent', mailType: spec.noun, recipientName: 'Sam Rivera', ageMinutes: 4 };

  /** A card showing the host's draft, able to send from balance. */
  const ready = async (options: MountOptions = {}) => {
    const harness = mount(spec, { toolOutput: spec.output('draft_host_0001'), ...options });
    await flush();
    expect(harness.text('send-button')).toBe(label);
    return harness;
  };

  /** A card showing the host's draft, offering Pay & Send only. */
  const payable = async (options: MountOptions = {}) => {
    const harness = mount(spec, { toolOutput: spec.output('draft_host_0001', eligibility(false)), ...options });
    await flush();
    expect(harness.visible('pay-send-button')).toBe(true);
    return harness;
  };

  it('says the same mail went out, and sends another copy only on the next click', async () => {
    let calls = 0;
    const harness = await ready({
      sendResponse: () => (calls++ === 0 ? refusal(sentDetails) : { structuredContent: { orderId: 'ord_copy_0001' } })
    });

    await harness.click('send-button');

    expect(harness.text('error-message')).toBe(
      `You already sent this same ${spec.noun} to Sam Rivera 4 minutes ago. Send another copy only if you want two.`
    );
    expect(harness.visible('error-message')).toBe(true);
    expect(harness.text('send-button')).toBe('Send another copy');
    expect(harness.disabled('send-button')).toBe(false);
    expect(harness.text('id-value')).toBe('draft_host_0001');
    expect(harness.savedStates.some(state => (state as Json).sent === true)).toBe(false);

    await harness.click('send-button');

    expect(harness.callsTo(spec.sendTool).map(call => call.args)).toEqual([
      { draftId: 'draft_host_0001', confirm: true },
      { draftId: 'draft_host_0001', confirm: true, sendAnotherCopy: true }
    ]);
    expect(harness.text('send-button')).toBe(sentLabel);
    expect(harness.text('id-value')).toBe('ord_copy_0001');
    expect(harness.visible('error-message')).toBe(false);
    expect(harness.savedStates.at(-1)).toMatchObject({ sent: true, orderId: 'ord_copy_0001' });
  });

  it.each<[string, Json, string]>([
    ['a paid order', { kind: 'paid', recipientName: 'Sam Rivera', ageMinutes: 125 },
      `You already paid to send this same ${spec.noun} to Sam Rivera 2 hours ago. Send another copy only if you want two.`],
    ['an open checkout', { kind: 'checkout_open', recipientName: 'Sam Rivera', ageMinutes: 0 },
      `A checkout for this same ${spec.noun} to Sam Rivera was started less than a minute ago and is still open. If you pay for both, two copies are mailed.`],
    ['one minute', { kind: 'sent', recipientName: '', ageMinutes: 1 },
      `You already sent this same ${spec.noun} 1 minute ago. Send another copy only if you want two.`],
    ['one hour', { kind: 'sent', recipientName: 'Sam', ageMinutes: 60 },
      `You already sent this same ${spec.noun} to Sam 1 hour ago. Send another copy only if you want two.`],
    ['no usable age', { kind: 'sent', recipientName: 'Sam', ageMinutes: 'soon' },
      `You already sent this same ${spec.noun} to Sam recently. Send another copy only if you want two.`],
    ['an unknown kind', { kind: 'other' },
      `This same ${spec.noun} was sent or paid for recently. Send another copy only if you want two.`]
  ])('words %s', async (_label, details, text) => {
    const harness = await ready({ sendResponse: () => refusal(details) });
    await harness.click('send-button');
    expect(harness.text('error-message')).toBe(text);
  });

  it('recognises the refusal from its text when the details are missing', async () => {
    const harness = await ready({ sendResponse: () => refusal() });
    await harness.click('send-button');
    expect(harness.text('error-message')).toBe(
      `This same ${spec.noun} was sent or paid for recently. Send another copy only if you want two.`
    );
    expect(harness.text('send-button')).toBe('Send another copy');
  });

  it.each([
    ['as it is', 'Possible duplicate: This same mail was already sent.'],
    ['behind words of its own', 'Tool call failed: Possible duplicate: This same mail was already sent.'],
    [
      "wrapped the way ChatGPT wraps a refusal (#434)",
      'Error code: INVALID_ARGUMENT; Error: RuntimeException: Error calling MCP tool: ' +
        "[TextContent(type='text', text='Possible duplicate: This same mail was already sent.', annotations=None, meta=None)]"
    ]
  ])('recognises a refusal the host turns into a rejection, %s', async (_label, message) => {
    const harness = await ready({
      sendResponse: () => {
        throw new Error(message);
      }
    });
    await harness.click('send-button');
    expect(harness.text('send-button')).toBe('Send another copy');
    expect(harness.text('error-message')).toContain('sent or paid for recently');
  });

  it('shows any other refused send as a failure, never as sent', async () => {
    const harness = await ready({
      sendResponse: () => ({ isError: true, content: [{ type: 'text', text: 'Draft has expired.' }] })
    });

    await harness.click('send-button');

    expect(harness.text('error-message')).toBe('Failed to send: Draft has expired.');
    expect(harness.text('send-button')).toBe('Retry Send');
    expect(harness.text('status-pill')).toBe('Send failed');
    expect(harness.savedStates.some(state => (state as Json).sent === true)).toBe(false);

    await harness.click('send-button');
    expect(harness.callsTo(spec.sendTool).at(-1)!.args).not.toHaveProperty('sendAnotherCopy');
  });

  it('shows a refused send with no text as a failure too', async () => {
    const harness = await ready({ sendResponse: () => ({ isError: true }) });
    await harness.click('send-button');
    expect(harness.text('error-message')).toBe(`Failed to send: The ${spec.noun} was not sent.`);
  });

  it('keeps the another-copy label through a re-render', async () => {
    const harness = await ready({ sendResponse: () => refusal(sentDetails) });
    await harness.click('send-button');

    await harness.fireGlobals();

    expect(harness.text('send-button')).toBe('Send another copy');
    expect(harness.visible('error-message')).toBe(true);
  });

  it('asks for another copy at checkout once told, and opens it', async () => {
    let calls = 0;
    const harness = await payable({
      checkoutResponse: () =>
        calls++ === 0
          ? refusal({ kind: 'checkout_open', recipientName: 'Sam Rivera', ageMinutes: 3 })
          : { structuredContent: { orderId: 'ord_checkout_0002', checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_copy' } }
    });

    await harness.click('pay-send-button');

    expect(harness.text('error-message')).toBe(
      `A checkout for this same ${spec.noun} to Sam Rivera was started 3 minutes ago and is still open. If you pay for both, two copies are mailed.`
    );
    expect(harness.text('pay-send-button')).toBe('Pay for another copy');
    expect(harness.disabled('pay-send-button')).toBe(false);
    expect(harness.visible('checkout-link')).toBe(false);

    await harness.fireGlobals();
    expect(harness.text('pay-send-button')).toBe('Pay for another copy');

    await harness.click('pay-send-button');

    expect(harness.callsTo('create_mail_checkout').map(call => call.args)).toEqual([
      { draftId: 'draft_host_0001' },
      { draftId: 'draft_host_0001', sendAnotherCopy: true }
    ]);
    expect(harness.visible('checkout-link')).toBe(true);
    expect(harness.text('id-value')).toBe('ord_checkout_0002');
  });

  it('recognises a checkout refusal the host turns into a rejection', async () => {
    const harness = await payable({
      checkoutResponse: () => {
        throw new Error('Error: Possible duplicate: A Pay & Send checkout for this same mail is open.');
      }
    });
    await harness.click('pay-send-button');
    expect(harness.text('pay-send-button')).toBe('Pay for another copy');
  });

  it('shows any other refused checkout with its reason', async () => {
    const harness = await payable({
      checkoutResponse: () => ({ isError: true, content: [{ type: 'text', text: 'Pay & Send is not currently available.' }] })
    });

    await harness.click('pay-send-button');

    expect(harness.text('error-message')).toBe('Unable to open checkout: Pay & Send is not currently available.');
    expect(harness.text('pay-send-button')).toBe('Retry Pay & Send');
    expect(harness.visible('checkout-link')).toBe(false);
  });
});

describe.each([LETTER, POSTCARD])("$file shows a refused call's sentence, not the host's wrapper (#434)", spec => {
  // ChatGPT rejects a card's own callTool when the result is an error, and the
  // rejection's message wraps the result's text in a Python-style repr. This
  // is the message GIFT-01 step 9 showed whole under "Send Gift Letter" on
  // development (2026-09-23).
  const DAILY_CAP = 'This account has reached its daily limit of 3 items. Please try again tomorrow.';
  const GIFT01_REJECTION =
    "Error code: INVALID_ARGUMENT; Error: RuntimeException: Error calling MCP tool: [TextContent(type='text', text='This account has reached its daily limit of 3 items. Please try again tomorrow.', annotations=None, meta=None)]";
  /** The same rejection around another text, quoted as Python quoted it. */
  const rejection = (quoted: string) =>
    new Error(
      'Error code: INVALID_ARGUMENT; Error: RuntimeException: Error calling MCP tool: ' +
        `[TextContent(type='text', text=${quoted}, annotations=None, meta=None)]`
    );

  /** Calls to `tool` reject with `error`; every other call answers as usual. */
  const refuseCalls = (harness: Harness, tool: string, error: Error, answers: Record<string, unknown> = {}) => {
    const usual = harness.openai.callTool as (name: string, args: Json) => Promise<unknown>;
    harness.openai.callTool = async (name: string, args: Json) => {
      if (name === tool) {
        harness.calls.push({ name, args });
        throw error;
      }
      if (name in answers) {
        harness.calls.push({ name, args });
        return answers[name];
      }
      return usual(name, args);
    };
  };

  /** A card showing the host's draft with no letters to send it. */
  const unpaid = async () => {
    const harness = mount(spec, { toolOutput: spec.output('draft_host_0001', eligibility(false)) });
    await flush();
    expect(harness.visible('buy-pack-button')).toBe(true);
    return harness;
  };

  it('shows the daily limit sentence alone after a refused send', async () => {
    expect(GIFT01_REJECTION).toBe(rejection(`'${DAILY_CAP}'`).message);
    const harness = mount(spec, {
      toolOutput: spec.output('draft_host_0001'),
      sendResponse: () => {
        throw new Error(GIFT01_REJECTION);
      }
    });
    await flush();

    await harness.click('send-button');

    expect(harness.text('error-message')).toBe(`Failed to send: ${DAILY_CAP}`);
    expect(harness.visible('error-message')).toBe(true);
    expect(harness.disabled('send-button')).toBe(false);
  });

  it('shows the sentence after a refused checkout', async () => {
    const harness = mount(spec, {
      toolOutput: spec.output('draft_host_0001', eligibility(false)),
      checkoutResponse: () => {
        throw rejection("'Pay & Send is not currently available.'");
      }
    });
    await flush();

    await harness.click('pay-send-button');

    expect(harness.text('error-message')).toBe('Unable to open checkout: Pay & Send is not currently available.');
  });

  it('shows the sentence after a refused preview', async () => {
    const harness = await lostCall(spec, {
      previewResponse: () => {
        throw rejection("'Image is too small for print quality.'");
      }
    });

    await harness.click('retry-button');

    expect(harness.text('error-message')).toBe('Unable to create the preview: Image is too small for print quality.');
  });

  it('shows the sentence when the letter packs cannot be listed', async () => {
    const harness = await unpaid();
    refuseCalls(harness, 'list_letter_packs', rejection("'Letter packs are not on sale right now.'"));

    await harness.click('buy-pack-button');

    expect(harness.callsTo('list_letter_packs')).toHaveLength(1);
    expect(harness.text('error-message')).toBe('Unable to load letter packs: Letter packs are not on sale right now.');
  });

  it('shows the sentence when a letter pack checkout is refused', async () => {
    const harness = await unpaid();
    refuseCalls(harness, 'create_pack_checkout', rejection("'Letter packs are not on sale right now.'"), {
      list_letter_packs: {
        structuredContent: {
          packs: [{ pack: 'starter', letters: 5, currency: 'usd', displayAmount: '19.99' }]
        }
      }
    });
    await harness.click('buy-pack-button');
    const choice = harness.document.querySelector('#pack-options button[data-pack="starter"]');
    expect(choice).not.toBeNull();

    choice!.dispatchEvent(new harness.document.defaultView!.Event('click'));
    await flush();

    expect(harness.callsTo('create_pack_checkout')).toHaveLength(1);
    expect(harness.text('error-message')).toBe(
      'Unable to start the letter pack checkout: Letter packs are not on sale right now.'
    );
  });

  it('keeps an apostrophe in a sentence Python quoted with double quotes', async () => {
    const harness = mount(spec, {
      toolOutput: spec.output('draft_host_0001'),
      sendResponse: () => {
        throw rejection(`"This draft isn't ready to send yet."`);
      }
    });
    await flush();

    await harness.click('send-button');

    expect(harness.text('error-message')).toBe("Failed to send: This draft isn't ready to send yet.");
  });

  it('unescapes a quote in a sentence that holds both kinds', async () => {
    // Python keeps single quotes when the text holds both, and escapes the
    // single ones.
    const harness = mount(spec, {
      toolOutput: spec.output('draft_host_0001'),
      sendResponse: () => {
        throw rejection(`'The name "Sam" doesn\\'t match the draft.'`);
      }
    });
    await flush();

    await harness.click('send-button');

    expect(harness.text('error-message')).toBe(`Failed to send: The name "Sam" doesn't match the draft.`);
  });

  it('shows only the first sentence of a result with two', async () => {
    const harness = mount(spec, {
      toolOutput: spec.output('draft_host_0001'),
      sendResponse: () => {
        throw new Error(
          'Error code: INVALID_ARGUMENT; Error: RuntimeException: Error calling MCP tool: ' +
            "[TextContent(type='text', text='This draft has expired.', annotations=None, meta=None), " +
            "TextContent(type='text', text='Ask for a new preview.', annotations=None, meta=None)]"
        );
      }
    });
    await flush();

    await harness.click('send-button');

    expect(harness.text('error-message')).toBe('Failed to send: This draft has expired.');
  });

  it('decodes the other escapes Python writes', async () => {
    // Python writes these only for characters that do not print: a tab, a
    // carriage return, a no-break space, a zero-width space, a tag character.
    const harness = mount(spec, {
      toolOutput: spec.output('draft_host_0001'),
      sendResponse: () => {
        throw rejection(`'Tab\\there,\\r\\nno\\xa0break \\u200b done \\U000e0001 \\\\ ok'`);
      }
    });
    await flush();

    await harness.click('send-button');

    expect(harness.text('error-message')).toBe('Failed to send: Tab here, no\u00a0break \u200b done \u{e0001} \\ ok');
  });

  it('drops an escape outside Unicode rather than failing to show the message', async () => {
    const harness = mount(spec, {
      toolOutput: spec.output('draft_host_0001'),
      sendResponse: () => {
        throw rejection(`'Not a character: \\U00110000.'`);
      }
    });
    await flush();

    await harness.click('send-button');

    expect(harness.visible('error-message')).toBe(true);
    expect(harness.text('error-message')).toBe('Failed to send: Not a character: .');
  });

  it('shows a line break in the sentence as a space', async () => {
    const harness = mount(spec, {
      toolOutput: spec.output('draft_host_0001'),
      sendResponse: () => {
        throw rejection(`'This draft has expired.\\nAsk for a new preview.'`);
      }
    });
    await flush();

    await harness.click('send-button');

    expect(harness.text('error-message')).toBe('Failed to send: This draft has expired. Ask for a new preview.');
  });

  it('reads a rejection that is a bare string', async () => {
    const harness = mount(spec, {
      toolOutput: spec.output('draft_host_0001'),
      sendResponse: () => {
        throw GIFT01_REJECTION;
      }
    });
    await flush();

    await harness.click('send-button');

    expect(harness.text('error-message')).toBe(`Failed to send: ${DAILY_CAP}`);
  });

  it('says Unknown error for a rejection with no message', async () => {
    const harness = mount(spec, {
      toolOutput: spec.output('draft_host_0001'),
      sendResponse: () => {
        throw new Error('');
      }
    });
    await flush();

    await harness.click('send-button');

    expect(harness.text('error-message')).toBe('Failed to send: Unknown error');
  });

  it('shows a wrapper with no sentence in it as it came', async () => {
    const empty = rejection("''");
    const harness = mount(spec, {
      toolOutput: spec.output('draft_host_0001'),
      sendResponse: () => {
        throw empty;
      }
    });
    await flush();

    await harness.click('send-button');

    expect(harness.text('error-message')).toBe(`Failed to send: ${empty.message}`);
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

  it('offers the preview at once when a saved preview arrives after the first render', async () => {
    const harness = mount(spec);
    await flush();
    expect(harness.pendingTimers()).toHaveLength(1);

    harness.openai.widgetState = { v: 1, draftId: 'draft_host_0001' };
    await harness.fireGlobals();

    expect(harness.pendingTimers()).toEqual([]);
    expect(harness.visible('retry-button')).toBe(true);
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

  it('drops the tip when saved state arrives after the wait ran out', async () => {
    const harness = await lostCall(spec);
    expect(harness.visible('empty-hint')).toBe(true);

    harness.openai.widgetState = { v: 1, draftId: 'draft_host_0001' };
    await harness.fireGlobals();

    expect(harness.visible('retry-button')).toBe(true);
    expect(harness.visible('empty-hint')).toBe(false);
  });

  it('drops the tip when a kept order arrives after the wait ran out', async () => {
    const harness = await lostCall(spec);
    expect(harness.visible('empty-hint')).toBe(true);

    harness.openai.widgetState = {
      v: 1,
      draftId: 'draft_host_0001',
      sent: true,
      orderId: 'ord_sent_0001'
    };
    await harness.fireGlobals();

    expect(harness.text('status-pill')).toBe('With the printer');
    expect(harness.visible('empty-hint')).toBe(false);
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
    expect(harness.visible('empty-hint')).toBe(false);
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
    // Nothing was lost: the host does not replay results into a reopened card.
    expect(harness.visible('empty-hint')).toBe(false);

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
