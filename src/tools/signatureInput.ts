import type { ToolContext } from '../contracts/types.js';
import { isSignaturesOffered } from '../config/signatures.js';
import { getSignature, rememberSignatureChoice } from '../services/signatureService.js';
import { SignatureRefusedError, signatureImageUri } from './signatureShared.js';

/**
 * A letter preview's signature (#608): the `signature` argument, or the
 * account's remembered choice when the call names none (Principle 4).
 */
export interface PreviewSignature {
  /** The saved signature as the letter prints it, a PNG data URI: the draft keeps this copy. */
  image?: string;
  /** What the call asked: true or false, or undefined when it named none. */
  asked?: boolean;
}

/**
 * The signature a letter preview prints, read once with the choice it was
 * saved with:
 * - `signature: true` prints the saved one, and is refused when none is saved;
 * - `false` prints none;
 * - left out, the saved one when the account's choice is on.
 *
 * While signatures are not offered the argument is withheld from the served
 * schemas, so a call that names it anyway is refused rather than printed
 * unsigned. Left out, nothing is read.
 */
export async function chooseSignature(asked: boolean | undefined, context: ToolContext): Promise<PreviewSignature> {
  if (!isSignaturesOffered()) {
    if (asked === true) {
      throw new SignatureRefusedError('SIGNATURES_OFF', "Signatures aren't available here. Preview the letter without signature.");
    }
    return {};
  }
  if (asked === false) return { asked };
  const saved = await getSignature(context.user.userId);
  if (!saved) {
    if (asked === true) {
      throw new SignatureRefusedError(
        'SIGNATURE_NOT_SAVED',
        'No signature is saved. Ask the person for a photo of their signature and save it with set_signature, or preview the letter without signature.'
      );
    }
    return {};
  }
  return asked === true || saved.useByDefault ? { image: signatureImageUri(saved.png), asked } : { asked };
}

/**
 * Remembers a preview's explicit choice for the account's next previews, once
 * its draft exists: a refused preview chose nothing. Never fails the preview.
 */
export async function rememberPreviewSignature(signature: PreviewSignature, context: ToolContext): Promise<void> {
  if (signature.asked === undefined) return;
  try {
    await rememberSignatureChoice(context.user.userId, signature.asked);
  } catch (error) {
    context.logger.warn(
      { correlationId: context.correlationId, event: 'quote.signature_not_remembered', error: (error as Error).message },
      'The signature choice was not remembered'
    );
  }
}
