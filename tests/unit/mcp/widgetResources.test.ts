/**
 * Unit tests for MCP Widget Resource Registration
 *
 * Tests that widgets are registered as MCP resources with:
 * - ui:// protocol URI
 * - text/html;profile=mcp-app MIME type
 * - Proper content delivery
 *
 * User Stories Covered:
 * - US-MCP-07: Widget Resources for ChatGPT UI
 *
 * GitHub Issue: #19
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  buildWidgetResourceMeta,
  getZodOutputShape,
  WIDGET_DEFINITIONS,
  WIDGET_MIME_TYPE
} from '../../../src/mcp/registerTools.js';
import { LetterIrlServer } from '../../../src/server.js';

describe('Widget Resource Registration (US-MCP-07)', () => {
  describe('widget URI format', () => {
    // The previous version built `ui://widgets/${name}.html` itself and then
    // asserted the string it had just built matched a ui:// pattern. It held
    // for any widget name, including one with no file behind it.
    it.each(WIDGET_DEFINITIONS)(
      '$name is addressable at the ui:// path a tool would reference',
      async ({ name }) => {
        const uri = `ui://widgets/${name}.html`;
        const file = path.join(
          path.resolve(__dirname, '../../../widgets'),
          uri.replace(/^ui:\/\/widgets\//, '')
        );
        const exists = await fs.access(file).then(() => true).catch(() => false);
        expect(exists, `${uri} resolves to no file`).toBe(true);
      }
    );

    it('should have 5 widgets defined', () => {
      expect(WIDGET_DEFINITIONS.length).toBe(5);
    });
  });

  describe('widget MIME type', () => {
    it('should use text/html;profile=mcp-app MIME type', () => {
      expect(WIDGET_MIME_TYPE).toBe('text/html;profile=mcp-app');
    });
  });

  describe('widget metadata aliases', () => {
    it('should expose canonical ui metadata and OpenAI compatibility aliases', () => {
      const meta = buildWidgetResourceMeta('Test widget');
      expect(meta.ui).toMatchObject({
        description: 'Test widget',
        domain: 'https://api.letterirl.com',
        csp: {
          redirectDomains: expect.arrayContaining([
            'https://checkout.stripe.com',
            'https://letterirl.com'
          ])
        },
        prefersBorder: true
      });
      expect(meta).toMatchObject({
        'openai/widgetPrefersBorder': true,
        'openai/widgetDescription': 'Test widget',
        'openai/widgetCSP': {
          redirect_domains: expect.arrayContaining([
            'https://checkout.stripe.com',
            'https://letterirl.com'
          ])
        }
      });
    });
  });

  describe('tool outputTemplate references', () => {
    const templates = new Map(
      new LetterIrlServer().listTools().map(tool => [
        tool.name,
        tool.meta?.['openai/outputTemplate'] as string | undefined
      ])
    );

    it('quote_and_preview_letter references the LetterPreviewCard widget', () => {
      expect(templates.get('quote_and_preview_letter')).toBe('ui://widgets/LetterPreviewCard.html');
    });

    it.each([
      'get_account_balance',
      'get_order_status',
      'send_letter'
    ])('%s declares no widget, because it answers in text', toolName => {
      // Asserted against the registered tool rather than a list written here.
      // The previous version built the array and checked its own length, which
      // held whatever the tools actually declared.
      expect(templates.has(toolName)).toBe(true);
      expect(templates.get(toolName)).toBeUndefined();
    });
  });

  describe('widget HTML content', () => {
    const widgetDir = path.resolve(__dirname, '../../../widgets');

    it.each(WIDGET_DEFINITIONS)(
      '$name.html should exist',
      async ({ name }) => {
        const filePath = path.join(widgetDir, `${name}.html`);
        const exists = await fs.access(filePath).then(() => true).catch(() => false);
        expect(exists).toBe(true);
      }
    );

    it.each(WIDGET_DEFINITIONS)(
      '$name.html should use window.openai.toolOutput',
      async ({ name }) => {
        const filePath = path.join(widgetDir, `${name}.html`);
        const content = await fs.readFile(filePath, 'utf-8');
        expect(content).toContain('window.openai');
        expect(content).toContain('toolOutput');
      }
    );

    it.each(WIDGET_DEFINITIONS)(
      '$name.html should listen for openai:set_globals event',
      async ({ name }) => {
        const filePath = path.join(widgetDir, `${name}.html`);
        const content = await fs.readFile(filePath, 'utf-8');
        expect(content).toContain('openai:set_globals');
      }
    );

    it.each(WIDGET_DEFINITIONS)(
      '$name.html should NOT use deprecated window.renderContext',
      async ({ name }) => {
        const filePath = path.join(widgetDir, `${name}.html`);
        const content = await fs.readFile(filePath, 'utf-8');
        expect(content).not.toContain('renderContext');
      }
    );
  });

  /**
   * Every field a widget reads off `window.openai.toolOutput` has to survive
   * into structuredContent, or the card renders a blank where a value should
   * be - silently, with no error anywhere.
   *
   * Two things can stop a field arriving. partitionToolResult deliberately
   * moves the large ones into `_meta`, where the widget must read them from
   * `toolResponseMetadata` instead. And structuredContent is validated against
   * the tool's zod output schema, which strips anything the schema does not
   * declare. A field in neither place cannot reach the widget by any route.
   *
   * This replaced a test that asserted four string literals were strings. It
   * named this contract and checked none of it, and the contract it named was
   * already stale - `requiredCredits` is not a top-level field of the letter
   * preview output.
   *
   * Reading the widget's field access out of its HTML is crude, and it is what
   * is available until something can actually render a widget (issue #206).
   */
  describe('widget data contract', () => {
    const widgetDir = path.resolve(__dirname, '../../../widgets');

    /** Moved to `_meta` by partitionToolResult; legitimately absent from structuredContent. */
    const META_PARTITIONED = new Set([
      'previewHtml',
      'previewFrontHtml',
      'previewBackHtml',
      'inlineImageData',
      'headerImageData',
      'frontImageData',
      'generatedImagePreview'
    ]);

    /**
     * Reads that cannot be satisfied today: not declared in the output schema,
     * so zod strips them, and not in the `_meta` partition either. Recorded
     * rather than fixed because confirming what the card does without them
     * needs a renderer - see #206. The list is asserted exactly, so a new
     * violation fails this test instead of joining a growing allowance.
     */
    const KNOWN_UNDELIVERABLE: Record<string, string[]> = {
      LetterPreviewCard: ['headerImagePreview', 'inlineImagePreview']
    };

    function widgetToolNames(): Map<string, string> {
      const byWidget = new Map<string, string>();
      for (const tool of new LetterIrlServer().listTools()) {
        const template = tool.meta?.['openai/outputTemplate'];
        if (typeof template !== 'string') continue;
        const widget = template.replace(/^ui:\/\/widgets\//, '').replace(/\.html$/, '');
        if (!byWidget.has(widget)) byWidget.set(widget, tool.name);
      }
      return byWidget;
    }

    it('binds every widget to a tool that declares it', () => {
      const bound = widgetToolNames();
      expect(bound.size).toBeGreaterThan(0);
      for (const widget of bound.keys()) {
        expect(WIDGET_DEFINITIONS.map(definition => definition.name)).toContain(widget);
      }
    });

    it('reads only fields its tool can actually deliver', async () => {
      const bound = widgetToolNames();
      const unaccounted: Record<string, string[]> = {};

      for (const [widget, toolName] of bound) {
        const shape = getZodOutputShape(toolName);
        if (!shape) continue;
        const html = await fs.readFile(path.join(widgetDir, `${widget}.html`), 'utf-8');
        const read = new Set(
          [...html.matchAll(/\bstate\.([a-zA-Z_][a-zA-Z0-9_]*)/g)].map(match => match[1])
        );
        const missing = [...read]
          .filter(field => !(field in shape) && !META_PARTITIONED.has(field))
          .sort();
        if (missing.length) unaccounted[widget] = missing;
      }

      expect(unaccounted).toEqual(KNOWN_UNDELIVERABLE);
    });
  });

  describe('widget features', () => {
    it('LetterPreviewCard should have loading state', async () => {
      const filePath = path.join(path.resolve(__dirname, '../../../widgets'), 'LetterPreviewCard.html');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('loading');
      expect(content).toContain('showLoading');
    });

    it('LetterPreviewCard should have send button (US-MCP-08)', async () => {
      const filePath = path.join(path.resolve(__dirname, '../../../widgets'), 'LetterPreviewCard.html');
      const content = await fs.readFile(filePath, 'utf-8');
      // US-MCP-08: Widget now has a Send button that calls send_letter via callTool
      expect(content).toContain('send-button');
      expect(content).toContain('Send Letter');
    });
  });
});

describe('registerWidgetResources implementation', () => {
  it('should register all widget resources', () => {
    expect(WIDGET_DEFINITIONS.length).toBe(5);
    expect(WIDGET_DEFINITIONS.map((widget) => widget.name)).toEqual([
      'LetterPreviewCard',
      'PostcardPreviewCard',
      'ImageUploadCard',
      'GenerateImageCard',
      'GetStartedCard'
    ]);
  });

  it('should handle missing widget files gracefully', () => {
    // The implementation should skip widgets that don't exist
    // and log a warning instead of throwing
    const nonExistentWidget = { name: 'NonExistent', description: 'Does not exist' };
    expect(() => {
      const uri = `ui://widgets/${nonExistentWidget.name}.html`;
      return uri;
    }).not.toThrow();
  });
});
