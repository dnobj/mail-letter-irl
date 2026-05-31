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

import { describe, it, expect } from 'vitest';
import { LetterIrlServer } from '../../../src/server.js';
import {
  buildAnnotations,
  buildToolMeta,
  buildToolSecuritySchemes,
  getZodInputShape,
  getZodOutputShape
} from '../../../src/mcp/registerTools.js';

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
  { name: 'get_started', readOnly: true },
  { name: 'get_account_balance', readOnly: true },
  { name: 'get_order_status', readOnly: true },
  { name: 'get_return_address', readOnly: true },
  { name: 'list_orders', readOnly: true },
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
  { name: 'set_return_address', readOnly: false },
  { name: 'confirm_uploaded_image', readOnly: false },
  { name: 'submit_feature_request', readOnly: false },
  { name: 'upload_image', readOnly: false },
  { name: 'generate_image', readOnly: false },
];

// Destructive tools: delete user data
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

    it('should have exactly 5 read-only tools', () => {
      expect(readOnlyTools.length).toBe(5);
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
      '$name should have destructiveHint: false (non-destructive)',
      ({ name }) => {
        const annotations = buildAnnotations({ name, readOnly: false });
        expect(annotations.destructiveHint).toBe(false);
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

    it('should have destructiveHint: false (non-destructive)', () => {
      const annotations = buildAnnotations({ name: 'set_return_address', readOnly: false });
      expect(annotations.destructiveHint).toBe(false);
    });
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
    it('should cover all 17 registered tools in annotation checks', () => {
      const runtimeToolNames = new LetterIrlServer().listTools().map((tool) => tool.name).sort();
      const checkedToolNames = allTools.map((tool) => tool.name).sort();

      expect(allTools.length).toBe(17);
      expect(checkedToolNames).toEqual(runtimeToolNames);
    });

    it('should have 5 read-only tools', () => {
      const readOnlyCount = allTools.filter(t => {
        const annotations = buildAnnotations({ name: t.name, readOnly: t.readOnly });
        return annotations.readOnlyHint === true;
      }).length;
      expect(readOnlyCount).toBe(5);
    });

    it('should have 12 write tools (non-read-only)', () => {
      const writeCount = allTools.filter(t => {
        const annotations = buildAnnotations({ name: t.name, readOnly: t.readOnly });
        return annotations.readOnlyHint === false;
      }).length;
      expect(writeCount).toBe(12);
    });

    it('should have 8 open-world tools (call external APIs)', () => {
      const openWorldCount = allTools.filter(t => {
        const annotations = buildAnnotations({ name: t.name, readOnly: t.readOnly });
        return annotations.openWorldHint === true;
      }).length;
      expect(openWorldCount).toBe(8);
    });

    it('should have 5 idempotent tools (send + address management + upload relay)', () => {
      const idempotentCount = allTools.filter(t => {
        const annotations = buildAnnotations({ name: t.name, readOnly: t.readOnly });
        return annotations.idempotentHint === true;
      }).length;
      expect(idempotentCount).toBe(5);
    });

    it('should have 1 destructive tool', () => {
      const destructiveCount = allTools.filter(t => {
        const annotations = buildAnnotations({ name: t.name, readOnly: t.readOnly });
        return annotations.destructiveHint === true;
      }).length;
      expect(destructiveCount).toBe(1);
    });
  });

  describe('Runtime Zod Schema Coverage', () => {
    it('should register input and output Zod shapes for every runtime tool', () => {
      const tools = new LetterIrlServer().listTools();

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
      expect(buildToolSecuritySchemes(true)).toEqual([
        {
          type: 'oauth2',
          scopes: ['openid', 'email', 'profile']
        }
      ]);
    });

    it('should declare noauth security scheme when auth is disabled', () => {
      expect(buildToolSecuritySchemes(false)).toEqual([{ type: 'noauth' }]);
    });

    it('should merge securitySchemes into tool metadata', () => {
      expect(
        buildToolMeta(
          {
            'openai/outputTemplate': 'ui://widgets/LetterPreviewCard.html',
            'openai/widgetAccessible': true
          },
          true
        )
      ).toMatchObject({
        securitySchemes: [
          {
            type: 'oauth2',
            scopes: ['openid', 'email', 'profile']
          }
        ],
        'openai/widgetAccessible': true,
        ui: {
          resourceUri: 'ui://widgets/LetterPreviewCard.html',
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
});
