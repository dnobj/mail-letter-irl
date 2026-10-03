import type { McpToolDefinition, ToolContext } from '../contracts/types.js';
import { clearSignatureInputSchema, clearSignatureOutputSchema } from '../schemas.js';
import { clearSignature } from '../services/signatureService.js';
import { requireSignatures, SignatureRefusedError } from './signatureShared.js';

/**
 * Removes the person's saved signature (#608). New previews then print none;
 * letters already previewed keep their own copy. Listed only while signatures
 * are offered (src/server.ts).
 */
export const CLEAR_SIGNATURE_TOOL = 'clear_signature';

interface ClearSignatureInput {
  confirm: boolean;
}

export interface ClearSignatureOutput {
  /** Whether a saved signature was removed: false when none was saved. */
  removed: boolean;
  message: string;
}

async function handler(input: ClearSignatureInput, context: ToolContext): Promise<ClearSignatureOutput> {
  requireSignatures();
  if (input.confirm !== true) {
    throw new SignatureRefusedError(
      'CONFIRM_REQUIRED',
      'Ask the person to confirm, then call again with confirm: true. A removed signature cannot be brought back; set_signature saves one again.'
    );
  }
  const removed = await clearSignature(context.user.userId);
  context.logger.info(
    { correlationId: context.correlationId, event: 'signature.cleared', removed },
    'Signature cleared'
  );
  return {
    removed,
    message: removed
      ? 'Removed the saved signature. New letter previews print none; letters already previewed keep theirs.'
      : 'No signature was saved, so nothing changed.'
  };
}

export const clearSignatureTool: McpToolDefinition<ClearSignatureInput, ClearSignatureOutput> = {
  name: CLEAR_SIGNATURE_TOOL,
  title: 'Remove the saved signature',
  description:
    "Remove the person's saved signature. New letter previews then print none; letters already previewed keep theirs. " +
    'Requires confirm: true, once the person has agreed. It cannot be undone; set_signature saves one again.',
  readOnly: false,
  inputSchema: clearSignatureInputSchema,
  outputSchema: clearSignatureOutputSchema,
  meta: {
    'openai/toolInvocation/invoking': 'Removing the signature...',
    'openai/toolInvocation/invoked': 'Signature removed',
    destructiveHint: true
  },
  handler
};
