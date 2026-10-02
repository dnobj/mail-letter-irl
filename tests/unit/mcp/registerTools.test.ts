/**
 * Unit tests for MCP Tool Registration with Annotations
 *
 * Tests that tools are registered with correct annotations per MCP specification
 * and OpenAI Apps SDK requirements.
 *
 * User Stories Covered:
 * - US-MCP-06: Tool Read/Write Annotations
 *
 * GitHub Issues: #17, #92
 *
 * @see docs/learnings/tool-annotation-decision.md
 * @see https://modelcontextprotocol.io/legacy/concepts/tools
 * @see https://developers.openai.com/apps-sdk/plan/tools/
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { widgetTemplateUri } from "../../../src/mcp/widgetUris.js";
import { LetterIrlServer } from '../../../src/server.js';
import {
  buildAnnotations,
  buildToolMeta,
  buildToolSecuritySchemes,
  getZodInputShape,
  getServedInputSchema,
  getZodOutputShape,
  summarizeToolResult
} from '../../../src/mcp/registerTools.js';
import { cancelScheduledMailTool, getStartedTool, setArrivalDateTool } from '../../../src/tools/index.js';
import {
  getOrderStatusOutputSchema,
  listOrdersOutputSchema,
  sendLetterOutputSchema,
  sendPostcardOutputSchema
} from '../../../src/schemas.js';
import { clientProfileNamed } from '../../../src/auth/clientProfiles.js';

/**
 * Tool definitions matching the actual tools in the codebase.
 *
 * IMPORTANT: Quote/preview tools are NOT read-only because they create
 * draft records in the database. Per MCP specification:
 * "readOnlyHint: true = tool does NOT modify its environment"
 *
 * Creating database records IS modifying the environment.
 */

// Read-only tools: only retrieve data, no database modifications
const readOnlyTools = [
  { name: 'list_letter_packs', readOnly: true },
  { name: 'get_started', readOnly: true },
  { name: 'get_account_balance', readOnly: true },
  { name: 'get_profile', readOnly: true },
  { name: 'get_order_status', readOnly: true },
  { name: 'get_purchase_status', readOnly: true },
  { name: 'get_return_address', readOnly: true },
  { name: 'list_orders', readOnly: true },
  // The preview card's question about its draft (#474).
  { name: 'get_draft_status', readOnly: true },
];

// Quote/preview tools: create draft records in database (NOT read-only)
const quotePreviewTools = [
  { name: 'quote_and_preview_letter', readOnly: false },
  { name: 'quote_and_preview_letter_with_header_image', readOnly: false },
  { name: 'quote_and_preview_letter_with_image', readOnly: false },
  { name: 'quote_and_preview_postcard', readOnly: false },
];

// Send tools: consume drafts, deduct credits, send mail
const sendTools = [
  { name: 'send_letter', readOnly: false },
  { name: 'send_postcard', readOnly: false },
];

// Other write tools
const otherWriteTools = [
  { name: 'create_mail_checkout', readOnly: false },
  { name: 'create_pack_checkout', readOnly: false },
  { name: 'redeem_promo_code', readOnly: false },
  { name: 'set_return_address', readOnly: false },
  { name: 'confirm_uploaded_image', readOnly: false },
  { name: 'submit_feature_request', readOnly: false },
  { name: 'upload_image', readOnly: false },
  { name: 'generate_image_for_mail', readOnly: false },
];

// Grouping only: this list completes allTools for the 23-tool coverage check.
// Which tools are destructive is decided by buildAnnotations and pinned by the
// exact-set assertion in the classification summary below (six tools).
const destructiveTools = [
  { name: 'clear_return_address', readOnly: false },
];

const allTools = [
  ...readOnlyTools,
  ...quotePreviewTools,
  ...sendTools,
  ...otherWriteTools,
  ...destructiveTools,
];

