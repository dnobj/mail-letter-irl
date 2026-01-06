/**
 * Test fixtures for postcards and image processing
 *
 * User Stories Covered:
 * - US-POSTCARD-01: Preview a Postcard
 * - US-POSTCARD-02: Send a Postcard
 * - US-POSTCARD-03: Postcard Image Processing
 */

import { testUsers } from './users.js';
import { testAddresses } from './letters.js';

// =============================================================================
// Image Fixtures
// =============================================================================

export const testImages = {
  // Valid image file info (as received from OpenAI)
  validJpegFile: {
    download_url: 'https://files.openai.com/test/image-valid.jpg',
    file_id: 'file-abc123',
    contentType: 'image/jpeg',
    contentLength: 2 * 1024 * 1024, // 2MB
  },

  validPngFile: {
    download_url: 'https://files.openai.com/test/image-valid.png',
    file_id: 'file-def456',
    contentType: 'image/png',
    contentLength: 5 * 1024 * 1024, // 5MB
  },

  validWebpFile: {
    download_url: 'https://files.openai.com/test/image-valid.webp',
    file_id: 'file-ghi789',
    contentType: 'image/webp',
    contentLength: 1 * 1024 * 1024, // 1MB
  },

  // Invalid: too large (over 10MB)
  tooLargeFile: {
    download_url: 'https://files.openai.com/test/image-too-large.jpg',
    file_id: 'file-large001',
    contentType: 'image/jpeg',
    contentLength: 15 * 1024 * 1024, // 15MB
  },

  // Invalid: wrong format
  invalidGifFile: {
    download_url: 'https://files.openai.com/test/image.gif',
    file_id: 'file-gif001',
    contentType: 'image/gif',
    contentLength: 500 * 1024, // 500KB
  },

  // Invalid: unsupported type
  invalidSvgFile: {
    download_url: 'https://files.openai.com/test/image.svg',
    file_id: 'file-svg001',
    contentType: 'image/svg+xml',
    contentLength: 50 * 1024, // 50KB
  },
};

// Simulated image metadata (as returned by Sharp)
export const testImageMetadata = {
  // Valid dimensions (above minimum 600x900)
  validLandscape: {
    width: 1920,
    height: 1080,
    format: 'jpeg',
  },

  validPortrait: {
    width: 1080,
    height: 1920,
    format: 'jpeg',
  },

  validSquare: {
    width: 1200,
    height: 1200,
    format: 'png',
  },

  // Exactly at minimum
  atMinimum: {
    width: 600,
    height: 900,
    format: 'webp',
  },

  // Too small (below minimum 600x900)
  tooSmallWidth: {
    width: 400,
    height: 900,
    format: 'jpeg',
  },

  tooSmallHeight: {
    width: 600,
    height: 600,
    format: 'jpeg',
  },

  tooSmallBoth: {
    width: 320,
    height: 240,
    format: 'jpeg',
  },
};

// Simulated processed image result
export const testProcessedImage = {
  base64DataUri: 'data:image/jpeg;base64,/9j/4AAQSkZJRg...truncated...',
  originalWidth: 1920,
  originalHeight: 1080,
  processedWidth: 1800,
  processedHeight: 2700,
};

// =============================================================================
// Postcard Content Fixtures
// =============================================================================

export const testPostcardContent = {
  // Short message (well under limit)
  shortMessage: {
    message: 'Having a great time! Wish you were here!',
  },

  // Medium message
  mediumMessage: {
    message: `Hey Mom & Dad!

Having an amazing time in Colorado! The mountains are absolutely breathtaking. Yesterday we hiked to a waterfall and saw a family of deer.

Wish you were here!

Love,
David & Sarah`,
  },

  // At limit (~400 chars)
  atLimitMessage: {
    message: `Dear Family,

This vacation has been absolutely incredible! Every day brings new adventures. The weather has been perfect - sunny but cool. We've explored so many beautiful trails and seen amazing wildlife. The local food has been delicious too. We've taken hundreds of photos to share with you when we return. Can't wait to see everyone and tell you all about our experiences!

With love`,
  },

  // Over limit
  overLimitMessage: {
    message: 'A'.repeat(500), // Exceeds ~400 char limit
  },
};

// =============================================================================
// Postcard Draft Fixtures
// =============================================================================

let postcardDraftIdCounter = 1;

export function generatePostcardDraftId(): string {
  return `postcard-draft-${Date.now()}-${postcardDraftIdCounter++}`;
}

