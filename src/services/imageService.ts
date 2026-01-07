/**
 * Image Service for Letter IRL
 *
 * Handles image processing for postcards and letters:
 * - Download from OpenAI URLs
 * - Validate size, type, and dimensions
 * - Resize for print (postcard: 1800x2700 for 6x9 at 300 DPI)
 * - Letter header: 1950x600 (6.5" x 2" at 300 DPI)
 * - Letter inline: 1950x900 (6.5" x 3" at 300 DPI)
 * - Convert to base64 data URI
 *
 * User Stories:
 * - US-POSTCARD-01: Preview a Postcard
 * - US-POSTCARD-03: Postcard Image Processing
 * - US-LAYOUT-01: Preview Letter with Header Image
 * - US-LAYOUT-02: Preview Letter with Inline Image
 * - US-LAYOUT-04: Letter Layout Image Processing
 */

import sharp from 'sharp';
import type { ImageFileParam, ProcessedImage, PostcardSize, LetterImageType } from './types.js';

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  maxFileSize: 10 * 1024 * 1024, // 10 MB for postcards
  minWidth: 100,   // Lowered - Sharp will upscale to print size
  minHeight: 100,  // Lowered - Sharp will upscale to print size
  jpegQuality: 85,
  allowedTypes: ['image/png', 'image/jpeg', 'image/webp'] as const,
  // PostGrid uses landscape orientation (width x height)
  // Our internal names (6x4, 6x9, 6x11) refer to the PostGrid size names
  // PostGrid 6x4 = 6" wide x 4" tall (landscape)
  // PostGrid 9x6 = 9" wide x 6" tall (landscape) - we call it '6x9' internally
  // PostGrid 11x6 = 11" wide x 6" tall (landscape) - we call it '6x11' internally
  sizes: {
    '6x4': { width: 1800, height: 1200 },   // 6x4 at 300 DPI (6" x 4")
    '6x9': { width: 2700, height: 1800 },   // 9x6 at 300 DPI (9" x 6") - landscape
    '6x11': { width: 3300, height: 1800 },  // 11x6 at 300 DPI (11" x 6") - landscape
  } as const,
} as const;

