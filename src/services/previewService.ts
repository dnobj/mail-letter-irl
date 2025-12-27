/**
 * Preview Service for Letter IRL
 *
 * Handles letter preview generation with layout-aware rendering.
 *
 * User Stories:
 * - US-LETTER-01: Preview a Letter
 * - US-LAYOUT-01: Preview Letter with Header Image
 * - US-LAYOUT-02: Preview Letter with Inline Image
 * - US-LAYOUT-03: Layout Type Detection and Override
 * - US-LAYOUT-05: Letter Layout Widget Preview
 */

import { Address, LetterLayoutType } from "../contracts/types.js";

// ============================================================================
// Character Limits by Layout Type
// ============================================================================

export const LAYOUT_CHARACTER_LIMITS: Record<LetterLayoutType, number> = {
  text_only: 1800,      // Full page of text
  header_image: 1500,   // Reduced for 2" header image
  inline_image: 1200,   // Reduced for 3" inline image
};

// ============================================================================
// Types
// ============================================================================

export interface PreviewInput {
  sender: Address;
  recipient: Address;
  bodyText: string;
  signOff: string;
}

export interface LayoutPreviewInput extends PreviewInput {
  layoutType: LetterLayoutType;
  headerImageData?: string;   // Base64 data URI
  inlineImageData?: string;   // Base64 data URI
}

export interface LayoutDetectionInput {
  headerImageUrl?: string;
  inlineImageUrl?: string;
  layoutType?: LetterLayoutType;
}

// ============================================================================
// Layout Detection (US-LAYOUT-03)
// ============================================================================

/**
 * Detect layout type from input, or use explicit override if provided
 *
 * @throws Error if both header and inline images are provided
 */
export function detectLayoutType(input: LayoutDetectionInput): LetterLayoutType {
  // Explicit override takes precedence
  if (input.layoutType) {
    return input.layoutType;
  }

  // Check for conflicting images
  if (input.headerImageUrl && input.inlineImageUrl) {
    throw new Error('Cannot use both header and inline images. Please choose one layout type.');
  }

  // Auto-detect from provided images
  if (input.headerImageUrl) {
    return 'header_image';
  }
  if (input.inlineImageUrl) {
    return 'inline_image';
  }

  return 'text_only';
}

// ============================================================================
// Character Limit Validation
// ============================================================================

/**
 * Get character limit for a given layout type
 */
export function getCharacterLimit(layoutType: LetterLayoutType): number {
  return LAYOUT_CHARACTER_LIMITS[layoutType];
}

/**
 * Validate content against layout-specific character limit
 *
 * @returns Object with isValid and optional error message
 */
export function validateCharacterLimit(
  bodyText: string,
  signOff: string,
  layoutType: LetterLayoutType
): { isValid: boolean; error?: string; totalChars: number; limit: number } {
  const totalChars = bodyText.length + signOff.length;
  const limit = LAYOUT_CHARACTER_LIMITS[layoutType];
  const isValid = totalChars <= limit;

  if (!isValid) {
    const error = layoutType === 'text_only'
      ? `Letter exceeds one-page limit (~${limit} characters)`
      : layoutType === 'header_image'
        ? `Letter exceeds one-page limit with header image (~${limit} characters)`
        : `Letter exceeds one-page limit with inline image (~${limit} characters)`;
    return { isValid, error, totalChars, limit };
  }

  return { isValid, totalChars, limit };
}

// ============================================================================
// Credit Estimation
// ============================================================================

/**
 * Estimate required credits for a letter
 * Note: All layouts cost the same (2 credits per letter)
 */
export function estimateRequiredCredits(
  bodyText: string,
  signOff: string,
  charsPerPage = LAYOUT_CHARACTER_LIMITS.text_only
): number {
  // Flat rate: All letters cost 2 credits (one page maximum)
  return 2;
}

// ============================================================================
// Preview HTML Rendering
// ============================================================================

/**
 * Render minimal preview HTML for widget display (backward compatible)
 */
export function renderPreviewHtml(input: PreviewInput): string {
  return `<!doctype html><html><body><address>${input.sender.name}<br>${input.sender.addressLine1}</address><hr><p>${input.bodyText}</p><p>${input.signOff}</p></body></html>`;
}

/**
 * Render layout-aware preview HTML for widget display
 * This generates enhanced HTML that the widget can use for visual preview
 */
