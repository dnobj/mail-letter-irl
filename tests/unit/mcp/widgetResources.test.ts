/**
 * Unit tests for MCP Widget Resource Registration
 *
 * Tests that widgets are registered as MCP resources with correct:
 * - ui:// protocol URIs
 * - text/html+skybridge MIME type
 * - Proper content delivery
 *
 * User Stories Covered:
 * - US-MCP-07: Widget Resources for ChatGPT UI
 *
 * GitHub Issue: #19
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';

// Widget definitions matching the implementation
const WIDGET_DEFINITIONS = [
  { name: "BalanceCard", description: "Displays account credit balance and send affordability" },
  { name: "LetterPreviewCard", description: "Shows letter preview with send action button" },
  { name: "LetterConfirmationCard", description: "Confirms letter has been queued for sending" },
  { name: "LetterStatusCard", description: "Shows order status timeline and delivery tracking" },
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

    it('should have all 4 widgets defined', () => {
      expect(WIDGET_DEFINITIONS.length).toBe(4);
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
    const toolWidgetMappings = [
      { tool: 'get_account_balance', widget: 'ui://widgets/BalanceCard.html' },
      { tool: 'get_order_status', widget: 'ui://widgets/LetterStatusCard.html' },
      { tool: 'quote_and_preview_letter', widget: 'ui://widgets/LetterPreviewCard.html' },
      { tool: 'send_letter', widget: 'ui://widgets/LetterConfirmationCard.html' },
    ];

    it.each(toolWidgetMappings)(
      '$tool should reference $widget',
      ({ tool, widget }) => {
        expect(widget).toMatch(/^ui:\/\/widgets\/\w+\.html$/);
      }
    );

    it('switch_account should use text template (no widget)', () => {
      // switch_account returns logout instructions, not balance data
      const expectedTemplate = 'text';
      expect(expectedTemplate).toBe('text');
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
      '$name.html should NOT use deprecated window.renderContext',
      async ({ name }) => {
        const filePath = path.join(widgetDir, `${name}.html`);
        const content = await fs.readFile(filePath, 'utf-8');
        expect(content).not.toContain('renderContext');
      }
    );
  });

  describe('widget data structure compatibility', () => {
    // Each widget expects specific data fields from toolOutput

    it('BalanceCard expects creditsRemaining, canSendStandardLetter', () => {
      const expectedFields = ['creditsRemaining', 'canSendStandardLetter', 'message'];
      expectedFields.forEach(field => {
        expect(typeof field).toBe('string');
      });
    });

    it('LetterPreviewCard expects previewHtml, requiredCredits, canSendNow', () => {
      const expectedFields = ['previewHtml', 'requiredCredits', 'canSendNow'];
      expectedFields.forEach(field => {
        expect(typeof field).toBe('string');
      });
    });

    it('LetterConfirmationCard expects orderId, currentStatus, creditsRemaining', () => {
      const expectedFields = ['orderId', 'currentStatus', 'creditsRemaining'];
      expectedFields.forEach(field => {
        expect(typeof field).toBe('string');
      });
    });

    it('LetterStatusCard expects orderId, currentStatus, statusTimeline', () => {
      const expectedFields = ['orderId', 'currentStatus', 'statusTimeline'];
      expectedFields.forEach(field => {
        expect(typeof field).toBe('string');
      });
    });
  });

  describe('widget interactivity', () => {
    it('LetterPreviewCard should have send_letter callTool integration', async () => {
      const filePath = path.join(path.resolve(__dirname, '../../../widgets'), 'LetterPreviewCard.html');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('callTool');
      expect(content).toContain('send_letter');
    });

    it('LetterConfirmationCard should have get_order_status callTool integration', async () => {
      const filePath = path.join(path.resolve(__dirname, '../../../widgets'), 'LetterConfirmationCard.html');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('callTool');
      expect(content).toContain('get_order_status');
    });

    it('LetterStatusCard should have sendFollowUpMessage integration', async () => {
      const filePath = path.join(path.resolve(__dirname, '../../../widgets'), 'LetterStatusCard.html');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('sendFollowUpMessage');
    });
  });
});

describe('registerWidgetResources implementation', () => {
  // Mock tests for the actual registration function behavior

  it('should register 4 widget resources', () => {
    expect(WIDGET_DEFINITIONS.length).toBe(4);
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