// Letter image configuration (US-LAYOUT-04)
const LETTER_IMAGE_CONFIG = {
  maxFileSize: 5 * 1024 * 1024, // 5 MB for letter images
  jpegQuality: 85,
  allowedTypes: ['image/png', 'image/jpeg', 'image/webp'] as const,
  // Letter page is 8.5" x 11" with 1" margins on sides
  // Content area is 6.5" wide (1950px at 300 DPI)
  sizes: {
    header: { width: 1950, height: 600 },   // 6.5" x 2" at 300 DPI (header/letterhead)
    inline: { width: 1950, height: 900 },   // 6.5" x 3" at 300 DPI (inline after signature)
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
 * Input type for image processing - accepts either OpenAI file param or direct URL
 */
export type ImageInput = ImageFileParam | { url: string };

/**
 * Download and process an image for postcard printing
 *
 * @param input - OpenAI file parameter with download_url, or object with url string
 * @param size - Target postcard size (default: '6x9')
 * @returns Processed image as base64 data URI with metadata
 * @throws ImageProcessingError with user-friendly message
 */
export async function downloadAndProcessImage(
  input: ImageInput,
  size: PostcardSize = '6x9'
): Promise<ProcessedImage> {
  // Support both OpenAI fileParams ({download_url, file_id}) and plain URLs ({url})
  const download_url = 'download_url' in input ? input.download_url : input.url;
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
// Preview Image Configuration (for ChatGPT widget)
// ============================================================================

// Preview images are smaller for fast widget loading in ChatGPT
// ChatGPT filters out large base64 data from tool outputs
const PREVIEW_CONFIG = {
  // Small enough to pass through ChatGPT's widget data filtering
  maxWidth: 400,
  maxHeight: 300,
  jpegQuality: 60,  // Lower quality for smaller size
} as const;

// ============================================================================
// Postcard Image Processing with Preview
// ============================================================================

/**
 * Result type for postcard image processing with preview
 */
export interface ProcessedPostcardImage extends ProcessedImage {
  /** Small preview image for ChatGPT widget display (~10-20KB) */
  previewDataUri: string;
}

/**
 * Download and process an image for postcard printing, generating both:
 * - Full quality image for PostGrid printing (2700x1800 at 300 DPI)
 * - Smaller preview image for ChatGPT widget display (~400x300)
 *
 * @param input - OpenAI file parameter with download_url, or object with url string
 * @param size - Target postcard size (default: '6x9')
 * @returns Processed images (full + preview) with metadata
 * @throws ImageProcessingError with user-friendly message
 */
export async function downloadAndProcessPostcardImageWithPreview(
  input: ImageInput,
  size: PostcardSize = '6x9'
): Promise<ProcessedPostcardImage> {
  const download_url = 'download_url' in input ? input.download_url : input.url;
  const targetDimensions = CONFIG.sizes[size];

  // 1. Download image
  const buffer = await downloadImage(download_url);

  // 2. Get metadata and validate dimensions
  const metadata = await getImageMetadata(buffer);
  validateDimensions(metadata.width, metadata.height);

  // 3. Create full-quality image for PostGrid printing
  const processed = await sharp(buffer)
    .resize(targetDimensions.width, targetDimensions.height, {
      fit: 'cover',
      position: 'center',
    })
    .jpeg({ quality: CONFIG.jpegQuality })
    .toBuffer();

  // 4. Create small preview for ChatGPT widget
  // Maintain aspect ratio of postcard (landscape)
  const previewWidth = PREVIEW_CONFIG.maxWidth;
  const previewHeight = Math.round(previewWidth * (targetDimensions.height / targetDimensions.width));

  const preview = await sharp(buffer)
    .resize(previewWidth, previewHeight, {
      fit: 'cover',
      position: 'center',
    })
    .jpeg({ quality: PREVIEW_CONFIG.jpegQuality })
    .toBuffer();

  // 5. Convert both to base64 data URIs
  const base64Full = processed.toString('base64');
  const base64Preview = preview.toString('base64');

  return {
    base64DataUri: `data:image/jpeg;base64,${base64Full}`,
    previewDataUri: `data:image/jpeg;base64,${base64Preview}`,
    originalWidth: metadata.width,
    originalHeight: metadata.height,
    processedWidth: targetDimensions.width,
    processedHeight: targetDimensions.height,
  };
}

// ============================================================================
// Letter Image Processing (US-LAYOUT-04)
// ============================================================================

/**
 * Download and process an image for letter layouts (header or inline)
 *
 * @param input - OpenAI file parameter with download_url, or object with url string
 * @param imageType - 'header' for top of letter, 'inline' for after signature
 * @returns Processed image as base64 data URI with metadata
 * @throws ImageProcessingError with user-friendly message
 */
export async function downloadAndProcessLetterImage(
  input: ImageInput,
  imageType: LetterImageType
): Promise<ProcessedImage> {
  const download_url = 'download_url' in input ? input.download_url : input.url;
  const targetDimensions = LETTER_IMAGE_CONFIG.sizes[imageType];

  // 1. Download image (with letter-specific size limit)
  const buffer = await downloadLetterImage(download_url, imageType);

  // 2. Get metadata and validate
  const metadata = await getImageMetadata(buffer);
  validateDimensions(metadata.width, metadata.height);

  // 3. Resize to fit within dimensions while maintaining aspect ratio
  // Use 'inside' fit to ensure image doesn't exceed max dimensions
  const processed = await sharp(buffer)
    .resize(targetDimensions.width, targetDimensions.height, {
      fit: 'inside',       // Fit within bounds, don't crop
      withoutEnlargement: false, // Allow upscaling if needed
    })
    .jpeg({ quality: LETTER_IMAGE_CONFIG.jpegQuality })
    .toBuffer();

  // Get actual processed dimensions
  const processedMetadata = await sharp(processed).metadata();

  // 4. Convert to base64 data URI
  const base64 = processed.toString('base64');
  const dataUri = `data:image/jpeg;base64,${base64}`;

  return {
    base64DataUri: dataUri,
    originalWidth: metadata.width,
    originalHeight: metadata.height,
    processedWidth: processedMetadata.width || targetDimensions.width,
    processedHeight: processedMetadata.height || targetDimensions.height,
  };
}

/**
 * Result type for letter image processing with preview
 */
export interface ProcessedImageWithPreview extends ProcessedImage {
  /** Small preview image for ChatGPT widget display (~20-50KB) */
  previewDataUri: string;
}

/**
 * Download and process an image for letter layouts, generating both:
 * - Full quality image for PostGrid printing
 * - Smaller preview image for ChatGPT widget display
 *
 * @param input - OpenAI file parameter with download_url, or object with url string
 * @param imageType - 'header' for top of letter, 'inline' for after signature
 * @returns Processed images (full + preview) with metadata
 * @throws ImageProcessingError with user-friendly message
 */
export async function downloadAndProcessLetterImageWithPreview(
  input: ImageInput,
  imageType: LetterImageType
): Promise<ProcessedImageWithPreview> {
  const download_url = 'download_url' in input ? input.download_url : input.url;
  const targetDimensions = LETTER_IMAGE_CONFIG.sizes[imageType];

  // 1. Download image (with letter-specific size limit)
  const buffer = await downloadLetterImage(download_url, imageType);

  // 2. Get metadata and validate
  const metadata = await getImageMetadata(buffer);
  validateDimensions(metadata.width, metadata.height);

  // 3. Create full-quality image for PostGrid
  const processed = await sharp(buffer)
    .resize(targetDimensions.width, targetDimensions.height, {
      fit: 'inside',
      withoutEnlargement: false,
    })
    .jpeg({ quality: LETTER_IMAGE_CONFIG.jpegQuality })
    .toBuffer();

  const processedMetadata = await sharp(processed).metadata();

  // 4. Create small preview for ChatGPT widget
  const preview = await sharp(buffer)
    .resize(PREVIEW_CONFIG.maxWidth, PREVIEW_CONFIG.maxHeight, {
      fit: 'inside',
      withoutEnlargement: true,  // Don't upscale small images for preview
    })
    .jpeg({ quality: PREVIEW_CONFIG.jpegQuality })
    .toBuffer();

  // 5. Convert both to base64 data URIs
  const base64Full = processed.toString('base64');
  const base64Preview = preview.toString('base64');

  return {
    base64DataUri: `data:image/jpeg;base64,${base64Full}`,
    previewDataUri: `data:image/jpeg;base64,${base64Preview}`,
    originalWidth: metadata.width,
    originalHeight: metadata.height,
    processedWidth: processedMetadata.width || targetDimensions.width,
    processedHeight: processedMetadata.height || targetDimensions.height,
  };
}

/**
 * Download image for letter layouts with appropriate size validation
 */
async function downloadLetterImage(url: string, imageType: LetterImageType): Promise<Buffer> {
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
    if (contentLength && parseInt(contentLength, 10) > LETTER_IMAGE_CONFIG.maxFileSize) {
      throw new ImageProcessingError(
        'IMAGE_TOO_LARGE',
        `${imageType === 'header' ? 'Header' : 'Inline'} image is too large. Please use an image under 5MB.`
      );
    }

    // Check content-type header
    const contentType = response.headers.get('content-type');
    if (contentType && !isAllowedLetterType(contentType)) {
      throw new ImageProcessingError(
        'UNSUPPORTED_FORMAT',
        'Unsupported image format. Please use PNG, JPEG, or WebP.'
      );
    }

    // Download full content
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Validate actual size
    if (buffer.length > LETTER_IMAGE_CONFIG.maxFileSize) {
      throw new ImageProcessingError(
        'IMAGE_TOO_LARGE',
        `${imageType === 'header' ? 'Header' : 'Inline'} image is too large. Please use an image under 5MB.`
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
 * Check if content type is allowed for letter images
 */
function isAllowedLetterType(contentType: string): boolean {
  const type = contentType.split(';')[0].trim().toLowerCase();
  return (LETTER_IMAGE_CONFIG.allowedTypes as readonly string[]).includes(type);
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
  LETTER_IMAGE_CONFIG,
  downloadImage,
  downloadLetterImage,
  getImageMetadata,
  validateDimensions,
  isAllowedType,
  isAllowedLetterType,
};
