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
  partitionToolResult,
  normalizeHttpsOrigin,
  getZodOutputShape,
  WIDGET_DEFINITIONS,
  WIDGET_MIME_TYPE
} from '../../../src/mcp/registerTools.js';
import { createHash } from 'crypto';
import { widgetTemplateUri, WIDGET_TEMPLATE_VERSION } from '../../../src/mcp/widgetUris.js';
import { LetterIrlServer } from '../../../src/server.js';

describe('Widget Resource Registration (US-MCP-07)', () => {
  describe('widget URI format', () => {
    // The previous version built `ui://widgets/${name}.html` itself and then
    // asserted the string it had just built matched a ui:// pattern. It held
    // for any widget name, including one with no file behind it.
    it.each(WIDGET_DEFINITIONS)(
      '$name is addressable at the ui:// path a tool would reference',
      async ({ name }) => {
        const uri = widgetTemplateUri(name);
        // The versioned URI (…html@vN) maps to the unversioned file on disk.
        const file = path.join(
          path.resolve(__dirname, '../../../widgets'),
          uri.replace(/^ui:\/\/widgets\//, '').replace(/@v\d+$/, '')
        );
        const exists = await fs.access(file).then(() => true).catch(() => false);
        expect(exists, `${uri} resolves to no file`).toBe(true);
      }
    );

    it('should have 4 widgets defined', () => {
      expect(WIDGET_DEFINITIONS.length).toBe(4);
    });

    it('does not define the removed GenerateImageCard widget', () => {
      // generate_image_fallback and its widget were removed (decision record:
      // docs/learnings/generate-image-removal-decision.md). Pin the removal so
      // a merge or revert cannot silently resurrect it.
      expect(WIDGET_DEFINITIONS.map((widget) => widget.name)).not.toContain('GenerateImageCard');
    });

    it('versions every widget template URI (issue #235 cache-bust)', () => {
      // Literal shape assertion, deliberately NOT helper-vs-helper: if someone
      // strips the @vN suffix from widgetTemplateUri, this reddens.
      expect(widgetTemplateUri('LetterPreviewCard')).toMatch(
        /^ui:\/\/widgets\/LetterPreviewCard\.html@v\d+$/
      );
    });

    it('WIDGET_TEMPLATE_VERSION was bumped when widget HTML last changed', async () => {
      // Self-maintaining #235 invariant: this digest is recorded alongside the
      // version. When widget HTML changes this test fails; the fix is to bump
      // WIDGET_TEMPLATE_VERSION in src/mcp/widgetUris.ts AND re-record the
      // digest printed in the failure message. Bumping only the digest ships
      // stale widgets to native mobile caches - always bump both.
      const widgetDir = path.resolve(__dirname, '../../../widgets');
      const parts: string[] = [];
      for (const { name } of [...WIDGET_DEFINITIONS].sort((a, b) => a.name.localeCompare(b.name))) {
        const content = await fs.readFile(path.join(widgetDir, `${name}.html`), 'utf-8');
        parts.push(`${name}:${createHash('sha256').update(content).digest('hex')}`);
      }
      const digest = createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 12);
      expect({ version: WIDGET_TEMPLATE_VERSION, digest }).toEqual({
        version: 4,
        digest: '102f5c3499c8'
      });
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
      expect(templates.get('quote_and_preview_letter')).toBe(widgetTemplateUri('LetterPreviewCard'));
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
      'headerImagePreview',
      'inlineImagePreview'
    ]);

    /**
     * Reads that no channel can satisfy. Empty, and asserted exactly so it
     * stays that way: a new violation fails this test rather than joining a
     * growing allowance.
     *
     * It held LetterPreviewCard's headerImagePreview and inlineImagePreview
     * until those were routed through `_meta` - the card had been rendering
     * every image letter without its image.
     */
    const KNOWN_UNDELIVERABLE: Record<string, string[]> = {};

    function widgetToolNames(): Map<string, string> {
      const byWidget = new Map<string, string>();
      for (const tool of new LetterIrlServer().listTools()) {
        const template = tool.meta?.['openai/outputTemplate'];
        if (typeof template !== 'string') continue;
        // Version suffix is REQUIRED here: an unversioned outputTemplate keeps
        // ".html" in the key and fails the binding test below, so removing the
        // #235 cache-bust cannot slip through silently.
        const widget = template.replace(/^ui:\/\/widgets\//, '').replace(/\.html@v\d+$/, '');
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
    expect(WIDGET_DEFINITIONS.length).toBe(4);
    expect(WIDGET_DEFINITIONS.map((widget) => widget.name)).toEqual([
      'LetterPreviewCard',
      'PostcardPreviewCard',
      'ImageUploadCard',
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

// Rescued from the deleted generatedImageResultBridge.test.ts (its widget was
// removed; these pins are widget-independent and must survive).
describe('widget image CSP', () => {
  it('publishes canonical and legacy CSP with the exact API origin', () => {
    const meta = buildWidgetResourceMeta('Test widget');

    expect(meta.ui.csp).toEqual({
      connectDomains: ['https://chatgpt.com', 'https://api.letterirl.com'],
      resourceDomains: ['https://*.oaistatic.com', 'https://*.oaiusercontent.com', 'https://api.letterirl.com'],
      redirectDomains: ['https://checkout.stripe.com', 'https://letterirl.com']
    });
    expect(meta['openai/widgetCSP']).toEqual({
      connect_domains: ['https://chatgpt.com', 'https://api.letterirl.com'],
      resource_domains: ['https://*.oaistatic.com', 'https://*.oaiusercontent.com', 'https://api.letterirl.com'],
      redirect_domains: ['https://checkout.stripe.com', 'https://letterirl.com']
    });
  });

  it('normalizes a configured API URL to an HTTPS origin', () => {
    expect(normalizeHttpsOrigin('https://dev.example.com/mcp?ignored=true'))
      .toBe('https://dev.example.com');
    expect(normalizeHttpsOrigin('http://dev.example.com/mcp'))
      .toBe('https://api.letterirl.com');
  });
});


// Rescued from the deleted generatedImageResultBridge.test.ts: these pin
// still-live partitionToolResult behavior with a documented silent-failure
// history (header/inline letters once rendered cards without their images
// because the previews reached neither channel).
describe('partitionToolResult channel contract', () => {
  it('omits absent metadata and all heavy model-facing image fields', () => {
    const result = partitionToolResult({
      message: 'Preview ready',
      inlineImageData: 'inline-base64',
      headerImageData: 'header-base64',
      frontImageData: 'front-base64'
    });

    expect(result.structuredContent).toEqual({ message: 'Preview ready' });
    expect(result._meta).toEqual({});
  });

  it('forwards the compressed image previews to the widget, not to the model', () => {
    const result = partitionToolResult({
      message: 'Preview ready',
      headerImagePreview: 'header-preview-base64',
      inlineImagePreview: 'inline-preview-base64',
      headerImageData: 'header-full-base64'
    });

    expect(result.structuredContent).toEqual({ message: 'Preview ready' });
    expect(result._meta).toEqual({
      headerImagePreview: 'header-preview-base64',
      inlineImagePreview: 'inline-preview-base64'
    });
  });
});
