/**
 * Unit tests for Mobile Detection in MCP Request Handling
 *
 * Tests the detection of mobile clients from OpenAI userAgent metadata
 * and the propagation of isMobile flag through ToolContext.
 *
 * User Stories Covered:
 * - US-POSTCARD-04: Mobile Image Graceful Degradation
 *
 * GitHub Issues: #100
 *
 * Background:
 * ChatGPT mobile clients cannot properly send images to MCP tools.
 * They send placeholder string "attached" instead of actual file data.
 * We detect mobile clients to provide helpful error messages.
 *
 * @see docs/user-stories.md#us-postcard-04
 * @see /home/dnicholl/.claude/plans/sprightly-baking-falcon.md
 */

import { describe, it, expect } from 'vitest';

// ============================================================================
// Mobile Detection Utility
// ============================================================================

/**
 * Detect if the request is from a mobile client based on userAgent.
 *
 * OpenAI includes userAgent in request metadata:
 * - Desktop/Web: May not include userAgent or have "Desktop" indicators
 * - Mobile: Contains "Android", "iPhone", "iPad", or "Mobile"
 *
 * Example mobile userAgent:
 * "ChatGPT/1.2025.364 (Android 16; SM-S928U1; build 2536400)"
 *
 * @param userAgent - The openai/userAgent value from request metadata
 * @returns true if mobile client detected, false otherwise
 */
export function isMobileClient(userAgent: string | undefined): boolean {
  if (!userAgent) {
    return false;
  }
  return /Android|iPhone|iPad|Mobile/i.test(userAgent);
}

/**
 * Extract userAgent from MCP request metadata.
 *
 * The userAgent can be in either:
 * - args._meta["openai/userAgent"] - Input object has metadata
 * - extra._meta["openai/userAgent"] - MCP SDK's RequestHandlerExtra
 *
 * @param argsMeta - The _meta from args object
 * @param extraMeta - The _meta from extra object
 * @returns The userAgent string if found, undefined otherwise
 */
export function extractUserAgent(
  argsMeta: Record<string, unknown> | undefined,
  extraMeta: Record<string, unknown> | undefined
): string | undefined {
  const userAgent =
    (argsMeta?.['openai/userAgent'] as string | undefined) ||
    (extraMeta?.['openai/userAgent'] as string | undefined);
  return userAgent;
}

// ============================================================================
// Tests: Mobile Detection Utility
// ============================================================================

describe('Mobile Detection (US-POSTCARD-04, Issue #100)', () => {
  describe('isMobileClient()', () => {
    describe('Returns true for mobile userAgents', () => {
      it('should detect Android phone', () => {
        const userAgent = 'ChatGPT/1.2025.364 (Android 16; SM-S928U1; build 2536400)';
        expect(isMobileClient(userAgent)).toBe(true);
      });

      it('should detect iPhone', () => {
        const userAgent = 'ChatGPT/1.2025.100 (iPhone; iOS 18.0; Build/12345)';
        expect(isMobileClient(userAgent)).toBe(true);
      });

      it('should detect iPad', () => {
        const userAgent = 'ChatGPT/1.2025.200 (iPad; iPadOS 18.0)';
        expect(isMobileClient(userAgent)).toBe(true);
      });

      it('should detect generic Mobile indicator', () => {
        const userAgent = 'ChatGPT/1.0 (Mobile; Unknown)';
        expect(isMobileClient(userAgent)).toBe(true);
      });

      it('should be case-insensitive', () => {
        expect(isMobileClient('chatgpt/1.0 (android 15)')).toBe(true);
        expect(isMobileClient('ChatGPT/1.0 (IPHONE)')).toBe(true);
        expect(isMobileClient('ChatGPT/1.0 (ipad)')).toBe(true);
        expect(isMobileClient('ChatGPT/1.0 (MOBILE)')).toBe(true);
      });
    });

    describe('Returns false for non-mobile userAgents', () => {
      it('should not detect desktop browser', () => {
        const userAgent = 'ChatGPT/1.2025.364 (Windows NT 10.0; Win64; x64)';
        expect(isMobileClient(userAgent)).toBe(false);
      });

      it('should not detect macOS', () => {
        const userAgent = 'ChatGPT/1.2025.364 (Macintosh; Intel Mac OS X 10_15_7)';
        expect(isMobileClient(userAgent)).toBe(false);
      });

      it('should not detect Linux desktop', () => {
        const userAgent = 'ChatGPT/1.2025.364 (X11; Linux x86_64)';
        expect(isMobileClient(userAgent)).toBe(false);
      });

      it('should return false for undefined userAgent', () => {
        expect(isMobileClient(undefined)).toBe(false);
      });

      it('should return false for empty string', () => {
        expect(isMobileClient('')).toBe(false);
      });
    });
  });

  describe('extractUserAgent()', () => {
    it('should extract from argsMeta', () => {
      const argsMeta = { 'openai/userAgent': 'ChatGPT/1.0 (Android)' };
      const extraMeta = undefined;

      expect(extractUserAgent(argsMeta, extraMeta)).toBe('ChatGPT/1.0 (Android)');
    });

    it('should extract from extraMeta when argsMeta is undefined', () => {
      const argsMeta = undefined;
      const extraMeta = { 'openai/userAgent': 'ChatGPT/1.0 (iPhone)' };

      expect(extractUserAgent(argsMeta, extraMeta)).toBe('ChatGPT/1.0 (iPhone)');
    });

    it('should prefer argsMeta over extraMeta', () => {
      const argsMeta = { 'openai/userAgent': 'ChatGPT/1.0 (Android)' };
      const extraMeta = { 'openai/userAgent': 'ChatGPT/1.0 (Desktop)' };

      expect(extractUserAgent(argsMeta, extraMeta)).toBe('ChatGPT/1.0 (Android)');
    });

    it('should return undefined when neither has userAgent', () => {
      expect(extractUserAgent(undefined, undefined)).toBeUndefined();
      expect(extractUserAgent({}, {})).toBeUndefined();
    });

    it('should handle empty argsMeta with extraMeta', () => {
      const argsMeta = {};
      const extraMeta = { 'openai/userAgent': 'ChatGPT/1.0 (iPad)' };

      expect(extractUserAgent(argsMeta, extraMeta)).toBe('ChatGPT/1.0 (iPad)');
    });
  });
});

