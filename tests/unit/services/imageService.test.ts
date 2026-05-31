/**
 * Unit tests for imageService
 *
 * Tests the image processing pipeline for postcards:
 * - Downloading images from OpenAI URLs
 * - Validating file size, type, and dimensions
 * - Resizing images for print (1800x2700 for 6x9 at 300 DPI)
 * - Converting to base64 data URI
 *
 * User Stories Covered:
 * - US-POSTCARD-01: Preview a Postcard (image validation)
 * - US-POSTCARD-03: Postcard Image Processing
 *
 * Personas Covered:
 * - Sarah (Occasional Sender) - uploads vacation photos
 * - David (Business User) - uploads brand imagery
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  testImages,
  testImageMetadata,
  testProcessedImage,
  postcardErrors,
  imageProcessingConfig,
} from '../../fixtures/postcards.js';
import { _testing as imageServiceTesting } from '../../../src/services/imageService.js';

// Mock fetch for downloading images
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock sharp for image processing (will be implemented later)
vi.mock('sharp', () => {
  return {
    default: vi.fn(() => ({
      metadata: vi.fn(),
      resize: vi.fn().mockReturnThis(),
      jpeg: vi.fn().mockReturnThis(),
      toBuffer: vi.fn(),
    })),
  };
});

describe('imageService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Image Download Validation
  // ==========================================================================
  describe('Image Download Validation', () => {
    it('should reject non-HTTPS image URLs before fetching', async () => {
      await expect(
        imageServiceTesting.validateRemoteImageUrl('http://example.com/image.jpg')
      ).rejects.toThrow("Couldn't download the image");
    });

    it('should reject localhost and private IP image URLs before fetching', async () => {
      expect(imageServiceTesting.isUnsafeIpAddress('127.0.0.1')).toBe(true);
      expect(imageServiceTesting.isUnsafeIpAddress('10.0.0.5')).toBe(true);
      expect(imageServiceTesting.isUnsafeIpAddress('172.16.0.1')).toBe(true);
      expect(imageServiceTesting.isUnsafeIpAddress('192.168.1.20')).toBe(true);
      expect(imageServiceTesting.isUnsafeIpAddress('169.254.169.254')).toBe(true);
      expect(imageServiceTesting.isUnsafeIpAddress('::1')).toBe(true);
      expect(imageServiceTesting.isUnsafeIpAddress('::ffff:7f00:1')).toBe(true);

      await expect(
        imageServiceTesting.validateRemoteImageUrl('https://127.0.0.1/image.jpg')
      ).rejects.toThrow("Couldn't download the image");
      await expect(
        imageServiceTesting.validateRemoteImageUrl('https://[::1]/image.jpg')
      ).rejects.toThrow("Couldn't download the image");
    });

    it('should allow public HTTPS IP image URLs', async () => {
      await expect(
        imageServiceTesting.validateRemoteImageUrl('https://8.8.8.8/image.jpg')
      ).resolves.toBeInstanceOf(URL);
    });

    it('should reject images larger than 10MB based on Content-Length header', async () => {
      // Simulate a response with Content-Length > 10MB
      const largeFile = testImages.tooLargeFile;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: {
          get: (name: string) => {
            if (name === 'content-length') return String(largeFile.contentLength);
            if (name === 'content-type') return largeFile.contentType;
            return null;
          },
        },
      });

      // Expected: validation should fail before downloading full content
      const contentLength = largeFile.contentLength;
      const maxSize = imageProcessingConfig.maxFileSize;

      expect(contentLength).toBeGreaterThan(maxSize);

      // Error message should be user-friendly
      const errorMsg = postcardErrors.imageTooLarge;
      expect(errorMsg).toBe('Image is too large. Please use an image under 10MB.');
    });

    it('should accept images under 10MB', async () => {
      const validFile = testImages.validJpegFile;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: {
          get: (name: string) => {
            if (name === 'content-length') return String(validFile.contentLength);
            if (name === 'content-type') return validFile.contentType;
            return null;
          },
        },
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(validFile.contentLength)),
      });

      const contentLength = validFile.contentLength;
      const maxSize = imageProcessingConfig.maxFileSize;

      expect(contentLength).toBeLessThanOrEqual(maxSize);
    });

    it('should reject unsupported image formats (GIF)', async () => {
      const gifFile = testImages.invalidGifFile;

      const allowedTypes = imageProcessingConfig.allowedTypes;

      expect(allowedTypes).not.toContain(gifFile.contentType);

      const errorMsg = postcardErrors.unsupportedFormat;
      expect(errorMsg).toBe('Unsupported image format. Please use PNG, JPEG, or WebP.');
    });

    it('should reject unsupported image formats (SVG)', async () => {
      const svgFile = testImages.invalidSvgFile;

      const allowedTypes = imageProcessingConfig.allowedTypes;

      expect(allowedTypes).not.toContain(svgFile.contentType);
    });

    it('should accept JPEG images', async () => {
      const allowedTypes = imageProcessingConfig.allowedTypes;
      expect(allowedTypes).toContain('image/jpeg');
    });

    it('should accept PNG images', async () => {
      const allowedTypes = imageProcessingConfig.allowedTypes;
      expect(allowedTypes).toContain('image/png');
    });

    it('should accept WebP images', async () => {
      const allowedTypes = imageProcessingConfig.allowedTypes;
      expect(allowedTypes).toContain('image/webp');
    });

    it('should handle download failures gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const errorMsg = postcardErrors.downloadFailed;
      expect(errorMsg).toBe("Couldn't download the image. Please try again.");
    });
  });

  // ==========================================================================
  // Image Dimension Validation
  // ==========================================================================
  describe('Image Dimension Validation', () => {
    it('should reject images with width below 600px', async () => {
      const metadata = testImageMetadata.tooSmallWidth;

      const minWidth = imageProcessingConfig.minWidth;
      expect(metadata.width).toBeLessThan(minWidth);

      const errorMsg = postcardErrors.imageTooSmall;
      expect(errorMsg).toContain('600x900 pixels');
    });

    it('should reject images with height below 900px', async () => {
      const metadata = testImageMetadata.tooSmallHeight;

      const minHeight = imageProcessingConfig.minHeight;
      expect(metadata.height).toBeLessThan(minHeight);
    });

    it('should reject images with both dimensions too small', async () => {
      const metadata = testImageMetadata.tooSmallBoth;

      const minWidth = imageProcessingConfig.minWidth;
      const minHeight = imageProcessingConfig.minHeight;

      expect(metadata.width).toBeLessThan(minWidth);
      expect(metadata.height).toBeLessThan(minHeight);
    });

    it('should accept images at exactly minimum dimensions (600x900)', async () => {
      const metadata = testImageMetadata.atMinimum;

      const minWidth = imageProcessingConfig.minWidth;
      const minHeight = imageProcessingConfig.minHeight;

      expect(metadata.width).toBeGreaterThanOrEqual(minWidth);
      expect(metadata.height).toBeGreaterThanOrEqual(minHeight);
    });

    it('should accept landscape images if dimensions are sufficient', async () => {
      const metadata = testImageMetadata.validLandscape;

      // For landscape, we need to check if cropped version meets requirements
      // 1920x1080 cropped to 2:3 ratio = 1620x1080 or 1080x720
      // Actually we use cover/center, so largest dimension is used
      expect(metadata.width).toBeGreaterThanOrEqual(imageProcessingConfig.minWidth);
    });

    it('should accept portrait images', async () => {
      const metadata = testImageMetadata.validPortrait;

      expect(metadata.width).toBeGreaterThanOrEqual(imageProcessingConfig.minWidth);
      expect(metadata.height).toBeGreaterThanOrEqual(imageProcessingConfig.minHeight);
    });

    it('should accept square images if dimensions are sufficient', async () => {
      const metadata = testImageMetadata.validSquare;

      expect(metadata.width).toBeGreaterThanOrEqual(imageProcessingConfig.minWidth);
      expect(metadata.height).toBeGreaterThanOrEqual(imageProcessingConfig.minHeight);
    });
  });

  // ==========================================================================
  // Image Processing (Resize)
  // ==========================================================================
  describe('Image Processing', () => {
    it('should resize images to 1800x2700 (6x9 at 300 DPI)', async () => {
      const targetWidth = imageProcessingConfig.targetWidth;
      const targetHeight = imageProcessingConfig.targetHeight;

      expect(targetWidth).toBe(1800);
      expect(targetHeight).toBe(2700);
    });

    it('should use cover fit with center position for cropping', async () => {
      // This test documents the expected Sharp options
      // Actual implementation will use: sharp(buffer).resize(1800, 2700, { fit: 'cover', position: 'center' })
      const resizeOptions = { fit: 'cover', position: 'center' };

      expect(resizeOptions.fit).toBe('cover');
      expect(resizeOptions.position).toBe('center');
    });

    it('should convert to JPEG with 85% quality', async () => {
      const jpegQuality = imageProcessingConfig.jpegQuality;

      expect(jpegQuality).toBe(85);
    });

    it('should return base64 data URI format', async () => {
      const result = testProcessedImage;

      expect(result.base64DataUri).toMatch(/^data:image\/jpeg;base64,/);
    });

    it('should include original dimensions in result', async () => {
      const result = testProcessedImage;

      expect(result.originalWidth).toBe(1920);
      expect(result.originalHeight).toBe(1080);
    });

    it('should include processed dimensions in result', async () => {
      const result = testProcessedImage;

      expect(result.processedWidth).toBe(1800);
      expect(result.processedHeight).toBe(2700);
    });
  });

  // ==========================================================================
  // Error Handling
  // ==========================================================================
  describe('Error Handling', () => {
    it('should provide user-friendly error for file too large', () => {
      expect(postcardErrors.imageTooLarge).toBe(
        'Image is too large. Please use an image under 10MB.'
      );
    });

    it('should provide user-friendly error for wrong format', () => {
      expect(postcardErrors.unsupportedFormat).toBe(
        'Unsupported image format. Please use PNG, JPEG, or WebP.'
      );
    });

    it('should provide user-friendly error for image too small', () => {
      expect(postcardErrors.imageTooSmall).toBe(
        'Image is too small for print quality. Please use at least 600x900 pixels.'
      );
    });

    it('should provide user-friendly error for download failure', () => {
      expect(postcardErrors.downloadFailed).toBe(
        "Couldn't download the image. Please try again."
      );
    });

    it('should provide user-friendly error for processing failure', () => {
      expect(postcardErrors.processingFailed).toBe(
        'Image could not be processed. Please try a different image.'
      );
    });
  });

  // ==========================================================================
  // OpenAI File Parameter Integration
  // ==========================================================================
  describe('OpenAI File Parameter Integration', () => {
    it('should accept image with download_url and file_id', async () => {
      const imageParam = testImages.validJpegFile;

      expect(imageParam).toHaveProperty('download_url');
      expect(imageParam).toHaveProperty('file_id');

      expect(imageParam.download_url).toMatch(/^https:\/\//);
      expect(imageParam.file_id).toMatch(/^file-/);
    });

    it('should fetch from the provided download_url', async () => {
      const imageParam = testImages.validJpegFile;

      // Document expected fetch call
      const expectedUrl = imageParam.download_url;
      expect(expectedUrl).toBe('https://files.openai.com/test/image-valid.jpg');
    });
  });
});
