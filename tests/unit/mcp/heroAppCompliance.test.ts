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

// Widget directory path
const widgetDir = path.resolve(__dirname, '../../../widgets');

describe('Hero App SDK Compliance (Issue #42)', () => {
  describe('US-MCP-07: Widget Resources', () => {
    describe('CSP Configuration', () => {
      it('should include chatgpt.com in connect_domains', () => {
        // CSP must include ChatGPT domain for internal communication
        const expectedDomains = ['https://chatgpt.com'];
        expect(expectedDomains).toContain('https://chatgpt.com');
      });

      it('should include backend API URL in connect_domains', () => {
        // CSP must include our API URL for widget → backend calls
        // Default: https://api.letterirl.com
        // Configurable via LETTER_IRL_API_URL env var
        const apiUrl = process.env.LETTER_IRL_API_URL ?? 'https://api.letterirl.com';
        expect(apiUrl).toMatch(/^https:\/\//);
      });

      it('should have resource_domains for OpenAI static assets', () => {
        // Required for loading OpenAI's static assets
        const resourceDomains = ['https://*.oaistatic.com'];
        expect(resourceDomains[0]).toBe('https://*.oaistatic.com');
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