export interface TestPostcardDraft {
  draft_id: string;
  user_id: string;
  mail_type: 'postcard';
  sender: string; // JSON stringified
  recipient: string; // JSON stringified
  message: string;
  front_image_data: string | null; // Base64 data URI
  front_image_url: string | null; // Original URL for debugging
  postcard_size: '6x9';
  required_credits: number;
  preview_front_html: string | null;
  preview_back_html: string | null;
  sender_validation: string | null;
  recipient_validation: string | null;
  status: 'pending' | 'consumed' | 'expired' | 'cancelled';
  expires_at: Date;
  consumed_at: Date | null;
  consumed_letter_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export function createTestPostcardDraft(
  userId: string = testUsers.sarah.user_id,
  options: {
    status?: TestPostcardDraft['status'];
    expiresInHours?: number;
    expiredHoursAgo?: number;
    consumedLetterId?: string;
    message?: string;
    hasImage?: boolean;
  } = {}
): TestPostcardDraft {
  const {
    status = 'pending',
    expiresInHours = 24,
    expiredHoursAgo,
    consumedLetterId,
    message = testPostcardContent.mediumMessage.message,
    hasImage = true,
  } = options;

  let expiresAt: Date;
  if (expiredHoursAgo !== undefined) {
    expiresAt = new Date(Date.now() - expiredHoursAgo * 60 * 60 * 1000);
  } else {
    expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);
  }

  const draft: TestPostcardDraft = {
    draft_id: generatePostcardDraftId(),
    user_id: userId,
    mail_type: 'postcard',
    sender: JSON.stringify(testAddresses.validSender),
    recipient: JSON.stringify(testAddresses.validRecipient),
    message,
    front_image_data: hasImage ? testProcessedImage.base64DataUri : null,
    front_image_url: hasImage ? testImages.validJpegFile.download_url : null,
    postcard_size: '6x9',
    required_credits: 2,
    preview_front_html: hasImage ? '<html><body><img src="..."/></body></html>' : null,
    preview_back_html: '<html><body>Message preview</body></html>',
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

// Pre-built postcard draft scenarios
export const testPostcardDrafts = {
  // Valid pending postcard draft
  pending: () => createTestPostcardDraft(testUsers.sarah.user_id, { status: 'pending' }),

  // Already consumed (for idempotency tests)
  consumed: () =>
    createTestPostcardDraft(testUsers.sarah.user_id, {
      status: 'consumed',
      consumedLetterId: 'postcard-letter-001',
    }),

  // Expired postcard draft
  expired: () =>
    createTestPostcardDraft(testUsers.sarah.user_id, {
      status: 'expired',
      expiredHoursAgo: 2,
    }),

  // Cancelled postcard draft
  cancelled: () =>
    createTestPostcardDraft(testUsers.sarah.user_id, {
      status: 'cancelled',
    }),

  // Postcard without image (error case)
  noImage: () =>
    createTestPostcardDraft(testUsers.sarah.user_id, {
      status: 'pending',
      hasImage: false,
    }),

  // Draft belonging to different user
  differentUser: () =>
    createTestPostcardDraft(testUsers.marcus.user_id, { status: 'pending' }),
};

// =============================================================================
// Error Message Constants
// =============================================================================

export const postcardErrors = {
  // Mobile-specific error (US-POSTCARD-04: Mobile Image Graceful Degradation)
  missingImageMobile:
    "MOBILE IMAGE LIMITATION\n\n" +
    "ChatGPT mobile cannot send images to this app yet. " +
    "Postcards require an image.\n\n" +
    "RECOMMENDED: Use quote_and_preview_letter for a text-only letter instead.\n\n" +
    "OTHER OPTIONS:\n" +
    "- Switch to desktop/web browser for postcards with images\n" +
    "- Provide a direct image URL (imageUrl parameter)\n\n" +
    "There is a mobile workaround - ask me about it if you want to try.",
  // Desktop error (simple)
  missingImage: 'No image received. Please attach an image or provide imageUrl.',
  imageTooLarge: 'Image is too large. Please use an image under 10MB.',
  unsupportedFormat: 'Unsupported image format. Please use PNG, JPEG, or WebP.',
  imageTooSmall: 'Image is too small for print quality. Please use at least 600x900 pixels.',
  downloadFailed: "Couldn't download the image. Please try again.",
  messageTooLong: 'Message exceeds postcard limit (~400 characters)',
  processingFailed: 'Image could not be processed. Please try a different image.',
};

// =============================================================================
// Image Processing Constants
// =============================================================================

export const imageProcessingConfig = {
  maxFileSize: 10 * 1024 * 1024, // 10MB
  minWidth: 600,
  minHeight: 900,
  targetWidth: 1800, // 6 inches at 300 DPI
  targetHeight: 2700, // 9 inches at 300 DPI
  jpegQuality: 85,
  allowedTypes: ['image/png', 'image/jpeg', 'image/webp'] as const,
};
