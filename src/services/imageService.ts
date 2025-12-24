/**
 * Image Service for Letter IRL
 *
 * Handles image processing for postcards:
 * - Download from OpenAI URLs
 * - Validate size, type, and dimensions
 * - Resize for print (1800x2700 for 6x9 at 300 DPI)
 * - Convert to base64 data URI
 *
 * User Stories:
 * - US-POSTCARD-01: Preview a Postcard
 * - US-POSTCARD-03: Postcard Image Processing
 */

import sharp from 'sharp';
import type { ImageFileParam, ProcessedImage, PostcardSize } from './types.js';

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  maxFileSize: 10 * 1024 * 1024, // 10 MB
  minWidth: 100,   // Lowered - Sharp will upscale to print size
  minHeight: 100,  // Lowered - Sharp will upscale to print size
  jpegQuality: 85,
  allowedTypes: ['image/png', 'image/jpeg', 'image/webp'] as const,
  sizes: {
    '6x4': { width: 1800, height: 1200 },   // 6x4 at 300 DPI
    '6x9': { width: 1800, height: 2700 },   // 6x9 at 300 DPI
    '6x11': { width: 1800, height: 3300 },  // 6x11 at 300 DPI
  } as const,
} as const;

// ============================================================================
// Error Classes
// ============================================================================

export class ImageProcessingError extends Error {
  constructor(
    public readonly code: 'IMAGE_TOO_LARGE' | 'UNSUPPORTED_FORMAT' | 'IMAGE_TOO_SMALL' | 'DOWNLOAD_FAILED' | 'PROCESSING_FAILED',
    public readonly userMessage: string,
    originalError?: Error
  ) {
    super(userMessage);
    this.name = 'ImageProcessingError';
    if (originalError) {
      this.stack = `${this.stack}\nCaused by: ${originalError.stack}`;
    }
  }
}

// ============================================================================
// Main Processing Function
// ============================================================================

/**
 * Download and process an image for postcard printing
 *
 * @param fileParam - OpenAI file parameter with download_url and file_id
 * @param size - Target postcard size (default: '6x9')
 * @returns Processed image as base64 data URI with metadata
 * @throws ImageProcessingError with user-friendly message
 */
export async function downloadAndProcessImage(
  fileParam: ImageFileParam,
  size: PostcardSize = '6x9'
): Promise<ProcessedImage> {
  const { download_url } = fileParam;
  const targetDimensions = CONFIG.sizes[size];

  // 1. Download image
  const buffer = await downloadImage(download_url);

  // 2. Get metadata and validate dimensions
  const metadata = await getImageMetadata(buffer);
  validateDimensions(metadata.width, metadata.height);

  // 3. Resize and convert to JPEG
  const processed = await sharp(buffer)
    .resize(targetDimensions.width, targetDimensions.height, {
      fit: 'cover',
      position: 'center',
    })
    .jpeg({ quality: CONFIG.jpegQuality })
    .toBuffer();

  // 4. Convert to base64 data URI
  const base64 = processed.toString('base64');
  const dataUri = `data:image/jpeg;base64,${base64}`;

  return {
    base64DataUri: dataUri,
    originalWidth: metadata.width,
    originalHeight: metadata.height,
    processedWidth: targetDimensions.width,
    processedHeight: targetDimensions.height,
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Download image from URL with validation
 */
async function downloadImage(url: string): Promise<Buffer> {
  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new ImageProcessingError(
        'DOWNLOAD_FAILED',
        "Couldn't download the image. Please try again."
      );
    }

    // Check content-length header
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > CONFIG.maxFileSize) {
      throw new ImageProcessingError(
        'IMAGE_TOO_LARGE',
        'Image is too large. Please use an image under 10MB.'
      );
    }

    // Check content-type header
    const contentType = response.headers.get('content-type');
    if (contentType && !isAllowedType(contentType)) {
      throw new ImageProcessingError(
        'UNSUPPORTED_FORMAT',
        'Unsupported image format. Please use PNG, JPEG, or WebP.'
      );
    }

    // Download full content
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Validate actual size (in case Content-Length was missing)
    if (buffer.length > CONFIG.maxFileSize) {
      throw new ImageProcessingError(
        'IMAGE_TOO_LARGE',
        'Image is too large. Please use an image under 10MB.'
      );
    }

    return buffer;
  } catch (error) {
    if (error instanceof ImageProcessingError) {
      throw error;
    }
    throw new ImageProcessingError(
      'DOWNLOAD_FAILED',
      "Couldn't download the image. Please try again.",
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Get image metadata using Sharp
 */
async function getImageMetadata(buffer: Buffer): Promise<{ width: number; height: number; format: string }> {
  try {
    const metadata = await sharp(buffer).metadata();

    if (!metadata.width || !metadata.height) {
      throw new ImageProcessingError(
        'PROCESSING_FAILED',
        'Image could not be processed. Please try a different image.'
      );
    }

    return {
      width: metadata.width,
      height: metadata.height,
      format: metadata.format || 'unknown',
    };
  } catch (error) {
    if (error instanceof ImageProcessingError) {
      throw error;
    }
    throw new ImageProcessingError(
      'PROCESSING_FAILED',
      'Image could not be processed. Please try a different image.',
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Validate image dimensions meet minimum requirements
 */
function validateDimensions(width: number, height: number): void {
  if (width < CONFIG.minWidth || height < CONFIG.minHeight) {
    throw new ImageProcessingError(
      'IMAGE_TOO_SMALL',
      `Image is too small for print quality. Please use at least ${CONFIG.minWidth}x${CONFIG.minHeight} pixels.`
    );
  }
}

/**
 * Check if content type is allowed
 */
function isAllowedType(contentType: string): boolean {
  // Handle content types like "image/jpeg; charset=utf-8"
  const type = contentType.split(';')[0].trim().toLowerCase();
  return (CONFIG.allowedTypes as readonly string[]).includes(type);
}

// ============================================================================
// Exports for Testing
// ============================================================================

export const _testing = {
  CONFIG,
  downloadImage,
  getImageMetadata,
  validateDimensions,
  isAllowedType,
};
