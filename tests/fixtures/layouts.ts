/**
 * Test fixtures for letter layouts
 *
 * User Stories Covered:
 * - US-LAYOUT-01: Preview Letter with Header Image
 * - US-LAYOUT-02: Preview Letter with Inline Image
 * - US-LAYOUT-03: Layout Type Detection and Override
 * - US-LAYOUT-04: Letter Layout Image Processing
 * - US-LAYOUT-05: Letter Layout Widget Preview
 * - US-LAYOUT-06: Letter Layout PostGrid Printing
 *
 * Personas Covered:
 * - Sarah (Occasional Sender) - personal letterhead, photos with letters
 * - David (Business User) - business branding headers
 */

import { testUsers } from './users.js';
import { testAddresses, testLetterContent } from './letters.js';

// =============================================================================
// Layout Type Definitions
// =============================================================================

export type LetterLayoutType = 'text_only' | 'header_image' | 'inline_image';

// =============================================================================
// Layout Image Fixtures
// =============================================================================

export const testLayoutImages = {
  // Valid header image
  validHeaderImage: {
    download_url: 'https://files.openai.com/test/header-letterhead.jpg',
    file_id: 'file-header-001',
    contentType: 'image/jpeg',
    contentLength: 500 * 1024, // 500KB
  },

  // Valid inline image
  validInlineImage: {
    download_url: 'https://files.openai.com/test/inline-photo.jpg',
    file_id: 'file-inline-001',
    contentType: 'image/jpeg',
    contentLength: 1 * 1024 * 1024, // 1MB
  },

  // Valid PNG header
  validPngHeader: {
    download_url: 'https://files.openai.com/test/header-logo.png',
    file_id: 'file-header-png-001',
    contentType: 'image/png',
    contentLength: 200 * 1024, // 200KB
  },

  // Too large (over 5MB limit for letter images)
  tooLargeImage: {
    download_url: 'https://files.openai.com/test/header-too-large.jpg',
    file_id: 'file-large-001',
    contentType: 'image/jpeg',
    contentLength: 8 * 1024 * 1024, // 8MB
  },

  // Wrong format (GIF not allowed)
  invalidGifImage: {
    download_url: 'https://files.openai.com/test/header.gif',
    file_id: 'file-gif-001',
    contentType: 'image/gif',
    contentLength: 100 * 1024, // 100KB
  },
};

// Simulated image metadata (as returned by Sharp)
export const testLayoutImageMetadata = {
  // Valid header dimensions
  validHeader: {
    width: 1920,
    height: 400,
    format: 'jpeg',
  },

  // Valid inline dimensions
  validInline: {
    width: 1200,
    height: 800,
    format: 'jpeg',
  },

  // Header at target size (6.5" x 2" at 300 DPI)
  headerAtTarget: {
    width: 1950,
    height: 600,
    format: 'jpeg',
  },

  // Inline at target size (6.5" x 3" at 300 DPI)
  inlineAtTarget: {
    width: 1950,
    height: 900,
    format: 'jpeg',
  },
};

// Simulated processed layout images
export const testProcessedLayoutImages = {
  header: {
    base64DataUri: 'data:image/jpeg;base64,/9j/4AAQSkZJRg...header-truncated...',
    originalWidth: 1920,
    originalHeight: 400,
    processedWidth: 1950,
    processedHeight: 600,
  },
  inline: {
    base64DataUri: 'data:image/jpeg;base64,/9j/4AAQSkZJRg...inline-truncated...',
    originalWidth: 1200,
    originalHeight: 800,
    processedWidth: 1950,
    processedHeight: 900,
  },
};

// =============================================================================
// Layout-specific Letter Content Fixtures
// =============================================================================

export const testLayoutLetterContent = {
  // Short letter for text_only (under 1800 char limit)
  textOnlyShort: {
    bodyText: testLetterContent.shortLetter.bodyText,
    signOff: testLetterContent.shortLetter.signOff,
    layoutType: 'text_only' as LetterLayoutType,
    maxChars: 1800,
  },

  // Letter for header layout (under 1500 char limit)
  headerLayoutShort: {
    bodyText: `Dear Friend,

I hope this letter finds you well. I wanted to share some exciting news and connect with you.

Life has been wonderful lately, and I've been thinking about our last conversation. There's so much to catch up on!

Looking forward to hearing from you soon.`,
    signOff: 'Warm regards,\nSarah',
    layoutType: 'header_image' as LetterLayoutType,
    maxChars: 1500,
  },

  // Letter for inline layout (under 1200 char limit)
  inlineLayoutShort: {
    bodyText: `Dear Friend,

I wanted to share this special photo with you. It captures such a wonderful moment!

Hope to see you soon.`,
    signOff: 'Love,\nSarah',
    layoutType: 'inline_image' as LetterLayoutType,
    maxChars: 1200,
  },

  // Over header layout limit (>1500 chars)
  overHeaderLimit: {
    bodyText: 'A'.repeat(1600),
    signOff: 'Test',
    layoutType: 'header_image' as LetterLayoutType,
  },

  // Over inline layout limit (>1200 chars)
  overInlineLimit: {
    bodyText: 'A'.repeat(1300),
    signOff: 'Test',
    layoutType: 'inline_image' as LetterLayoutType,
  },
};

