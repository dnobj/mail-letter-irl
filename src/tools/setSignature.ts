import type { McpToolDefinition, ToolContext } from '../contracts/types.js';
import type { ImageFileParam } from '../services/types.js';
import { setSignatureInputSchema, setSignatureOutputSchema } from '../schemas.js';
import { downloadSignatureSource } from '../services/imageService.js';
import { cleanSignatureImage, SignatureImageError } from '../services/signatureImage.js';
import { saveSignature } from '../services/signatureService.js';
import { AccountErasedError } from '../auth/accountErased.js';
import {
  requireSignatures,
  SignatureRefusedError,
  signatureImageUri,
  signatureSourceOf
} from './signatureShared.js';

/**
 * Saves the person's signature (#608, concept 3): one picture for the
 * account, cleaned into dark ink on white and cropped to the ink, which their
 * letters print under the closing. A new picture replaces the one before;
 * letters already previewed keep theirs. Listed only while signatures are
 * offered (src/server.ts).
 */
export const SET_SIGNATURE_TOOL = 'set_signature';

interface SetSignatureInput {
  image?: ImageFileParam;
  imageUrl?: string;
}

export interface SetSignatureOutput {
  saved: true;
  /** Whether it replaced a signature saved before. */
  replaced: boolean;
  /** The cleaned signature's size, in pixels. */
  width: number;
  height: number;
  /** The cleaned signature, for a card: partitioned into _meta, never the model's. */
  signatureImage: string;
  message: string;
}

async function handler(input: SetSignatureInput, context: ToolContext): Promise<SetSignatureOutput> {
  requireSignatures();
  const source = signatureSourceOf(input);
  if (!source) {
    throw new SignatureRefusedError(
      'SIGNATURE_PICTURE_REQUIRED',
      'Ask the person for a photo of their signature, signed in dark ink on white paper and photographed flat and close. Pass it as image, or a link to it as imageUrl.'
    );
  }

  const userId = context.user.userId;
  const picture = await downloadSignatureSource(source, { actorId: userId });
  let cleaned;
  try {
    cleaned = await cleanSignatureImage(picture, userId);
  } catch (error) {
    if (error instanceof SignatureImageError) throw new SignatureRefusedError(error.code, error.message);
    throw error;
  }

  const saved = await saveSignature(userId, cleaned);
  // Erased while this waited for the account's lock.
  if (!saved.ok) throw new AccountErasedError();

  // The size only: never the picture or where it came from.
  context.logger.info(
    {
      correlationId: context.correlationId,
      event: 'signature.saved',
      replaced: saved.replaced,
      width: cleaned.width,
      height: cleaned.height
    },
    'Signature saved'
  );
  return {
    saved: true,
    replaced: saved.replaced,
    width: cleaned.width,
    height: cleaned.height,
    signatureImage: signatureImageUri(cleaned.png),
    message:
      (saved.replaced ? 'Saved the new signature, in place of the one before.' : 'Saved the signature.') +
      ' Letters previewed from now on print it under the closing.' +
      ' Letters already previewed keep what they had. clear_signature removes it.'
  };
}

function describe(): string {
  return (
    "Use this when the person wants their handwritten signature printed on their letters. " +
    'It saves one picture of their signature for their account, in place of any saved before, and their letters then print it under the closing. ' +
    'Take the picture as a file the person attached (image) or a link to it (imageUrl). ' +
    'It works best as dark ink on white paper, photographed flat and close. ' +
    'The server crops it to the ink and turns the paper white, and refuses a picture with no signature in it. ' +
    "Use only the person's own signature. It is free and sends nothing."
  );
}

export const setSignatureTool: McpToolDefinition<SetSignatureInput, SetSignatureOutput> = {
  name: SET_SIGNATURE_TOOL,
  title: 'Save a signature',
  description: describe,
  readOnly: false,
  inputSchema: setSignatureInputSchema,
  outputSchema: setSignatureOutputSchema,
  meta: {
    'openai/fileParams': ['image'],
    'openai/toolInvocation/invoking': 'Saving the signature...',
    'openai/toolInvocation/invoked': 'Signature saved',
    // It replaces the saved signature, which cannot be brought back.
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false
  },
  handler
};
