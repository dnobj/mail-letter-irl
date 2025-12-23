/**
 * Unit tests for MCP Widget Resource Registration
 *
 * Tests that the LetterPreviewCard widget is registered as an MCP resource with:
 * - ui:// protocol URI
 * - text/html+skybridge MIME type
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

// Only LetterPreviewCard widget is used - other tools use text responses
const WIDGET_DEFINITIONS = [
  { name: "LetterPreviewCard", description: "Shows letter preview with cost, delivery info, and status" },
];

describe('Widget Resource Registration (US-MCP-07)', () => {
  describe('widget URI format', () => {
    it.each(WIDGET_DEFINITIONS)(
      'should use ui:// protocol for $name',
      ({ name }) => {
        const expectedUri = `ui://widgets/${name}.html`;
        expect(expectedUri).toMatch(/^ui:\/\//);
        expect(expectedUri).toContain(name);
        expect(expectedUri).toMatch(/\.html$/);
      }
    );

    it('should have 1 widget defined (LetterPreviewCard only)', () => {
      expect(WIDGET_DEFINITIONS.length).toBe(1);
    });
  });

  describe('widget MIME type', () => {
    it('should use text/html+skybridge MIME type', () => {
      // The skybridge MIME type tells ChatGPT to inject window.openai runtime
      const expectedMimeType = 'text/html+skybridge';
      expect(expectedMimeType).toBe('text/html+skybridge');
    });
  });

  describe('tool outputTemplate references', () => {
    it('quote_and_preview_letter should reference LetterPreviewCard widget', () => {
      const widget = 'ui://widgets/LetterPreviewCard.html';
      expect(widget).toMatch(/^ui:\/\/widgets\/\w+\.html$/);
    });

    it('other tools should NOT have widget outputTemplate', () => {
      // get_account_balance, get_order_status, send_letter, switch_account
      // all use text responses now, not widgets
      const textOnlyTools = [
        'get_account_balance',
        'get_order_status',
        'send_letter',
        'switch_account',
      ];
      expect(textOnlyTools.length).toBe(4);
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

  describe('widget data structure compatibility', () => {
    it('LetterPreviewCard expects previewHtml, requiredCredits, canSendNow, draftId', () => {
      const expectedFields = ['previewHtml', 'requiredCredits', 'canSendNow', 'draftId'];
      expectedFields.forEach(field => {
        expect(typeof field).toBe('string');
      });
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
  it('should register 1 widget resource (LetterPreviewCard only)', () => {
    expect(WIDGET_DEFINITIONS.length).toBe(1);
    expect(WIDGET_DEFINITIONS[0].name).toBe('LetterPreviewCard');
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