// =============================================================================
// Layout Draft Fixtures
// =============================================================================

let layoutDraftIdCounter = 1;

export function generateLayoutDraftId(): string {
  return `layout-draft-${Date.now()}-${layoutDraftIdCounter++}`;
}

export interface TestLayoutDraft {
  draft_id: string;
  user_id: string;
  mail_type: 'letter';
  sender: string;
  recipient: string;
  body_text: string;
  sign_off: string;
  layout_type: LetterLayoutType;
  header_image_data: string | null;
  header_image_url: string | null;
  inline_image_data: string | null;
  inline_image_url: string | null;
  required_credits: number;
  preview_html: string | null;
  sender_validation: string | null;
  recipient_validation: string | null;
  status: 'pending' | 'consumed' | 'expired' | 'cancelled';
  expires_at: Date;
  consumed_at: Date | null;
  consumed_letter_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export function createTestLayoutDraft(
  userId: string = testUsers.sarah.user_id,
  options: {
    layoutType?: LetterLayoutType;
    status?: TestLayoutDraft['status'];
    expiresInHours?: number;
    expiredHoursAgo?: number;
    consumedLetterId?: string;
    bodyText?: string;
    signOff?: string;
    hasHeaderImage?: boolean;
    hasInlineImage?: boolean;
  } = {}
): TestLayoutDraft {
  const {
    layoutType = 'text_only',
    status = 'pending',
    expiresInHours = 24,
    expiredHoursAgo,
    consumedLetterId,
    bodyText = testLayoutLetterContent.textOnlyShort.bodyText,
    signOff = testLayoutLetterContent.textOnlyShort.signOff,
    hasHeaderImage = layoutType === 'header_image',
    hasInlineImage = layoutType === 'inline_image',
  } = options;

  let expiresAt: Date;
  if (expiredHoursAgo !== undefined) {
    expiresAt = new Date(Date.now() - expiredHoursAgo * 60 * 60 * 1000);
  } else {
    expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);
  }

  const draft: TestLayoutDraft = {
    draft_id: generateLayoutDraftId(),
    user_id: userId,
    mail_type: 'letter',
    sender: JSON.stringify(testAddresses.validSender),
    recipient: JSON.stringify(testAddresses.validRecipient),
    body_text: bodyText,
    sign_off: signOff,
    layout_type: layoutType,
    header_image_data: hasHeaderImage ? testProcessedLayoutImages.header.base64DataUri : null,
    header_image_url: hasHeaderImage ? testLayoutImages.validHeaderImage.download_url : null,
    inline_image_data: hasInlineImage ? testProcessedLayoutImages.inline.base64DataUri : null,
    inline_image_url: hasInlineImage ? testLayoutImages.validInlineImage.download_url : null,
    required_credits: 2,
    preview_html: '<html><body>Layout Preview</body></html>',
    sender_validation: JSON.stringify({ status: 'verified' }),
    recipient_validation: JSON.stringify({ status: 'verified' }),
    status,
    expires_at: expiresAt,
    consumed_at: status === 'consumed' ? new Date() : null,
    consumed_letter_id: consumedLetterId ?? null,
    created_at: new Date(),
    updated_at: new Date(),
  };

  return draft;
}

// Pre-built layout draft scenarios
export const testLayoutDrafts = {
  // Text-only layout (current default)
  textOnly: () => createTestLayoutDraft(testUsers.sarah.user_id, {
    layoutType: 'text_only',
  }),

  // Header image layout
  headerImage: () => createTestLayoutDraft(testUsers.sarah.user_id, {
    layoutType: 'header_image',
    bodyText: testLayoutLetterContent.headerLayoutShort.bodyText,
    signOff: testLayoutLetterContent.headerLayoutShort.signOff,
  }),

  // Inline image layout
  inlineImage: () => createTestLayoutDraft(testUsers.sarah.user_id, {
    layoutType: 'inline_image',
    bodyText: testLayoutLetterContent.inlineLayoutShort.bodyText,
    signOff: testLayoutLetterContent.inlineLayoutShort.signOff,
  }),

  // Already consumed header draft (for idempotency)
  consumedHeader: () => createTestLayoutDraft(testUsers.sarah.user_id, {
    layoutType: 'header_image',
    status: 'consumed',
    consumedLetterId: 'letter-header-001',
  }),

  // Expired inline draft
  expiredInline: () => createTestLayoutDraft(testUsers.sarah.user_id, {
    layoutType: 'inline_image',
    status: 'expired',
    expiredHoursAgo: 2,
  }),

  // Business user header (David)
  businessHeader: () => createTestLayoutDraft(testUsers.david.user_id, {
    layoutType: 'header_image',
    bodyText: 'Dear Valued Customer,\n\nThank you for your business...',
    signOff: 'Best regards,\nDavid\nAcme Corp',
  }),
};

