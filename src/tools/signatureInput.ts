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
  /** Whether signatures are offered: only then does the preview say what it printed. */
  offered?: boolean;
  /** Whether the account has a saved signature: read even when the call asked for none, so the output can say so. */
  saved?: boolean;
}

/** What a letter preview's output says of its signature (#608 review round 1). */
export interface PreviewSignatureOutput {
  /** Whether the letter prints the person's saved signature. */
  printed: boolean;
  /** Why: the call asked, the account's remembered choice, or no signature is saved. */
  source: 'asked' | 'remembered' | 'none_saved';
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
 * unsigned. While they are offered the saved signature is read even for
 * `false`, so the output says whether one is saved: the card offers its switch
 * only then (#615 review round 1).
 */
export async function chooseSignature(asked: boolean | undefined, context: ToolContext): Promise<PreviewSignature> {
  if (!isSignaturesOffered()) {
    if (asked === true) {
      throw new SignatureRefusedError('SIGNATURES_OFF', "Signatures aren't available here. Preview the letter without signature.");
    }
    return {};
  }
  const saved = await getSignature(context.user.userId);
  if (asked === false) return { asked, offered: true, saved: saved !== null };
  if (!saved) {
    if (asked === true) {
      throw new SignatureRefusedError(
        'SIGNATURE_NOT_SAVED',
        'No signature is saved. Ask the person for a photo of their signature and save it with set_signature, or preview the letter without signature.'
      );
    }
    return { offered: true, saved: false };
  }
  return asked === true || saved.useByDefault
    ? { image: signatureImageUri(saved.png), asked, offered: true, saved: true }
    : { asked, offered: true, saved: true };
}

/**
 * What the preview's output says of the signature, so a model without the
 * card knows the letter is signed, and why (#608 review round 1): `printed`
 * follows the layout, which is what prints. Nothing while signatures are not
 * offered, so the output is then as before them.
 */
export function previewSignatureOutput(signature: PreviewSignature | undefined, printed: boolean): PreviewSignatureOutput | undefined {
  if (!signature?.offered) return undefined;
  // None saved, whatever the call asked: nothing to sign with (#615 review round 1).
  if (!signature.saved) return { printed: false, source: 'none_saved' };
  return { printed, source: signature.asked !== undefined ? 'asked' : 'remembered' };
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
