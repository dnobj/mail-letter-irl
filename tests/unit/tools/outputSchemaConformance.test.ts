import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getZodOutputShape } from '../../../src/mcp/registerTools.js';

/**
 * Issue #197 - the preview tools must keep answering with what their schema
 * requires.
 *
 * A required field was added to the letter preview schema and to one of the two
 * builders that produce that output. The other builder's interface never
 * declared it, so the omission was invisible to the compiler and every letter
 * preview was rejected at the MCP boundary with
 * `-32602 Required field missing: sendEligibility`. The draft id travels in that
 * same response, so no letter could be sent at all.
 *
 * The structural half of the fix is `src/contracts/outputConformance.ts`, which
 * fails the build if a builder's output type stops satisfying its schema. This
 * file guards the other direction: that the schema still demands the field, so
 * a future failure cannot be "fixed" by quietly making it optional.
 */

const PREVIEW_TOOLS = [
  'quote_and_preview_letter',
  'quote_and_preview_letter_with_header_image',
  'quote_and_preview_letter_with_image',
  'quote_and_preview_postcard'
] as const;

describe('preview tool output schemas', () => {
  it.each(PREVIEW_TOOLS)('%s requires sendEligibility and a draftId', toolName => {
    const shape = getZodOutputShape(toolName);
    expect(shape, `${toolName} has no registered output shape`).toBeDefined();

    // isOptional() rather than a key check: the field being present but
    // optional is the exact regression this test exists to prevent, and a
    // presence check would pass in that state.
    expect(shape!.sendEligibility.isOptional()).toBe(false);
    expect(shape!.draftId.isOptional()).toBe(false);
  });

  it.each(PREVIEW_TOOLS)('%s reports sendEligibility as missing, not merely absent', toolName => {
    const schema = z.object(getZodOutputShape(toolName)!);

    // Parsing an empty object surfaces every required key at once, which is
    // what the MCP layer does to a builder's response. No fixture to drift.
    const result = schema.safeParse({});
    expect(result.success).toBe(false);

    const missing = result.success ? [] : result.error.issues.map(issue => issue.path.join('.'));
    expect(missing).toContain('sendEligibility');
    expect(missing).toContain('draftId');
  });
});