describe('Tool Annotation Correctness (US-MCP-06, Issue #92)', () => {
  describe('Read-Only Tools', () => {
    it.each(readOnlyTools)(
      '$name should have readOnlyHint: true (only reads data)',
      ({ name }) => {
        const annotations = buildAnnotations({ name, readOnly: true });
        expect(annotations.readOnlyHint).toBe(true);
        expect(annotations.destructiveHint).toBe(false);
        expect(annotations.openWorldHint).toBe(false);
      }
    );

    it('should have exactly 9 read-only tools', () => {
      expect(readOnlyTools.length).toBe(9);
    });
  });

  describe('Quote/Preview Tools (NOT read-only)', () => {
    /**
     * Quote/preview tools create draft records in the database.
     * Per MCP specification: "readOnlyHint: true = tool does NOT modify its environment"
     * Creating database records IS modifying the environment.
     *
     * @see docs/learnings/tool-annotation-decision.md
     */
    it.each(quotePreviewTools)(
      '$name should have readOnlyHint: false (creates draft records)',
      ({ name }) => {
        const annotations = buildAnnotations({ name, readOnly: false });
        expect(annotations.readOnlyHint).toBe(false);
      }
    );

    it.each(quotePreviewTools)(
      '$name should have openWorldHint: true (calls PostGrid API)',
      ({ name }) => {
        const annotations = buildAnnotations({ name, readOnly: false });
        expect(annotations.openWorldHint).toBe(true);
      }
    );

    it.each(quotePreviewTools)(
      '$name should have idempotentHint: false (each call creates new draft)',
      ({ name }) => {
        const annotations = buildAnnotations({ name, readOnly: false });
        expect(annotations.idempotentHint).toBe(false);
      }
    );

    it.each(quotePreviewTools)(
      '$name should have destructiveHint: false (non-destructive)',
      ({ name }) => {
        const annotations = buildAnnotations({ name, readOnly: false });
        expect(annotations.destructiveHint).toBe(false);
      }
    );

    it('should have exactly 4 quote/preview tools', () => {
      expect(quotePreviewTools.length).toBe(4);
    });
  });

  describe('Send Tools', () => {
    it.each(sendTools)(
      '$name should have readOnlyHint: false (modifies credits and creates records)',
      ({ name }) => {
        const annotations = buildAnnotations({ name, readOnly: false });
        expect(annotations.readOnlyHint).toBe(false);
      }
    );

    it.each(sendTools)(
      '$name should have openWorldHint: true (sends physical mail)',
      ({ name }) => {
        const annotations = buildAnnotations({ name, readOnly: false });
        expect(annotations.openWorldHint).toBe(true);
      }
    );

    it.each(sendTools)(
      '$name should have idempotentHint: true (draft consumption makes retries safe)',
      ({ name }) => {
        const annotations = buildAnnotations({ name, readOnly: false });
        expect(annotations.idempotentHint).toBe(true);
      }
    );

    it.each(sendTools)(
      '$name should have destructiveHint: true (mail cannot be recalled once printed)',
      ({ name }) => {
        const annotations = buildAnnotations({ name, readOnly: false });
        expect(annotations.destructiveHint).toBe(true);
      }
    );

    it('should have exactly 2 send tools', () => {
      expect(sendTools.length).toBe(2);
    });
  });

  describe('set_return_address Tool', () => {
    it('should have readOnlyHint: false (saves address to database)', () => {
      const annotations = buildAnnotations({ name: 'set_return_address', readOnly: false });
      expect(annotations.readOnlyHint).toBe(false);
    });

    it('should have openWorldHint: true (validates via PostGrid)', () => {
      const annotations = buildAnnotations({ name: 'set_return_address', readOnly: false });
      expect(annotations.openWorldHint).toBe(true);
    });

    it('should have idempotentHint: true (setting same address twice = no change)', () => {
      const annotations = buildAnnotations({ name: 'set_return_address', readOnly: false });
      expect(annotations.idempotentHint).toBe(true);
    });

    it('should have destructiveHint: true (overwrites the saved address in place)', () => {
      const annotations = buildAnnotations({ name: 'set_return_address', readOnly: false });
      expect(annotations.destructiveHint).toBe(true);
    });
  });

  describe('Checkout Tools (Destructive)', () => {
    it.each([{ name: 'create_mail_checkout' }, { name: 'create_pack_checkout' }])(
      '$name should have destructiveHint: true (starts a payment the customer cannot undo alone)',
      ({ name }) => {
        const annotations = buildAnnotations({ name, readOnly: false });
        expect(annotations.destructiveHint).toBe(true);
        expect(annotations.readOnlyHint).toBe(false);
      }
    );

    it.each([{ name: 'redeem_promo_code' }, { name: 'generate_image_for_mail' }, { name: 'submit_feature_request' }, { name: 'upload_image' }])(
      '$name should stay destructiveHint: false (additive for the customer)',
      ({ name }) => {
        const annotations = buildAnnotations({ name, readOnly: false });
        expect(annotations.destructiveHint).toBe(false);
      }
    );
  });

  describe('confirm_uploaded_image Tool', () => {
    it('should have readOnlyHint: false (persists recent upload state)', () => {
      const annotations = buildAnnotations({ name: 'confirm_uploaded_image', readOnly: false });
      expect(annotations.readOnlyHint).toBe(false);
    });

    it('should have destructiveHint: false (non-destructive)', () => {
      const annotations = buildAnnotations({ name: 'confirm_uploaded_image', readOnly: false });
      expect(annotations.destructiveHint).toBe(false);
    });

    it('should have openWorldHint: false (local state only)', () => {
      const annotations = buildAnnotations({ name: 'confirm_uploaded_image', readOnly: false });
      expect(annotations.openWorldHint).toBe(false);
    });

    it('should have idempotentHint: true (same relay can be safely repeated)', () => {
      const annotations = buildAnnotations({ name: 'confirm_uploaded_image', readOnly: false });
      expect(annotations.idempotentHint).toBe(true);
    });
  });

  describe('clear_return_address Tool (Destructive)', () => {
    it('should have readOnlyHint: false (deletes data)', () => {
      const annotations = buildAnnotations({ name: 'clear_return_address', readOnly: false });
      expect(annotations.readOnlyHint).toBe(false);
    });

    it('should have destructiveHint: true (permanently deletes address)', () => {
      const annotations = buildAnnotations({ name: 'clear_return_address', readOnly: false });
      expect(annotations.destructiveHint).toBe(true);
    });

    it('should have openWorldHint: false (local database only)', () => {
      const annotations = buildAnnotations({ name: 'clear_return_address', readOnly: false });
      expect(annotations.openWorldHint).toBe(false);
    });

    it('should have idempotentHint: true (clearing twice = no additional effect)', () => {
      const annotations = buildAnnotations({ name: 'clear_return_address', readOnly: false });
      expect(annotations.idempotentHint).toBe(true);
    });
  });

  describe('Tool Classification Summary', () => {
    it('should cover all 24 registered tools in annotation checks', () => {
      // ChatGPT's list is the full one; other apps lack the checkouts (#475).
      const runtimeToolNames = new LetterIrlServer()
        .listTools(clientProfileNamed('chatgpt'))
        .map((tool) => tool.name)
        .sort();
      const checkedToolNames = allTools.map((tool) => tool.name).sort();

      expect(allTools.length).toBe(24);
      expect(checkedToolNames).toEqual(runtimeToolNames);
    });

    it('should have 9 read-only tools', () => {
      const readOnlyCount = allTools.filter(t => {
        const annotations = buildAnnotations({ name: t.name, readOnly: t.readOnly });
        return annotations.readOnlyHint === true;
      }).length;
      expect(readOnlyCount).toBe(9);
    });

    it('should have 15 write tools (non-read-only)', () => {
      const writeCount = allTools.filter(t => {
        const annotations = buildAnnotations({ name: t.name, readOnly: t.readOnly });
        return annotations.readOnlyHint === false;
      }).length;
      expect(writeCount).toBe(15);
    });

    it('should have 9 open-world tools (call external APIs)', () => {
      const openWorldCount = allTools.filter(t => {
        const annotations = buildAnnotations({ name: t.name, readOnly: t.readOnly });
        return annotations.openWorldHint === true;
      }).length;
      expect(openWorldCount).toBe(10);
    });

    it('should have 7 idempotent tools (send + checkout + promo + address management + upload relay)', () => {
      const idempotentCount = allTools.filter(t => {
        const annotations = buildAnnotations({ name: t.name, readOnly: t.readOnly });
        return annotations.idempotentHint === true;
      }).length;
      expect(idempotentCount).toBe(7);
    });

    it('should have 6 destructive tools (two sends, the address overwrite, two checkouts, the address clear)', () => {
      const destructiveNames = allTools.filter(t => {
        const annotations = buildAnnotations({ name: t.name, readOnly: t.readOnly });
        return annotations.destructiveHint === true;
      }).map(t => t.name).sort();
      expect(destructiveNames).toEqual([
        'clear_return_address',
        'create_mail_checkout',
        'create_pack_checkout',
        'send_letter',
        'send_postcard',
        'set_return_address',
      ]);
    });
  });

  describe('Runtime Zod Schema Coverage', () => {
    it('should register input and output Zod shapes for every runtime tool', () => {
      const tools = new LetterIrlServer().listTools(clientProfileNamed('chatgpt'));

      for (const tool of tools) {
        expect(getZodInputShape(tool.name), `${tool.name} input shape`).toBeDefined();
        expect(getZodOutputShape(tool.name), `${tool.name} output shape`).toBeDefined();
      }
    });
  });

  describe('Annotation Consistency', () => {
    it('read-only tools should not have openWorldHint', () => {
      readOnlyTools.forEach(({ name }) => {
        const annotations = buildAnnotations({ name, readOnly: true });
        if (annotations.readOnlyHint) {
          expect(annotations.openWorldHint).toBe(false);
        }
      });
    });

    it('read-only tools should not have idempotentHint', () => {
      // Per MCP spec: idempotentHint is only meaningful when readOnlyHint is false
      readOnlyTools.forEach(({ name }) => {
        const annotations = buildAnnotations({ name, readOnly: true });
        if (annotations.readOnlyHint) {
          expect(annotations.idempotentHint).toBe(false);
        }
      });
    });

    it('read-only tools should not have destructiveHint', () => {
      // Per MCP spec: destructiveHint is only meaningful when readOnlyHint is false
      readOnlyTools.forEach(({ name }) => {
        const annotations = buildAnnotations({ name, readOnly: true });
        if (annotations.readOnlyHint) {
          expect(annotations.destructiveHint).toBe(false);
        }
      });
    });
  });

  describe('Tool Auth Metadata', () => {
    it('should declare oauth2 security scheme when auth is required', () => {
      expect(buildToolSecuritySchemes('get_account_balance', true)).toEqual([
        {
          type: 'oauth2',
          // offline_access rides along on every tool because ChatGPT builds
          // its authorization request from the union of these lists, not from
          // scopes_supported (#160). The identity scopes ride along for any
          // client registered outside Auth0's strict mode; ChatGPT's CIMD
          // client is never granted them (#424). All of them are requested,
          // never enforced.
          scopes: ['mail:read', 'offline_access', 'openid', 'email']
        }
      ]);
    });

    it('should declare noauth security scheme when auth is disabled', () => {
      expect(buildToolSecuritySchemes('send_letter', false)).toEqual([{ type: 'noauth' }]);
    });

    it('lets the cards call set_arrival_date and cancel_scheduled_mail, and leaves both to the model too (#535)', () => {
      for (const tool of [setArrivalDateTool, cancelScheduledMailTool]) {
        // With the send rule on, which is when card-only tools are hidden.
        const meta = buildToolMeta(tool.name, tool.meta ?? {}, true, true);
        expect(meta['openai/widgetAccessible'], tool.name).toBe(true);
        expect(meta.ui, tool.name).toMatchObject({ widgetAccessible: true });
        expect(meta['openai/visibility'], tool.name).toBeUndefined();
        expect((meta.ui as Record<string, unknown>).visibility, tool.name).toBeUndefined();
      }
    });

    it('should merge securitySchemes into tool metadata', () => {
      expect(
        buildToolMeta(
          'quote_and_preview_letter',
          {
            'openai/outputTemplate': widgetTemplateUri('LetterPreviewCard'),
            'openai/widgetAccessible': true
          },
          true
        )
      ).toMatchObject({
        securitySchemes: [
          {
            type: 'oauth2',
            scopes: ['mail:draft', 'offline_access', 'openid', 'email']
          }
        ],
        'openai/widgetAccessible': true,
        ui: {
          resourceUri: widgetTemplateUri('LetterPreviewCard'),
          widgetAccessible: true
        }
      });
    });
  });
});

