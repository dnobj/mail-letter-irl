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
  text_only: 1600,      // ~24 lines of text (conservative for single page)
  header_image: 1100,   // ~17 lines with 2" header image
  inline_image: 800,    // ~12 lines with 3" inline image
};

// Line limits by layout type (accounts for vertical space)
export const LAYOUT_LINE_LIMITS: Record<LetterLayoutType, number> = {
  text_only: 24,        // Full page of text
  header_image: 17,     // Reduced for 2" header image
  inline_image: 12,     // Reduced for 3" inline image
};

// Characters per line (6.5" width at 12pt Times New Roman)
const CHARS_PER_LINE = 65;

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
// Line Estimation
// ============================================================================

/**
 * Estimate the number of lines text will occupy when rendered.
 * Accounts for both explicit line breaks and text wrapping.
 *
 * @param text - The text to estimate lines for
 * @param charsPerLine - Characters per line (default: 65 for 6.5" at 12pt)
 * @returns Estimated number of lines
 */
export function estimateLines(text: string, charsPerLine = CHARS_PER_LINE): number {
  if (!text) return 0;

  // Trim trailing newlines to avoid over-counting
  // (a trailing \n doesn't create a visible line)
  const trimmed = text.replace(/\n+$/, '');
  if (!trimmed) return 0;

  const paragraphs = trimmed.split('\n');
  let totalLines = 0;

  for (const para of paragraphs) {
    // Empty lines (from consecutive \n) count as 1 line
    if (para.length === 0) {
      totalLines += 1;
    } else {
      // Each paragraph wraps based on character count
      totalLines += Math.ceil(para.length / charsPerLine);
    }
  }

  return totalLines;
}

// ============================================================================
// Content Validation
// ============================================================================

/**
 * Get character limit for a given layout type
 */
export function getCharacterLimit(layoutType: LetterLayoutType): number {
  return LAYOUT_CHARACTER_LIMITS[layoutType];
}

/**
 * Get line limit for a given layout type
 */
export function getLineLimit(layoutType: LetterLayoutType): number {
  return LAYOUT_LINE_LIMITS[layoutType];
}

/**
 * Validate content against layout-specific character AND line limits.
 * Both limits must pass for the content to be valid.
 *
 * @returns Object with validation result and details
 */
export function validateCharacterLimit(
  bodyText: string,
  signOff: string,
  layoutType: LetterLayoutType
): {
  isValid: boolean;
  error?: string;
  totalChars: number;
  charLimit: number;
  totalLines: number;
  lineLimit: number;
  /** @deprecated Use charLimit instead */
  limit: number;
} {
  const totalChars = bodyText.length + signOff.length;
  const charLimit = LAYOUT_CHARACTER_LIMITS[layoutType];
  const charsValid = totalChars <= charLimit;

  // Estimate lines for combined content (body + sign-off with spacing)
  // Trim trailing newlines from body to avoid stacking with the \n\n separator
  const trimmedBody = bodyText.replace(/\n+$/, '');
  const combinedText = signOff ? `${trimmedBody}\n\n${signOff}` : trimmedBody;
  const totalLines = estimateLines(combinedText);
  const lineLimit = LAYOUT_LINE_LIMITS[layoutType];
  const linesValid = totalLines <= lineLimit;

  const isValid = charsValid && linesValid;

  if (!isValid) {
    let error: string;
    const layoutLabel = layoutType === 'text_only' ? ''
      : layoutType === 'header_image' ? ' with header image'
      : ' with inline image';

    if (!charsValid && !linesValid) {
      error = `Letter exceeds one-page limit${layoutLabel}: ${totalChars}/${charLimit} characters and ${totalLines}/${lineLimit} lines. Please shorten your message.`;
    } else if (!charsValid) {
      error = `Letter exceeds character limit${layoutLabel}: ${totalChars}/${charLimit} characters. Please shorten your message.`;
    } else {
      error = `Letter has too many line breaks${layoutLabel}: ${totalLines}/${lineLimit} lines. Try combining some paragraphs.`;
    }

    return { isValid, error, totalChars, charLimit, totalLines, lineLimit, limit: charLimit };
  }

  return { isValid, totalChars, charLimit, totalLines, lineLimit, limit: charLimit };
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
