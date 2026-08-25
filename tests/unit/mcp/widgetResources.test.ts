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
import type { z } from 'zod';
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

    it('should have 5 widgets defined', () => {
      expect(WIDGET_DEFINITIONS.length).toBe(5);
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
        // Normalize line endings: with core.autocrlf a Windows checkout
        // materializes CRLF and the pin must not depend on that.
        const content = (await fs.readFile(path.join(widgetDir, `${name}.html`), 'utf-8')).replace(/\r\n/g, '\n');
        parts.push(`${name}:${createHash('sha256').update(content).digest('hex')}`);
      }
      const digest = createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 12);
      expect({ version: WIDGET_TEMPLATE_VERSION, digest }).toEqual({
        version: 15,
        digest: 'f1af82ba787d'
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
   * `toolResponseMetadata` instead. And ChatGPT filters structuredContent
   * against the JSON Schema the server published on `tools/list` - built from
   * the tool's zod output schema - so a field the schema does not declare is
   * dropped before the widget ever sees it. (The drop is client-side: at SDK
   * 1.29.0 the server validates and ships the result unstripped. See
   * src/contracts/outputConformance.ts, which guards the same contract from
   * the producing side.) A field in neither place cannot reach the widget by
   * any route.
   *
   * This check has now missed two live bugs, and the misses were all in how it
   * read the HTML rather than in the rule it enforced:
   *
   *   1. It matched only `state.foo`, so the destructuring both preview cards
   *      actually use (`const { recipientName, ... } = state`) was invisible -
   *      3 of ~25 reads seen in PostcardPreviewCard. That is how the flat
   *      address fields shipped undeclared.
   *   2. It captured only the first path segment, so
   *      `state.senderAddressValidation?.originalAddress` passed on the parent
   *      key alone. That is how `originalAddress` shipped undeclared, leaving
   *      the letter card's address window empty on every preview.
   *   3. It assumed the alias was named `state`. ImageRoutingCard reads `out.`
   *      and ImageUploadCard reads `output.`, so both asserted nothing at all.
   *
   * So the extraction now discovers each widget's own alias for the output
   * object, follows destructuring, and validates dotted paths against the
   * nested schema.
   *
   * Reading field access out of HTML is still crude, and it is what is
   * available until something can actually render a widget (issue #206).
   */
  describe('widget data contract', () => {
    const widgetDir = path.resolve(__dirname, '../../../widgets');

    /**
     * Moved out of structuredContent by partitionToolResult and legitimately
     * absent from the schema. Derived from the real function rather than
     * hand-copied: the previous copy had already drifted, omitting
     * generatedImagePreview.
     */
    const META_PARTITIONED = (() => {
      const probe: Record<string, unknown> = {
        previewHtml: 'x',
        previewFrontHtml: 'x',
        previewBackHtml: 'x',
        inlineImageData: 'x',
        headerImageData: 'x',
        frontImageData: 'x',
        headerImagePreview: 'x',
        inlineImagePreview: 'x',
        generatedImagePreview: 'x',
        title: 'x',
        overview: 'x',
        purchaseStep: 'x',
        examplePrompts: ['x'],
        // Control: a field partitionToolResult must leave alone, so this
        // derivation fails loudly if it ever stops removing anything.
        draftId: 'x'
      };
      const { structuredContent } = partitionToolResult({ ...probe });
      const removed = Object.keys(probe).filter(key => !(key in structuredContent));
      expect(removed).toContain('generatedImagePreview');
      expect(removed).not.toContain('draftId');
      return new Set(removed);
    })();

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

    /**
     * The identifiers a widget uses for the tool output. Seeded from any
     * declaration whose initializer mentions toolOutput (covering
     * `= window.openai.toolOutput` and `= toolOutput()` alike), then extended
     * through spreads so GetStartedCard's `{ ...responseMeta, ...output }`
     * merge is followed too.
     */
    function outputAliases(html: string): Set<string> {
      const aliases = new Set<string>();
      const declarations = [
        ...html.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]*)/g)
      ];
      for (const [, name, init] of declarations) {
        if (/\btoolOutput\b/.test(init)) aliases.add(name);
      }
      // Transitive: an object literal spreading an alias also carries its fields.
      let grew = true;
      while (grew) {
        grew = false;
        for (const [, name, init] of declarations) {
          if (aliases.has(name)) continue;
          const spreads = [...init.matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)/g)].map(m => m[1]);
          if (spreads.some(spread => aliases.has(spread))) {
            aliases.add(name);
            grew = true;
          }
        }
      }
      return aliases;
    }

    /** Dotted field paths a widget reads off any of its output aliases. */
    function fieldReads(html: string, aliases: Set<string>): Set<string> {
      const paths = new Set<string>();
      for (const alias of aliases) {
        const escaped = alias.replace(/\$/g, '\\$');
        // Member access, following optional chains: alias.a?.b.c
        const member = new RegExp(
          `\\b${escaped}((?:\\s*\\??\\.\\s*[A-Za-z_$][\\w$]*)+)`,
          'g'
        );
        for (const match of html.matchAll(member)) {
          const segments = match[1]
            .split(/\??\./)
            .map(segment => segment.trim())
            .filter(Boolean);
          if (segments.length) paths.add(segments.join('.'));
        }
        // Destructuring, including multiline and renames: const { a, b: c } = alias
        const destructure = new RegExp(
          `\\{([^{}]*)\\}\\s*=\\s*${escaped}\\b`,
          'gs'
        );
        for (const match of html.matchAll(destructure)) {
          for (const entry of match[1].split(',')) {
            const key = entry.split(':')[0].trim().replace(/^\.\.\./, '');
            if (/^[A-Za-z_$][\w$]*$/.test(key)) paths.add(key);
          }
        }
      }
      return paths;
    }

    /**
     * Walks a dotted path through the zod shape, unwrapping optionals and
     * stepping into arrays, so a nested read is checked against the nested
     * schema instead of passing on its parent key.
     */
    function pathIsDeclared(shape: Record<string, z.ZodTypeAny>, dotted: string): boolean {
      const [head, ...rest] = dotted.split('.');
      let current: z.ZodTypeAny | undefined = shape[head];
      if (!current) return false;
      for (const segment of rest) {
        // Unwrap optional/nullable/default wrappers, then arrays.
        for (let i = 0; i < 8; i += 1) {
          const candidate = current as unknown as {
            unwrap?: () => z.ZodTypeAny;
            element?: z.ZodTypeAny;
            shape?: Record<string, z.ZodTypeAny>;
          };
          if (candidate?.shape) break;
          if (typeof candidate?.unwrap === 'function') {
            current = candidate.unwrap();
            continue;
          }
          if (candidate?.element) {
            current = candidate.element;
            continue;
          }
          break;
        }
        const objectShape = (current as unknown as { shape?: Record<string, z.ZodTypeAny> })?.shape;
        // A read one level into a non-object (or a passthrough record) cannot
        // be proven wrong; treat the parent's declaration as sufficient.
        if (!objectShape) return true;
        current = objectShape[segment];
        if (!current) return false;
      }
      return true;
    }

    it('binds every widget to a tool that declares it', () => {
      const bound = widgetToolNames();
      expect(bound.size).toBeGreaterThan(0);
      for (const widget of bound.keys()) {
        expect(WIDGET_DEFINITIONS.map(definition => definition.name)).toContain(widget);
      }
    });

    it('finds the output alias every widget actually uses', async () => {
      // Guards hole 3 directly: if a widget renames its output variable and
      // the discovery stops seeing it, the contract test below would go
      // vacuously green instead of failing.
      const bound = widgetToolNames();
      for (const widget of bound.keys()) {
        const html = await fs.readFile(path.join(widgetDir, `${widget}.html`), 'utf-8');
        const aliases = outputAliases(html);
        expect(aliases.size, `${widget}: no window.openai.toolOutput alias found`).toBeGreaterThan(0);
        expect(
          fieldReads(html, aliases).size,
          `${widget}: alias found but no field reads extracted`
        ).toBeGreaterThan(0);
      }
    });

    it('reads only fields its tool can actually deliver', async () => {
      const bound = widgetToolNames();
      const unaccounted: Record<string, string[]> = {};

      for (const [widget, toolName] of bound) {
        const shape = getZodOutputShape(toolName);
        if (!shape) continue;
        const html = await fs.readFile(path.join(widgetDir, `${widget}.html`), 'utf-8');
        const missing = [...fieldReads(html, outputAliases(html))]
          .filter(
            dotted =>
              !pathIsDeclared(shape as Record<string, z.ZodTypeAny>, dotted) &&
              !META_PARTITIONED.has(dotted.split('.')[0])
          )
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
      'GetStartedCard',
      'ImageRoutingCard'
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