describe('OpenAI Apps SDK Submission Compliance', () => {
  /**
   * Per OpenAI App Submission Guidelines:
   * "Write or destructive tools (e.g., creating, updating, deleting, posting, sending)
   * must be clearly marked using the readOnlyHint and openWorldHint."
   *
   * @see https://developers.openai.com/apps-sdk/app-submission-guidelines/
   */

  describe('Quote/Preview tools are correctly marked as write operations', () => {
    it('quote_and_preview_letter creates drafts (readOnly: false)', () => {
      const tool = quotePreviewTools.find(t => t.name === 'quote_and_preview_letter');
      expect(tool?.readOnly).toBe(false);
    });

    it('quote_and_preview_letter_with_header_image creates drafts (readOnly: false)', () => {
      const tool = quotePreviewTools.find(t => t.name === 'quote_and_preview_letter_with_header_image');
      expect(tool?.readOnly).toBe(false);
    });

    it('quote_and_preview_letter_with_image creates drafts (readOnly: false)', () => {
      const tool = quotePreviewTools.find(t => t.name === 'quote_and_preview_letter_with_image');
      expect(tool?.readOnly).toBe(false);
    });

    it('quote_and_preview_postcard creates drafts (readOnly: false)', () => {
      const tool = quotePreviewTools.find(t => t.name === 'quote_and_preview_postcard');
      expect(tool?.readOnly).toBe(false);
    });
  });

  describe('Send tools are marked with openWorldHint', () => {
    it('send_letter has openWorldHint: true (sends physical mail)', () => {
      const annotations = buildAnnotations({ name: 'send_letter', readOnly: false });
      expect(annotations.openWorldHint).toBe(true);
    });

    it('send_postcard has openWorldHint: true (sends physical mail)', () => {
      const annotations = buildAnnotations({ name: 'send_postcard', readOnly: false });
      expect(annotations.openWorldHint).toBe(true);
    });
  });

  describe('Destructive tools are marked with destructiveHint', () => {
    it('clear_return_address has destructiveHint: true', () => {
      const annotations = buildAnnotations({ name: 'clear_return_address', readOnly: false });
      expect(annotations.destructiveHint).toBe(true);
    });
  });

  describe('tool summaries do not duplicate their widget', () => {
    /**
     * The summary is the model's account of what the tool did. When it is the
     * card's own copy, the model restates the card immediately below a card
     * already showing it - which is exactly what get_started did: the summary
     * was `result.overview`, and the reply re-explained the app and re-listed
     * all three example prompts under a card containing both.
     *
     * Same contract as the image routing card: the widget is the single voice,
     * the model adds at most one sentence.
     */
    it('get_started tells the model the card already speaks, and does not echo it', async () => {
      const chatgpt = clientProfileNamed('chatgpt');
      const output = await getStartedTool.handler({}, { client: chatgpt } as never);
      const summary = summarizeToolResult('get_started', output as unknown as Record<string, unknown>, chatgpt);

      expect(summary).not.toContain(output.overview);
      expect(summary).not.toContain(output.purchaseStep);
      for (const prompt of output.examplePrompts) {
        expect(summary, `summary re-lists the example prompt "${prompt}"`).not.toContain(prompt);
      }
      expect(summary.toLowerCase()).toContain('one short sentence');
    });

    it('get_started carries the guide itself where no card shows it (#484)', async () => {
      // Told that a card "is displayed above", the model in an app with no
      // card had nothing to pass on, including where to buy letters.
      const vscode = clientProfileNamed('vscode');
      const output = await getStartedTool.handler({}, { client: vscode } as never);
      const summary = summarizeToolResult('get_started', output as unknown as Record<string, unknown>, vscode);

      expect(summary).toContain(output.overview);
      expect(summary).toContain(output.purchaseStep);
      for (const prompt of output.examplePrompts) {
        expect(summary).toContain(`"${prompt}"`);
      }
      // Claude dropped the letter packs link when paraphrasing, before its
      // card showed it (#475).
      expect(summary).toContain('including any link');
      expect(summary).not.toMatch(/\bcard\b/i);
    });

    it("get_started points Claude at the card, which carries the letter packs link (#474)", async () => {
      const claude = clientProfileNamed('claude');
      const output = await getStartedTool.handler({}, { client: claude } as never);
      const summary = summarizeToolResult('get_started', output as unknown as Record<string, unknown>, claude);
      expect(summary).toBe(summarizeToolResult('get_started', output as unknown as Record<string, unknown>, clientProfileNamed('chatgpt')));
      expect(summary).toMatch(/getting-started card is displayed above/);
    });

    it('a summary that names no app is the one for an app with no card', async () => {
      const output = (await getStartedTool.handler({}, {} as never)) as unknown as Record<string, unknown>;
      expect(summarizeToolResult('get_started', output)).toBe(
        summarizeToolResult('get_started', output, clientProfileNamed('generic'))
      );
    });

    it('get_draft_status reads as a plain fact, for an app that shows it to its model (#474)', () => {
      const summary = (result: Record<string, unknown>) => summarizeToolResult('get_draft_status', result);
      expect(summary({ draftId: 'd', status: 'sent', orderId: 'ord_1' })).toBe('That preview has been sent as order ord_1.');
      expect(summary({ draftId: 'd', status: 'sent' })).toBe('That preview has been sent.');
      expect(summary({ draftId: 'd', status: 'expired' })).toBe('That preview has expired.');
      expect(summary({ draftId: 'd', status: 'ready' })).toBe('That preview has not been sent and can still be sent.');
      expect(summary({ draftId: 'd', status: 'not_found' })).toBe('That preview was not found.');
    });
  });
});