// =============================================================================
// Layout Image Processing Constants
// =============================================================================

export const layoutImageProcessingConfig = {
  // Header image config
  header: {
    maxFileSize: 5 * 1024 * 1024, // 5MB
    targetWidth: 1950, // 6.5 inches at 300 DPI
    targetHeight: 600, // 2 inches at 300 DPI
    jpegQuality: 85,
  },
  // Inline image config
  inline: {
    maxFileSize: 5 * 1024 * 1024, // 5MB
    targetWidth: 1950, // 6.5 inches at 300 DPI
    targetHeight: 900, // 3 inches at 300 DPI
    jpegQuality: 85,
  },
  // Shared config
  allowedTypes: ['image/png', 'image/jpeg', 'image/webp'] as const,
};

// =============================================================================
// Layout Character Limits
// =============================================================================

export const layoutCharacterLimits = {
  text_only: 1800,
  header_image: 1500,
  inline_image: 1200,
};

// =============================================================================
// Error Message Constants
// =============================================================================

export const layoutErrors = {
  // Header image errors
  headerImageTooLarge: 'Header image is too large. Please use an image under 5MB.',
  headerImageWrongFormat: 'Unsupported image format. Please use PNG, JPEG, or WebP.',
  headerImageProcessingFailed: 'Could not process header image. Please try a different image.',
  headerLayoutOverLimit: 'Letter exceeds one-page limit with header image (~1500 characters)',

  // Inline image errors
  inlineImageTooLarge: 'Inline image is too large. Please use an image under 5MB.',
  inlineImageWrongFormat: 'Unsupported image format. Please use PNG, JPEG, or WebP.',
  inlineImageProcessingFailed: 'Could not process inline image. Please try a different image.',
  inlineLayoutOverLimit: 'Letter exceeds one-page limit with inline image (~1200 characters)',

  // Layout conflict errors
  bothImagesProvided: 'Cannot use both header and inline images. Please choose one layout type.',
  invalidLayoutType: 'Invalid layout type. Must be one of: text_only, header_image, inline_image.',
};

// =============================================================================
// Layout Detection Test Cases
// =============================================================================

export const layoutDetectionCases = {
  // Auto-detect: text_only (no images)
  autoDetectTextOnly: {
    input: {
      bodyText: 'Hello world',
      signOff: 'Best',
      headerImageUrl: undefined,
      inlineImageUrl: undefined,
      layoutType: undefined,
    },
    expectedLayout: 'text_only' as LetterLayoutType,
  },

  // Auto-detect: header_image (header URL provided)
  autoDetectHeader: {
    input: {
      bodyText: 'Hello world',
      signOff: 'Best',
      headerImageUrl: testLayoutImages.validHeaderImage.download_url,
      inlineImageUrl: undefined,
      layoutType: undefined,
    },
    expectedLayout: 'header_image' as LetterLayoutType,
  },

  // Auto-detect: inline_image (inline URL provided)
  autoDetectInline: {
    input: {
      bodyText: 'Hello world',
      signOff: 'Best',
      headerImageUrl: undefined,
      inlineImageUrl: testLayoutImages.validInlineImage.download_url,
      layoutType: undefined,
    },
    expectedLayout: 'inline_image' as LetterLayoutType,
  },

  // Explicit override: text_only even though images provided
  explicitTextOnly: {
    input: {
      bodyText: 'Hello world',
      signOff: 'Best',
      headerImageUrl: testLayoutImages.validHeaderImage.download_url,
      inlineImageUrl: undefined,
      layoutType: 'text_only' as LetterLayoutType,
    },
    expectedLayout: 'text_only' as LetterLayoutType,
  },

  // Error: both images provided
  bothImagesError: {
    input: {
      bodyText: 'Hello world',
      signOff: 'Best',
      headerImageUrl: testLayoutImages.validHeaderImage.download_url,
      inlineImageUrl: testLayoutImages.validInlineImage.download_url,
      layoutType: undefined,
    },
    expectedError: layoutErrors.bothImagesProvided,
  },
};

// =============================================================================
// PostGrid HTML Expected Outputs
// =============================================================================

export const expectedPostGridHtml = {
  textOnly: (message: string) => `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: 'Times New Roman', serif;
      font-size: 12pt;
      line-height: 1.6;
      margin: 3.5in 1in 1in 1in;
      color: #000;
    }
    .letter-body { white-space: pre-wrap; word-wrap: break-word; }
  </style>
</head>
<body>
  <div class="letter-body">${message}</div>
</body>
</html>`,

  // Check that header HTML contains key elements (not exact match)
  headerImageContains: [
    'class="header-image"',
    '<img src="data:image/jpeg;base64,',
    'margin: 3.5in',
    'max-height: 2in',
  ],

  // Check that inline HTML contains key elements
  inlineImageContains: [
    'class="inline-image"',
    '<img src="data:image/jpeg;base64,',
    'max-height: 3in',
    'text-align: center',
  ],
};
