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
import { giftLetterPageSvg, type CardFragment, type GiftCardContent } from "./giftCardRenderer.js";
import { RENDERER_VERSION } from "../render/index.js";

// ============================================================================
// Character Limits by Layout Type
// ============================================================================

export const LAYOUT_CHARACTER_LIMITS: Record<LetterLayoutType, number> = {
  text_only: 1600,      // ~24 lines of text (conservative for single page)
  header_image: 1100,   // ~17 lines with 2" header image
  inline_image: 800,    // ~12 lines with 3" inline image
};

// Line limits by layout type
// SOFT LIMITS: guidance, named only in the manifest's prose (src/schemas.ts).
// The served tool descriptions state no line counts; the refusal sentence does.
export const LAYOUT_LINE_LIMITS_SOFT: Record<LetterLayoutType, number> = {
  text_only: 24,        // Full page of text
  header_image: 15,     // Reduced for 2" header image: with the sign-off it fits our renderer's 16 (#534) and the legacy 17
  inline_image: 12,     // Reduced for 3" inline image
};

// HARD LIMITS: the most lines validation accepts. A buffer over the soft
// limit spares a retry when the sign-off or wrapping adds a line, but a limit
// must never pass what fits on one printed page: past it, the letter prints,
// and is billed, a second page. From the print check in PostGrid's test mode on
// 2026-09-29 (#77), with short lines that do not wrap:
// - header_image: at 19 lines, lines 18 and 19 printed on page 2 and 17 fit
//   under the 2" image (18 alone was not printed).
// - inline_image: at 15 lines the text and the 3" image fit, but a blank
//   page 2 printed.
// - text_only: 26 lines printed on one page.
// At these limits, header_image 17 and inline_image 14 each printed on one
// page (2026-09-30).
// Lines are counted on letterPrintText, the text exactly as it prints.
export const LAYOUT_LINE_LIMITS: Record<LetterLayoutType, number> = {
  text_only: 26,        // Soft limit 24 + 2 buffer
  header_image: 17,     // No buffer: 17 is what fits under a 2" header image
  inline_image: 14,     // Soft limit 12 + 2 buffer
};

// Characters per line, across 6.5" at 12pt. The print HTML names Times New
// Roman, but PostGrid prints in Open Sans (#526): there a mixed-case line held
// 74 to 82 characters, and an all-caps line 66 to 70 (2026-09-30).
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
  /** A gift send's card, drawn by the same renderer print uses. */
  giftCard?: GiftCardContent;
}

/**
 * The gift card page, from giftCardRenderer - the renderer PostGridProvider
 * prints with - so the preview cannot drift from the print. Empty for every
 * letter that is not a gift send.
 */
function giftPageFor(input: LayoutPreviewInput): CardFragment {
  return input.giftCard ? giftLetterPageSvg(input.giftCard, input.sender.name) : { css: '', html: '' };
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

/**
 * A letter's text as it prints: the body without trailing blank lines, then
 * the sign-off on the next line. Validation counts lines on exactly this text
 * and the provider prints exactly this text (letterJobService), so the count
 * cannot fall short of the print. The print used to keep a body's trailing
 * newlines, which validation dropped: a letter at the line limit could still
 * print a line or two taller, onto a second page (#77).
 */
export function letterPrintText(bodyText: string | null | undefined, signOff?: string | null): string {
  // The print's HTML parser reads \r\n and a lone \r as one line break each;
  // as \n they are counted the same way.
  const unix = (text: string) => text.replace(/\r\n?/g, '\n');
  // A letter row without body text (a malformed or scrubbed one) must not
  // throw in the outbox: it would fail the job before dispatch.
  const body = unix(bodyText ?? '').trimEnd();
  return (signOff ? `${body}\n${unix(signOff)}` : body).trim();
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

  // Count the lines of the text exactly as it prints.
  const totalLines = estimateLines(letterPrintText(bodyText, signOff));
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
  const giftPage = giftPageFor(input);
  // Trim trailing newlines from body text to prevent gap before sign-off
  const trimmedBodyText = input.bodyText.replace(/\n+$/, '');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: 'Times New Roman', serif;
      font-size: 12pt;
      line-height: 1.6;
      /* 12% margin matches PostGrid's 1in on 8.5in page width */
      margin: 9% 12%;
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
    }${giftPage.css}
  </style>
</head>
<body>
  <div class="sender-address">
    ${escapeHtml(input.sender.name)}<br>
    ${escapeHtml(input.sender.addressLine1)}${input.sender.addressLine2 ? '<br>' + escapeHtml(input.sender.addressLine2) : ''}<br>
    ${escapeHtml(input.sender.city)}, ${escapeHtml(input.sender.state)} ${escapeHtml(input.sender.postalCode)}
  </div>
  <div class="letter-body">${escapeHtml(trimmedBodyText)}</div>
  <div class="sign-off">${escapeHtml(input.signOff)}</div>${giftPage.html}
</body>
</html>`;
}

/**
 * Render header image layout preview
 */
function renderHeaderImagePreview(input: LayoutPreviewInput): string {
  const giftPage = giftPageFor(input);
  const headerImageHtml = input.headerImageData
    ? `<div class="header-image"><img src="${input.headerImageData}" alt="Header" style="width: 100%; max-height: 2in; object-fit: contain;"></div>`
    : '';

  // Trim trailing newlines from body text to prevent gap before sign-off
  const trimmedBodyText = input.bodyText.replace(/\n+$/, '');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: 'Times New Roman', serif;
      font-size: 12pt;
      line-height: 1.6;
      /* 12% margin matches PostGrid's 1in on 8.5in page width */
      margin: 9% 12%;
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
    }${giftPage.css}
  </style>
</head>
<body>
  ${headerImageHtml}
  <div class="sender-address">
    ${escapeHtml(input.sender.name)}<br>
    ${escapeHtml(input.sender.addressLine1)}${input.sender.addressLine2 ? '<br>' + escapeHtml(input.sender.addressLine2) : ''}<br>
    ${escapeHtml(input.sender.city)}, ${escapeHtml(input.sender.state)} ${escapeHtml(input.sender.postalCode)}
  </div>
  <div class="letter-body">${escapeHtml(trimmedBodyText)}</div>
  <div class="sign-off">${escapeHtml(input.signOff)}</div>${giftPage.html}
</body>
</html>`;
}

