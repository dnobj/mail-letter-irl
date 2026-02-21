/**
 * Mobile Detection Utilities
 *
 * Detects mobile clients from OpenAI userAgent metadata to enable
 * graceful degradation for features that don't work on mobile (like image uploads).
 *
 * User Stories:
 * - US-POSTCARD-04: Mobile Image Graceful Degradation
 *
 * @see docs/user-stories.md#us-postcard-04
 */

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

/**
 * Mobile-specific error messages for image tools.
 *
 * These messages guide ChatGPT to use text-only tools when on mobile,
 * and include a hint about a workaround (details only if user asks).
 */
export const MOBILE_IMAGE_ERRORS = {
  /**
   * Error for postcards (require images, no text fallback)
   */
  postcard:
    "IMAGE UPLOAD NEEDED\n\n" +
    "The image couldn't be received directly. " +
    "Use the upload_image tool instead \u2014 it provides a file picker widget that works on all platforms.\n\n" +
    "IMPORTANT: Call upload_image immediately now so the widget opens in this turn.\n\n" +
    "ALTERNATIVES:\n" +
    "- Provide a direct image URL via the imageUrl parameter\n" +
    "- Use quote_and_preview_letter for a text-only letter instead",

  /**
   * Error for letters with images (can fall back to text-only)
   */
  letterWithImage:
    "IMAGE UPLOAD NEEDED\n\n" +
    "The image couldn't be received directly. " +
    "Use the upload_image tool instead \u2014 it provides a file picker widget that works on all platforms.\n\n" +
    "IMPORTANT: Call upload_image immediately now so the widget opens in this turn.\n\n" +
    "ALTERNATIVES:\n" +
    "- Provide a direct image URL via the imageUrl parameter\n" +
    "- Use quote_and_preview_letter for a text-only letter instead",

  /**
   * Desktop error — same guidance, upload_image works on desktop too
   */
  desktop:
    "IMAGE UPLOAD NEEDED\n\n" +
    "The image couldn't be received directly. " +
    "Use the upload_image tool instead \u2014 it provides a file picker widget that works on all platforms.\n\n" +
    "IMPORTANT: Call upload_image immediately now so the widget opens in this turn.\n\n" +
    "ALTERNATIVES:\n" +
    "- Provide a direct image URL via the imageUrl parameter",
};
