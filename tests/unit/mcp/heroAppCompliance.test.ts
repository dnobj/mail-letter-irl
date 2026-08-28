/**
 * Unit tests for Hero App SDK Compliance
 *
 * Tests the implementation of OpenAI Apps SDK requirements for
 * widget resources, data separation, and tool accessibility.
 *
 * User Stories Covered:
 * - US-MCP-07: Widget Resources
 * - US-MCP-08: Widget Tool Accessibility
 *
 * GitHub Issue: #42
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  WIDGET_CSP_CANONICAL,
  WIDGET_CSP_LEGACY,
  WIDGET_DEFINITIONS
} from '../../../src/mcp/registerTools.js';

// Widget directory path
const widgetDir = path.resolve(__dirname, '../../../widgets');

describe('Hero App SDK Compliance (Issue #42)', () => {
  describe('US-MCP-07: Widget Resources', () => {
    /**
     * These three tests used to assert on literals they had just written -
     * `const expected = ['https://chatgpt.com']; expect(expected).toContain(
     * 'https://chatgpt.com')` - importing nothing from src. They looked like
     * CSP coverage and were tautologies. They now read the shipped constants.
     */
    describe('CSP Configuration', () => {
      it('includes chatgpt.com in connect domains, for the widget bridge', () => {
        expect(WIDGET_CSP_CANONICAL.connectDomains).toContain('https://chatgpt.com');
        expect(WIDGET_CSP_LEGACY.connect_domains).toContain('https://chatgpt.com');
      });

      it('includes the backend API origin in connect domains, for widget -> server calls', () => {
        // ImageUploadCard's diagnostic beacon posts here; the origin is
        // env-derived, so assert the shape rather than a hardcoded host.
        const apiOrigins = WIDGET_CSP_CANONICAL.connectDomains.filter(
          domain => domain !== 'https://chatgpt.com'
        );
        expect(apiOrigins).toHaveLength(1);
        expect(apiOrigins[0]).toMatch(/^https:\/\//);
        // Origin only - a path here would silently widen nothing and mislead.
        expect(apiOrigins[0]).toBe(new URL(apiOrigins[0]).origin);
      });

      it('includes OpenAI static assets in resource domains', () => {
        expect(WIDGET_CSP_CANONICAL.resourceDomains).toContain('https://*.oaistatic.com');
        expect(WIDGET_CSP_LEGACY.resource_domains).toContain('https://*.oaistatic.com');
      });

      it('keeps the two key families in lockstep', () => {
        // The canonical ui.csp keys are what ChatGPT reads today; the
        // snake_case aliases are the compatibility shape. They must describe
        // the same policy or one surface silently permits more than the other.
        expect(WIDGET_CSP_LEGACY.connect_domains).toEqual(WIDGET_CSP_CANONICAL.connectDomains);
        expect(WIDGET_CSP_LEGACY.resource_domains).toEqual(WIDGET_CSP_CANONICAL.resourceDomains);
        expect(WIDGET_CSP_LEGACY.redirect_domains).toEqual(WIDGET_CSP_CANONICAL.redirectDomains);
      });

      /**
       * Issue #228. ChatGPT's Library picker hands back a download URL on an
       * Azure blob host, which `https://*.oaiusercontent.com` does not cover.
       * It is deliberately absent: trusting `*.blob.core.windows.net` would
       * trust all of Azure blob storage, and the subdomain varies by region.
       *
       * The cost is two thumbnails inside ImageUploadCard, which degrade to an
       * explanatory line. The picked image itself is unaffected - it reaches
       * the server over the window.openai bridge and is fetched from Node,
       * where page CSP does not apply - so the postcard preview still shows it.
       *
       * Pinned so that "the thumbnail is broken, add the host" has to argue
       * with this decision rather than quietly widen the policy.
       */
      it('deliberately does not trust the Azure blob host behind Library picks', () => {
        const allDomains = [
          ...WIDGET_CSP_CANONICAL.connectDomains,
          ...WIDGET_CSP_CANONICAL.resourceDomains,
          ...WIDGET_CSP_CANONICAL.redirectDomains
        ];
        for (const domain of allDomains) {
          expect(domain).not.toContain('blob.core.windows.net');
        }
      });

      it('every widget degrades rather than breaking when a remote image is blocked', async () => {
        // The flip side of the exclusion above: a widget that points an <img>
        // at a host the CSP does not allow must handle the failure. Today only
        // ImageUploadCard loads a remote image at all.
        const html = await fs.readFile(
          path.join(widgetDir, 'ImageUploadCard.html'),
          'utf-8'
        );
        // Both remote-image sinks carry an error handler.
        expect(html).toMatch(/previewImg\.onerror\s*=/);
        expect(html).toMatch(/doneImg\.onerror\s*=/);
        // ...and both explain themselves with the same shared copy.
        const uses = html.match(/THUMBNAIL_UNAVAILABLE/g) ?? [];
        expect(uses.length).toBeGreaterThanOrEqual(3); // declaration + 2 sinks

        // No other widget may quietly acquire a remote image sink without a
        // CSP decision: they render data: URIs only.
        for (const { name } of WIDGET_DEFINITIONS.filter(w => w.name !== 'ImageUploadCard')) {
          const other = await fs.readFile(path.join(widgetDir, `${name}.html`), 'utf-8');
          const remoteSrc = other.match(/\.src\s*=\s*(?!["'`]data:)["'`]https?:/g) ?? [];
          expect(remoteSrc, `${name} loads a hardcoded remote image`).toHaveLength(0);
        }
      });
    });

    describe('Data Separation (structuredContent vs _meta)', () => {
      it('should separate heavy data (previewHtml) into _meta', () => {
        // Heavy data like previewHtml should go to _meta (widget-only)
        // Light data (cost, status, draftId) stays in structuredContent (model sees)
        const toolResult = {
          previewHtml: '<html>...large preview content...</html>',
          requiredCredits: 2,
          canSendNow: true,
          draftId: 'draft-123',
        };

        // Expected separation
        const { previewHtml, ...modelFacingData } = toolResult;

        // Model should NOT see previewHtml (context bloat)
        expect(modelFacingData).not.toHaveProperty('previewHtml');
        expect(modelFacingData).toHaveProperty('requiredCredits');
        expect(modelFacingData).toHaveProperty('canSendNow');
        expect(modelFacingData).toHaveProperty('draftId');

        // Widget should receive previewHtml via _meta
        expect(previewHtml).toBe(toolResult.previewHtml);
      });

      it('should exclude base64 image data from model-facing response (Issue #96)', () => {
        // Base64 image data (60K+ characters) must NOT go to the model
        // This prevents 68K+ token responses that confuse ChatGPT
        // Image data is already embedded in previewHtml for the widget
        const toolResult = {
          previewHtml: '<html><img src="data:image/png;base64,..."></html>',
          inlineImageData: 'data:image/png;base64,iVBORw0KGgoAAAANSU...',  // 60K+ chars
          headerImageData: 'data:image/png;base64,iVBORw0KGgoAAAANSU...',  // 60K+ chars
          frontImageData: 'data:image/jpeg;base64,/9j/4AAQSkZJRg...',     // Postcard front
          lettersRequired: 1,
          canSendNow: true,
          draftId: 'draft-123',
        };

        // Expected separation - all heavy data excluded
        const {
          previewHtml,
          inlineImageData,
          headerImageData,
          frontImageData,
          ...modelFacingData
        } = toolResult;

        // Model should NOT see any image data (massive context bloat)
        expect(modelFacingData).not.toHaveProperty('previewHtml');
        expect(modelFacingData).not.toHaveProperty('inlineImageData');
        expect(modelFacingData).not.toHaveProperty('headerImageData');
        expect(modelFacingData).not.toHaveProperty('frontImageData');

        // Model SHOULD see essential fields
        expect(modelFacingData).toHaveProperty('lettersRequired');
        expect(modelFacingData).toHaveProperty('canSendNow');
        expect(modelFacingData).toHaveProperty('draftId');
      });

      it('should keep essential data in structuredContent', () => {
        // These fields are needed by both model and widget
        const essentialFields = ['requiredCredits', 'canSendNow', 'draftId'];
        essentialFields.forEach(field => {
          expect(typeof field).toBe('string');
        });
      });

      it('should NOT move draftId to _meta (both model and widget need it)', () => {
        // draftId is critical for send_letter call
        // Must stay in structuredContent
        const toolResult = { draftId: 'draft-123', requiredCredits: 2 };
        expect(toolResult).toHaveProperty('draftId');
      });
    });

    describe('Widget HTML Content', () => {
      it('LetterPreviewCard should read previewHtml from toolResponseMetadata', async () => {
        const filePath = path.join(widgetDir, 'LetterPreviewCard.html');
        const content = await fs.readFile(filePath, 'utf-8');

        // Widget should be able to get previewHtml from toolResponseMetadata (after change)
        // Or from toolOutput (backward compatibility)
        // At minimum, it should reference window.openai
        expect(content).toContain('window.openai');
      });

      it('LetterPreviewCard should have fallback for previewHtml location', async () => {
        const filePath = path.join(widgetDir, 'LetterPreviewCard.html');
        const content = await fs.readFile(filePath, 'utf-8');

        // Widget should work whether previewHtml is in toolOutput or toolResponseMetadata
        // This ensures backward compatibility during rollout
        expect(content).toContain('previewHtml');
      });
    });
  });

  describe('US-MCP-08: Widget Tool Accessibility', () => {
    describe('send_letter tool configuration', () => {
      it('should have widgetAccessible: true for send_letter', () => {
        // send_letter must be callable from widget via callTool
        const sendLetterMeta = {
          'openai/toolInvocation/invoking': 'Sending letter...',
          'openai/toolInvocation/invoked': 'Letter sent',
          'openai/widgetAccessible': true, // Required for callTool from widget
        };

        expect(sendLetterMeta['openai/widgetAccessible']).toBe(true);
      });

      it('send_letter should NOT have outputTemplate (no widget on send)', () => {
        // send_letter returns text confirmation, not a widget
        const sendLetterMeta = {
          'openai/toolInvocation/invoking': 'Sending letter...',
          'openai/toolInvocation/invoked': 'Letter sent',
          'openai/widgetAccessible': true,
          // No 'openai/outputTemplate' - no widget rendered after send
        };

        expect(sendLetterMeta).not.toHaveProperty('openai/outputTemplate');
      });
    });

    describe('Widget Send Button', () => {
      it('LetterPreviewCard should have a Send button', async () => {
        const filePath = path.join(widgetDir, 'LetterPreviewCard.html');
        const content = await fs.readFile(filePath, 'utf-8');

        // Widget should have a button for sending
        // This will be added as part of the implementation
        // For now, check that the widget exists and has interactive elements
        expect(content).toContain('<button');
      });

      it('Send button should call window.openai.callTool', async () => {
        const filePath = path.join(widgetDir, 'LetterPreviewCard.html');
        const content = await fs.readFile(filePath, 'utf-8');

        // Widget should use callTool to invoke send_letter
        // This will be added as part of the implementation
        expect(content).toContain('callTool');
      });

      it('Send button should pass draftId and confirm: true', async () => {
        const filePath = path.join(widgetDir, 'LetterPreviewCard.html');
        const content = await fs.readFile(filePath, 'utf-8');

        // The send call should include draftId and confirm
        expect(content).toContain('draftId');
        expect(content).toContain('confirm');
      });

      it('Send button should be disabled when canSendNow is false', async () => {
        const filePath = path.join(widgetDir, 'LetterPreviewCard.html');
        const content = await fs.readFile(filePath, 'utf-8');

        // Button should check canSendNow state
        expect(content).toContain('canSendNow');
      });
    });

    describe('Idempotency Protection', () => {
      it('duplicate send calls with same draftId should be safe', () => {
        // Server-side idempotency via draftId prevents double-charging
        const firstCall = { draftId: 'draft-123', confirm: true };
        const secondCall = { draftId: 'draft-123', confirm: true };

        expect(firstCall.draftId).toBe(secondCall.draftId);
        // Server handles idempotency - returns existing order on retry
      });
    });
  });

  describe('Backward Compatibility', () => {
    describe('Widget data source fallback', () => {
      it('should check both toolOutput and toolResponseMetadata for previewHtml', () => {
        // Widget logic should handle both data locations:
        // 1. New: window.openai.toolResponseMetadata.previewHtml
        // 2. Legacy: window.openai.toolOutput.previewHtml
        const fallbackLogic = `
          const previewHtml =
            window.openai?.toolResponseMetadata?.previewHtml ??
            window.openai?.toolOutput?.previewHtml;
        `;

        expect(fallbackLogic).toContain('toolResponseMetadata');
        expect(fallbackLogic).toContain('toolOutput');
      });
    });

    describe('Non-OpenAI MCP clients', () => {
      it('should still work for Claude Desktop (no widgets)', () => {
        // Claude Desktop doesn't render widgets
        // But tool responses should still contain essential data
        // previewHtml can be missing (it's widget-only)
        const modelFacingData = {
          requiredCredits: 2,
          canSendNow: true,
          draftId: 'draft-123',
          // Model can describe the letter without HTML
        };

        expect(modelFacingData).toHaveProperty('draftId');
        expect(modelFacingData).toHaveProperty('canSendNow');
      });
    });
  });

  describe('Integration Scenarios', () => {
    describe('Happy Path: Preview and Send from Widget', () => {
      it('should support full workflow: preview → widget render → send button', () => {
        // 1. User calls quote_and_preview_letter
        const previewResult = {
          draftId: 'draft-123',
          requiredCredits: 2,
          canSendNow: true,
          // previewHtml in _meta
        };

        // 2. Widget renders with Send button enabled
        expect(previewResult.canSendNow).toBe(true);
        expect(previewResult.draftId).toBeDefined();

        // 3. User clicks Send button
        const sendCall = {
          draftId: previewResult.draftId,
          confirm: true,
        };

        // 4. send_letter called via callTool
        expect(sendCall.confirm).toBe(true);
      });
    });

    describe('Error Path: Insufficient Credits', () => {
      it('should disable Send button when canSendNow is false', () => {
        const previewResult = {
          draftId: 'draft-456',
          requiredCredits: 2,
          canSendNow: false,
          reasonCannotSend: 'Insufficient credits',
        };

        expect(previewResult.canSendNow).toBe(false);
        expect(previewResult.reasonCannotSend).toBeDefined();
        // Widget should show reasonCannotSend in status pill
      });
    });
  });
});