describe('cancel_scheduled_mail (#535)', () => {
  it('is a destructive, closed-world write that repeats safely', () => {
    expect(buildAnnotations({ name: 'cancel_scheduled_mail', readOnly: false })).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
      idempotentHint: true
    });
  });

  it('narrates a scheduled send and order with their dates, and the cancel while it is possible', () => {
    vi.stubEnv('LETTER_IRL_ARRIVE_BY_ENABLED', 'true');
    try {
      narratesScheduledMail();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('names no cancel tool while arrival dates are off, when cancel_scheduled_mail is not listed', () => {
    vi.stubEnv('LETTER_IRL_ARRIVE_BY_ENABLED', '');
    try {
      const schedule = { arriveBy: '2026-10-16', mailOn: '2026-10-06' };
      const letter = summarizeToolResult('send_letter', { orderId: 'ltr-1', currentStatus: 'scheduled', schedule, cancellable: true });
      expect(letter).toMatch(/^Letter ltr-1 is scheduled\. Goes to the printer /);
      expect(letter).not.toMatch(/cancel/);
      const order = summarizeToolResult('get_order_status', { orderId: 'ltr-1', currentStatus: 'scheduled', ...schedule, cancellable: true });
      expect(order).not.toMatch(/cancel/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  function narratesScheduledMail() {
    const schedule = { arriveBy: '2026-10-16', mailOn: '2026-10-06' };
    const dates = /Goes to the printer Tue, Oct 6(, 2026)?, and aims to arrive by Fri, Oct 16(, 2026)?\./;
    const letter = summarizeToolResult('send_letter', { orderId: 'ltr-1', currentStatus: 'scheduled', schedule, cancellable: true });
    expect(letter).toMatch(/^Letter ltr-1 is scheduled\. /);
    expect(letter).toMatch(dates);
    expect(letter).toMatch(/It can be cancelled free until then with cancel_scheduled_mail\.$/);
    expect(summarizeToolResult('send_postcard', { orderId: 'pc-1', currentStatus: 'scheduled', schedule, cancellable: true })).toMatch(
      /^Postcard pc-1 is scheduled\. /
    );
    const order = summarizeToolResult('get_order_status', { orderId: 'ltr-1', currentStatus: 'scheduled', ...schedule, cancellable: false });
    expect(order).toMatch(/^Latest order status: scheduled\. /);
    expect(order).toMatch(dates);
    expect(order).not.toMatch(/cancel/);
    // Anything else reads as before.
    expect(summarizeToolResult('send_letter', { orderId: 'ltr-2', currentStatus: 'accepted', schedule, cancellable: false })).toBe(
      'Letter ltr-2 queued with status accepted.'
    );
    expect(summarizeToolResult('get_order_status', { currentStatus: 'delivered' })).toBe('Latest order status: delivered.');
  }

  it("narrates the tool's own sentence", () => {
    const message = 'Cancelled. The letter it cost is back in the balance.';
    expect(summarizeToolResult('cancel_scheduled_mail', { orderId: 'o', message })).toBe(message);
    expect(summarizeToolResult('cancel_scheduled_mail', { orderId: 'o' })).toBe('The scheduled mail was cancelled.');
  });

  it('has input and output shapes for registration, served as declared', () => {
    expect(Object.keys(getZodInputShape('cancel_scheduled_mail')!)).toEqual(['orderId', 'confirm']);
    expect(Object.keys(getZodOutputShape('cancel_scheduled_mail')!)).toEqual(['orderId', 'status', 'alreadyCancelled', 'returned', 'message']);
    expect(getServedInputSchema('cancel_scheduled_mail')).toBe(getZodInputShape('cancel_scheduled_mail'));
  });
});

describe('set_arrival_date (#535)', () => {
  it('is a write that is neither destructive nor open-world, and repeats safely', () => {
    expect(buildAnnotations({ name: 'set_arrival_date', readOnly: false })).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true
    });
  });

  it("narrates the tool's own sentence", () => {
    const message = 'Arrival date set. Goes to the printer Tue, Oct 6, and aims to arrive by Fri, Oct 16. Nothing has been sent.';
    expect(summarizeToolResult('set_arrival_date', { draftId: 'd', message, deliveryEstimate: 'x' })).toBe(message);
    expect(summarizeToolResult('set_arrival_date', { draftId: 'd' })).toBe('The arrival date was updated.');
  });

  it('has input and output shapes for registration', () => {
    expect(Object.keys(getZodInputShape('set_arrival_date')!)).toEqual(['draftId', 'arriveBy']);
    expect(Object.keys(getZodOutputShape('set_arrival_date')!)).toEqual(['draftId', 'schedule', 'deliveryEstimate', 'message']);
    // Served as declared: it is listed only while the flag is on.
    expect(getServedInputSchema('set_arrival_date')).toBe(getZodInputShape('set_arrival_date'));
  });
});

describe('arrive-by in the served schemas (#535)', () => {
  const PREVIEWS = [
    'quote_and_preview_letter',
    'quote_and_preview_letter_with_header_image',
    'quote_and_preview_letter_with_image',
    'quote_and_preview_postcard'
  ];

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('describes cancellable without naming a tool, whatever the flag: the outputs are served either way', () => {
    // cancel_scheduled_mail is listed only while arrival dates are on.
    const said = 'With an arrival date: whether it can still be cancelled free, before it goes to the printer';
    const cancellable = (shape: z.ZodRawShape | undefined) => (shape?.cancellable as z.ZodTypeAny | undefined)?.description;
    const listed = (getZodOutputShape('list_orders')!.orders as z.ZodArray<z.AnyZodObject>).element.shape;
    expect(cancellable(getZodOutputShape('send_letter')), 'send_letter').toBe(said);
    expect(cancellable(getZodOutputShape('send_postcard')), 'send_postcard').toBe(said);
    expect(cancellable(getZodOutputShape('get_order_status')), 'get_order_status').toBe(said);
    expect(cancellable(listed), 'list_orders').toBe(said);
    // And the manifest's layer, all of it.
    for (const [name, schema] of [
      ['send_letter', sendLetterOutputSchema],
      ['send_postcard', sendPostcardOutputSchema],
      ['get_order_status', getOrderStatusOutputSchema],
      ['list_orders', listOrdersOutputSchema]
    ] as const) {
      const text = JSON.stringify(schema);
      expect(text, name).toContain(said);
      expect(text, name).not.toContain('cancel_scheduled_mail');
    }
  });

  it('offers arriveBy on the four previews only while the flag is on', () => {
    vi.stubEnv('LETTER_IRL_ARRIVE_BY_ENABLED', 'true');
    // Stationery offered too (#563), so nothing else is withheld, and the
    // postcard sizes (#594), so nothing is narrowed.
    vi.stubEnv('LETTER_IRL_STATIONERY_ENABLED', 'true');
    vi.stubEnv('LETTER_IRL_PRINT_RENDERER', 'pdf');
    vi.stubEnv('LETTER_IRL_POSTCARD_SIZES_ENABLED', 'true');
    vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
    for (const name of PREVIEWS) {
      const served = getServedInputSchema(name) as Record<string, { description?: string }>;
      // On: the raw shape, as declared.
      expect(served, name).toBe(getZodInputShape(name));
      expect(served.arriveBy.description).toContain('YYYY-MM-DD');
    }
    vi.stubEnv('LETTER_IRL_ARRIVE_BY_ENABLED', '');
    for (const name of PREVIEWS) {
      const served = getServedInputSchema(name) as z.AnyZodObject;
      expect(served, name).toBeInstanceOf(z.ZodObject);
      expect(served.shape, name).not.toHaveProperty('arriveBy');
      // Everything else is served as it was.
      expect(Object.keys(served.shape)).toEqual(Object.keys(getZodInputShape(name)!).filter(key => key !== 'arriveBy'));
    }
  });

  it("passes a stray arriveBy through to the preview while off, so its refusal runs, not the SDK's strip", () => {
    vi.stubEnv('LETTER_IRL_ARRIVE_BY_ENABLED', '');
    const served = getServedInputSchema('quote_and_preview_letter') as z.AnyZodObject;
    const recipient = { name: 'Sam', addressLine1: '1 Main St', city: 'X', state: 'NY', postalCode: '10001', country: 'US' };
    const parsed = served.parse({ recipient, bodyText: 'Hi', signOff: 'Pat', arriveBy: '2026-10-16' });
    expect(parsed.arriveBy).toBe('2026-10-16');
  });

  it('leaves every other tool exactly as declared, and declares arriveBy on no other', () => {
    vi.stubEnv('LETTER_IRL_ARRIVE_BY_ENABLED', '');
    const tools = new LetterIrlServer().listTools(clientProfileNamed('chatgpt'));
    for (const tool of tools) {
      if (PREVIEWS.includes(tool.name)) continue;
      expect(getServedInputSchema(tool.name), tool.name).toBe(getZodInputShape(tool.name));
      expect(getZodInputShape(tool.name), tool.name).not.toHaveProperty('arriveBy');
    }
  });

  it("words a held preview's dates with the server's clock when the preview gave no sentence of its own", () => {
    // A result without the preview's sentence (an older result, or one whose
    // deliveryEstimate is the ordinary one): the dates are reworded, with the
    // year only when it is not this year in New York.
    vi.useFakeTimers({ now: new Date('2026-10-01T14:00:00Z'), toFake: ['Date'] });
    try {
      const schedule = { arriveBy: '2026-10-16', mailOn: '2026-10-06' };
      for (const name of PREVIEWS) {
        for (const deliveryEstimate of [undefined, 'Mailed in 1-2 business days; usually arrives in 1-2 weeks']) {
          expect(summarizeToolResult(name, { lettersRequired: 1, schedule, deliveryEstimate }), name).toMatch(
            / Scheduled: Goes to the printer Tue, Oct 6, and aims to arrive by Fri, Oct 16\. If it is sent, it is held until then; USPS does not guarantee First-Class dates\.$/
          );
        }
      }
      vi.setSystemTime(new Date('2025-12-01T15:00:00Z'));
      expect(summarizeToolResult('quote_and_preview_letter', { lettersRequired: 1, schedule })).toContain(
        'Goes to the printer Tue, Oct 6, 2026, and aims to arrive by Fri, Oct 16, 2026.'
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("narrates a held preview's dates as the preview worded them, and nothing extra for mail sent at once", () => {
    const schedule = { arriveBy: '2026-10-16', mailOn: '2026-10-06', releasesAt: '2026-10-06T13:00:00.000Z', earliestArrival: '2026-10-13', latestArrival: '2026-11-30' };
    // As a preview built it with its own clock, here a year before these dates:
    // the narration repeats it rather than rewording it with the server's clock.
    const deliveryEstimate = 'Goes to the printer Tue, Oct 6, 2026, and aims to arrive by Fri, Oct 16, 2026.';
    for (const name of PREVIEWS) {
      const held = summarizeToolResult(name, { lettersRequired: 1, schedule, deliveryEstimate });
      expect(held, name).toMatch(
        / Scheduled: Goes to the printer Tue, Oct 6, 2026, and aims to arrive by Fri, Oct 16, 2026\. If it is sent, it is held until then; USPS does not guarantee First-Class dates\.$/
      );
      expect(summarizeToolResult(name, { lettersRequired: 1, deliveryEstimate: 'Mailed in 1-2 business days' }), name).not.toContain('Scheduled');
    }
  });
});

describe("a letter preview's narration names its stationery (#563)", () => {
  const PREVIEW = { lettersRequired: 1, layoutType: 'text_only' };

  it('names a theme asked for, and a remembered one as the account\'s last choice', () => {
    expect(summarizeToolResult('quote_and_preview_letter', { ...PREVIEW, stationery: { theme: 'botanical', source: 'asked' } })).toMatch(
      / Stationery: botanical\.$/
    );
    expect(summarizeToolResult('quote_and_preview_letter', { ...PREVIEW, stationery: { theme: 'monogram', source: 'remembered' } })).toMatch(
      / Stationery: monogram, the account's last choice; stationery in the call or set_stationery changes it\.$/
    );
    // Classic asked for is named too.
    expect(summarizeToolResult('quote_and_preview_letter', { ...PREVIEW, stationery: { theme: 'classic', source: 'asked' } })).toMatch(
      / Stationery: classic\.$/
    );
  });

  it('says nothing of Classic by default, or while stationery is not offered', () => {
    const plain = summarizeToolResult('quote_and_preview_letter', PREVIEW);
    expect(summarizeToolResult('quote_and_preview_letter', { ...PREVIEW, stationery: { theme: 'classic', source: 'default' } })).toBe(plain);
    expect(plain).not.toContain('Stationery');
  });

  it('names the pages of a longer letter and the sheets, led by Pay & Send (#586), and nothing for one page', () => {
    const paidPerSend = { sendEligibility: { packPays: false } };
    for (const name of ['quote_and_preview_letter', 'quote_and_preview_letter_with_header_image', 'quote_and_preview_letter_with_image']) {
      const two = summarizeToolResult(name, { ...PREVIEW, ...paidPerSend, pages: 2 });
      expect(two, name).toMatch(/^Preview ready: paid with Pay & Send\. /);
      expect(two, name).toMatch(/ A two-page letter, printed on both sides of one sheet\.$/);
      expect(two, name).not.toContain('requires');
      expect(summarizeToolResult(name, { ...PREVIEW, ...paidPerSend, pages: 3 }), name).toMatch(
        / A three-page letter, printed on both sides of two sheets\.$/
      );
      expect(summarizeToolResult(name, PREVIEW), name).toMatch(/^Preview ready: requires 1 letter\. /);
      expect(summarizeToolResult(name, PREVIEW), name).not.toContain('page letter');
      expect(summarizeToolResult(name, { ...PREVIEW, pages: 1 }), name).not.toContain('page letter');
    }
    // A postcard no pack pays for (#579) is led the same way.
    expect(summarizeToolResult('quote_and_preview_postcard', { lettersRequired: 1, ...paidPerSend })).toMatch(
      /^Postcard preview ready: paid with Pay & Send\. /
    );
    expect(summarizeToolResult('quote_and_preview_postcard', { lettersRequired: 1 })).toMatch(/^Postcard preview ready: requires 1 letter\. /);
    // A result without its count reads as one letter, in the singular.
    expect(summarizeToolResult('quote_and_preview_letter', { layoutType: 'text_only' })).toMatch(/^Preview ready: requires 1 letter\. /);
  });

  it("answers set_stationery with the tool's own sentence", () => {
    expect(summarizeToolResult('set_stationery', { message: 'The letter is now on the botanical stationery.' })).toBe(
      'The letter is now on the botanical stationery.'
    );
  });
});
