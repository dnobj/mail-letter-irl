/**
 * Schema Consistency Tests
 *
 * Verifies that tool schemas are consistent across:
 * - Runtime Zod schemas (src/zodSchemas.ts)
 * - MCP tool schemas (src/mcp/toolSchemas.ts)
 * - Manifest definitions (manifest.json)
 *
 * GitHub Issue: #38 - Fix send_letter contract drift
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Import the Zod schemas (runtime source of truth)
import {
  sendLetterInputZ,
  quoteAndPreviewInputZ,
  getOrderStatusInputZ,
  getAccountBalanceInputZ,
} from '../../../src/zodSchemas.js';

// Import the MCP tool schemas
import { toolInputSchemas } from '../../../src/mcp/toolSchemas.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load manifest.json
const manifestPath = path.resolve(__dirname, '../../../manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

describe('Schema Consistency (Issue #38)', () => {
  describe('send_letter schema', () => {
    it('should have draftId and confirm in Zod schema (runtime)', () => {
      const shape = sendLetterInputZ.shape;
      expect(shape).toHaveProperty('draftId');
      expect(shape).toHaveProperty('confirm');
      // Should NOT have legacy fields
      expect(shape).not.toHaveProperty('sender');
      expect(shape).not.toHaveProperty('recipient');
      expect(shape).not.toHaveProperty('bodyText');
      expect(shape).not.toHaveProperty('signOff');
      expect(shape).not.toHaveProperty('requiredCredits');
    });

    it('should have draftId and confirm in MCP toolSchemas', () => {
      const schema = toolInputSchemas.send_letter;
      const shape = schema.shape;
      expect(shape).toHaveProperty('draftId');
      expect(shape).toHaveProperty('confirm');
      // Should NOT have legacy fields
      expect(shape).not.toHaveProperty('sender');
      expect(shape).not.toHaveProperty('recipient');
      expect(shape).not.toHaveProperty('bodyText');
      expect(shape).not.toHaveProperty('signOff');
      expect(shape).not.toHaveProperty('requiredCredits');
    });

    it('should have draftId and confirm in manifest.json', () => {
      const sendLetterInput = manifest.definitions.SendLetterInput;
      expect(sendLetterInput).toBeDefined();
      expect(sendLetterInput.required).toContain('draftId');
      expect(sendLetterInput.required).toContain('confirm');
      expect(sendLetterInput.properties).toHaveProperty('draftId');
      expect(sendLetterInput.properties).toHaveProperty('confirm');
      // Should NOT have legacy fields
      expect(sendLetterInput.required).not.toContain('sender');
      expect(sendLetterInput.required).not.toContain('recipient');
      expect(sendLetterInput.required).not.toContain('bodyText');
      expect(sendLetterInput.required).not.toContain('signOff');
      expect(sendLetterInput.required).not.toContain('requiredCredits');
    });

    it('should match required fields across all schemas', () => {
      // Zod schema required fields (all non-optional fields)
      const zodRequired = Object.keys(sendLetterInputZ.shape);

      // MCP tool schema required fields
      const mcpRequired = Object.keys(toolInputSchemas.send_letter.shape);

      // Manifest required fields
      const manifestRequired = manifest.definitions.SendLetterInput.required;

      // All should match
      expect(zodRequired.sort()).toEqual(['confirm', 'draftId']);
      expect(mcpRequired.sort()).toEqual(['confirm', 'draftId']);
      expect([...manifestRequired].sort()).toEqual(['confirm', 'draftId']);
    });
  });

  describe('quote_and_preview_letter schema', () => {
    it('should have consistent fields across Zod and MCP schemas', () => {
      const zodShape = quoteAndPreviewInputZ.shape;
      const mcpShape = toolInputSchemas.quote_and_preview_letter.shape;

      // Both should have recipient, bodyText, signOff
      expect(zodShape).toHaveProperty('recipient');
      expect(zodShape).toHaveProperty('bodyText');
      expect(zodShape).toHaveProperty('signOff');

      expect(mcpShape).toHaveProperty('recipient');
      expect(mcpShape).toHaveProperty('bodyText');
      expect(mcpShape).toHaveProperty('signOff');
    });
  });

  describe('manifest tool definitions', () => {
    it('should define send_letter tool', () => {
      const tools = manifest.tools;
      const sendLetterTool = tools.find((t: any) => t.name === 'send_letter');
      expect(sendLetterTool).toBeDefined();
      expect(sendLetterTool.inputSchema.$ref).toBe('#/definitions/SendLetterInput');
    });

    it('should define quote_and_preview_letter tool', () => {
      const tools = manifest.tools;
      const previewTool = tools.find((t: any) => t.name === 'quote_and_preview_letter');
      expect(previewTool).toBeDefined();
    });
  });
});