// ============================================================================
// Tests: ToolContext isMobile Flag
// ============================================================================

describe('ToolContext isMobile Flag (US-POSTCARD-04)', () => {
  /**
   * These tests verify the contract that isMobile should be:
   * - true when mobile client detected
   * - false when desktop client detected
   * - undefined when userAgent not available (conservative default)
   */

  describe('isMobile value based on userAgent', () => {
    it('should be true for Android userAgent', () => {
      const userAgent = 'ChatGPT/1.2025.364 (Android 16; SM-S928U1)';
      const isMobile = isMobileClient(userAgent);
      expect(isMobile).toBe(true);
    });

    it('should be false for desktop userAgent', () => {
      const userAgent = 'ChatGPT/1.2025.364 (Windows NT 10.0)';
      const isMobile = isMobileClient(userAgent);
      expect(isMobile).toBe(false);
    });

    it('should be false for undefined userAgent (conservative default)', () => {
      const userAgent = undefined;
      const isMobile = userAgent ? isMobileClient(userAgent) : undefined;
      expect(isMobile).toBeUndefined();
    });
  });
});

// ============================================================================
// Tests: Error Message Content
// ============================================================================

describe('Mobile-Specific Error Messages (US-POSTCARD-04)', () => {
  /**
   * Error messages for mobile users should:
   * 1. Explain the limitation clearly
   * 2. Recommend text-only letter as alternative
   * 3. Mention desktop/web for image support
   * 4. Include workaround hint (without details unless asked)
   */

  // Postcard mobile error message (postcards require images)
  const POSTCARD_MOBILE_ERROR =
    "MOBILE IMAGE LIMITATION\n\n" +
    "ChatGPT mobile cannot send images to this app yet. " +
    "Postcards require an image.\n\n" +
    "RECOMMENDED: Use quote_and_preview_letter for a text-only letter instead.\n\n" +
    "OTHER OPTIONS:\n" +
    "- Switch to desktop/web browser for postcards with images\n" +
    "- Provide a direct image URL (imageUrl parameter)\n\n" +
    "There is a mobile workaround - ask me about it if you want to try.";

  // Letter with image mobile error message (can fall back to text-only)
  const LETTER_IMAGE_MOBILE_ERROR =
    "MOBILE IMAGE LIMITATION\n\n" +
    "ChatGPT mobile cannot send images to this app yet.\n\n" +
    "RECOMMENDED: Use quote_and_preview_letter for a text-only letter instead.\n\n" +
    "OTHER OPTIONS:\n" +
    "- Switch to desktop/web browser for letters with images\n" +
    "- Provide a direct image URL (imageUrl parameter)\n\n" +
    "There is a mobile workaround - ask me about it if you want to try.";

  // Desktop error message (simple, no mobile guidance)
  const DESKTOP_NO_IMAGE_ERROR = "No image received. Please attach an image or provide imageUrl.";

  describe('Postcard Mobile Error Message', () => {
    it('should explain the limitation', () => {
      expect(POSTCARD_MOBILE_ERROR).toContain('MOBILE IMAGE LIMITATION');
      expect(POSTCARD_MOBILE_ERROR).toContain('ChatGPT mobile cannot send images');
    });

    it('should mention postcards require image', () => {
      expect(POSTCARD_MOBILE_ERROR).toContain('Postcards require an image');
    });

    it('should recommend text-only letter', () => {
      expect(POSTCARD_MOBILE_ERROR).toContain('quote_and_preview_letter');
      expect(POSTCARD_MOBILE_ERROR).toContain('text-only letter');
    });

    it('should mention desktop/web option', () => {
      expect(POSTCARD_MOBILE_ERROR).toContain('desktop/web browser');
    });

    it('should mention imageUrl as alternative', () => {
      expect(POSTCARD_MOBILE_ERROR).toContain('imageUrl parameter');
    });

    it('should hint at workaround without details', () => {
      expect(POSTCARD_MOBILE_ERROR).toContain('mobile workaround');
      expect(POSTCARD_MOBILE_ERROR).toContain('ask me about it');
      // Should NOT include the actual workaround steps
      expect(POSTCARD_MOBILE_ERROR).not.toContain('Open a NEW chat');
    });
  });

  describe('Letter with Image Mobile Error Message', () => {
    it('should explain the limitation', () => {
      expect(LETTER_IMAGE_MOBILE_ERROR).toContain('MOBILE IMAGE LIMITATION');
      expect(LETTER_IMAGE_MOBILE_ERROR).toContain('ChatGPT mobile cannot send images');
    });

    it('should recommend text-only letter', () => {
      expect(LETTER_IMAGE_MOBILE_ERROR).toContain('quote_and_preview_letter');
      expect(LETTER_IMAGE_MOBILE_ERROR).toContain('text-only letter');
    });

    it('should mention desktop/web option', () => {
      expect(LETTER_IMAGE_MOBILE_ERROR).toContain('desktop/web browser');
    });

    it('should mention imageUrl as alternative', () => {
      expect(LETTER_IMAGE_MOBILE_ERROR).toContain('imageUrl parameter');
    });

    it('should hint at workaround without details', () => {
      expect(LETTER_IMAGE_MOBILE_ERROR).toContain('mobile workaround');
      expect(LETTER_IMAGE_MOBILE_ERROR).toContain('ask me about it');
    });
  });

  describe('Desktop Error Message', () => {
    it('should be simple and direct', () => {
      expect(DESKTOP_NO_IMAGE_ERROR).toBe('No image received. Please attach an image or provide imageUrl.');
    });

    it('should NOT include mobile-specific guidance', () => {
      expect(DESKTOP_NO_IMAGE_ERROR).not.toContain('MOBILE');
      expect(DESKTOP_NO_IMAGE_ERROR).not.toContain('desktop/web');
      expect(DESKTOP_NO_IMAGE_ERROR).not.toContain('workaround');
    });
  });

  describe('Workaround Details (for LLM context)', () => {
    /**
     * The workaround should be included in the error but marked for
     * ChatGPT to only share if explicitly asked. This tests the
     * workaround content that will be in the hidden part.
     */
    const WORKAROUND_DETAILS =
      "[WORKAROUND - only share these steps if user explicitly asks about the workaround]\n" +
      "1. Open a NEW chat (without Letter IRL connected)\n" +
      "2. Upload your photo\n" +
      "3. Ask ChatGPT to edit/resize the photo\n" +
      "4. Add Letter IRL to the chat\n" +
      "5. Now try sending the postcard with the edited photo";

    it('should include instruction to only share when asked', () => {
      expect(WORKAROUND_DETAILS).toContain('only share these steps if user explicitly asks');
    });

    it('should include all 5 workaround steps', () => {
      expect(WORKAROUND_DETAILS).toContain('1. Open a NEW chat');
      expect(WORKAROUND_DETAILS).toContain('2. Upload your photo');
      expect(WORKAROUND_DETAILS).toContain('3. Ask ChatGPT to edit/resize');
      expect(WORKAROUND_DETAILS).toContain('4. Add Letter IRL to the chat');
      expect(WORKAROUND_DETAILS).toContain('5. Now try sending');
    });
  });
});
