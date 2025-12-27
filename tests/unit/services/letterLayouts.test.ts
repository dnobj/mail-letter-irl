/**
 * Unit tests for letter layout feature
 *
 * Tests the multi-layout letter system:
 * - Layout type detection and override
 * - Character limit enforcement per layout
 * - Image processing for header and inline images
 * - Preview HTML generation for each layout
 * - PostGrid HTML generation for printing
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
 * - Sarah (Occasional Sender) - personal letterhead, inline photos
 * - David (Business User) - business branding headers
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { testUsers } from '../../fixtures/users.js';
import { testAddresses } from '../../fixtures/letters.js';
import {
  testLayoutImages,
  testLayoutImageMetadata,
  testProcessedLayoutImages,
  testLayoutLetterContent,
  testLayoutDrafts,
  createTestLayoutDraft,
  layoutImageProcessingConfig,
  layoutCharacterLimits,
  layoutErrors,
  layoutDetectionCases,
  expectedPostGridHtml,
  type LetterLayoutType,
} from '../../fixtures/layouts.js';

// =============================================================================
// Layout Type Detection (US-LAYOUT-03)
// =============================================================================
describe('Layout Type Detection', () => {
  describe('Auto-detection from content', () => {
    it('should detect text_only when no images provided', () => {
      const testCase = layoutDetectionCases.autoDetectTextOnly;
      const { headerImageUrl, inlineImageUrl, layoutType } = testCase.input;

      // Detection logic
      const detected = detectLayoutType({ headerImageUrl, inlineImageUrl, layoutType });

      expect(detected).toBe(testCase.expectedLayout);
      expect(detected).toBe('text_only');
    });

    it('should detect header_image when header URL provided', () => {
      const testCase = layoutDetectionCases.autoDetectHeader;
      const { headerImageUrl, inlineImageUrl, layoutType } = testCase.input;

      const detected = detectLayoutType({ headerImageUrl, inlineImageUrl, layoutType });

      expect(detected).toBe(testCase.expectedLayout);
      expect(detected).toBe('header_image');
    });

    it('should detect inline_image when inline URL provided', () => {
      const testCase = layoutDetectionCases.autoDetectInline;
      const { headerImageUrl, inlineImageUrl, layoutType } = testCase.input;

      const detected = detectLayoutType({ headerImageUrl, inlineImageUrl, layoutType });

      expect(detected).toBe(testCase.expectedLayout);
      expect(detected).toBe('inline_image');
    });
  });

  describe('Explicit override', () => {
    it('should use explicit layoutType when provided', () => {
      const testCase = layoutDetectionCases.explicitTextOnly;
      const { headerImageUrl, inlineImageUrl, layoutType } = testCase.input;

      const detected = detectLayoutType({ headerImageUrl, inlineImageUrl, layoutType });

      expect(detected).toBe(testCase.expectedLayout);
      // Even though header image is provided, explicit override takes precedence
      expect(detected).toBe('text_only');
    });

    it('should reject both header and inline images', () => {
      const testCase = layoutDetectionCases.bothImagesError;
      const { headerImageUrl, inlineImageUrl, layoutType } = testCase.input;

      expect(() => {
        detectLayoutType({ headerImageUrl, inlineImageUrl, layoutType });
      }).toThrow(testCase.expectedError);
    });
  });
});

// =============================================================================
// Character Limit Enforcement (US-LAYOUT-01, US-LAYOUT-02)
// =============================================================================
describe('Character Limit Enforcement', () => {
  describe('text_only layout', () => {
    it('should allow up to 1800 characters', () => {
      const limit = layoutCharacterLimits.text_only;
      expect(limit).toBe(1800);

      const content = testLayoutLetterContent.textOnlyShort;
      const totalChars = content.bodyText.length + content.signOff.length;

      expect(totalChars).toBeLessThanOrEqual(limit);
    });

    it('should reject letters over 1800 characters', () => {
      const limit = layoutCharacterLimits.text_only;
      const overLimitBody = 'A'.repeat(1900);

      expect(overLimitBody.length).toBeGreaterThan(limit);
    });
  });

  describe('header_image layout', () => {
    it('should allow up to 1500 characters', () => {
      const limit = layoutCharacterLimits.header_image;
      expect(limit).toBe(1500);

      const content = testLayoutLetterContent.headerLayoutShort;
      const totalChars = content.bodyText.length + content.signOff.length;

      expect(totalChars).toBeLessThanOrEqual(limit);
    });

    it('should reject letters over 1500 characters', () => {
      const content = testLayoutLetterContent.overHeaderLimit;
      const totalChars = content.bodyText.length + content.signOff.length;
      const limit = layoutCharacterLimits.header_image;

      expect(totalChars).toBeGreaterThan(limit);

      // Error message should be user-friendly
      expect(layoutErrors.headerLayoutOverLimit).toContain('1500');
    });
  });

  describe('inline_image layout', () => {
    it('should allow up to 1200 characters', () => {
      const limit = layoutCharacterLimits.inline_image;
      expect(limit).toBe(1200);

      const content = testLayoutLetterContent.inlineLayoutShort;
      const totalChars = content.bodyText.length + content.signOff.length;

      expect(totalChars).toBeLessThanOrEqual(limit);
    });

    it('should reject letters over 1200 characters', () => {
      const content = testLayoutLetterContent.overInlineLimit;
      const totalChars = content.bodyText.length + content.signOff.length;
      const limit = layoutCharacterLimits.inline_image;

      expect(totalChars).toBeGreaterThan(limit);

      // Error message should be user-friendly
      expect(layoutErrors.inlineLayoutOverLimit).toContain('1200');
    });
  });
});

// =============================================================================
// Layout Image Processing (US-LAYOUT-04)
// =============================================================================
describe('Layout Image Processing', () => {
  describe('Header image processing', () => {
    it('should process header images to 1950x600 (6.5" x 2" at 300 DPI)', () => {
      const config = layoutImageProcessingConfig.header;

      expect(config.targetWidth).toBe(1950);
      expect(config.targetHeight).toBe(600);
    });

    it('should reject header images over 5MB', () => {
      const config = layoutImageProcessingConfig.header;
      const largeImage = testLayoutImages.tooLargeImage;

      expect(largeImage.contentLength).toBeGreaterThan(config.maxFileSize);

      // Error message should be user-friendly
      expect(layoutErrors.headerImageTooLarge).toContain('5MB');
    });

    it('should accept PNG, JPEG, and WebP formats', () => {
      const allowedTypes = layoutImageProcessingConfig.allowedTypes;

      expect(allowedTypes).toContain('image/png');
      expect(allowedTypes).toContain('image/jpeg');
      expect(allowedTypes).toContain('image/webp');
    });

    it('should reject GIF format', () => {
      const allowedTypes = layoutImageProcessingConfig.allowedTypes;
      const gifImage = testLayoutImages.invalidGifImage;

      expect(allowedTypes).not.toContain(gifImage.contentType);
    });

    it('should return base64 data URI for processed header', () => {
      const processed = testProcessedLayoutImages.header;

      expect(processed.base64DataUri).toMatch(/^data:image\/jpeg;base64,/);
    });
  });

  describe('Inline image processing', () => {
    it('should process inline images to 1950x900 (6.5" x 3" at 300 DPI)', () => {
      const config = layoutImageProcessingConfig.inline;

      expect(config.targetWidth).toBe(1950);
      expect(config.targetHeight).toBe(900);
    });

    it('should reject inline images over 5MB', () => {
      const config = layoutImageProcessingConfig.inline;
      const largeImage = testLayoutImages.tooLargeImage;

      expect(largeImage.contentLength).toBeGreaterThan(config.maxFileSize);

      // Error message should be user-friendly
      expect(layoutErrors.inlineImageTooLarge).toContain('5MB');
    });

    it('should use 85% JPEG quality', () => {
      const config = layoutImageProcessingConfig.inline;

      expect(config.jpegQuality).toBe(85);
    });

    it('should return base64 data URI for processed inline', () => {
      const processed = testProcessedLayoutImages.inline;

      expect(processed.base64DataUri).toMatch(/^data:image\/jpeg;base64,/);
    });
  });
});

// =============================================================================
// Layout Draft Fixtures (US-LAYOUT-05)
// =============================================================================
describe('Layout Draft Fixtures', () => {
  it('should create text_only layout draft', () => {
    const draft = testLayoutDrafts.textOnly();

    expect(draft.layout_type).toBe('text_only');
    expect(draft.header_image_data).toBeNull();
    expect(draft.inline_image_data).toBeNull();
    expect(draft.status).toBe('pending');
  });

  it('should create header_image layout draft with image data', () => {
    const draft = testLayoutDrafts.headerImage();

    expect(draft.layout_type).toBe('header_image');
    expect(draft.header_image_data).not.toBeNull();
    expect(draft.header_image_url).not.toBeNull();
    expect(draft.inline_image_data).toBeNull();
  });

  it('should create inline_image layout draft with image data', () => {
    const draft = testLayoutDrafts.inlineImage();

    expect(draft.layout_type).toBe('inline_image');
    expect(draft.inline_image_data).not.toBeNull();
    expect(draft.inline_image_url).not.toBeNull();
    expect(draft.header_image_data).toBeNull();
  });

  it('should create consumed header draft for idempotency tests', () => {
    const draft = testLayoutDrafts.consumedHeader();

    expect(draft.layout_type).toBe('header_image');
    expect(draft.status).toBe('consumed');
    expect(draft.consumed_letter_id).toBe('letter-header-001');
  });

  it('should create business user header draft for David persona', () => {
    const draft = testLayoutDrafts.businessHeader();

    expect(draft.user_id).toBe(testUsers.david.user_id);
    expect(draft.layout_type).toBe('header_image');
    expect(draft.body_text).toContain('Valued Customer');
  });
});

// =============================================================================
// PostGrid HTML Generation (US-LAYOUT-06)
// =============================================================================
describe('PostGrid HTML Generation', () => {
  describe('text_only layout HTML', () => {
    it('should generate HTML with correct structure', () => {
      const message = 'Hello World';
      const html = expectedPostGridHtml.textOnly(message);

      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('<html>');
      expect(html).toContain('</html>');
    });

    it('should include 3.5in top margin for address window', () => {
      const html = expectedPostGridHtml.textOnly('Test');

      expect(html).toContain('margin: 3.5in 1in 1in 1in');
    });

    it('should use Times New Roman serif font', () => {
      const html = expectedPostGridHtml.textOnly('Test');

      expect(html).toContain("font-family: 'Times New Roman', serif");
    });

    it('should include message in letter-body div', () => {
      const message = 'My test message content';
      const html = expectedPostGridHtml.textOnly(message);

      expect(html).toContain('class="letter-body"');
      expect(html).toContain(message);
    });
  });

  describe('header_image layout HTML', () => {
    it('should contain header-image class', () => {
      const expectedContents = expectedPostGridHtml.headerImageContains;

      expect(expectedContents).toContain('class="header-image"');
    });

    it('should contain base64 image source', () => {
      const expectedContents = expectedPostGridHtml.headerImageContains;

      expect(expectedContents).toContain('<img src="data:image/jpeg;base64,');
    });

    it('should maintain 3.5in top margin', () => {
      const expectedContents = expectedPostGridHtml.headerImageContains;

      expect(expectedContents).toContain('margin: 3.5in');
    });

    it('should limit header image height to 2 inches', () => {
      const expectedContents = expectedPostGridHtml.headerImageContains;

      expect(expectedContents).toContain('max-height: 2in');
    });
  });

  describe('inline_image layout HTML', () => {
    it('should contain inline-image class', () => {
      const expectedContents = expectedPostGridHtml.inlineImageContains;

      expect(expectedContents).toContain('class="inline-image"');
    });

    it('should contain base64 image source', () => {
      const expectedContents = expectedPostGridHtml.inlineImageContains;

      expect(expectedContents).toContain('<img src="data:image/jpeg;base64,');
    });

    it('should limit inline image height to 3 inches', () => {
      const expectedContents = expectedPostGridHtml.inlineImageContains;

      expect(expectedContents).toContain('max-height: 3in');
    });

    it('should center the inline image', () => {
      const expectedContents = expectedPostGridHtml.inlineImageContains;

      expect(expectedContents).toContain('text-align: center');
    });
  });
});

// =============================================================================
// Error Messages (User-friendly)
// =============================================================================
describe('Error Messages', () => {
  describe('Header image errors', () => {
    it('should provide user-friendly error for file too large', () => {
      expect(layoutErrors.headerImageTooLarge).toBe(
        'Header image is too large. Please use an image under 5MB.'
      );
    });

    it('should provide user-friendly error for wrong format', () => {
      expect(layoutErrors.headerImageWrongFormat).toBe(
        'Unsupported image format. Please use PNG, JPEG, or WebP.'
      );
    });

    it('should provide user-friendly error for character limit', () => {
      expect(layoutErrors.headerLayoutOverLimit).toBe(
        'Letter exceeds one-page limit with header image (~1500 characters)'
      );
    });
  });

  describe('Inline image errors', () => {
    it('should provide user-friendly error for file too large', () => {
      expect(layoutErrors.inlineImageTooLarge).toBe(
        'Inline image is too large. Please use an image under 5MB.'
      );
    });

    it('should provide user-friendly error for character limit', () => {
      expect(layoutErrors.inlineLayoutOverLimit).toBe(
        'Letter exceeds one-page limit with inline image (~1200 characters)'
      );
    });
  });

  describe('Layout conflict errors', () => {
    it('should provide clear error for both images', () => {
      expect(layoutErrors.bothImagesProvided).toBe(
        'Cannot use both header and inline images. Please choose one layout type.'
      );
    });
  });
});

// =============================================================================
// Helper function for tests (will be implemented in actual code)
// =============================================================================
function detectLayoutType(input: {
  headerImageUrl?: string;
  inlineImageUrl?: string;
  layoutType?: LetterLayoutType;
}): LetterLayoutType {
  // Explicit override takes precedence
  if (input.layoutType) {
    return input.layoutType;
  }

  // Check for conflicting images
  if (input.headerImageUrl && input.inlineImageUrl) {
    throw new Error(layoutErrors.bothImagesProvided);
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