export function renderLayoutPreviewHtml(input: LayoutPreviewInput): string {
  switch (input.layoutType) {
    case 'header_image':
      return renderHeaderImagePreview(input);
    case 'inline_image':
      return renderInlineImagePreview(input);
    case 'text_only':
    default:
      return renderTextOnlyPreview(input);
  }
}

/**
 * Render text-only layout preview
 */
function renderTextOnlyPreview(input: LayoutPreviewInput): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: 'Times New Roman', serif;
      font-size: 12pt;
      line-height: 1.6;
      margin: 0.5in;
      color: #000;
    }
    .sender-address {
      margin-bottom: 1em;
    }
    .letter-body {
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    .sign-off {
      white-space: pre-wrap;
      margin-top: 1em;
    }
  </style>
</head>
<body>
  <div class="sender-address">
    ${escapeHtml(input.sender.name)}<br>
    ${escapeHtml(input.sender.addressLine1)}${input.sender.addressLine2 ? '<br>' + escapeHtml(input.sender.addressLine2) : ''}<br>
    ${escapeHtml(input.sender.city)}, ${escapeHtml(input.sender.state)} ${escapeHtml(input.sender.postalCode)}
  </div>
  <div class="letter-body">${escapeHtml(input.bodyText)}</div>
  <div class="sign-off">${escapeHtml(input.signOff)}</div>
</body>
</html>`;
}

/**
 * Render header image layout preview
 */
function renderHeaderImagePreview(input: LayoutPreviewInput): string {
  const headerImageHtml = input.headerImageData
    ? `<div class="header-image"><img src="${input.headerImageData}" alt="Header" style="width: 100%; max-height: 2in; object-fit: contain;"></div>`
    : '';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: 'Times New Roman', serif;
      font-size: 12pt;
      line-height: 1.6;
      margin: 0.5in;
      color: #000;
    }
    .header-image {
      margin-bottom: 1em;
      text-align: center;
    }
    .header-image img {
      max-width: 100%;
      max-height: 2in;
    }
    .sender-address {
      margin-bottom: 1em;
    }
    .letter-body {
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    .sign-off {
      white-space: pre-wrap;
      margin-top: 1em;
    }
  </style>
</head>
<body>
  ${headerImageHtml}
  <div class="sender-address">
    ${escapeHtml(input.sender.name)}<br>
    ${escapeHtml(input.sender.addressLine1)}${input.sender.addressLine2 ? '<br>' + escapeHtml(input.sender.addressLine2) : ''}<br>
    ${escapeHtml(input.sender.city)}, ${escapeHtml(input.sender.state)} ${escapeHtml(input.sender.postalCode)}
  </div>
  <div class="letter-body">${escapeHtml(input.bodyText)}</div>
  <div class="sign-off">${escapeHtml(input.signOff)}</div>
</body>
</html>`;
}

/**
 * Render inline image layout preview
 */
function renderInlineImagePreview(input: LayoutPreviewInput): string {
  const inlineImageHtml = input.inlineImageData
    ? `<div class="inline-image"><img src="${input.inlineImageData}" alt="Photo" style="max-width: 100%; max-height: 3in; object-fit: contain;"></div>`
    : '';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: 'Times New Roman', serif;
      font-size: 12pt;
      line-height: 1.6;
      margin: 0.5in;
      color: #000;
    }
    .sender-address {
      margin-bottom: 1em;
    }
    .letter-body {
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    .sign-off {
      white-space: pre-wrap;
      margin-top: 1em;
    }
    .inline-image {
      margin-top: 1em;
      text-align: center;
    }
    .inline-image img {
      max-width: 100%;
      max-height: 3in;
    }
  </style>
</head>
<body>
  <div class="sender-address">
    ${escapeHtml(input.sender.name)}<br>
    ${escapeHtml(input.sender.addressLine1)}${input.sender.addressLine2 ? '<br>' + escapeHtml(input.sender.addressLine2) : ''}<br>
    ${escapeHtml(input.sender.city)}, ${escapeHtml(input.sender.state)} ${escapeHtml(input.sender.postalCode)}
  </div>
  <div class="letter-body">${escapeHtml(input.bodyText)}</div>
  <div class="sign-off">${escapeHtml(input.signOff)}</div>
  ${inlineImageHtml}
</body>
</html>`;
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Escape HTML special characters to prevent XSS
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
