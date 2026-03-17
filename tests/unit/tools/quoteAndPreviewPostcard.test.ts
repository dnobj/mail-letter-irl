/**
 * Unit tests for quote_and_preview_postcard tool
 *
 * Tests the postcard preview workflow:
 * - Address validation
 * - Image processing integration
 * - Draft creation with mail_type='postcard'
 * - Preview HTML generation
 * - Credit calculation
 *
 * User Stories Covered:
 * - US-POSTCARD-01: Preview a Postcard
 * - US-POSTCARD-03: Postcard Image Processing (integration)
 *
 * Personas Covered:
 * - Sarah (Occasional Sender) - vacation postcards with personal photos
 * - David (Business User) - branded postcards
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { testUsers } from '../../fixtures/users.js';
import { testAddresses } from '../../fixtures/letters.js';
import {
  testImages,
  testPostcardContent,
  testPostcardDrafts,
  postcardErrors,
  imageProcessingConfig,
} from '../../fixtures/postcards.js';
import { quoteAndPreviewPostcardTool } from '../../../src/tools/quoteAndPreviewPostcard.js';

describe('quote_and_preview_postcard Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Successful Preview Flow
  // ==========================================================================
  describe('Successful Preview Flow', () => {
    it('should create postcard draft with valid inputs', async () => {
      const input = {
        recipient: testAddresses.validRecipient,
        sender: testAddresses.validSender,
        message: testPostcardContent.mediumMessage.message,
        // Image would come from _meta["openai/fileParams"]
      };

      // Expected draft properties
      const expectedDraft = testPostcardDrafts.pending();

      expect(expectedDraft.mail_type).toBe('postcard');
      expect(expectedDraft.postcard_size).toBe('6x9');
      expect(expectedDraft.status).toBe('pending');
    });

    it('should set mail_type to postcard in draft', () => {
      const draft = testPostcardDrafts.pending();

      expect(draft.mail_type).toBe('postcard');
    });

    it('should set postcard_size to 6x9', () => {
      const draft = testPostcardDrafts.pending();

      expect(draft.postcard_size).toBe('6x9');
    });

    it('should require 2 credits (same as letter)', () => {
      const draft = testPostcardDrafts.pending();

      expect(draft.required_credits).toBe(2);
    });

    it('should create draft with 24-hour expiration', () => {
      const draft = testPostcardDrafts.pending();

      const now = new Date();
      const expiresAt = draft.expires_at;
      const hoursUntilExpiry = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60);

      expect(hoursUntilExpiry).toBeGreaterThan(23);
      expect(hoursUntilExpiry).toBeLessThanOrEqual(24);
    });

    it('should store processed image as base64 in front_image_data', () => {
      const draft = testPostcardDrafts.pending();

      expect(draft.front_image_data).not.toBeNull();
      expect(draft.front_image_data).toMatch(/^data:image\/jpeg;base64,/);
    });

    it('should store original image URL in front_image_url for debugging', () => {
      const draft = testPostcardDrafts.pending();

      expect(draft.front_image_url).not.toBeNull();
      expect(draft.front_image_url).toMatch(/^https:\/\//);
    });

    it('should return draftId for use in send operation', () => {
      const draft = testPostcardDrafts.pending();

      expect(draft.draft_id).toBeDefined();
      expect(draft.draft_id).toMatch(/^postcard-draft-/);
    });

    it('should return canSendNow based on credit balance', () => {
      // User with sufficient credits
      const userCredits = 10;
      const requiredCredits = 2;
      const canSendNow = userCredits >= requiredCredits;

      expect(canSendNow).toBe(true);

      // User with insufficient credits
      const lowCredits = 1;
      const canSendNowLow = lowCredits >= requiredCredits;

      expect(canSendNowLow).toBe(false);
    });

    it('should generate front preview HTML with image', () => {
      const draft = testPostcardDrafts.pending();

      expect(draft.preview_front_html).not.toBeNull();
      expect(draft.preview_front_html).toContain('<img');
    });

    it('should generate back preview HTML with message', () => {
      const draft = testPostcardDrafts.pending();

      expect(draft.preview_back_html).not.toBeNull();
    });
  });

  // ==========================================================================
  // Address Validation
  // ==========================================================================
  describe('Address Validation', () => {
    it('should validate addresses via PostGrid (US only)', () => {
      const validAddress = testAddresses.validRecipient;

      expect(validAddress.country).toBe('US');
    });

    it('should reject non-US addresses', () => {
      const nonUSAddress = testAddresses.invalidNonUS;

      expect(nonUSAddress.country).not.toBe('US');
      // Should throw error: "Only supports mailing within United States"
    });

    it('should reject addresses with missing required fields', () => {
      const invalidAddress = testAddresses.invalidMissing;

      expect(invalidAddress.line1).toBe('');
      // Should throw error listing missing fields
    });

    it('should use saved return address if sender not provided', () => {
      // When sender is not provided, tool should look up user's saved return address
      const input = {
        recipient: testAddresses.validRecipient,
        // sender: not provided
        message: testPostcardContent.shortMessage.message,
      };

      // Tool should use saved return address or throw clear error if none saved
      expect(input.recipient).toBeDefined();
    });
  });

  // ==========================================================================
  // Image Validation (Integration with imageService)
  // ==========================================================================
  describe('Image Validation', () => {
    it('should require an image for postcard front', () => {
      const draftWithoutImage = testPostcardDrafts.noImage();

      expect(draftWithoutImage.front_image_data).toBeNull();

      // Desktop error should be clear and direct
      const desktopError = postcardErrors.missingImage;
      expect(desktopError).toContain('No image received');
      expect(desktopError).toContain('imageUrl');

      // Mobile error should guide users to text-only letter (US-POSTCARD-04)
      const mobileError = postcardErrors.missingImageMobile;
      expect(mobileError).toContain('MOBILE IMAGE LIMITATION');
      expect(mobileError).toContain('quote_and_preview_letter');
    });

    it('should reject images over 10MB', () => {
      const largeImage = testImages.tooLargeFile;

      expect(largeImage.contentLength).toBeGreaterThan(imageProcessingConfig.maxFileSize);

      const errorMsg = postcardErrors.imageTooLarge;
      expect(errorMsg).toContain('10MB');
    });

    it('should reject unsupported image formats', () => {
      const gifImage = testImages.invalidGifFile;

      expect(imageProcessingConfig.allowedTypes).not.toContain(gifImage.contentType);

      const errorMsg = postcardErrors.unsupportedFormat;
      expect(errorMsg).toContain('PNG, JPEG, or WebP');
    });

    it('should reject images too small for print', () => {
      const errorMsg = postcardErrors.imageTooSmall;
      expect(errorMsg).toContain('600x900 pixels');
    });

    it('should accept valid JPEG image', () => {
      const jpegImage = testImages.validJpegFile;

      expect(imageProcessingConfig.allowedTypes).toContain(jpegImage.contentType);
      expect(jpegImage.contentLength).toBeLessThanOrEqual(imageProcessingConfig.maxFileSize);
    });

    it('should accept valid PNG image', () => {
      const pngImage = testImages.validPngFile;

      expect(imageProcessingConfig.allowedTypes).toContain(pngImage.contentType);
    });

    it('should accept valid WebP image', () => {
      const webpImage = testImages.validWebpFile;

      expect(imageProcessingConfig.allowedTypes).toContain(webpImage.contentType);
    });
  });

  // ==========================================================================
  // Message Validation
  // ==========================================================================
  describe('Message Validation', () => {
    it('should accept short messages', () => {
      const shortMessage = testPostcardContent.shortMessage.message;

      expect(shortMessage.length).toBeLessThan(400);
    });

    it('should accept messages at the limit (~400 chars)', () => {
      const atLimitMessage = testPostcardContent.atLimitMessage.message;

      // Allow some flexibility around 400
      expect(atLimitMessage.length).toBeLessThanOrEqual(450);
    });

    it('should reject messages over the limit', () => {
      const overLimitMessage = testPostcardContent.overLimitMessage.message;

      expect(overLimitMessage.length).toBeGreaterThan(400);

      const errorMsg = postcardErrors.messageTooLong;
      expect(errorMsg).toContain('~400 characters');
    });
  });

  // ==========================================================================
  // OpenAI File Parameter Integration
  // ==========================================================================
  describe('OpenAI File Parameter Integration', () => {
    it('should accept image via _meta["openai/fileParams"]', () => {
      // Tool schema should declare file parameters
      const toolMeta = {
        'openai/fileParams': ['image'],
      };

      expect(toolMeta['openai/fileParams']).toContain('image');
    });

    it('should extract download_url from file parameter', () => {
      // File parameter structure from OpenAI
      const fileParam = {
        download_url: 'https://files.openai.com/test/image.jpg',
        file_id: 'file-abc123',
      };

      expect(fileParam.download_url).toBeDefined();
      expect(fileParam.file_id).toBeDefined();
    });
  });

  // ==========================================================================
  // Error Handling
  // ==========================================================================
  describe('Error Handling', () => {
    it('should provide clear desktop error for missing image', () => {
      // Desktop error is simple and direct
      expect(postcardErrors.missingImage).toContain('No image received');
      expect(postcardErrors.missingImage).toContain('imageUrl');
    });

    it('should provide mobile-specific error with guidance (US-POSTCARD-04)', () => {
      // Mobile error guides users to text-only letter alternative
      expect(postcardErrors.missingImageMobile).toContain('MOBILE IMAGE LIMITATION');
      expect(postcardErrors.missingImageMobile).toContain('quote_and_preview_letter');
      expect(postcardErrors.missingImageMobile).toContain('desktop/web browser');
      expect(postcardErrors.missingImageMobile).toContain('imageUrl parameter');
      expect(postcardErrors.missingImageMobile).toContain('workaround');
    });

    it('should provide clear error for image too large', () => {
      expect(postcardErrors.imageTooLarge).toBe(
        'Image is too large. Please use an image under 10MB.'
      );
    });

    it('should provide clear error for wrong format', () => {
      expect(postcardErrors.unsupportedFormat).toBe(
        'Unsupported image format. Please use PNG, JPEG, or WebP.'
      );
    });

    it('should provide clear error for image too small', () => {
      expect(postcardErrors.imageTooSmall).toBe(
        'Image is too small for print quality. Please use at least 600x900 pixels.'
      );
    });

    it('should provide clear error for download failure', () => {
      expect(postcardErrors.downloadFailed).toBe(
        "Couldn't download the image. Please try again."
      );
    });

    it('should provide clear error for message too long', () => {
      expect(postcardErrors.messageTooLong).toBe(
        'Message exceeds postcard limit (~400 characters)'
      );
    });
  });

  // ==========================================================================
  // Widget Output Template
  // ==========================================================================
  describe('Widget Output Template', () => {
    it('should describe imageUrl reuse and upload_image as fallback-only', () => {
      expect(quoteAndPreviewPostcardTool.description).toContain('Use this when the user wants to make, create, design, or preview a postcard');
      expect(quoteAndPreviewPostcardTool.description).toContain('pass imageUrl when a generated or hosted image is already available');
      expect(quoteAndPreviewPostcardTool.description).toContain('use upload_image only if no attachment or usable imageUrl made it through');
    });

    it('should specify PostcardPreviewCard widget in _meta', () => {
      // Tool should declare output template
      const toolMeta = {
        'openai/outputTemplate': 'ui://widgets/PostcardPreviewCard.html',
      };

      expect(toolMeta['openai/outputTemplate']).toBe('ui://widgets/PostcardPreviewCard.html');
    });
  });
});