/**
 * Render inline image layout preview
 */
function renderInlineImagePreview(input: LayoutPreviewInput): string {
  const giftPage = giftPageFor(input);
  const inlineImageHtml = input.inlineImageData
    ? `<div class="inline-image"><img src="${input.inlineImageData}" alt="Photo" style="max-width: 100%; max-height: 3in; object-fit: contain;"></div>`
    : '';

  // Trim trailing newlines from body text to prevent gap before sign-off
  // (matches PostGrid behavior which trims the combined message)
  const trimmedBodyText = input.bodyText.replace(/\n+$/, '');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: 'Times New Roman', serif;
      font-size: 12pt;
      line-height: 1.6;
      /* 12% margin matches PostGrid's 1in on 8.5in page width */
      margin: 9% 12%;
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
    }
    .inline-image {
      margin-top: 1em;
      text-align: center;
    }
    .inline-image img {
      max-width: 100%;
      max-height: 3in;
    }${giftPage.css}
  </style>
</head>
<body>
  <div class="sender-address">
    ${escapeHtml(input.sender.name)}<br>
    ${escapeHtml(input.sender.addressLine1)}${input.sender.addressLine2 ? '<br>' + escapeHtml(input.sender.addressLine2) : ''}<br>
    ${escapeHtml(input.sender.city)}, ${escapeHtml(input.sender.state)} ${escapeHtml(input.sender.postalCode)}
  </div>
  <div class="letter-body">${escapeHtml(trimmedBodyText)}</div>
  <div class="sign-off">${escapeHtml(input.signOff)}</div>
  ${inlineImageHtml}${giftPage.html}
</body>
</html>`;
}

/**
 * An address as PostGrid stamps it on a letter (probe P6): the name, the
 * street lines, then "CITY, ST ZIP", in upper case. A preview draws these
 * where PostGrid will. Whether PostGrid standardises an address further
 * before stamping it was not probed.
 */
export function stampedAddressLines(address: Address): string[] {
  return [address.name, address.addressLine1, address.addressLine2, `${address.city}, ${address.state} ${address.postalCode}`]
    .filter((line): line is string => typeof line === 'string' && line.trim() !== '')
    .map(line => line.trim().toUpperCase());
}

/** A postcard's return address as PostGrid stamps it: headed "RETURN TO:" (#534 probe P9). */
export function stampedPostcardReturnLines(address: Address): string[] {
  return ['RETURN TO:', ...stampedAddressLines(address)];
}

/**
 * The preview our own renderer draws (#534): each page as SVG, from the same
 * layout the PDF is printed from, in a minimal HTML document. The website's
 * confirm page shows it in a sandboxed iframe, where it scales to the frame's
 * width.
 *
 * `data-renderer` on the body names the renderer version the pages were
 * drawn as (pdf-2 for a theme, #563), and the letter card shows the pages of
 * a document that carries it. The text is also repeated, hidden,
 * in the legacy preview's `letter-body` and `sign-off` elements, which a card
 * served before #534 Phase 3, still cached by an app, reads instead.
 */
export function renderLetterPreviewDocument(
  pages: string[],
  text: { bodyText: string; signOff: string },
  version: string = RENDERER_VERSION
): string {
  const trimmedBodyText = text.bodyText.replace(/\n+$/, '');

  return rendererDocument(pages, version, `  <div hidden>
    <div class="letter-body">${escapeHtml(trimmedBodyText)}</div>
    <div class="sign-off">${escapeHtml(text.signOff)}</div>
  </div>
`);
}

/**
 * A postcard our renderer drew (#534 Phase 4): its front and back as SVG, in
 * the same document as a letter's, which the website's confirm page shows.
 * No card before Phase 4 reads a postcard's document, so it carries no
 * hidden text.
 */
export function renderPostcardPreviewDocument(pages: string[]): string {
  return rendererDocument(pages, RENDERER_VERSION, '');
}

/**
 * The pages of a document our renderer's pages are shown in, each `<svg>` as
 * written; none for any other document, the legacy HTML included.
 * set_stationery (#563) draws a letter's page again and keeps the pages after
 * it, a gift letter's card, as they were drawn.
 */
export function rendererDocumentPages(html: string | null | undefined): string[] {
  if (!html || !html.includes('<body data-renderer="')) return [];
  return html.match(/<svg [\s\S]*?<\/svg>/g) ?? [];
}

/** The picture a rendered page shows, as its data URI: the preview's small copy of the image. */
export function renderedPageImage(page: string): string | undefined {
  return /<image href="(data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/=]+)"/.exec(page)?.[1];
}

/** The minimal document our renderer's pages are shown in, drawn as `version`, `after` closing the body. */
function rendererDocument(pages: string[], version: string, after: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    html, body { margin: 0; background: #fff; }
    svg { display: block; width: 100%; height: auto; }
    svg + svg { margin-top: 12px; }
  </style>
</head>
<body data-renderer="${version}">
${pages.join('\n')}
${after}</body>
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
