import type { McpToolDefinition, ToolContext } from '../contracts/types.js';
import { uploadPhotoChunkInputSchema, uploadPhotoChunkOutputSchema } from '../schemas.js';
import { isCardUploadEnabled } from '../config/cardUpload.js';
import { ImageProcessingError } from '../services/imageService.js';
import { classifyDiagnosticError } from '../utils/diagnosticLog.js';
import {
  PhotoUploadRefusedError,
  receivePhotoChunk,
  type PhotoChunkInput,
  type PhotoChunkResult
} from '../services/photoUploadService.js';

/**
 * One chunk of a photo from our upload card (#474, phase 3).
 *
 * In an app with no file store for cards (Claude), the upload card shrinks
 * the photo and sends it here in chunks; the last chunk finishes the upload
 * and makes the photo the account's recent upload, so the next preview with
 * no image uses it. The limits live in src/services/photoUploadService.ts.
 *
 * Card-only (APP_ONLY_TOOLS in src/mcp/registerTools.ts), and listed only
 * while LETTER_IRL_CARD_UPLOAD_ENABLED is on (src/config/cardUpload.ts).
 */
export const UPLOAD_PHOTO_CHUNK_TOOL = 'upload_photo_chunk';

async function handler(input: PhotoChunkInput, context: ToolContext): Promise<PhotoChunkResult> {
  // Off, the tool is not registered at all (server.ts listTools); this holds
  // the switch for any caller that reaches the handler another way.
  if (!isCardUploadEnabled()) {
    throw new PhotoUploadRefusedError(
      'UNAVAILABLE',
      'Photo upload is not available here yet. Use a link to the photo instead.'
    );
  }
  let result: PhotoChunkResult;
  try {
    result = await receivePhotoChunk(context.user.userId, input);
  } catch (error) {
    // The card shows an error's text to the person as it is, so only words
    // written for them leave here: our refusals, and the image service's.
    if (error instanceof PhotoUploadRefusedError || error instanceof ImageProcessingError) throw error;
    context.logger.error(
      {
        correlationId: context.correlationId,
        event: 'photo_upload.failed',
        errorClass: classifyDiagnosticError(error)
      },
      'Photo upload failed'
    );
    throw new PhotoUploadRefusedError('FAILED', 'The photo could not be kept just now. Please try again.');
  }
  context.logger.info(
    {
      correlationId: context.correlationId,
      event: result.done ? 'photo_upload.finished' : 'photo_upload.chunk',
      chunkIndex: input.index,
      chunkTotal: input.total,
      chunkChars: input.data.length,
      ...(result.done ? { width: result.width, height: result.height } : {})
    },
    result.done ? 'Photo upload finished' : 'Photo upload chunk received'
  );
  return result;
}

export const uploadPhotoChunkTool: McpToolDefinition<PhotoChunkInput, PhotoChunkResult> = {
  name: UPLOAD_PHOTO_CHUNK_TOOL,
  title: 'Upload a photo',
  description:
    "Used by Letter IRL's upload card: receives a photo the person picked, in chunks, and keeps it " +
    'for their next letter or postcard preview. Not for direct use.',
  readOnly: false,
  inputSchema: uploadPhotoChunkInputSchema,
  outputSchema: uploadPhotoChunkOutputSchema,
  meta: {
    'openai/widgetAccessible': true,
    'openai/toolInvocation/invoking': 'Uploading the photo...',
    'openai/toolInvocation/invoked': 'Uploaded',
    // Keeps a photo (replacing the account's last one) and nothing else; a
    // chunk sent again changes nothing, so the card may retry it.
    readOnlyHint: false,
    idempotentHint: true
  },
  handler
};
