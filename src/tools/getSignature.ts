import type { McpToolDefinition, ToolContext } from '../contracts/types.js';
import { getSignatureInputSchema, getSignatureOutputSchema } from '../schemas.js';
import { getSignature } from '../services/signatureService.js';
import { requireSignatures, signatureImageUri } from './signatureShared.js';

/**
 * Whether the person has a saved signature (#608), with the picture for a
 * card. Read-only. Listed only while signatures are offered (src/server.ts).
 */
export const GET_SIGNATURE_TOOL = 'get_signature';

type GetSignatureInput = Record<string, never>;

export interface GetSignatureOutput {
  saved: boolean;
  /** The cleaned signature's size, in pixels, when one is saved. */
  width?: number;
  height?: number;
  /** When it was saved, ISO 8601. */
  savedAt?: string;
  /** The cleaned signature, for a card: partitioned into _meta, never the model's. */
  signatureImage?: string;
  message: string;
}

async function handler(_input: GetSignatureInput, context: ToolContext): Promise<GetSignatureOutput> {
  requireSignatures();
  const signature = await getSignature(context.user.userId);
  if (!signature) {
    return {
      saved: false,
      message: 'No signature is saved. set_signature saves one from a photo of the person\'s signature.'
    };
  }
  return {
    saved: true,
    width: signature.width,
    height: signature.height,
    savedAt: signature.updatedAt,
    signatureImage: signatureImageUri(signature.png),
    message: 'A signature is saved. Letters print it under the closing.'
  };
}

export const getSignatureTool: McpToolDefinition<GetSignatureInput, GetSignatureOutput> = {
  name: GET_SIGNATURE_TOOL,
  title: 'Get the saved signature',
  description:
    'Check whether the person has a saved signature for their letters, and when it was saved. ' +
    'Read-only: it changes and sends nothing.',
  readOnly: true,
  inputSchema: getSignatureInputSchema,
  outputSchema: getSignatureOutputSchema,
  meta: {
    'openai/toolInvocation/invoking': 'Checking the signature...',
    'openai/toolInvocation/invoked': 'Signature checked'
  },
  handler
};
